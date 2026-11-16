import type { ScenarioConfig } from '../../src/contracts/domain-models.js'
import type { EquipmentPublishedReference, EquipmentTargetType } from '../../src/features/admin/equipment-history-contract.js'
import { portParameterTargets } from '../../src/features/scenarios/port-parameter-source.js'

/**
 * 判断两条发布引用是否指向同一个目标来源。
 * 身份包含来源摘要：同一目标上不同链路或端口引用必须分别登记，不能合并。
 */
export function samePublishedReference(
  left: EquipmentPublishedReference,
  right: EquipmentPublishedReference,
): boolean {
  return left.equipmentId === right.equipmentId && left.equipmentVersion === right.equipmentVersion
    && left.targetType === right.targetType && left.targetId === right.targetId
    && left.targetVersion === right.targetVersion && left.sourceSummary === right.sourceSummary
}

/**
 * 扫描场景配置中所有装备参数来源（链路与平台端口），生成待登记的发布历史引用。
 * 只记录显式 EQUIPMENT 来源；不按参数相等猜测来源，不把历史目标伪装成当前场景引用。
 */
export function scanPublishedParameterSources(
  config: ScenarioConfig,
  target: { targetType: EquipmentTargetType; targetId: string; targetVersion: string },
  createdAt: string,
): EquipmentPublishedReference[] {
  const references: EquipmentPublishedReference[] = []
  for (const link of config.links) {
    const source = link.parameterSource
    if (source?.kind === 'EQUIPMENT') references.push({
      equipmentId: source.sourceId, equipmentVersion: source.sourceVersion, targetType: target.targetType,
      targetId: target.targetId, targetVersion: target.targetVersion,
      sourceSummary: `links[${link.id}].parameterSource fields=${source.fields.join(',')}`, createdAt,
    })
  }
  for (const portTarget of portParameterTargets(config)) {
    const source = portTarget.parameters.parameterSource
    if (source?.kind === 'EQUIPMENT') references.push({
      equipmentId: source.sourceId, equipmentVersion: source.sourceVersion, targetType: target.targetType,
      targetId: target.targetId, targetVersion: target.targetVersion,
      sourceSummary: `${portTarget.path}.parameterSource fields=${source.fields.join(',')}`, createdAt,
    })
  }
  return references
}

/**
 * 在发布提交前登记本次扫描到的全部来源引用，并返回本次真正新增的引用。
 * @param config 将要冻结的完整场景配置。
 * @param target 发布目标身份（类型、编号、版本）。
 * @param createdAt 本次发布时刻，统一写入所有新增引用。
 * @param add 单条登记；已存在同一引用时返回 `false`，不得视为本次新增。
 * @param remove 撤销登记，用于本次登记中途失败时只回滚本次新增项。
 * @returns 本次真正新增的引用列表，供提交失败时精确撤销。
 * @remarks 任一登记失败时先撤销本次新增项再原样抛出，绝不删除先前已存在的引用；
 *          撤销自身失败被吞掉，避免掩盖原始登记错误。
 */
export function registerPublishedParameterSources(
  config: ScenarioConfig,
  target: { targetType: EquipmentTargetType; targetId: string; targetVersion: string },
  createdAt: string,
  add: (reference: EquipmentPublishedReference) => boolean,
  remove: (reference: EquipmentPublishedReference) => void,
): EquipmentPublishedReference[] {
  const inserted: EquipmentPublishedReference[] = []
  try {
    for (const reference of scanPublishedParameterSources(config, target, createdAt)) {
      if (add(reference)) inserted.push(reference)
    }
  } catch (error) {
    for (const reference of inserted) {
      try { remove(reference) } catch { /* 保留原始登记错误 */ }
    }
    throw error
  }
  return inserted
}
