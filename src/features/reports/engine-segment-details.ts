import type { EngineLinkSegment } from '../../contracts/domain-models'

/** 页面与导出使用相同的源值说明；未确认的量不推算、不补零。 */
export function engineSegmentDetails(segment: EngineLinkSegment): Array<{ title: string; rows: string[][] }> {
  const value = (raw: string | number | null | undefined) => raw == null || raw === '' ? '暂无数据' : String(raw)
  return [
    { title: '链路信息', rows: [
      ['引擎原始状态', value(segment.engineStatus)], ['传输距离（m）', value(segment.distanceM)],
      ['错误信息', value(segment.error)],
    ] },
    { title: '损耗明细', rows: [
      ['自由空间损耗（dB）', value(segment.losses.freeSpaceDb)], ['海面多径损耗（dB）', value(segment.losses.seaMultipathDb)],
      ['大气损耗（dB）', value(segment.losses.atmosphericDb)], ['雨衰损耗（dB）', value(segment.losses.rainDb)],
      ['云衰损耗（dB）', value(segment.losses.cloudDb)], ['云雨合并损耗（dB）', value(segment.losses.cloudRainDb)],
      ['干扰损耗（dB）', value(segment.losses.jammingDb)], ['总复合损耗（dB，原值，口径待确认）', value(segment.losses.totalDb)],
    ] },
    { title: '通信参数', rows: [
      ['频率（GHz）', value(segment.inputTrace.frequencyGHz)], ['数据率（Mbps）', value(segment.inputTrace.dataRateMbps)],
      ['EIRP（dBW）', value(segment.inputTrace.eirpDbw)], ['G/T（dB/K）', value(segment.inputTrace.gtDbk)],
      ['时延（原值，单位待确认）', value(segment.quality.delay)],
    ] },
    { title: '干扰来源（计算输入）', rows: segment.inputTrace.jammers.length ? segment.inputTrace.jammers.map(jammer => [
      value(jammer.jammerName), `距离 ${value(jammer.distanceM)} m；EIRP ${value(jammer.eirpDbw)} dBW；损耗 ${value(jammer.lossDb)} dB`,
    ]) : [['干扰来源', '本帧未提供']] },
  ]
}
