import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import * as deployment from './deployment-config.mjs'

const read = path => existsSync(path) ? readFileSync(path) : null
const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function replaceAtom(text, key, value, overwrite) {
  const lines = [...text.matchAll(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=`, 'gm'))]
  if (lines.length > 1) throw new Error(`配置项 ${key} 重复，已停止，未覆盖配置。`)
  if (lines.length === 0) return text + (text && !text.endsWith('\n') ? '\r\n' : '') + `${key}=${value}\r\n`
  if (!overwrite) return text
  const pattern = new RegExp(`^([ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[ \\t]*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^#\\r\\n]*?)([ \\t]*(?:#[^\\r\\n]*)?)(\\r?)$`, 'gm')
  if ([...text.matchAll(pattern)].length !== 1) throw new Error(`配置项 ${key} 格式不明确，请先核对。`)
  return text.replace(pattern, (_match, prefix, comment, cr) => `${prefix}${value}${comment}${cr}`)
}
function readConfiguration(path) {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error(`配置必须是普通文件：${path}`)
  return read(path)
}

export async function prepareConfiguration(target, templates) {
  const deploymentPath = join(target, 'deployment.env')
  let config = deployment.LOCAL_DEFAULT
  if (existsSync(deploymentPath)) {
    const values = deployment.parseDeploymentEnv(readFileSync(deploymentPath, 'utf8'))
    // 更新器不改部署地址，也不要求在打包机网卡上找到部署机地址；启动器仍负责网卡检查。
    config = deployment.validateDeployment(values, [values.DEPLOY_HOST])
  }
  const envPath = join(target, 'frontend/.env.local')
  const envBefore = readConfiguration(envPath)
  let envText = envBefore?.toString('utf8') ?? ''
  if (envBefore && !Buffer.from(envText, 'utf8').equals(envBefore)) throw new Error('.env.local 不是有效 UTF-8，已停止以免破坏原文件。')
  // Node 22.14 的 loadEnvFile 会把 BOM 拼入首个键；输出无 BOM，保留参数和注释。
  envText = envText.replace(/^\uFEFF/, '')
  const originalValues = parseEnv(envText)
  const required = parseEnv(readFileSync(join(templates, 'frontend.env.local.template'), 'utf8'))
  assert.deepEqual(required, { useRealEngine: 'true', WRJ_LINK_CALC_MODE: 'auto' })
  for (const [key, value] of Object.entries(required)) envText = replaceAtom(envText, key, value, true)
  assert.deepEqual(parseEnv(envText), { ...originalValues, ...required }, '合并会改变非目标配置项，已停止')

  const mission = config.missionExe ?? join(target, 'afsim/Release/mission.exe')
  if (!existsSync(mission) || !lstatSync(mission).isFile()) throw new Error(`目标 mission.exe 不存在：${mission}`)
  const iniPath = join(dirname(mission), 'CalcConfig.ini')
  const iniBefore = readConfiguration(iniPath)
  const fallback = new URL(deployment.apiAccessEnv(config).realUrl)
  const explicit = process.env.LINK_ENGINE_WS_URL ?? originalValues.LINK_ENGINE_WS_URL
  const endpoint = explicit?.trim() ? new URL(explicit.trim()) : fallback
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('LINK_ENGINE_WS_URL 必须为 ws/wss 地址；原值未修改。')
  const local = endpoint.hostname === config.deployHost || endpoint.hostname === 'localhost' || /^127\./.test(endpoint.hostname)
  if (local && endpoint.protocol === 'ws:' && endpoint.search) throw new Error('本机 LinkCalc 地址不支持查询参数；原值未修改。')
  const defaults = local && endpoint.protocol === 'ws:' ? endpoint : fallback
  const values = { wsip: defaults.hostname === 'localhost' ? '127.0.0.1' : defaults.hostname, wsport: defaults.port || '80', wspath: defaults.pathname }
  // latin1 往返保持原 INI 的 GBK/UTF-8 注释字节，只补缺项，不覆盖校准参数。
  let iniText = iniBefore?.toString('latin1') ?? readFileSync(join(templates, 'CalcConfig.ini.template'), 'latin1')
    .replace('{{WSIP}}', values.wsip).replace('{{WSPORT}}', values.wsport).replace('{{WSPATH}}', values.wspath)
  for (const [key, value] of Object.entries({ ...values, frame_rate: '5' })) {
    iniText = replaceAtom(iniText, key, value, false)
    const match = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*([^ \\t\\r\\n#;]+)[ \\t]*(?:[#;][^\\r\\n]*)?\\r?$`, 'gm')
    if ([...iniText.matchAll(match)].length !== 1) throw new Error(`CalcConfig.ini 的 ${key} 为空或格式非法；原值未修改。`)
  }
  return [
    { path: envPath, label: 'frontend/.env.local', before: envBefore, after: Buffer.from(envText, 'utf8') },
    { path: iniPath, label: 'mission/CalcConfig.ini', before: iniBefore, after: Buffer.from(iniText, 'latin1') },
  ]
}

export function backupConfiguration(plan, backup) {
  const folder = join(backup, 'configuration')
  mkdirSync(folder)
  const records = plan.map((entry, index) => {
    assert.ok(equal(read(entry.path), entry.before), `配置在检查后发生变化：${entry.path}`)
    const file = entry.before === null ? null : `${index}.original`
    if (file) writeFileSync(join(folder, file), entry.before, { flag: 'wx' })
    return { path: entry.path, label: entry.label, file, beforeHash: entry.before === null ? null : hash(entry.before), afterHash: hash(entry.after) }
  })
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(records, null, 2) + '\n', { flag: 'wx' })
}

function atomicWrite(path, bytes) {
  const pending = `${path}.v10-${randomUUID()}.tmp`
  try {
    writeFileSync(pending, bytes, { flag: 'wx' })
    renameSync(pending, path)
  } finally { rmSync(pending, { force: true }) }
}

export function applyConfiguration(plan) {
  for (const entry of plan) assert.ok(equal(read(entry.path), entry.before), `配置在备份后发生变化：${entry.path}`)
  const applied = []
  try {
    for (const entry of plan) {
      if (equal(entry.before, entry.after)) continue
      atomicWrite(entry.path, entry.after)
      applied.push(entry)
      console.log(`已合并配置：${entry.path}`)
    }
  } catch (error) {
    const failures = []
    for (const entry of applied.reverse()) {
      try {
        assert.ok(equal(read(entry.path), entry.after), '配置已被其他程序修改')
        if (entry.before === null) rmSync(entry.path)
        else atomicWrite(entry.path, entry.before)
      } catch (rollbackError) { failures.push(`${entry.path}：${rollbackError.message}`) }
    }
    throw new Error(`配置合并失败：${error.message}。${failures.length ? '部分配置恢复失败，请使用 configuration 备份手工恢复：' + failures.join('；') : '本次已写配置已恢复；原代码备份请保留。'}`)
  }
}

/** 复制覆盖后的首次启动迁移一次；后续启动保留用户再次调整的开关。 */
export async function upgradeDeploymentConfigV10(root) {
  const marker = join(root, '.wrj-config-v10.json')
  if (existsSync(marker)) {
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).version, 10, 'v10 配置迁移记录损坏，请核对后再启动')
    return undefined
  }
  const templates = fileURLToPath(new URL('./deployment/config-v10/', import.meta.url))
  const plan = await prepareConfiguration(root, templates)
  const backup = mkdtempSync(join(root, 'config-backup-v10-'))
  try {
    backupConfiguration(plan, backup)
    applyConfiguration(plan)
    atomicWrite(marker, Buffer.from(JSON.stringify({ version: 10, backup }, null, 2) + '\n'))
    return backup
  } catch (error) {
    throw new Error(`v10 配置升级未完成，已停止启动；原配置备份：${backup}。${error.message}`)
  }
}
