// @vitest-environment node
import { afterEach, expect, it } from 'vitest'

const { spawn } = await import('node:' + 'child_process')
const { once } = await import('node:' + 'events')
const { setTimeout: delay } = await import('node:' + 'timers/promises')
const { default: nodeProcess } = await import('node:' + 'process')
const { terminateOwnedMissionProcess } = await import('../../server/local/' + 'mission-runner.js')

const ownedParents: Array<ReturnType<typeof spawn>> = []

function isAlive(pid: number): boolean {
  try { nodeProcess.kill(pid, 0); return true }
  catch { return false }
}

async function waitUntilGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!isAlive(pid)) return true
    await delay(100)
  }
  return false
}

afterEach(async () => {
  for (const parent of ownedParents.splice(0)) {
    if (parent.pid && isAlive(parent.pid)) await terminateOwnedMissionProcess(parent, true)
    if (parent.exitCode === null) await Promise.race([once(parent, 'close'), delay(3_000)])
  }
})

it('Windows timeout cleanup terminates the owned parent process tree', async () => {
  if (nodeProcess.platform !== 'win32') return

  const childSource = 'setInterval(() => {}, 1000)'
  const parentSource = [
    "const { spawn } = require('node:child_process')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'ignore', windowsHide: true })`,
    'console.log(child.pid)',
    'setInterval(() => {}, 1000)',
  ].join(';')
  const parent = spawn(nodeProcess.execPath, ['-e', parentSource], {
    detached: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  })
  ownedParents.push(parent)
  const [chunk] = await once(parent.stdout!, 'data')
  const childPid = Number(String(chunk).trim())
  expect(Number.isSafeInteger(childPid)).toBe(true)
  expect(childPid).toBeGreaterThan(0)
  expect(isAlive(childPid)).toBe(true)

  const parentClosed = once(parent, 'close')
  await terminateOwnedMissionProcess(parent, true)
  await Promise.race([
    parentClosed,
    delay(10_000).then(() => { throw new Error('owned parent did not close after forced termination') }),
  ])
  const childGone = await waitUntilGone(childPid)
  if (!childGone) await terminateOwnedMissionProcess({ pid: childPid, kill: () => false }, true)
  expect(childGone).toBe(true)
})
