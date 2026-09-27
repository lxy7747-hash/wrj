// @vitest-environment node
import { expect, it } from 'vitest'
const { runStep } = await import('../../scripts/' + 'release-check-step.mjs')
const { default: process } = await import('node:' + 'process')
const { mkdtempSync, readFileSync, rmSync } = await import('node:' + 'fs')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')

it('启动失败时返回错误并结束步骤', async () => {
  const result = await runStep(`wrj-missing-command-${process.pid}`, [], {
    timeoutMs: 1000,
    cwd: process.cwd(),
    env: process.env,
  })
  expect(result.exitCode).not.toBe(0)
  expect(result.output).toContain('ENOENT')
})

it('超时终止挂起子进程并返回失败原因与日志', async () => {
  const start = performance.now()
  const result = await runStep(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 150,
    cwd: process.cwd(),
    env: process.env,
  })
  expect(result).toMatchObject({ exitCode: 1, reason: 'timeout', output: expect.stringContaining('检查超时') })
  expect(performance.now() - start).toBeLessThan(5000)
  expect(() => process.kill(result.pid!, 0)).toThrow()
})

it('中断同样终止子进程，避免残留验收步骤', async () => {
  const controller = new AbortController()
  const pending = runStep(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 5000,
    signal: controller.signal,
    cwd: process.cwd(),
    env: process.env,
  })
  controller.abort()
  const result = await pending
  expect(result).toMatchObject({ exitCode: 1, reason: 'interrupted', output: expect.stringContaining('检查中断') })
  expect(() => process.kill(result.pid!, 0)).toThrow()
})

it('超时时终止步骤创建的后代进程', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wrj-release-step-'))
  const pidFile = join(directory, 'child.pid')
  const source = `
    const { spawn } = require('node:child_process')
    const { writeFileSync } = require('node:fs')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    writeFileSync(process.argv[1], String(child.pid))
    setInterval(() => {}, 1000)
  `
  try {
    const result = await runStep(process.execPath, ['-e', source, pidFile], {
      timeoutMs: 500,
      cwd: process.cwd(),
      env: process.env,
    })
    const descendantPid = Number(readFileSync(pidFile, 'utf8'))
    expect(result.reason).toBe('timeout')
    expect(() => process.kill(descendantPid, 0)).toThrow()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
