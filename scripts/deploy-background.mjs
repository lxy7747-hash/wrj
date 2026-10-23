import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { access, appendFile, mkdir, open as openFile, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { parseEnv } from 'node:util'

const STATE_FILE = 'deploy-background.state.json'
const LOCK_FILE = 'deploy-background.start.lock'
const LOG_FILE = 'background.log'
const CONTROL_TIMEOUT_MS = 2_000
const READY_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 20_000
const FAILURE_RETENTION_MS = 5_000

function token() { return randomBytes(24).toString('hex') }
function logs(root) { return join(root, 'logs') }
function statePath(root) { return join(logs(root), STATE_FILE) }
function lockPath(root) { return join(logs(root), LOCK_FILE) }
function defaultRoot() { return dirname(dirname(fileURLToPath(import.meta.url))) }

async function ensureLogs(root) { await mkdir(logs(root), { recursive: true }) }

async function log(root, message) {
  await ensureLogs(root)
  await appendFile(join(logs(root), LOG_FILE), `${new Date().toISOString()} ${message}\n`, 'utf8')
}

function parseArgs(values) {
  const [command, ...rest] = values
  const options = { command, root: undefined, runtimeNode: undefined, openBrowser: false }
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value === '--open-browser') options.openBrowser = true
    else if (value === '--root') options.root = rest[++index]
    else if (value === '--runtime-node') options.runtimeNode = rest[++index]
    else throw new Error(`Unknown argument: ${value}`)
  }
  return options
}

