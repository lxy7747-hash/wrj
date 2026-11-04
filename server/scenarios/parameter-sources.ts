import type { EquipmentParameter, EquipmentReference, Link, LinkParameterSource, MasterData, MasterDataReference, ScenarioConfig, ScenarioDraft, ScenarioParameterCatalog } from '../../src/contracts/domain-models.js'
import { isLinkParameterSource } from '../../src/features/scenarios/link-parameter-source.js'
import { prepareLinkEquipment } from '../../src/features/scenarios/link-equipment-parameters.js'
import { prepareLinkMasterData } from '../../src/features/scenarios/link-master-parameters.js'
import { matchesPortSource, portParameterTargets, preparePortEquipment, preparePortMasterData } from '../../src/features/scenarios/port-parameter-source.js'

export class ParameterSourceError extends Error {
  constructor(readonly code: 'CONFLICT' | 'VALIDATION_FAILED', readonly fieldPath: string, message: string) {
    super(message)
  }
}

/** The Link contract owns the wire field; this narrow reader also tolerates old links without it. */
export function readLinkParameterSource(link: Link): LinkParameterSource | undefined {
  const value = (link as Link & { parameterSource?: unknown }).parameterSource
  if (value === undefined) return undefined
  if (!isLinkParameterSource(value)) {
    throw new ParameterSourceError('VALIDATION_FAILED', 'parameterSource', '参数来源字段不正确。')
  }
  return structuredClone(value)
}

export function parameterCatalog(equipment: EquipmentParameter[], masterData: MasterData[]): ScenarioParameterCatalog {
  return {
    equipment: equipment.filter(item => item.active !== false).map(item => structuredClone(item)),
    masterData: masterData.filter(item => item.active).map(item => structuredClone(item)),
  }
}

function sameFields(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((field, index) => field === right[index]) }
function fieldValue(link: Link, field: string): unknown {
  if (field === 'antennaGain.tx') return link.antennaGain.tx
  if (field === 'antennaGain.rx') return link.antennaGain.rx
  return (link as unknown as Record<string, unknown>)[field]
}
function matches(link: Link, prepared: Link, fields: readonly string[]): boolean { return fields.every(field => Object.is(fieldValue(link, field), fieldValue(prepared, field))) }

export interface MemoryParameterSourceAccess {
  equipment(): EquipmentParameter[]
  equipmentHistory(id: string): EquipmentParameter[]
  masterData(): MasterData[]
  masterHistory(id: string): MasterData[]
  setEquipmentReference(reference: EquipmentReference, remove: boolean): void
  addMasterReference(reference: MasterDataReference): void
}

export function portParameterSourceChanges(previous: ScenarioConfig | undefined, draft: ScenarioDraft) {
  const before = new Map(previous ? portParameterTargets(previous).map(target => [target.id, target]) : [])
  const after = new Map(portParameterTargets(draft.config).map(target => [target.id, target]))
  return [...new Set([...before.keys(), ...after.keys()])].map(id => {
    const target = after.get(id)
    const old = before.get(id)?.parameters.parameterSource
    const source = target?.parameters.parameterSource
    if (source && !isLinkParameterSource(source)) throw new ParameterSourceError('VALIDATION_FAILED', `${target!.path}.parameterSource`, '端口来源格式不正确。')
    const unchanged = source !== undefined && old !== undefined && source.kind === old.kind && source.sourceId === old.sourceId
      && source.sourceVersion === old.sourceVersion && source.entryKey === old.entryKey && sameFields(source.fields, old.fields)
    return { id, target, old, source, unchanged }
  })
}

export function validatePortParameterSources(previous: ScenarioConfig | undefined, draft: ScenarioDraft, read: {
  equipment(id: string, version: number, historical: boolean): EquipmentParameter | undefined
  master(id: string, version: number, historical: boolean): MasterData | undefined
}): void {
  for (const { target, source, unchanged } of portParameterSourceChanges(previous, draft)) {
    if (!target || !source) continue
    const path = `${target.path}.parameterSource`
    if (source.entryKey !== undefined) throw new ParameterSourceError('VALIDATION_FAILED', path, '端口仅引用公共数字参数，不接受枚举条目选择。')
    const record = source.kind === 'EQUIPMENT' ? read.equipment(source.sourceId, source.sourceVersion, unchanged) : read.master(source.sourceId, source.sourceVersion, unchanged)
    if (!record || record.version !== source.sourceVersion || (!unchanged && (record.active === false || ('readOnly' in record && record.readOnly)))) {
      throw new ParameterSourceError('CONFLICT', path, '端口参数来源不存在、已停用、只读或版本已变化。')
    }
    const prepared = source.kind === 'EQUIPMENT'
      ? preparePortEquipment(target, { ...record, active: true, readOnly: false } as EquipmentParameter)
      : preparePortMasterData(target, { ...record, active: true } as MasterData, unchanged)
    if (!prepared.ok || !sameFields(source.fields, prepared.fields) || !matchesPortSource(target.parameters, prepared.parameters, source.fields)) {
      throw new ParameterSourceError('VALIDATION_FAILED', path, prepared.ok ? '端口参数与所选来源不一致。' : prepared.message)
    }
  }
}

