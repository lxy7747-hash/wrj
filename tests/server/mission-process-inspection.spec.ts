// @vitest-environment node
import { expect, it } from 'vitest'
const { readMissionProcesses, stopVerifiedMission } = await import('../../server/local/' + 'mission-process-inspection.js')
const { spawn } = await import('node:' + 'child_process')
const { once } = await import('node:' + 'events')
const { mkdtemp, writeFile, rm } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { default: process } = await import('node:' + 'process')

it('核对真实操作系统进程身份，拒绝不匹配 PID 身份，并停止本测试创建的进程树', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wrj-owned-process-'))
  const script = join(root, 'holder.cjs')
  await writeFile(script, `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); process.send({pid:child.pid}); setInterval(()=>{},1000)`)
  const child = spawn(process.execPath, [script, '-es', 'scenario.txt'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, detached: process.platform !== 'win32' })
  const closed = once(child, 'close')
  let descendantPid: number | undefined
  try {
    const [message] = await once(child, 'message')
    descendantPid = message.pid
    const processes = await readMissionProcesses()
    const identity = processes.find((entry: { pid: number; parentPid: number; startedAt: number }) => entry.pid === child.pid)!
    expect(identity.executable).toBeTruthy()
    expect(identity.commandLine).toContain('-es scenario.txt')
    expect(processes.find((entry: { pid: number; parentPid: number; startedAt: number }) => entry.pid === descendantPid)?.parentPid).toBe(child.pid)
    await expect(stopVerifiedMission({ ...identity, startedAt: identity.startedAt - 1000 })).rejects.toThrow('身份已变化')
    expect(child.exitCode).toBeNull()
    await stopVerifiedMission(identity)
    await closed
    const remaining = await readMissionProcesses()
    expect(remaining.some((entry: { pid: number; parentPid: number; startedAt: number }) => entry.pid === identity.pid && entry.startedAt === identity.startedAt)).toBe(false)
    expect(remaining.some((entry: { pid: number; parentPid: number; startedAt: number }) => entry.pid === descendantPid)).toBe(false)
  } finally {
    // 只清理测试独占创建的两个进程；不枚举或停止真实 Mission。
    if (child.exitCode === null && child.signalCode === null) {
      if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch { /* 已退出。 */ } }
      child.kill('SIGKILL')
      await closed
    }
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
