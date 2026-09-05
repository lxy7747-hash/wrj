import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(join(root, 'output'), { recursive: true })
const evidence = mkdtempSync(join(root, 'output', 'p8-'))
const npm = process.env.npm_execpath
if (!npm) throw new Error('请通过 npm run release:check 启动验收。')

/** 记录所有 Git 源文件（含未提交的新文件）的哈希，不读取已忽略的地图和输出。 */
function sourceHashes() {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  return Object.fromEntries(paths.sort().map((path) => [path, existsSync(join(root, path))
    ? createHash('sha256').update(readFileSync(join(root, path))).digest('hex') : 'DELETED']))
}

const manifest = {
  scope: '前端与本机 Node.js Mock 集成验收，不代表用户验收或真实服务上线',
  startedAt: new Date().toISOString(),
  node: process.version, platform: process.platform,
  baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }),
  sourceHashes: sourceHashes(),
  steps: [],
  status: 'RUNNING',
}

/** 串行执行已安装工具，保存完整日志；失败保留证据并阻断发布。 */
async function check(script, args = []) {
  const log = join(evidence, `${script.replaceAll(':', '-')}.log`)
  console.log(`检查 ${script}`)
  const result = await new Promise((resolveResult) => {
    let output = ''
    const child = spawn(process.execPath, [npm, 'run', script, '--', ...args], {
      cwd: root,
      env: { ...process.env, CI: 'true', PLAYWRIGHT_JSON_OUTPUT_NAME: join(evidence, 'playwright.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', (error) => { output += `\n${error.message}` })
    child.once('close', (code) => { writeFileSync(log, output); resolveResult(code ?? 1) })
  })
  manifest.steps.push({ script, args, exitCode: result, log })
  if (result !== 0) throw new Error(`${script} 未通过，请查看 ${log}`)
}

try {
  await check('typecheck')
  await check('build')
  await check('validate:contracts')
  // 覆盖率命令已执行全部组件、Store、合同、HTTP/WS 测试，不重复执行同一套用例。
  await check('test:coverage', ['--coverage.reportsDirectory=' + join(evidence, 'coverage'), '--coverage.reporter=text', '--coverage.reporter=json-summary'])
  await check('test:e2e', ['--reporter=list,json', '--output=' + join(evidence, 'browser')])
  if (JSON.stringify(sourceHashes()) !== JSON.stringify(manifest.sourceHashes)) throw new Error('验收期间源码发生变化，请重新执行。')
  manifest.status = 'PASS'
} catch (error) {
  manifest.status = 'FAIL'
  manifest.failure = error.message
  console.error(error.message)
  process.exitCode = 1
} finally {
  manifest.finishedAt = new Date().toISOString()
  writeFileSync(join(evidence, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`验收证据：${evidence}（${manifest.status}）`)
}