/** Pure Mock uses the same mapping guards before committing its in-memory scene. */
export function createMemoryParameterSourceCoordinator(access: MemoryParameterSourceAccess) {
  const validate = (previous: ScenarioConfig | undefined, draft: ScenarioDraft): void => {
    validatePortParameterSources(previous, draft, {
      equipment: (id, version, historical) => (historical ? access.equipmentHistory(id) : access.equipment()).find(record => record.equipmentId === id && record.version === version),
      master: (id, version, historical) => (historical ? access.masterHistory(id) : access.masterData()).find(record => record.dataId === id && record.version === version),
    })
    for (const [index, link] of draft.config.links.entries()) {
      const source = readLinkParameterSource(link)
      if (!source) continue
      const old = previous?.links.find(item => item.id === link.id)
      const oldSource = old && readLinkParameterSource(old)
      const unchanged = oldSource !== undefined && oldSource.kind === source.kind && oldSource.sourceId === source.sourceId
        && oldSource.sourceVersion === source.sourceVersion && oldSource.entryKey === source.entryKey && sameFields(oldSource.fields, source.fields)
      if (source.kind === 'EQUIPMENT') {
        const record = (unchanged ? access.equipmentHistory(source.sourceId) : access.equipment()).find(item => item.version === source.sourceVersion && item.equipmentId === source.sourceId)
        if (!record || (!unchanged && (record.active === false || record.readOnly))) throw new ParameterSourceError('CONFLICT', `links[${index}].parameterSource`, '装备来源不存在、不可用或版本已变化。')
        const prepared = prepareLinkEquipment(link, unchanged ? { ...record, active: true, readOnly: false } : record, draft.config.platforms, unchanged)
        if (!prepared.ok || !sameFields(source.fields, prepared.ok ? prepared.fields : []) || !matches(link, prepared.ok ? prepared.link : link, source.fields)) {
          throw new ParameterSourceError('VALIDATION_FAILED', `links[${index}].parameterSource`, prepared.ok ? '链路参数与装备来源不一致。' : prepared.message)
        }
      } else {
        const record = (unchanged ? access.masterHistory(source.sourceId) : access.masterData()).find(item => item.version === source.sourceVersion && item.dataId === source.sourceId)
        if (!record || (!unchanged && !record.active)) throw new ParameterSourceError('CONFLICT', `links[${index}].parameterSource`, '通用基础数据不存在、已停用或版本已变化。')
        const prepared = prepareLinkMasterData(link, unchanged ? { ...record, active: true } : record, draft.config.platforms, source.entryKey, unchanged)
        if (!prepared.ok || !sameFields(source.fields, prepared.ok ? prepared.fields : []) || !matches(link, prepared.ok ? prepared.link : link, source.fields)) {
          throw new ParameterSourceError('VALIDATION_FAILED', `links[${index}].parameterSource`, prepared.ok ? '链路参数与通用基础数据不一致。' : prepared.message)
        }
      }
    }
  }
  const commit = (previous: ScenarioConfig | undefined, draft: ScenarioDraft): void => {
    for (const { id, old, source, unchanged } of portParameterSourceChanges(previous, draft)) {
      if (old?.kind === 'EQUIPMENT' && (!source || source.kind !== old.kind || source.sourceId !== old.sourceId || source.sourceVersion !== old.sourceVersion)) {
        access.setEquipmentReference({ equipmentId: old.sourceId, scenarioId: draft.config.scenario.id, linkId: id, equipmentVersion: old.sourceVersion }, true)
      }
      if (!source || unchanged) continue
      if (source.kind === 'EQUIPMENT') access.setEquipmentReference({ equipmentId: source.sourceId, scenarioId: draft.config.scenario.id, linkId: id, equipmentVersion: source.sourceVersion }, false)
      else access.addMasterReference({ dataId: source.sourceId, dataVersion: source.sourceVersion, targetType: 'SCENARIO', targetId: draft.config.scenario.id, targetVersion: String(draft.revision) })
    }
    for (const link of draft.config.links) {
      const source = readLinkParameterSource(link)
      const oldSource = previous?.links.find(item => item.id === link.id) && readLinkParameterSource(previous.links.find(item => item.id === link.id)!)
      const unchanged = oldSource !== undefined && source !== undefined && oldSource.kind === source.kind && oldSource.sourceId === source.sourceId
        && oldSource.sourceVersion === source.sourceVersion && oldSource.entryKey === source.entryKey && sameFields(oldSource.fields, source.fields)
      if (oldSource?.kind === 'EQUIPMENT' && (!source || source.kind !== 'EQUIPMENT' || source.sourceId !== oldSource.sourceId)) access.setEquipmentReference({ equipmentId: oldSource.sourceId, scenarioId: draft.config.scenario.id, linkId: link.id, equipmentVersion: oldSource.sourceVersion }, true)
      if (!source || unchanged) continue
      if (source.kind === 'EQUIPMENT') access.setEquipmentReference({ equipmentId: source.sourceId, scenarioId: draft.config.scenario.id, linkId: link.id, equipmentVersion: source.sourceVersion }, false)
      else {
        access.addMasterReference({ dataId: source.sourceId, dataVersion: source.sourceVersion, targetType: 'SCENARIO', targetId: draft.config.scenario.id, targetVersion: String(draft.revision) })
      }
    }
    for (const old of previous?.links ?? []) {
      if (draft.config.links.some(link => link.id === old.id)) continue
      const source = readLinkParameterSource(old)
      if (source?.kind === 'EQUIPMENT') access.setEquipmentReference({ equipmentId: source.sourceId, scenarioId: draft.config.scenario.id, linkId: old.id, equipmentVersion: source.sourceVersion }, true)
    }
  }
  return { validate, commit }
}
