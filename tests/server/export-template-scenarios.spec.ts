// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ScenarioConfig, ScenarioDraft, ScenarioSnapshot } from '../../src/contracts/domain-models'
import { createRenamedTemplateScenario } from '../fixtures/template-scenario'

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

it('三个 50 信息节点快照完成自检后写出，保留原平台、链路、业务和完整航线', async () => {
  await import('../../scripts/' + 'export-template-20261106-scenarios.js')
  expect(nodeProcess.exitCode).toBeUndefined()
  expect(mkdir).toHaveBeenCalledOnce()
  expect(writeFile).toHaveBeenCalledTimes(3)
  const snapshots: ScenarioSnapshot[] = vi.mocked(writeFile).mock.calls.map((call: unknown[]) => JSON.parse(String(call[1])) as ScenarioSnapshot)
  const baseline = createRenamedTemplateScenario()
  for (const [index, snapshot] of snapshots.entries()) {
    expect(snapshot.config.scenario.id).toBe(`SCN-TEMPLATE-20261106-0${index + 1}`)
    expect(snapshot.config.platforms).toHaveLength(54)
    for (const [i, platform] of snapshot.config.platforms.entries()) {
      const linkIds = snapshot.config.links.filter(link => [link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId].includes(platform.id)).map(link => link.id)
      expect(platform.linkIds).toEqual(linkIds)
      if (i < 9) expect(platform).toEqual({ ...baseline.config.platforms[i], linkIds })
    }
    expect(snapshot.config.links).toHaveLength(96)
    expect(snapshot.config.links.slice(0, 6)).toEqual(baseline.config.links)
    expect(snapshot.config.informationDemand).toHaveLength(188)
    expect(snapshot.config.informationDemand.slice(0, 8)).toEqual(baseline.config.informationDemand)
    expect(snapshot.config.informationDemand.every(demand => !Object.hasOwn(demand, 'linkId'))).toBe(true)
    for (const key of ['sensors', 'output'] as const) expect(snapshot.config[key]).toEqual(baseline.config[key])
    expect(snapshot.config.scenario).toMatchObject({ duration: 5400, realtime: true, environment: baseline.config.scenario.environment })
    expect(snapshot.uiExtensions).toEqual(baseline.uiExtensions)
    expect(snapshot.config.linkSettings?.messageIntervalS).toBe(5)
    expect(snapshot.config.linkSettings?.linkCalc?.updateIntervalS).toBe(index === 2 ? 1 : 5)
    expect(snapshot.config.jammers.every(jammer => jammer.radarPower === 1000)).toBe(true)
    expect(snapshot.config.deviceParameters?.ports?.MISSION_UAV_PLATFORM?.microwave_link).toMatchObject({ eirpDbw: 30, gtDbk: -3 })
  }
  const config = snapshots[0]!.config
  const original = baseline.config.platforms.find(platform => platform.id === 'PLAT-003')!
  for (const [id, name, longitudeOffset, latitudeOffset] of [
    ['PLAT-006', '任务无人机 03', 0, 0], ['PLAT-014', '任务无人机 11', 0.16, 0],
    ['PLAT-015', '任务无人机 12', 0, 0.02], ['PLAT-050', '任务无人机 47', 0.16, 0.08],
  ] as const) {
    const platform = config.platforms.find(platform => platform.id === id)!
    const expected = structuredClone(original)
    for (const point of [expected.initialPosition, ...expected.waypoints, ...expected.loiterWaypoints!, ...expected.returnPlan!.waypoints]) {
      point.longitude += longitudeOffset
      point.latitude += latitudeOffset
    }
    expect(platform).toEqual({ ...expected, id, name, linkIds: [`c_forward_${id}`, `c_return_${id}`] })
    expect(config.linkSettings?.hotLinks?.forward).toContainEqual(['fiber_forward', `c_forward_${id}`])
    expect(config.linkSettings?.hotLinks?.reverse).toContainEqual([`c_return_${id}`, 'fiber_return'])
    for (const direction of ['forward', 'return']) {
      const source = baseline.config.links.find(link => link.id === `c_${direction}_uav2`)!
      expect(config.links.find(link => link.id === `c_${direction}_${id}`)).toEqual({ ...source, id: `c_${direction}_${id}`,
        ...(direction === 'forward' ? { targetPlatformId: id } : { sourcePlatformId: id }) })
    }
    for (const demand of baseline.config.informationDemand.filter(item => item.id.startsWith('uav2_'))) {
      const demandId = demand.id.replace('uav2_', `${id}_`)
      expect(config.informationDemand.find(item => item.id === demandId)).toEqual({ ...demand, id: demandId,
        sourcePlatformId: demand.direction === 'FORWARD' ? demand.sourcePlatformId : id,
        destinationPlatformIds: demand.direction === 'FORWARD' ? [id] : demand.destinationPlatformIds })
    }
  }
  expect(snapshots[1]!.config.jammers[0]).toMatchObject({ type: 'SPOT', bandwidth: 5, frequency: 4500 })
  expect(snapshots[1]!.config.jammers[1]).toMatchObject(baseline.config.jammers[1]!)
})

it.each(['write', 'script'] as const)('最后一条场景的 %s 校验失败时整批不写文件，并报告字段路径', async stage => {
  if (stage === 'write') {
    const validation = await import('../../src/features/scenarios/scenario-validation')
    const inspect = validation.inspectScenarioConfig
    vi.spyOn(validation, 'inspectScenarioConfig').mockImplementation((value, mode) => {
      const report = inspect(value, mode)
      if ((value as ScenarioConfig).scenario.id.endsWith('-03')) {
        report.result.valid = false
        report.result.errors.push({ severity: 'ERROR', code: 'TEST_INVALID', fieldPath: 'jammers[0].radarPower', message: '无效雷达功率' })
      }
      return report
    })
  } else {
    const generator = await import('../../server/scripts/' + 'mission-generator.js')
    const build = generator.buildMissionPackage
    vi.spyOn(generator, 'buildMissionPackage').mockImplementation((...args: unknown[]) => {
      const draft = args[0] as ScenarioDraft
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
