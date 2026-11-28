import type { EngineLinkSegment } from '../../contracts/domain-models'

const value = (raw: string | number | null | undefined) => raw == null || raw === '' ? '暂无数据' : String(raw)

export function engineSegmentLossRows(
  losses: EngineLinkSegment['losses'],
  { showMissingCombined = false } = {},
): string[][] {
  return [
    ['自由空间损耗（dB）', value(losses.freeSpaceDb)], ['海面多径损耗（dB）', value(losses.seaMultipathDb)],
    ['大气损耗（dB）', value(losses.atmosphericDb)], ['雨衰损耗（dB）', value(losses.rainDb)],
    ['云衰损耗（dB）', value(losses.cloudDb)],
    ...(showMissingCombined || losses.cloudRainDb !== null || (losses.rainDb == null && losses.cloudDb == null)
      ? [['云雨合并损耗（dB）', value(losses.cloudRainDb)]]
      : []),
    ['干扰损耗（dB）', value(losses.jammingDb)], ['总复合损耗（dB）', value(losses.totalDb)],
  ]
}

export function engineSegmentInputRows(segment: EngineLinkSegment): string[][] {
  const input = segment.inputTrace
  return [
    ['频率（GHz）', value(input.frequencyGHz)], ['数据率（Mbit/s）', value(input.dataRateMbps)],
    ['发射辐射功率（dBW）', value(input.eirpDbw)], ['G/T（dB/K）', value(input.gtDbk)],
  ]
}

export function engineSegmentQualityDetails(segment: EngineLinkSegment): Array<{ title: string; rows: string[][] }> {
  return [
    { title: '损耗明细', rows: engineSegmentLossRows(segment.losses) },
    { title: '通信参数', rows: [
      ...engineSegmentInputRows(segment),
      ['抗干扰余量（dB）', value(segment.quality.marginDb)],
      ...(segment.quality.delayMs != null || segment.quality.delay == null ? [['时延（ms）', value(segment.quality.delayMs)]] : []),
      ...(segment.quality.delay != null ? [['时延（原值，单位待确认）', value(segment.quality.delay)]] : []),
    ] },
  ]
}

/** 页面与导出使用相同的源值说明；未确认的量不推算、不补零。 */
export function engineSegmentDetails(segment: EngineLinkSegment): Array<{ title: string; rows: string[][] }> {
  return [
    { title: '链路信息', rows: [
      ['引擎原始状态', value(segment.engineStatus)], ['传输距离（m）', value(segment.distanceM)],
      ['错误信息', value(segment.error)],
    ] },
    ...engineSegmentQualityDetails(segment),
    { title: '干扰来源（计算输入）', rows: segment.inputTrace.jammers.length ? segment.inputTrace.jammers.map(jammer => [
      value(jammer.jammerName),
      `距离 ${value(jammer.distanceM)} m；EIRP ${value(jammer.eirpDbw)} dBW；损耗 ${value(jammer.lossDb)} dB${jammer.frequencyGHz == null ? '' : `；频段 ${value(jammer.frequencyGHz)} GHz`}`,
    ]) : [['干扰来源', '本帧未提供']] },
  ]
}
