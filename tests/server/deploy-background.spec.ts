// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'

const { mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { spawn } = await import('node:' + 'child_process')
const { setTimeout: delay } = await import('node:' + 'timers/promises')
const { default: nodeProcess } = await import('node:' + 'process')
const { startBackground, stopBackground, backgroundStatus } = await import('../../scripts/' + 'deploy-background.mjs')

const roots: string[] = []

async function fixture({ fail = false, readyDelay = 0, customPaths = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wrj background 中文 space '))
  roots.push(root)
  await mkdir(join(root, 'app', 'scripts'), { recursive: true })
  await writeFile(join(root, 'app', '.env.server'), `WRJ_PUBLIC_ORIGIN="http://127.0.0.1:4173" # browser entry\nSTUB_READY_DELAY=${readyDelay}\n${customPaths ? 'WRJ_OUTPUT_ROOT=C:\\configured output\nAFSIM_POSITION_LOG_PATH=\n' : ''}${fail ? 'STUB_FAIL=1\n' : ''}`)
  await writeFile(join(root, 'app', 'scripts', 'start-lan.mjs'), `
import { writeFile } from 'node:fs/promises'
if (process.env.STUB_FAIL === '1') process.exit(23)
await writeFile(new URL('../observed-env.json', import.meta.url), JSON.stringify({ output: process.env.WRJ_OUTPUT_ROOT, position: process.env.AFSIM_POSITION_LOG_PATH }))
setTimeout(() => process.send?.({ type: 'ready' }), Number(process.env.STUB_READY_DELAY || 0))
process.on('message', message => {
  if (message?.type === 'shutdown') process.exit(0)
})
setInterval(() => {}, 1_000)
`, 'utf8')
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await stopBackground(root).catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

describe('deployment background controller', () => {
  it('starts once, reports own IPC readiness, and stops through the launcher', async () => {
    const root = await fixture()
    const first = await startBackground(root, { runtimeNode: nodeProcess.execPath })
    const second = await startBackground(root, { runtimeNode: nodeProcess.execPath })
    expect(first).toMatchObject({ alreadyRunning: false, origin: 'http://127.0.0.1:4173' })
    expect(second).toMatchObject({ alreadyRunning: true, origin: 'http://127.0.0.1:4173' })
    await expect(backgroundStatus(root)).resolves.toMatchObject({ running: true, phase: 'ready' })
    await expect(readFile(join(root, 'logs', 'background.log'), 'utf8')).resolves.toBeDefined()
    await expect(stopBackground(root)).resolves.toEqual({ alreadyStopped: false })
    await expect(stopBackground(root)).resolves.toEqual({ alreadyStopped: true })
  })

  it('preserves explicit deployment path overrides from .env.server', async () => {
    const root = await fixture({ customPaths: true })
    await startBackground(root, { runtimeNode: nodeProcess.execPath })
    const observed = JSON.parse(await readFile(join(root, 'app', 'observed-env.json'), 'utf8'))
    expect(observed).toEqual({ output: 'C:\\configured output', position: '' })
  })

  it('stopping this controller does not affect an unrelated Node process', async () => {
    const root = await fixture()
    const sentinel = spawn(nodeProcess.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await startBackground(root, { runtimeNode: nodeProcess.execPath })
      await stopBackground(root)
      expect(sentinel.exitCode).toBeNull()
    } finally {
      sentinel.kill()
    }
  })

  it('reclaims only a demonstrably dead stale state with an invalid token', async () => {
    const root = await fixture()
    await mkdir(join(root, 'logs'), { recursive: true })
    await writeFile(join(root, 'logs', 'deploy-background.state.json'), JSON.stringify({
      version: 1, root, token: 'invalid-token', channel: join(root, 'logs', 'missing.sock'), pid: 999_999_999, phase: 'ready',
    }))
    await expect(backgroundStatus(root)).resolves.toEqual({ running: false, phase: 'stopped' })
    await expect(readFile(join(root, 'logs', 'deploy-background.state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when an unreachable state still belongs to a live process', async () => {
    const root = await fixture()
    const sentinel = spawn(nodeProcess.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await mkdir(join(root, 'logs'), { recursive: true })
      await writeFile(join(root, 'logs', 'deploy-background.state.json'), JSON.stringify({
        version: 1, root, token: 'invalid-token', channel: join(root, 'logs', 'missing.sock'), pid: sentinel.pid, phase: 'ready',
      }))
      await expect(startBackground(root, { runtimeNode: nodeProcess.execPath })).rejects.toThrow(/still stopping/i)
      expect(sentinel.exitCode).toBeNull()
    } finally {
      sentinel.kill()
    }
  })

  it('reports launcher startup failure without starting a second service', async () => {
    const root = await fixture({ fail: true })
    await expect(startBackground(root, { runtimeNode: nodeProcess.execPath })).rejects.toThrow(/startup failed|exited/i)
    await expect(backgroundStatus(root)).resolves.toMatchObject({ running: true, phase: 'failed' })
  })

  it('does not spawn a service after a stop arrives during startup', async () => {
    const root = await fixture({ readyDelay: 1_000 })
    const starting = startBackground(root, { runtimeNode: nodeProcess.execPath })
    const startupResult = starting.then(() => undefined, (error: unknown) => error)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await backgroundStatus(root)).running) break
      await delay(25)
    }
    await expect(stopBackground(root)).resolves.toEqual({ alreadyStopped: false })
    await expect(startupResult).resolves.toMatchObject({ message: expect.stringMatching(/ended before the service became ready/i) })
    await expect(backgroundStatus(root)).resolves.toEqual({ running: false, phase: 'stopped' })
  })
})
