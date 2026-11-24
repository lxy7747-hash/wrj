import type { InformationDemand, InformationType, LinkDirection } from '../../contracts/domain-models'

/** 文档前向指令、返向侦察默认值（四枚举，不再默认视频）；信息量统一为 MB，速率为 Mbps。 */
export const BUSINESS_DEFAULTS: Record<LinkDirection, { informationType: InformationType; volumeMb: number; frequencyHz: number; minDataRateMbps: number }> = {
  FORWARD: { informationType: '态势信息', volumeMb: 0.000256, frequencyHz: 1, minDataRateMbps: 0.0256 },
  REVERSE: { informationType: '侦察信息', volumeMb: 2, frequencyHz: 30, minDataRateMbps: 2 },
}

/**
 * 切换业务方向：信息类型始终跟随方向默认值（前向=态势信息，返向=侦察信息）；
 * 数据量/频次/速率只在新增且用户尚未改动旧默认值时一起切换，编辑已有业务不覆盖用户参数。
 */
export function changeBusinessDirection(demand: InformationDemand, direction: LinkDirection, editing: boolean): void {
  const before = demand.direction ? BUSINESS_DEFAULTS[demand.direction] : undefined
  const after = BUSINESS_DEFAULTS[direction]
  demand.informationType = after.informationType
  if (!editing && before !== undefined) {
    for (const key of ['volumeMb', 'frequencyHz', 'minDataRateMbps'] as const) {
      if (demand[key] === before[key]) demand[key] = after[key]
    }
  }
  demand.direction = direction
}
