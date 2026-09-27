import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { runStep } from './release-check-step.mjs'

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
const interrupted = new AbortController()
const onInterrupt = () => interrupted.abort()
process.once('SIGINT', onInterrupt)
process.once('SIGTERM', onInterrupt)
const stepTimeouts = {
  typecheck: 180_000,
  build: 180_000,
  'validate:contracts': 120_000,
  'test:coverage': 900_000,
  'test:e2e': 1_200_000,
}

/** 串行执行已安装工具，保存完整日志；失败保留证据并阻断发布。 */
async function check(script, args = []) {
  const log = join(evidence, `${script.replaceAll(':', '-')}.log`)
  console.log(`检查 ${script}`)
  const result = await runStep(process.execPath, [npm, 'run', script, '--', ...args], {
    cwd: root,
    env: { ...process.env, CI: 'true', PLAYWRIGHT_JSON_OUTPUT_NAME: join(evidence, 'playwright.json') },
    timeoutMs: stepTimeouts[script],
    signal: interrupted.signal,
  })
  writeFileSync(log, result.output)
  manifest.steps.push({ script, args, exitCode: result.exitCode, ...(result.reason ? { reason: result.reason } : {}), log })
  if (result.exitCode !== 0) throw new Error(`${script} ${result.reason === 'timeout' ? '超时' : result.reason === 'interrupted' ? '已中断' : '未通过'}，请查看 ${log}`)
}

try {
  await check('typecheck')
  await check('build')
  await check('validate:contracts')
  // 覆盖率命令已执行全部组件、Store、合同、HTTP/WS 测试，不重复执行同一套用例。
  await check('test:coverage', ['--coverage.reportsDirectory=' + join(evidence, 'coverage'), '--coverage.reporter=text', '--coverage.reporter=json-summary'])
  await check('test:e2e', ['--reporter=list,json', '--output=' + join(evidence, 'browser')])
  if (interrupted.signal.aborted) throw new Error('验收已中断。')
  if (JSON.stringify(sourceHashes()) !== JSON.stringify(manifest.sourceHashes)) throw new Error('验收期间源码发生变化，请重新执行。')
  if (interrupted.signal.aborted) throw new Error('验收已中断。')
  manifest.status = 'PASS'
} catch (error) {
  manifest.status = 'FAIL'
  manifest.failure = error.message
  console.error(error.message)
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', onInterrupt)
  process.removeListener('SIGTERM', onInterrupt)
  manifest.finishedAt = new Date().toISOString()
  writeFileSync(join(evidence, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`验收证据：${evidence}（${manifest.status}）`)
}
