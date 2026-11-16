// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) }))
const { mkdir, writeFile } = await import('node:' + 'fs/promises')
const { default: nodeProcess } = await import('node:' + 'process')
const exitCode = nodeProcess.exitCode

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  nodeProcess.exitCode = undefined
})
afterEach(() => { vi.restoreAllMocks(); nodeProcess.exitCode = exitCode })

it('50 节点快照按场景动态生成 mission_uav 实例并导出，不再受模板 3 架无人机限制', async () => {
  await import('../../scripts/' + 'export-template-20261106-scenarios.js')
  expect(nodeProcess.exitCode).not.toBe(1)
  expect(console.error).not.toHaveBeenCalled()
  expect(mkdir).toHaveBeenCalledTimes(1)
  expect(writeFile).toHaveBeenCalledTimes(3)
})

it.each(['write', 'script'] as const)('最后一条场景的 %s 校验失败时整批不写文件，并报告字段路径', async stage => {
  if (stage === 'write') {
    const validation = await import('../../src/features/scenarios/scenario-validation')
    const inspect = validation.inspectScenarioConfig
    vi.spyOn(validation, 'inspectScenarioConfig').mockImplementation((value, mode) => {
      const report = inspect(value, mode)
      if ((value as { scenario: { id: string } }).scenario.id.endsWith('-03')) {
        report.result.valid = false
        report.result.errors.push({ severity: 'ERROR', code: 'TEST_INVALID', fieldPath: 'jammers[0].radarPower', message: '无效雷达功率' })
      }
      return report
    })
  } else {
    const generator = await import('../../server/scripts/' + 'mission-generator.js')
    const build = generator.buildMissionPackage
    vi.spyOn(generator, 'buildMissionPackage').mockImplementation((...args: unknown[]) => {
      const draft = args[0] as { config: { scenario: { id: string } } }
      if (draft.config.scenario.id.endsWith('-03')) throw new generator.MissionGenerationError('jammers[0].radarPower', '生成失败')
      return build(...args)
    })
  }
  await import('../../scripts/' + 'export-template-20261106-scenarios.js')
  expect(nodeProcess.exitCode).toBe(1)
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('SCN-TEMPLATE-20261106-03 jammers[0].radarPower'))
  expect(mkdir).not.toHaveBeenCalled()
  expect(writeFile).not.toHaveBeenCalled()
})
