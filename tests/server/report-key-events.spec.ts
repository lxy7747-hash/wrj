// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { EngineRouteSwitch, SwitchEvent } from '../../src/contracts/domain-models'
import { LOCAL_QUALITY_REPORT, LOCAL_REPORT } from '../fixtures/local-report'
const { buildReportKeyEvents } = await import('../../server/local/' + 'report-key-events.js')

const QUALITY_SWITCH: SwitchEvent = {
  eventId: 'SWITCH-QUALITY', frameId: 'F-1', time: 1, type: 'LINK_SWITCH', direction: 'FORWARD',
  oldLinkId: 'L-1', newLinkId: 'L-2', oldBer: 0.01, newBer: 0.001,
  stabilityFrames: 3, minimumStableFrames: 2, hysteresisSatisfied: true, cooldownRemainingS: 0,
  decision: 'ACCEPTED', reason: 'accepted', dedupeKey: 'quality-switch',
}

const ENGINE_SWITCH: EngineRouteSwitch = {
  pathId: 'PATH-NEW', oldPathId: 'PATH-OLD', direction: 'FORWARD', sourceName: null, targetName: null,
  sourcePlatformId: 'A', targetPlatformId: 'B', transTypes: [], nodes: [], oldNodes: [], reasons: [],
}

