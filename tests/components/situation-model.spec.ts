import { describe, expect, it } from 'vitest'
import {
  SITUATION_EVENTS_F00042,
  SITUATION_FRAME_F00042,
  SITUATION_LINKS_F00042,
  SITUATION_METRICS_F00042,
  formatBer,
  formatSimulationTime,
  getJammerTypeLabel,
  selectSituationLinks,
  selectSituationMetrics,
} from '../../src/features/situation/situation-model'

describe('态势固定帧模型', () => {
  it('按规范 jammer type 统一 SPOT 为瞄准式', () => {
    expect(getJammerTypeLabel('JAM-SPOT-01-TX')).toBe('瞄准式')
    expect(getJammerTypeLabel('JAM-WB-01-TX')).toBe('宽带压制')
  })

  it('使指标、链路和事件保持在同一固定帧', () => {
    expect(SITUATION_FRAME_F00042.frameId).toBe('F-00042')
    expect(SITUATION_METRICS_F00042.frameId).toBe('F-00042')
    expect(SITUATION_LINKS_F00042).toHaveLength(10)
    expect(SITUATION_LINKS_F00042.every((link) => link.frameId === 'F-00042')).toBe(true)
    expect(SITUATION_EVENTS_F00042.every((event) => event.frameId === 'F-00042')).toBe(true)
    expect(SITUATION_METRICS_F00042).toMatchObject({
      businessNodeCount: 6,
      supportingEntityCount: 2,
      upLinkCount: 9,
      degradedLinkCount: 1,
      downLinkCount: 0,
      activeJammerCount: 1,
      switchEventCount: 2,
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

  it('不把跨帧投影静默重标为当前帧', () => {
    const candidate = structuredClone(SITUATION_FRAME_F00042)
    const projection = candidate.uiLinks.find((item) => item.linkId === 'L-DL-03')
    if (projection === undefined) throw new Error('测试固定帧缺少 L-DL-03 状态投影')
    projection.frameId = 'F-OTHER'

    const link = selectSituationLinks(candidate).find((item) => item.linkId === 'L-DL-03')

    expect(link).toMatchObject({ frameId: 'F-00042', status: 'DOWN', thresholdVersion: null })
  })

  it('保持参考图中的代表节点链路拓扑', () => {
    expect(SITUATION_LINKS_F00042.map((link) => [
      link.linkId, link.type, link.sourceName, link.destinationName,
    ])).toEqual([
      ['L-MW-01', 'MICROWAVE', '高空前出中继节点', '地面无人集群指挥车'],
      ['L-DL-03', 'DATALINK', '高空前出中继节点', '地面无人集群指挥车'],
      ['L-SAT-02', 'SAT', '通信卫星', '高空前出中继节点'],
      ['L-LASER-04', 'LASER', '后方指挥节点', '高空前出中继节点'],
      ['L-SAT-05', 'SAT', '通信卫星', '后方指挥节点'],
      ['L-MW-05', 'MICROWAVE', '高空前出中继节点', '空中无人作业节点 U01'],
      ['L-MW-06', 'MICROWAVE', '高空前出中继节点', '空中无人作业节点 U03'],
      ['L-DL-05', 'DATALINK', '后方指挥节点', '地面无人集群指挥车'],
      ['L-DL-06', 'DATALINK', '地面无人集群指挥车', '空中无人作业节点 U01'],
      ['L-DL-07', 'DATALINK', '空中无人作业节点 U01', '空中无人作业节点 U02'],
    ])
  })

  it('提供稳定的单位格式', () => {
    expect(formatSimulationTime(42)).toBe('T+ 00:00:42')
    expect(formatBer(0.00024)).toBe('2.4e-4')
  })

  it('按当前帧全部链路汇总状态并处理空集合', () => {
    const metrics = selectSituationMetrics(SITUATION_FRAME_F00042, SITUATION_EVENTS_F00042)
    expect(metrics).toMatchObject({
      filteredLinkCount: 10,
      upLinkCount: 9,
      degradedLinkCount: 1,
      downLinkCount: 0,
    })

    expect(selectSituationMetrics(SITUATION_FRAME_F00042, [], [])).toMatchObject({
      filteredLinkCount: 0,
      upLinkCount: 0,
      degradedLinkCount: 0,
      downLinkCount: 0,
    })
  })
})
