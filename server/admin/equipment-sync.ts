import type { EquipmentParameter, EquipmentReference, ScenarioDraft, Link } from '../../src/contracts/domain-models.js'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation.js'
import type { ScenarioProjection } from '../scenarios/projection.js'
import type { AdminResult } from './projection.js'

export interface EquipmentSceneUpdate { before: ScenarioDraft; after: ScenarioDraft }

/** 先检查全部引用，再提交一次；频率是范围而非默认点，不能替用户选频。 */
export function prepareEquipmentScenes(record: EquipmentParameter, references: EquipmentReference[], scenarios: ScenarioProjection): AdminResult<EquipmentSceneUpdate[]> {
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
    if (record.frequencyMinMHz !== null && (link.frequency < record.frequencyMinMHz || link.frequency > record.frequencyMaxMHz!)) {
      return { ok: false, status: 422, code: 'VALIDATION_FAILED', fieldPath: `${fieldPath}.frequency`, message: `场景 ${reference.scenarioId}／链路 ${reference.linkId} 的频率不在新装备范围内，请先调整场景；未自动选频。` }
    }
    if (record.bandwidthMHz != null) link.bandwidth = record.bandwidthMHz
    if (record.txPowerW != null) link.txPower = record.txPowerW
    if (record.dataRateMbps != null) link.dataRate = record.dataRateMbps
    if (record.modulation !== null) link.modulation = record.modulation as Link['modulation']
    if (record.berThreshold !== null) link.berThreshold = record.berThreshold
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
