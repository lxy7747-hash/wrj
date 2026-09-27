// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:child_process', { spy: true })
const { EventEmitter } = await import('node:' + 'events')
const runtime = (await import('node:' + 'process')).default
const devModule = '../../scripts/' + 'dev.mjs'
const originalExitCode = runtime.exitCode
const originalInt = runtime.listeners('SIGINT')
const originalTerm = runtime.listeners('SIGTERM')

afterEach(async () => {
  for (const listener of runtime.listeners('SIGINT')) if (!originalInt.includes(listener)) runtime.removeListener('SIGINT', listener)
  for (const listener of runtime.listeners('SIGTERM')) if (!originalTerm.includes(listener)) runtime.removeListener('SIGTERM', listener)
  runtime.exitCode = originalExitCode
  vi.mocked((await import('node:' + 'child_process')).spawn).mockReset()
  vi.resetModules()
})

function fakeChild(pid?: number) {
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn(() => { child.signalCode = 'SIGTERM'; child.emit('exit', null); return true }) })
  return child
}

it('子服务意外 exit 0 使聚合命令失败，用户主动停止仍正常退出', async () => {
  const first = fakeChild()
  const second = fakeChild()
  const spawn = vi.mocked((await import('node:' + 'child_process')).spawn)
  spawn.mockReturnValueOnce(first as never).mockReturnValueOnce(second as never)
  await import(devModule)
  first.exitCode = 0
  first.emit('exit', 0)
  expect(runtime.exitCode).toBe(1)
  expect(second.kill).toHaveBeenCalledTimes(1)

  for (const listener of runtime.listeners('SIGINT')) if (!originalInt.includes(listener)) runtime.removeListener('SIGINT', listener)
  for (const listener of runtime.listeners('SIGTERM')) if (!originalTerm.includes(listener)) runtime.removeListener('SIGTERM', listener)
  vi.resetModules()
  const third = fakeChild()
  const fourth = fakeChild()
  vi.mocked((await import('node:' + 'child_process')).spawn).mockReturnValueOnce(third as never).mockReturnValueOnce(fourth as never)
  await import(devModule)
  const stop = runtime.listeners('SIGINT').find((listener: (...args: unknown[]) => void) => !originalInt.includes(listener))
  expect(stop).toBeDefined()
  stop!()
  expect(runtime.exitCode).toBe(0)
  expect(third.kill).toHaveBeenCalledTimes(1)
  expect(fourth.kill).toHaveBeenCalledTimes(1)
})

it('Windows 停止本次启动的 cmd 进程树，完成后释放清理计时器', async () => {
  if (runtime.platform !== 'win32') return
  const first = fakeChild()
  const second = fakeChild(8765)
  const cleanup = fakeChild()
  const spawn = vi.mocked((await import('node:' + 'child_process')).spawn)
  spawn.mockReturnValueOnce(first as never).mockReturnValueOnce(second as never)
    .mockReturnValueOnce(cleanup as never)
  await import(devModule)
  first.exitCode = 0
  first.emit('exit', 0)
  expect(spawn).toHaveBeenLastCalledWith('taskkill', ['/PID', '8765', '/T', '/F'],
    { stdio: 'ignore', windowsHide: true })
  cleanup.emit('exit', 0)
  expect(second.kill).toHaveBeenCalledTimes(1)
})
