import type { EquipmentParameter, EquipmentReference, ScenarioDraft, Link } from '../../src/contracts/domain-models.js'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation.js'
import { prepareLinkEquipment } from '../../src/features/scenarios/link-equipment-parameters.js'
import type { ScenarioProjection } from '../scenarios/projection.js'
import type { AdminResult } from './projection.js'

export interface EquipmentSceneUpdate { before: ScenarioDraft; after: ScenarioDraft }

/** 先检查全部引用，再提交一次；频率是范围而非默认点，不能替用户选频。 */
export function prepareEquipmentScenes(record: EquipmentParameter, references: EquipmentReference[], scenarios: ScenarioProjection, allowLegacyType = false): AdminResult<EquipmentSceneUpdate[]> {
  const updates = new Map<string, EquipmentSceneUpdate>()
  for (const reference of references) {
    const fieldPath = `scenarios[${reference.scenarioId}].links[${reference.linkId}]`
    let update = updates.get(reference.scenarioId)
    if (!update) {
      const current = scenarios.get(reference.scenarioId)
      if (!current.ok) return { ...current, fieldPath, message: `引用场景 ${reference.scenarioId} 不可读取：${current.message}` }
      if (current.data.locked) return { ok: false, status: 409, code: 'CONFIG_LOCKED', fieldPath, message: `场景 ${reference.scenarioId} 已锁定，装备和全部引用均未更新。` }
      update = { before: current.data, after: structuredClone(current.data) }
      update.after.revision++
      updates.set(reference.scenarioId, update)
    }
    const link = update.after.config.links.find(item => item.id === reference.linkId)
    if (!link) return { ok: false, status: 409, code: 'CONFLICT', fieldPath, message: `场景 ${reference.scenarioId} 的引用链路 ${reference.linkId} 已不存在。` }
    const prepared = prepareLinkEquipment(link, record, update.after.config.platforms, allowLegacyType)
    if (!prepared.ok) return { ok: false, status: 422, code: 'VALIDATION_FAILED', fieldPath: `${fieldPath}.${prepared.fieldPath}`, message: prepared.message }
    const source = (link as Link & { parameterSource?: { kind?: unknown; sourceId?: unknown; sourceVersion?: unknown; fields?: unknown; entryKey?: unknown } }).parameterSource
    if (source?.kind === 'EQUIPMENT' && source.sourceId === record.equipmentId) {
      if (prepared.fields.length === 0) return { ok: false, status: 422, code: 'VALIDATION_FAILED', fieldPath: `${fieldPath}.parameterSource`, message: '装备未配置可同步的链路参数，不能保留参数来源。' }
      Object.assign(link, prepared.link, {
        parameterSource: { ...source, sourceVersion: record.version, fields: prepared.fields },
      })
      continue
    }
    Object.assign(link, prepared.link)
  }
  for (const { after } of updates.values()) {
    const validation = inspectScenarioConfig(after.config, 'write').result
    if (!validation.valid) {
      const issue = validation.errors[0]!
      return { ok: false, status: 422, code: 'VALIDATION_FAILED', fieldPath: `scenarios[${after.config.scenario.id}].${issue.fieldPath}`, message: `引用场景 ${after.config.scenario.id} 校验失败：${issue.message}` }
    }
  }
  return { ok: true, data: [...updates.values()] }
}