function controlPath(root, value) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\wrj-background-${value}`
  return join(logs(root), `wrj-background-${value}.sock`)
}

async function readState(root) {
  try {
    const state = JSON.parse(await readFile(statePath(root), 'utf8'))
    if (!state || typeof state !== 'object' || state.root !== root || typeof state.token !== 'string'
      || typeof state.channel !== 'string' || typeof state.phase !== 'string') return null
    return state
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

async function writeState(root, state) {
  await ensureLogs(root)
  const destination = statePath(root)
  const temporary = `${destination}.${token()}.tmp`
  await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, destination)
}

async function removeState(root, expectedToken) {
  const state = await readState(root)
  if (!state || (expectedToken && state.token !== expectedToken)) return
  await rm(statePath(root), { force: true })
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

async function requestControl(state, message) {
  return new Promise((resolve, reject) => {
    let settled = false
    let text = ''
    const socket = createConnection(state.channel)
    const settle = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      callback(value)
    }
    const timeout = setTimeout(() => settle(reject, new Error('Background control request timed out.')), CONTROL_TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.once('error', error => settle(reject, error))
    socket.on('data', chunk => {
      text += chunk
      const newline = text.indexOf('\n')
      if (newline < 0) return
      try { settle(resolve, JSON.parse(text.slice(0, newline))) }
      catch { settle(reject, new Error('Background control response was invalid.')) }
    })
    socket.once('connect', () => socket.write(`${JSON.stringify({ ...message, token: state.token })}\n`))
  })
}

async function activeState(root) {
  const state = await readState(root)
  if (!state) return null
  try {
    const reply = await requestControl(state, { type: 'status' })
    if (reply?.ok === true && reply?.root === root) return { state, reply }
    // An authentication rejection can mean a live controller owns this state. Preserve it
    // and fail closed instead of starting a second launcher against the same deployment.
    return { state, reply: { ok: false, root, phase: 'unknown', error: 'Background ownership could not be authenticated.' } }
  } catch {
    // An unreachable channel alone is not proof that an owned launcher is dead.
    if (!processIsAlive(state.pid)) {
      await removeState(root, state.token)
      return null
    }
    return { state, reply: { ok: false, root, phase: 'unknown', error: 'Background ownership could not be contacted.' } }
  }
}

async function readPublicOrigin(root) {
  const text = await readFile(join(root, 'app', '.env.server'), 'utf8')
  const origin = parseEnv(text).WRJ_PUBLIC_ORIGIN?.trim()
  if (!origin) throw new Error('app/.env.server must set WRJ_PUBLIC_ORIGIN.')
  let url
  try { url = new URL(origin) } catch { throw new Error('WRJ_PUBLIC_ORIGIN must be a valid http(s) URL.') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('WRJ_PUBLIC_ORIGIN must use http or https.')
  return url.origin
}

async function assertDeployment(root, runtimeNode) {
  for (const file of [runtimeNode, join(root, 'app', '.env.server'), join(root, 'app', 'scripts', 'start-lan.mjs')]) {
    try { await access(file) }
    catch { throw new Error(`Deployment file is missing: ${file}`) }
  }
  await readPublicOrigin(root)
}

async function waitForReady(root, launcherPid) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let sawLauncher = false
  while (Date.now() < deadline) {
    const active = await activeState(root)
    // The detached controller needs a moment to create its private pipe and state file.
    if (!active) {
      if (sawLauncher || (launcherPid && !processIsAlive(launcherPid))) {
        throw new Error('Background launcher ended before the service became ready.')
      }
      await delay(150)
      continue
    }
    sawLauncher = true
    if (active.reply.phase === 'failed') throw new Error(active.reply.error || 'Background service startup failed.')
    if (active.reply.phase === 'ready') return active.state
    await delay(150)
  }
  throw new Error('Background service did not report its own readiness before the timeout.')
}

function openBrowser(origin) {
  if (process.platform !== 'win32') return
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', origin], {
    detached: true, shell: false, stdio: 'ignore', windowsHide: true,
  })
  child.unref()
}

async function acquireStartLock(root) {
  await ensureLogs(root)
  const destination = lockPath(root)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await openFile(destination, 'wx')
      const owner = { pid: process.pid, nonce: token() }
      await handle.writeFile(JSON.stringify(owner), 'utf8')
      return { handle, owner }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(await readFile(destination, 'utf8')) } catch { owner = undefined }
      if (processIsAlive(owner?.pid)) return null
      await rm(destination, { force: true })
    }
  }
  return null
}

async function releaseStartLock(lock, root) {
  if (!lock) return
  await lock.handle.close()
  try {
    const owner = JSON.parse(await readFile(lockPath(root), 'utf8'))
    if (owner?.nonce === lock.owner.nonce) await rm(lockPath(root), { force: true })
  } catch { /* A replacement lock belongs to another start attempt. */ }
}

export async function startBackground(root, { open = false, runtimeNode = join(root, 'runtime', 'node.exe') } = {}) {
  root = resolve(root)
  await assertDeployment(root, runtimeNode)
  const current = await activeState(root)
  if (current?.reply.phase === 'ready' || current?.reply.phase === 'starting') {
    const origin = await readPublicOrigin(root)
    await waitForReady(root)
    if (open) openBrowser(origin)
    return { alreadyRunning: true, origin, state: current.state }
  }
  if (current) {
    try { await requestControl(current.state, { type: 'shutdown' }) } catch { /* Controller retains ownership until it exits. */ }
    throw new Error('An earlier background service is still stopping; retry after it exits.')
  }
  const lock = await acquireStartLock(root)
  if (!lock) {
    const origin = await readPublicOrigin(root)
    const state = await waitForReady(root)
    if (open) openBrowser(origin)
    return { alreadyRunning: true, origin, state }
  }
  try {
    const acquiredCurrent = await activeState(root)
    if (acquiredCurrent) {
      if (acquiredCurrent.reply.phase !== 'ready' && acquiredCurrent.reply.phase !== 'starting') {
        throw new Error('A background service already owns this deployment; retry after it exits.')
      }
      const origin = await readPublicOrigin(root)
      const state = await waitForReady(root)
      if (open) openBrowser(origin)
      return { alreadyRunning: true, origin, state }
    }
    const launcherLog = await openFile(join(logs(root), LOG_FILE), 'a')
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--root', root, '--runtime-node', runtimeNode], {
      cwd: root, detached: true, windowsHide: true, shell: false, stdio: ['ignore', launcherLog.fd, launcherLog.fd],
    })
    await launcherLog.close()
    child.unref()
    const origin = await readPublicOrigin(root)
    const state = await waitForReady(root, child.pid)
    if (open) openBrowser(origin)
    return { alreadyRunning: false, origin, state }
  } finally { await releaseStartLock(lock, root) }
}

export async function stopBackground(root) {
  root = resolve(root)
  const current = await activeState(root)
  if (!current) return { alreadyStopped: true }
  const reply = await requestControl(current.state, { type: 'shutdown' })
  if (reply?.ok !== true) throw new Error('Background launcher rejected the shutdown request.')
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS + CONTROL_TIMEOUT_MS + 5_000
  while (Date.now() < deadline) {
    if (!await readState(root)) return { alreadyStopped: false }
    await delay(100)
  }
  throw new Error('Background launcher is still stopping; it was not force-terminated.')
}

export async function backgroundStatus(root) {
  root = resolve(root)
  const current = await activeState(root)
  return current ? { running: true, ...current.reply } : { running: false, phase: 'stopped' }
}

async function runLauncher(root, runtimeNode) {
  root = resolve(root)
  await assertDeployment(root, runtimeNode)
  const id = token()
  const state = { version: 1, root, token: id, channel: controlPath(root, id), pid: process.pid, phase: 'starting' }
  if (process.platform !== 'win32') await unlink(state.channel).catch(() => undefined)
  let service
  let stopping = false
  let finalized = false
  let failureTimer
  let serviceLog
  let stateWrite = Promise.resolve()
  const persistState = () => {
    const snapshot = { ...state }
    const queued = stateWrite.catch(() => undefined).then(async () => {
      if (!finalized) await writeState(root, snapshot)
    })
    stateWrite = queued
    return queued
  }
  const control = createServer(socket => {
    let body = ''
    let replied = false
    const reply = payload => {
      if (replied) return
      replied = true
      socket.end(`${JSON.stringify(payload)}\n`)
    }
    socket.setEncoding('utf8')
    socket.once('error', () => {})
    socket.on('data', chunk => {
      if (replied) return
      body += chunk
      const newline = body.indexOf('\n')
      if (newline < 0) return
      let request
      try { request = JSON.parse(body.slice(0, newline)) } catch { reply({ ok: false }); return }
      if (request?.token !== id) { reply({ ok: false, error: 'invalid token' }); return }
      if (request.type === 'status') reply({ ok: true, root, phase: state.phase, error: state.error, servicePid: state.servicePid })
      else if (request.type === 'shutdown') { reply({ ok: true }); void shutdown() }
      else reply({ ok: false })
    })
  })
  const finalize = async code => {
    if (finalized) return
    finalized = true
    if (failureTimer) clearTimeout(failureTimer)
    await stateWrite.catch(() => undefined)
    // The launcher child has already exited here. Do not make state cleanup depend on
    // draining its inherited log descriptor: that can delay an otherwise completed stop.
    if (serviceLog) void serviceLog.close().catch(() => undefined)
    await removeState(root, id)
    await new Promise(resolveClose => control.close(() => resolveClose()))
    if (process.platform !== 'win32') await unlink(state.channel).catch(() => undefined)
    process.exit(code)
  }
  const markFailed = async message => {
    if (stopping || finalized || state.phase === 'failed') return
    state.phase = 'failed'
    state.error = message
    await persistState()
    await log(root, `background launcher failed: ${message}`)
    failureTimer = setTimeout(() => { void finalize(1) }, FAILURE_RETENTION_MS)
    failureTimer.unref()
  }
  const shutdown = async () => {
    if (stopping || finalized) return
    stopping = true
    state.phase = 'stopping'
    delete state.error
    await persistState()
    if (!service || service.exitCode !== null || service.signalCode !== null) return finalize(0)
    if (service.connected) service.send({ type: 'shutdown' })
    const exited = await Promise.race([
      new Promise(resolveExit => service.once('exit', () => resolveExit(true))),
      delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
    ])
    if (exited) return finalize(0)
    state.error = 'Graceful shutdown is still pending; controller retained ownership state.'
    await persistState()
    await log(root, state.error)
  }
  await new Promise((resolveListen, rejectListen) => { control.once('error', rejectListen); control.listen(state.channel, resolveListen) })
  await persistState()
  if (stopping || finalized) return
  serviceLog = await openFile(join(logs(root), LOG_FILE), 'a')
  if (stopping || finalized) {
    await serviceLog.close()
    return
  }
  const configuredEnv = parseEnv(await readFile(join(root, 'app', '.env.server'), 'utf8'))
  if (stopping || finalized) {
    await serviceLog.close()
    return
  }
  const env = {
    WRJ_WEB_ROOT: join(root, 'app', 'dist'), WRJ_OUTPUT_ROOT: join(root, 'runs'),
    SCENARIO_DB_PATH: join(root, 'data', 'scenarios.db'), MISSION_EXECUTABLE_PATH: join(root, 'engine', 'mission.exe'),
    WRJ_MAP_EXECUTABLE_PATH: join(root, 'tools', 'versatiles.exe'), WRJ_MAP_VECTOR_PATH: join(root, 'maps', 'china-taiwan-260823.pmtiles'),
    WRJ_MAP_SATELLITE_PATH: join(root, 'maps', 'taiwan-strait-satellite.pmtiles'),
    AFSIM_EVENT_LOG_PATH: join(root, 'input', 'scenario_events.csv'), AFSIM_POSITION_LOG_PATH: join(root, 'input', 'position.csv'),
    // Keep .env.server overrides even when this controller is called as a module;
    // process environment still has priority, matching Node's --env-file behavior.
    ...configuredEnv,
    ...process.env,
  }
  service = spawn(runtimeNode, ['--env-file=.env.server', 'scripts/start-lan.mjs'], {
    cwd: join(root, 'app'), env, shell: false, windowsHide: true, stdio: ['ignore', serviceLog.fd, serviceLog.fd, 'ipc'],
  })
  state.servicePid = service.pid
  service.once('message', message => {
    if (message?.type !== 'ready' || stopping || finalized || state.phase !== 'starting') return
    state.phase = 'ready'
    void persistState().catch(error => { void markFailed(`could not save ready state: ${error.message}`) })
  })
  service.once('error', error => { void markFailed(`service startup error: ${error.message}`) })
  service.once('exit', code => {
    if (stopping) { void finalize(0); return }
    void markFailed(`service exited with code ${code}`)
  })
  await persistState()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown() })
}

export async function runBackgroundCommand(command, { root = defaultRoot(), open = false, runtimeNode } = {}) {
  if (command === 'start') return startBackground(root, { open, ...(runtimeNode ? { runtimeNode } : {}) })
  if (command === 'stop') return stopBackground(root)
  if (command === 'status') return backgroundStatus(root)
  throw new Error('Usage: deploy-background.mjs start [--open-browser] | stop | status')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'serve') { await runLauncher(options.root ?? defaultRoot(), options.runtimeNode ?? process.execPath); return }
  const result = await runBackgroundCommand(options.command, { root: options.root ?? defaultRoot(), open: options.openBrowser, runtimeNode: options.runtimeNode })
  if (options.command === 'start') console.log(`WRJ background service ${result.alreadyRunning ? 'is already ready' : 'is ready'}: ${result.origin}`)
  else if (options.command === 'stop') console.log(result.alreadyStopped ? 'WRJ background service is already stopped.' : 'WRJ background service stopped.')
  else console.log(`WRJ background service: ${result.phase}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`WRJ background controller failed: ${error.message}`); process.exitCode = 1 })
}
