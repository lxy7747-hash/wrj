import { describe, expect, it } from 'vitest'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
import { isDetectionEvent, toDetectionEvent } from '../../src/features/reports/detection-events'
import { localReportTables } from '../../src/features/reports/local-report'

// 字段声明与数据行取自本机原生 WSF_ESM_SENSOR 运行输出（只保留映射用到的列）。
const ESM_CSV = [
  '! SENSOR_DETECTION_CHANGED,time<time>,event<string>,platform<string>,side<string>,target_platform<string>,sensor<string>,mode<string>,Pd<double>,required_Pd<double>,detected<bool>',
  '! SENSOR_TRACK_INITIATED,time<time>,event<string>,platform<string>,side<string>,sensor<string>,track_id<string>,target_platform<string>,frequency_count<int>,frequency_low_#<double>,frequency_high_#<double>',
  '! SENSOR_TRACK_DROPPED,time<time>,event<string>,platform<string>,side<string>,sensor<string>,track_id<string>,target_platform<string>,frequency_count<int>,frequency_low_#<double>,frequency_high_#<double>',
  '0,SENSOR_DETECTION_CHANGED,listener,,target,esm,default,1.000000e+00,1.177022e-01,1',
  '1,SENSOR_TRACK_INITIATED,listener,,esm,listener.1,target,1,2.15e+09,2.25e+09',
  '5,SENSOR_DETECTION_CHANGED,listener,,target,esm,default,0.000000e+00,1.177022e-01,0',
  '6,SENSOR_TRACK_DROPPED,listener,,esm,listener.1,target,0,,',
].join('\n')

describe('ESM 侦测规范事件', () => {
  it('原生 SENSOR_* 事件保留原文并映射目标、频段、概率、时刻与结论；缺失字段为 null 不补默认', () => {
    const log = parseAfsimEventLog(ESM_CSV)
    expect(log.valid).toBe(true)
    const events = log.events.map(toDetectionEvent)
    expect(events).toEqual([
      { eventId: 'LOG-L4', time: 0, type: 'SENSOR_DETECTION_CHANGED', platformId: 'listener', sensorId: 'esm', targetPlatformId: 'target',
        frequencyMinHz: null, frequencyMaxHz: null, probability: 1, detected: true },
      { eventId: 'LOG-L5', time: 1, type: 'SENSOR_TRACK_INITIATED', platformId: 'listener', sensorId: 'esm', targetPlatformId: 'target',
        frequencyMinHz: 2.15e9, frequencyMaxHz: 2.25e9, probability: null, detected: null },
      { eventId: 'LOG-L6', time: 5, type: 'SENSOR_DETECTION_CHANGED', platformId: 'listener', sensorId: 'esm', targetPlatformId: 'target',
        frequencyMinHz: null, frequencyMaxHz: null, probability: 0, detected: false },
      { eventId: 'LOG-L7', time: 6, type: 'SENSOR_TRACK_DROPPED', platformId: 'listener', sensorId: 'esm', targetPlatformId: 'target',
        frequencyMinHz: null, frequencyMaxHz: null, probability: null, detected: null },
    ])
    const ids = new Set(['listener'])
    expect(events.every(event => isDetectionEvent(event, ids))).toBe(true)
    expect(isDetectionEvent({ ...events[0], probability: 2 }, ids)).toBe(false)
    expect(isDetectionEvent({ ...events[0], platformId: 'unknown' }, ids)).toBe(false)
    expect(toDetectionEvent({ ...log.events[0]!, type: 'COMM_TURNED_ON' })).toBeNull()
  })

  it('报告表展示中文目标、MHz 频段、概率和侦测结论，缺失字段显示暂无数据', () => {
    const detectionEvents = parseAfsimEventLog(ESM_CSV).events.map(toDetectionEvent).filter(event => event !== null)
    const evidence = {
      eventFile: { fileName: 'events.csv', sha256: 'a'.repeat(64) }, positionFile: { fileName: 'position.csv', sha256: 'b'.repeat(64) },
      startTimeS: 0, endTimeS: 6, simulationComplete: true, positionCount: 0, positionIssueCount: 0, waitingForPositionLine: false,
      eventCount: 4, eventWarningCount: 0, nodes: [{ platformId: 'listener', name: '侦测站', type: 'X', side: 'red', positionCount: 0, firstTimeS: 0, lastTimeS: 0 }],
      eventCounts: [], connections: [], deviceEvents: [], detectionEvents,
    }
    const table = localReportTables(evidence).find(item => item.title === 'ESM 侦测事件')!
    expect(table.columns).toEqual(['事件编号', '时刻', '事件', '侦测平台', '传感器', '目标', '频段', '概率', '结论'])
    expect(table.rows[0]).toEqual(['LOG-L4', '0分0秒', '侦测状态变化', '侦测站（listener）', 'esm', 'target（target）', '暂无数据', '1.000', '侦测到目标'])
    expect(table.rows[1]![6]).toBe('2150～2250 MHz')
    expect(table.rows[2]![8]).toBe('未侦测到目标')
    expect(table.rows[3]![7]).toBe('暂无数据')
  })
})
