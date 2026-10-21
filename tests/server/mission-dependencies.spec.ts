// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:fs/promises', { spy: true })
const fs = await import('node:' + 'fs/promises')
const { mkdtemp, rm, writeFile } = fs
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const { inspectMissionDependencies, LINK_CALC_PROCESSOR } = await import('../../server/local/' + 'mission-dependencies.js')

afterEach(() => vi.restoreAllMocks())

describe('Mission 插件文件预检的证据边界', () => {
  it('无后方节点时不读取插件路径；路径不存在也不拦截', async () => {
    const stat = vi.spyOn(fs, 'stat')
    expect(await inspectMissionDependencies([], '/missing/plugin')).toMatchObject({ status: 'not-required' })
    expect(stat).not.toHaveBeenCalled()
  })

  it('未配置时是未知，不能声称未安装或阻断静态注册的处理器', async () => {
    const stat = vi.spyOn(fs, 'stat')
    expect(await inspectMissionDependencies([LINK_CALC_PROCESSOR])).toMatchObject({
      status: 'unknown', message: expect.stringContaining('无法在启动前确认'),
    })
    expect(stat).not.toHaveBeenCalled()
  })

  it('仅接受可读的普通文件；文件存在也不声称插件已加载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-dependency-'))
    try {
      const path = join(root, 'vendor-plugin.dll')
      expect(await inspectMissionDependencies([LINK_CALC_PROCESSOR], path)).toMatchObject({ status: 'configured-file-unavailable' })
      expect(await inspectMissionDependencies([LINK_CALC_PROCESSOR], root)).toMatchObject({ status: 'configured-file-unavailable', message: expect.stringContaining('不是普通文件') })
      expect(await inspectMissionDependencies([LINK_CALC_PROCESSOR], 'relative.dll')).toMatchObject({ status: 'configured-file-unavailable', message: expect.stringContaining('绝对路径') })
      await writeFile(path, 'file presence is not an ABI check')
      expect(await inspectMissionDependencies([LINK_CALC_PROCESSOR], path)).toMatchObject({ status: 'file-readable', pluginPath: path, message: expect.stringContaining('仍待引擎验证') })
      vi.spyOn(fs, 'access').mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
      expect(await inspectMissionDependencies([LINK_CALC_PROCESSOR], path)).toMatchObject({ status: 'configured-file-unavailable', message: expect.stringContaining('permission denied') })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