describe('简版报告关键事件', () => {
  it('按数值时刻排序并限制 20 条，保留总数，排除通用武器和消息事件', () => {
    const evidence = structuredClone(LOCAL_REPORT.localEvidence)
    evidence.endTimeS = 30
    evidence.eventCounts = [
      { type: 'JAMMING_REQUEST_INITIATED', count: 28 }, { type: 'JAMMING_REQUEST_CANCELED', count: 1 },
      { type: 'WEAPON_TURNED_OFF', count: 1 }, { type: 'MESSAGE_RECEIVED', count: 1 },
    ]
    evidence.deviceEvents = Array.from({ length: 24 }, (_, index) => ({
      eventId: `REQUEST-${index}`, time: 25 - index, type: 'JAMMING_REQUEST_INITIATED', platformId: 'A', deviceId: 'J-1',
    }))
    evidence.deviceEvents.push(
      { eventId: 'WEAPON-1', time: 0, type: 'WEAPON_TURNED_OFF', platformId: 'A', deviceId: 'W-1' },
      { eventId: 'MESSAGE-1', time: 0, type: 'MESSAGE_RECEIVED', platformId: 'A', deviceId: 'R-1' },
      { eventId: 'REQUEST-CANCELED', time: 1, type: 'JAMMING_REQUEST_CANCELED', platformId: 'A', deviceId: 'J-1' },
      { eventId: 'OUTSIDE', time: 31, type: 'JAMMING_REQUEST_INITIATED', platformId: 'A', deviceId: 'J-OUTSIDE' },
    )
    const { table, note } = buildReportKeyEvents(evidence)
    expect(table.rows).toHaveLength(20)
    expect(table.rows.at(0)).toEqual(['0分1秒', '干扰请求取消', '无人机甲', 'J-1 · 已记录请求', 'scenario_events.csv'])
    expect(table.rows.at(-1)?.[0]).toBe('0分20秒')
    expect(note).toContain('干扰请求 29 条')
    expect(note).toContain('前 20 条')
    expect(note).toContain('部分事件缺少明细')
    expect(note).toContain('设备实际启停未确认')
  })

  it('优先引擎切换，保留同帧的前反向，明确归档明细缺失', () => {
    const evidence = structuredClone(LOCAL_QUALITY_REPORT.localEvidence!)
    evidence.quality!.switchEvents = [QUALITY_SWITCH]
    evidence.engineFrameArchive = {
      sourceSha256: 'a'.repeat(64), frameCount: 1, firstSimulationTime: 3, lastSimulationTime: 3,
      missingFieldNames: [], detailTruncated: true, segmentRows: [],
      aggregate: { uniqueSingleSegmentCount: 0, switchCount: 5, missing: [] },
      switchRows: [ENGINE_SWITCH, { ...ENGINE_SWITCH, direction: 'REVERSE' as const }].map(value => ({ engineEpoch: 0, frameId: 3, simulationTime: 3, value })),
      eventRows: [{ engineEpoch: 0, frameId: 3, simulationTime: 3, value: {
        type: 'into_jamm', pathId: null, uavIds: ['A'], uavNames: [], jammerIds: [], jammerNames: ['干扰机甲'],
      } }],
    }
    const { table, note } = buildReportKeyEvents(evidence)
    expect(table.rows).toEqual([
      ['0分3秒', '路径切换', '前向', 'PATH-OLD → PATH-NEW', '引擎帧归档'],
      ['0分3秒', '路径切换', '反向', 'PATH-OLD → PATH-NEW', '引擎帧归档'],
      ['0分3秒', '进入干扰圈', '无人机甲', '干扰源 干扰机甲', '引擎帧归档'],
    ])
    expect(note).toContain('切换 5 条')
    expect(note).toContain('干扰圈事件已保留 1 条')
    expect(note).toContain('部分事件缺少明细')
    delete evidence.engineFrameArchive.aggregate
    expect(buildReportKeyEvents(evidence).note).toContain('已保留切换 2 条，总数未提供')
  })

  it('质量文件仅纳入已接受切换，运行日志作后备，没有来源时不标成零次', () => {
    const evidence = structuredClone(LOCAL_QUALITY_REPORT.localEvidence!)
    evidence.switchEvents = [{ eventId: 'RUNTIME', time: 3, demandId: 'DEMAND-1', ruleId: null, fromDeviceId: 'OLD', toDeviceId: 'NEW', fromLinkId: null, toLinkId: null, stableChecks: null }]
    evidence.quality!.switchEvents = [QUALITY_SWITCH, { ...QUALITY_SWITCH, eventId: 'REJECTED', decision: 'REJECTED' }]
    expect(buildReportKeyEvents(evidence).table.rows).toEqual([
      ['0分1秒', '链路切换', '前向', 'L-1 → L-2', 'quality.csv'],
    ])
    delete evidence.quality
    expect(buildReportKeyEvents(evidence).table.rows).toEqual([
      ['0分3秒', '链路切换', 'DEMAND-1', 'OLD → NEW', 'scenario_events.csv'],
    ])
    const unavailable = buildReportKeyEvents(LOCAL_REPORT.localEvidence)
    expect(unavailable.table.rows).toHaveLength(0)
    expect(unavailable.note).toContain('切换记录未提供')
  })

  it('完整收录探测圈与干扰圈四类迁移事件及对应干扰源与目标', () => {
    const evidence = structuredClone(LOCAL_QUALITY_REPORT.localEvidence!)
    evidence.endTimeS = 30
    evidence.engineFrameArchive = {
      sourceSha256: 'b'.repeat(64), frameCount: 4, firstSimulationTime: 1, lastSimulationTime: 20,
      missingFieldNames: [], detailTruncated: false, segmentRows: [],
      aggregate: { uniqueSingleSegmentCount: 0, switchCount: 0, missing: [] },
      switchRows: [],
      eventRows: [
        { engineEpoch: 0, frameId: 1, simulationTime: 2, value: { type: 'into_detect', pathId: null, uavIds: ['A'], uavNames: [], jammerIds: [], jammerNames: ['干扰机甲'] } },
        { engineEpoch: 0, frameId: 2, simulationTime: 5, value: { type: 'into_jamm', pathId: null, uavIds: ['A'], uavNames: [], jammerIds: [], jammerNames: ['干扰机甲'] } },
        { engineEpoch: 0, frameId: 3, simulationTime: 12, value: { type: 'release_jamm', pathId: null, uavIds: ['A'], uavNames: [], jammerIds: [], jammerNames: ['干扰机甲'] } },
        { engineEpoch: 0, frameId: 4, simulationTime: 18, value: { type: 'release_detect', pathId: null, uavIds: ['A'], uavNames: [], jammerIds: [], jammerNames: ['干扰机甲'] } },
      ],
    }
    const { table } = buildReportKeyEvents(evidence)
    expect(table.rows).toEqual([
      ['0分2秒', '进入探测圈', '无人机甲', '干扰源 干扰机甲', '引擎帧归档'],
      ['0分5秒', '进入干扰圈', '无人机甲', '干扰源 干扰机甲', '引擎帧归档'],
      ['0分12秒', '离开干扰圈', '无人机甲', '干扰源 干扰机甲', '引擎帧归档'],
      ['0分18秒', '离开探测圈', '无人机甲', '干扰源 干扰机甲', '引擎帧归档'],
    ])
  })
})
