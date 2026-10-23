// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const { EventEmitter } = await import('node:' + 'events')
const { createConnection, createServer } = await import('node:' + 'net')
const fs = await import('node:' + 'fs/promises')
const { mkdtemp, mkdir, readFile, rm, writeFile } = fs
const { tmpdir } = await import('node:' + 'os')
const { join, resolve } = await import('node:' + 'path')
const { setTimeout: delay } = await import('node:' + 'timers/promises')
const { default: nodeProcess } = await import('node:' + 'process')
const { runBackgroundCommand, backgroundStatus, startBackground, stopBackground } = await import('../../scripts/' + 'deploy-background.mjs')
const scriptPath = resolve('scripts/deploy-background.mjs')
const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wrj-background-unit-'))
  roots.push(root)
  await mkdir(join(root, 'app', 'scripts'), { recursive: true })
  await writeFile(join(root, 'app', '.env.server'), 'WRJ_PUBLIC_ORIGIN=http://127.0.0.1:4173\n', 'utf8')
  await writeFile(join(root, 'app', 'scripts', 'start-lan.mjs'), '// child process is mocked by this suite\n', 'utf8')
  return root
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeout = 2_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await delay(10)
  }
  throw new Error('Timed out waiting for controlled background launcher state.')
}

type LauncherState = { channel: string; token: string; phase: string; servicePid?: number; error?: string }

function observeLauncherState(root: string) {
  const destination = join(root, 'logs', 'deploy-background.state.json')
  const states: LauncherState[] = []
  const observers: Array<(state: LauncherState) => void> = []
  // Observe completed real writes, rather than racing Windows atomic rename with file polling.
  vi.doMock('node:fs/promises', () => ({
    ...fs,
    rename: async (from: string, to: string) => {
      const state = to === destination ? JSON.parse(await readFile(from, 'utf8')) as LauncherState : undefined
      await fs.rename(from, to)
      if (state) {
        states.push(state)
        for (const notify of observers) notify(state)
      }
    },
  }))
  return (predicate: (state: LauncherState) => boolean) => {
    const existing = states.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise<LauncherState>(resolveState => {
      observers.push(state => { if (predicate(state)) resolveState(state) })
    })
  }
}

function observeLauncherExit() {
  let resolveExit!: (code: number | undefined) => void
  const completed = new Promise<number | undefined>(resolve => { resolveExit = resolve })
  const exit = vi.spyOn(nodeProcess, 'exit').mockImplementation(((code?: number) => resolveExit(code)) as never)
  return { exit, completed }
}

async function sendControl(channel: string, message: object) {
  return new Promise<unknown>((resolveReply, rejectReply) => {
    let text = ''
    const socket = createConnection(channel)
    socket.setEncoding('utf8')
    socket.once('error', rejectReply)
    socket.on('data', (chunk: string) => {
      text += chunk
      const newline = text.indexOf('\n')
      if (newline < 0) return
      socket.end()
      resolveReply(JSON.parse(text.slice(0, newline)))
    })
    socket.once('connect', () => socket.write(`${JSON.stringify(message)}\n`))
  })
}

let cliImportSequence = 0

async function loadCliModule() {
  cliImportSequence += 1
  if (cliImportSequence === 1) return import('../../scripts/' + 'deploy-background.mjs?cli-unit-1')
  if (cliImportSequence === 2) return import('../../scripts/' + 'deploy-background.mjs?cli-unit-2')
  if (cliImportSequence === 3) return import('../../scripts/' + 'deploy-background.mjs?cli-unit-3')
  if (cliImportSequence === 4) return import('../../scripts/' + 'deploy-background.mjs?cli-unit-4')
  if (cliImportSequence === 5) return import('../../scripts/' + 'deploy-background.mjs?cli-unit-5')
  throw new Error('This test suite needs another statically declared CLI import.')
}

async function importAsCli(arguments_: string[]) {
  const previousArgv = nodeProcess.argv
  nodeProcess.argv = [nodeProcess.execPath, scriptPath, ...arguments_]
  try {
    await loadCliModule()
  } finally {
    nodeProcess.argv = previousArgv
  }
}

function signalListeners(): { sigint: Set<unknown>; sigterm: Set<unknown> } {
  return {
    sigint: new Set(nodeProcess.listeners('SIGINT') as unknown[]),
    sigterm: new Set(nodeProcess.listeners('SIGTERM') as unknown[]),
  }
}

