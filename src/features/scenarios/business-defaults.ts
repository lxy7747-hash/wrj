import type { InformationDemand, LinkDirection } from '../../contracts/domain-models'

/** 文档前向指令、返向视频默认值；信息量统一为 MB，速率为 Mbps。 */
export const BUSINESS_DEFAULTS = {
  FORWARD: { informationType: '目标指令', volumeMb: 0.000256, frequencyHz: 1, minDataRateMbps: 0.0256 },
  REVERSE: { informationType: '视频', volumeMb: 2, frequencyHz: 30, minDataRateMbps: 2 },
}

/** 新增时只替换未被用户改动的方向默认值；编辑已有业务保留参数。 */
export function changeBusinessDirection(demand: InformationDemand, direction: LinkDirection, editing: boolean): void {
  if (!editing && demand.direction) {
    const before = BUSINESS_DEFAULTS[demand.direction]
    const after = BUSINESS_DEFAULTS[direction]
    if (demand.informationType === before.informationType) demand.informationType = after.informationType
    for (const key of ['volumeMb', 'frequencyHz', 'minDataRateMbps'] as const) {
      if (demand[key] === before[key]) demand[key] = after[key]
    }
  }
  demand.direction = direction
}
