// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { mkdtemp, mkdir, readFile, readdir, rm, writeFile } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { dirname, join, resolve } = await import('node:' + 'path')
const { parseEnv } = await import('node:' + 'util')
const { Buffer } = await import('node:' + 'buffer')
const { upgradeDeploymentConfigV10 } = await import('../../scripts/' + 'deployment-config-upgrade-v10.mjs')

let root: string
const env = '\uFEFF# 原有配置\r\nuseRealEngine=false\r\nWRJ_LINK_CALC_MODE=stub\r\nrealUrl=ws://192.168.1.48:8080/ws/v1\r\nMISSION_EXECUTABLE_PATH=D:/部署机路径/mission.exe\r\nCUSTOM_VALUE="keep # value"\r\n'
const deployment = 'LISTEN_HOST=0.0.0.0\nDEPLOY_HOST=192.168.1.18\nUI_PORT=5173\nAPI_PORT=4173\nMAP_PORT=4174\n'
const ini = Buffer.concat([Buffer.from([0x23, 0xb2, 0xe2, 13, 10]), Buffer.from('wsip=127.0.0.1\r\nwsport=9090\r\nwspath=/custom\r\nframe_rate=17\r\ncalibration=2.5\r\n')])
const put = async (path: string, content: string | Uint8Array) => {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wrj-config-startup-'))
  await put('frontend/.env.local', env)
  await put('deployment.env', deployment)
  await put('afsim/Release/mission.exe', 'native binary unchanged')
  await put('afsim/Release/CalcConfig.ini', ini)
  await put('data/scenarios.db', 'database unchanged')
})

afterEach(async () => {
  expect(dirname(root)).toBe(resolve(tmpdir()))
  expect(root).toContain('wrj-config-startup-')
  await rm(root, { recursive: true, force: true })
})

describe('复制覆盖后的首次启动配置升级', () => {
  it('自动备份并合并两项开关，保留部署地址/路径/GBK 注释/校准，数据库不变', async () => {
    const backup = await upgradeDeploymentConfigV10(root)
    expect(backup).toContain('config-backup-v10-')
    expect(await readFile(join(backup, 'configuration/0.original'), 'utf8')).toBe(env)
    expect(await readFile(join(backup, 'configuration/1.original'))).toEqual(ini)
    const updated = await readFile(join(root, 'frontend/.env.local'), 'utf8')
    expect(updated.startsWith('\uFEFF')).toBe(false)
    expect(parseEnv(updated)).toEqual({ ...parseEnv(env.replace(/^\uFEFF/, '')), useRealEngine: 'true', WRJ_LINK_CALC_MODE: 'auto' })
    expect(await readFile(join(root, 'deployment.env'), 'utf8')).toBe(deployment)
    expect(await readFile(join(root, 'afsim/Release/CalcConfig.ini'))).toEqual(ini)
    expect(await readFile(join(root, 'afsim/Release/mission.exe'), 'utf8')).toBe('native binary unchanged')
    expect(await readFile(join(root, 'data/scenarios.db'), 'utf8')).toBe('database unchanged')
    expect(JSON.parse(await readFile(join(root, '.wrj-config-v10.json'), 'utf8'))).toEqual({ version: 10, backup })
  })

  it('后续启动不重复迁移，不覆盖用户之后主动调整的开关或参数', async () => {
    await upgradeDeploymentConfigV10(root)
    const changed = 'useRealEngine=false\nWRJ_LINK_CALC_MODE=stub\nNEW_SETTING=keep\n'
    await put('frontend/.env.local', changed)
    expect(await upgradeDeploymentConfigV10(root)).toBeUndefined()
    expect(await readFile(join(root, 'frontend/.env.local'), 'utf8')).toBe(changed)
    expect((await readdir(root)).filter((name: string) => name.startsWith('config-backup-v10-'))).toHaveLength(1)
  })

  it('缺少配置时使用模板，按自定义 mission 目录补齐，不覆盖默认目录的原 INI', async () => {
    const mission = join(root, 'custom engine/mission.exe')
    await put('custom engine/mission.exe', 'custom binary')
    await put('deployment.env', deployment + `MISSION_EXE_PATH=${mission}\n`)
    await rm(join(root, 'frontend/.env.local'))
    await upgradeDeploymentConfigV10(root)
    const created = await readFile(join(root, 'custom engine/CalcConfig.ini'), 'utf8')
    expect(created).toContain('wsip=192.168.1.18')
    expect(created).toContain('wsport=8080')
    expect(created).toContain('frame_rate=5')
    expect(created).not.toContain('{{')
    expect(await readFile(join(root, 'afsim/Release/CalcConfig.ini'))).toEqual(ini)
    expect(parseEnv(await readFile(join(root, 'frontend/.env.local'), 'utf8'))).toEqual({ useRealEngine: 'true', WRJ_LINK_CALC_MODE: 'auto' })
  })

  it('缺少 deployment.env 继续使用本机默认值，不新增部署配置', async () => {
    await rm(join(root, 'deployment.env'))
    await rm(join(root, 'afsim/Release/CalcConfig.ini'))
    await upgradeDeploymentConfigV10(root)
    expect(await readFile(join(root, 'afsim/Release/CalcConfig.ini'), 'utf8')).toContain('wsip=127.0.0.1')
    expect(await readdir(root)).not.toContain('deployment.env')
  })

  it('重复配置在写入前拒绝，不标记完成；修正后可正常重试', async () => {
    const invalid = env + 'useRealEngine=true\n'
    await put('frontend/.env.local', invalid)
    await expect(upgradeDeploymentConfigV10(root)).rejects.toThrow('配置项 useRealEngine 重复')
    expect(await readFile(join(root, 'frontend/.env.local'), 'utf8')).toBe(invalid)
    expect(await readdir(root)).not.toContain('.wrj-config-v10.json')
    expect((await readdir(root)).filter((name: string) => name.startsWith('config-backup-v10-'))).toHaveLength(0)
    await put('frontend/.env.local', env)
    await expect(upgradeDeploymentConfigV10(root)).resolves.toContain('config-backup-v10-')
  })

  it('配置迁移记录损坏时拒绝启动，不当作迁移成功', async () => {
    await put('.wrj-config-v10.json', '{"version":9}')
    await expect(upgradeDeploymentConfigV10(root)).rejects.toThrow('配置迁移记录损坏')
    expect(await readFile(join(root, 'frontend/.env.local'), 'utf8')).toBe(env)
  })
})