function removeAddedSignalListeners(baseline: { sigint: Set<unknown>; sigterm: Set<unknown> }) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const expected = signal === 'SIGINT' ? baseline.sigint : baseline.sigterm
    for (const listener of nodeProcess.listeners(signal) as unknown[]) {
      if (!expected.has(listener)) nodeProcess.off(signal, listener as never)
    }
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.doUnmock('node:child_process')
  vi.doUnmock('node:fs/promises')
  vi.doUnmock('node:timers/promises')
  vi.resetModules()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('deployment background controller in-process coverage', () => {
  it('routes the supported command API and rejects invalid commands before any deployment work', async () => {
    const root = await fixture()
    await expect(runBackgroundCommand('status', { root })).resolves.toEqual({ running: false, phase: 'stopped' })
    await expect(runBackgroundCommand('stop', { root })).resolves.toEqual({ alreadyStopped: true })
    await expect(runBackgroundCommand('restart', { root })).rejects.toThrow(/Usage: deploy-background/i)
    await expect(startBackground(root, { runtimeNode: join(root, 'runtime', 'missing-node') })).rejects.toThrow(/Deployment file is missing/i)
  })

  it('fails closed for an owned controller that rejects the state credential', async () => {
    const root = await fixture()
    const channel = nodeProcess.platform === 'win32'
      ? `\\\\.\\pipe\\wrj-background-unit-${nodeProcess.pid}-${Date.now()}`
      : join(root, 'logs', 'controlled.sock')
    await mkdir(join(root, 'logs'), { recursive: true })
    const server = createServer((socket: any) => {
      socket.once('data', () => socket.end(`${JSON.stringify({ ok: false, error: 'invalid token' })}\n`))
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(channel, resolveListen)
    })
    try {
      await writeFile(join(root, 'logs', 'deploy-background.state.json'), JSON.stringify({
        root, token: 'controller-secret', channel, pid: nodeProcess.pid, phase: 'ready',
      }), 'utf8')
      await expect(backgroundStatus(root)).resolves.toMatchObject({
        running: true,
        phase: 'unknown',
        error: expect.stringMatching(/could not be authenticated/i),
      })
      await expect(startBackground(root, { runtimeNode: nodeProcess.execPath })).rejects.toThrow(/still stopping/i)
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    }
  })

  it('runs the CLI launcher in this process, enforces control credentials, and clears state after shutdown', async () => {
    const root = await fixture()
    const baselineSignals = signalListeners()
    const { exit, completed } = observeLauncherExit()
    const stateWritten = observeLauncherState(root)
    const browser = { unref: vi.fn() }
    const child = Object.assign(new EventEmitter(), {
      pid: 41_001,
      exitCode: null as number | null,
      signalCode: null as string | null,
      connected: true,
      send: vi.fn(() => setTimeout(() => {
        child.exitCode = 0
        child.emit('exit', 0)
      }, 0)),
    })
    const spawn = vi.fn((executable: string) => {
      if (executable === 'rundll32.exe') return browser
      return child
    })
    vi.doMock('node:child_process', () => ({ spawn }))
    try {
      await importAsCli(['serve', '--root', root, '--runtime-node', nodeProcess.execPath])
      await stateWritten(state => state.phase === 'starting' && state.servicePid === child.pid)
      child.emit('message', { type: 'ready' })
      const state = await stateWritten(state => state.phase === 'ready')
      await expect(sendControl(state.channel, { type: 'status', token: 'wrong-token' })).resolves.toEqual({ ok: false, error: 'invalid token' })
      await expect(sendControl(state.channel, { type: 'not-supported', token: state.token })).resolves.toEqual({ ok: false })
      await expect(backgroundStatus(root)).resolves.toMatchObject({ running: true, phase: 'ready', servicePid: 41_001 })
      const controller = await import('../../scripts/' + 'deploy-background.mjs?cli-unit-1')
      await expect(controller.runBackgroundCommand('start', { root, runtimeNode: nodeProcess.execPath, open: true }))
        .resolves.toMatchObject({ alreadyRunning: true, origin: 'http://127.0.0.1:4173' })
      if (nodeProcess.platform === 'win32') {
        expect(spawn).toHaveBeenCalledWith('rundll32.exe', ['url.dll,FileProtocolHandler', 'http://127.0.0.1:4173'],
          expect.objectContaining({ windowsHide: true, shell: false }))
        expect(browser.unref).toHaveBeenCalledOnce()
      }
      await expect(stopBackground(root)).resolves.toEqual({ alreadyStopped: false })
      await expect(backgroundStatus(root)).resolves.toEqual({ running: false, phase: 'stopped' })
      await expect(completed).resolves.toBe(0)
      expect(child.send).toHaveBeenCalledWith({ type: 'shutdown' })
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      removeAddedSignalListeners(baselineSignals)
    }
  })

  it('retains and reports a service startup failure until an authenticated shutdown closes it', async () => {
    const root = await fixture()
    const baselineSignals = signalListeners()
    const { exit, completed } = observeLauncherExit()
    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => {
        const child = Object.assign(new EventEmitter(), {
          pid: 41_002,
          exitCode: null as number | null,
          signalCode: null as string | null,
          connected: true,
          send: vi.fn(() => setTimeout(() => {
            child.exitCode = 1
            child.emit('exit', 1)
          }, 0)),
        })
        setTimeout(() => child.emit('error', new Error('controlled startup error')), 0)
        return child
      }),
    }))
    try {
      await importAsCli(['serve', '--root', root, '--runtime-node', nodeProcess.execPath])
      await waitFor(async () => {
        try {
          const log = await readFile(join(root, 'logs', 'background.log'), 'utf8')
          return log.includes('controlled startup error') ? true : undefined
        } catch {
          return undefined
        }
      })
      await expect(backgroundStatus(root)).resolves.toMatchObject({ running: true, phase: 'failed', error: expect.stringMatching(/controlled startup error/i) })
      await expect(stopBackground(root)).resolves.toEqual({ alreadyStopped: false })
      await expect(backgroundStatus(root)).resolves.toEqual({ running: false, phase: 'stopped' })
      await expect(completed).resolves.toBe(0)
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      removeAddedSignalListeners(baselineSignals)
    }
  })

  it('executes CLI parsing for status and malformed options without launching a service', async () => {
    const root = await fixture()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const previousExitCode = nodeProcess.exitCode
    nodeProcess.exitCode = undefined
    try {
      await importAsCli(['status', '--root', root])
      await waitFor(async () => log.mock.calls.length > 0 ? true : undefined)
      expect(log).toHaveBeenCalledWith('WRJ background service: stopped')
      await importAsCli(['status', '--unknown-option'])
      await waitFor(async () => error.mock.calls.length > 0 ? true : undefined)
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/Unknown argument: --unknown-option/))
      expect(nodeProcess.exitCode).toBe(1)
    } finally {
      nodeProcess.exitCode = previousExitCode
    }
  })

  it('retains ownership when graceful shutdown has no exit evidence, then clears state only after exit', async () => {
    const root = await fixture()
    const baselineSignals = signalListeners()
    const { exit, completed } = observeLauncherExit()
    const stateWritten = observeLauncherState(root)
    const child = Object.assign(new EventEmitter(), {
      pid: 41_003, exitCode: null as number | null, signalCode: null, connected: true,
      send: vi.fn(), kill: vi.fn(),
    })
    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => child),
    }))
    // Only the launcher's shutdown deadline is controlled; socket/file completion still uses real events.
    vi.doMock('node:timers/promises', () => ({ setTimeout: (ms: number) => ms === 20_000 ? Promise.resolve() : delay(ms) }))
    try {
      await importAsCli(['serve', '--root', root, '--runtime-node', nodeProcess.execPath])
      await stateWritten(state => state.phase === 'starting' && state.servicePid === child.pid)
      child.emit('message', { type: 'ready' })
      const state = await stateWritten(state => state.phase === 'ready')
      await expect(sendControl(state.channel, { type: 'shutdown', token: state.token })).resolves.toEqual({ ok: true })
      await stateWritten(state => state.phase === 'stopping' && !!state.error)
      await expect(backgroundStatus(root)).resolves.toMatchObject({ running: true, phase: 'stopping', error: expect.stringContaining('ownership state') })
      expect(child.send).toHaveBeenCalledExactlyOnceWith({ type: 'shutdown' })
      expect(child.kill).not.toHaveBeenCalled()
      expect(exit).not.toHaveBeenCalled()
      child.exitCode = 0
      child.emit('exit', 0)
      await expect(completed).resolves.toBe(0)
      await expect(backgroundStatus(root)).resolves.toEqual({ running: false, phase: 'stopped' })
      expect(exit).toHaveBeenCalledWith(0)
    } finally {
      removeAddedSignalListeners(baselineSignals)
    }
  })
})
