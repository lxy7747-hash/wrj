import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fixture from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ScenarioDraft, TelemetryFrame } from '../../src/contracts/domain-models'
import { selectSituationLinks } from '../../src/features/situation/situation-model'
import { useTelemetryStore } from '../../src/stores/telemetry'
import { useScenarioStore } from '../../src/stores/scenario'
import CompositeLossExample from '../../src/components/interactions/CompositeLossExample.vue'
import EsmSensorPanel from '../../src/components/interactions/EsmSensorPanel.vue'
import ClosedLoopStepper from '../../src/components/interactions/ClosedLoopStepper.vue'
import LinkQualityDialog from '../../src/components/situation/LinkQualityDialog.vue'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

async function load(frame = structuredClone(fixture.frame) as TelemetryFrame) {
  const draft: ScenarioDraft = { config: structuredClone(fixture.scenario) as ScenarioDraft['config'], revision: 4,
    officialLibraryChanged: false, locked: false, uiExtensions: { jammers: fixture.scenario.jammers.map(jammer => ({ jammerId: jammer.id, direction: 0, enabled: true })), sensors: [
      { sensorId: 'ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true },
    ] } }
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ ok: true,
    data: url.endsWith('/events') ? fixture.events : url.includes('/frames/') ? frame : draft }) })))
  expect(await useScenarioStore().loadScenario('SCN-001')).toBe(true)
  expect(await useTelemetryStore().loadFrame()).toBe(true)
  return useTelemetryStore()
}

it('新损耗、阈值与字段错误从正式帧入口展示；缺省显示暂无数据', async () => {
  const store = await load()
  const panel = mount(CompositeLossExample, { global: { plugins: [ElementPlus] } })
  let detail = mount(LinkQualityDialog, { props: { modelValue: true, link: selectSituationLinks(store.frame!)[0]! },
    global: { plugins: [ElementPlus], stubs: { teleport: true, transition: false } } })
  try {
    await flushPromises()
    expect(panel.text()).toContain('海面多径暂无数据')
    expect(detail.text()).toContain('干信比阈值暂无数据')
    const frame = structuredClone(fixture.frame) as TelemetryFrame
    Object.assign(frame.evidence.losses.find(item => item.linkId === 'L-MW-01')!,
      { seaMultipathLossDb: 1, atmosphericLossDb: 2, cloudRainLossDb: 3 })
    Object.assign(frame.uiLinks.find(item => item.linkId === 'L-MW-01')!,
      { jsrThresholdDb: 4, warningBerThreshold: 0.01, emergencyBerThreshold: 0.02, jitterSuppressed: false })
    frame.links.find(item => item.linkId === 'L-MW-01')!.issues = [
      { severity: 'ERROR', code: 'PARAM_INVALID', fieldPath: 'links[0].frequency', message: '频率无效' },
    ]
    expect(store.acceptEnvelope({ type: 'event', schemaVersion: '1.0', topic: 'simulation.frame', taskId: frame.taskId,
      sequence: 1, simulationTime: frame.simulationTime, frameId: frame.frameId, payload: frame })).toBe(true)
    detail.unmount()
    detail = mount(LinkQualityDialog, { props: { modelValue: true, link: selectSituationLinks(store.frame!).find(item => item.linkId === 'L-MW-01')! },
      global: { plugins: [ElementPlus], stubs: { teleport: true, transition: false } } })
    await flushPromises()
    expect(panel.text()).toContain('海面多径1 dB')
    expect(panel.text()).toContain('大气衰减2 dB')
    expect(panel.text()).toContain('云雨损耗3 dB')
    expect(detail.text()).toContain('干信比阈值4.00 dB')
    expect(detail.text()).toContain('抖动抑制未抑制')
    expect(detail.get('[data-testid="link-parameter-issues"]').text()).toContain('PARAM_INVALID · links[0].frequency：频率无效')
  } finally { panel.unmount(); detail.unmount() }
})

it('未发现推送和传感器状态可展示，未发现事件不成为闭环上下文', async () => {
  const frame = structuredClone(fixture.frame) as TelemetryFrame
  frame.eventIds = []
  const store = await load()
  expect(store.acceptEnvelope({ type: 'event', schemaVersion: '1.0', topic: 'simulation.frame', taskId: frame.taskId,
    sequence: 1, simulationTime: frame.simulationTime, payload: { ...frame, frameId: 'F-NEXT',
      uiLinks: frame.uiLinks.map(item => ({ ...item, frameId: 'F-NEXT' })),
      evidence: { ...frame.evidence, routeDecisions: frame.evidence.routeDecisions.map(item => ({ ...item, frameId: 'F-NEXT' })),
        synchronization: { ...frame.evidence.synchronization, effectiveFrameId: 'F-NEXT' } } }, frameId: 'F-NEXT' })).toBe(true)
  const send = (payload: unknown, sequence: number) => store.acceptEnvelope({ type: 'event', schemaVersion: '1.0',
    topic: 'jammer.event', taskId: frame.taskId, sequence, simulationTime: 42, frameId: 'F-NEXT', payload })
  const sensor = useScenarioStore().draft!.config.sensors.find(item => item.id === 'ESM-01')!
  expect(send({ ...fixture.events[0], eventId: 'DET-MISS', dedupeKey: 'DET-MISS', frameId: 'F-NEXT',
    detected: false, frequencyMinMHz: 100, frequencyMaxMHz: 200 }, 1)).toBe(true)
  expect(send({ type: 'SENSOR_STATUS', time: 42, sensorId: sensor.id, platformId: sensor.platformId,
    active: false, scanCoveragePercent: 0 }, 2)).toBe(true)
  const panel = mount(EsmSensorPanel, { global: { plugins: [ElementPlus] } })
  const loop = mount(ClosedLoopStepper, { global: { plugins: [ElementPlus] } })
  try {
    await flushPromises()
    expect(panel.get('[data-testid="esm-state"]').text()).toBe('未发现')
    expect(panel.text()).toContain('100–200 MHz')
    expect(panel.get('[data-testid="sensor-runtime-status"]').text()).toContain('工作状态关闭')
    expect(panel.get('[data-testid="sensor-runtime-status"]').text()).toContain('扫描覆盖0%')
    expect(loop.text()).not.toContain('DET-MISS')
    expect(loop.find('button').exists()).toBe(false)
  } finally { panel.unmount(); loop.unmount() }
})
