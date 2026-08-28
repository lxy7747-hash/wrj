import { describe, expect, it } from 'vitest'
import {
  SITUATION_EVENTS_F00042,
  SITUATION_FRAME_F00042,
  SITUATION_LINKS_F00042,
  SITUATION_METRICS_F00042,
  formatBer,
  formatSimulationTime,
} from '../../src/features/situation/situation-model'

describe('态势固定帧模型', () => {
  it('使指标、链路和事件保持在同一固定帧', () => {
    expect(SITUATION_FRAME_F00042.frameId).toBe('F-00042')
    expect(SITUATION_METRICS_F00042.frameId).toBe('F-00042')
    expect(SITUATION_LINKS_F00042).toHaveLength(4)
    expect(SITUATION_LINKS_F00042.every((link) => link.frameId === 'F-00042')).toBe(true)
    expect(SITUATION_EVENTS_F00042.every((event) => event.frameId === 'F-00042')).toBe(true)
    expect(SITUATION_METRICS_F00042).toMatchObject({
      businessNodeCount: 4,
      supportingEntityCount: 2,
      upLinkCount: 3,
      degradedLinkCount: 1,
      downLinkCount: 0,
      activeJammerCount: 1,
      switchEventCount: 1,
    })
  })

  it('保留 L-DL-03 的界面劣化与规范中断投影', () => {
    const link = SITUATION_LINKS_F00042.find((item) => item.linkId === 'L-DL-03')

    expect(link).toMatchObject({
      frameId: 'F-00042',
      status: 'DEGRADED',
      canonicalStatus: 'DOWN',
      snrDb: 7.1,
      ber: 0.00024,
      consecutiveFrames: 3,
    })
    expect(link?.detailed?.linkStatus).toBe('DOWN')
  })

  it('从同帧证据派生摘要链路稳定帧数和数据年龄', () => {
    const link = SITUATION_LINKS_F00042.find((item) => item.linkId === 'L-SAT-02')

    expect(link).toMatchObject({
      frameId: 'F-00042',
      consecutiveFrames: 4,
      ageMs: 0,
    })
  })

  it('提供稳定的单位格式', () => {
    expect(formatSimulationTime(42)).toBe('T+ 00:00:42')
    expect(formatBer(0.00024)).toBe('2.4e-4')
  })
})
