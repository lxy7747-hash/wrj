// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
const { mkdtempSync, readFileSync, rmSync } = await import('node:' + 'fs')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createHash } = await import('node:' + 'crypto')
import type { EquipmentParameter, EquipmentReference, MasterData, Platform } from '../../src/contracts/domain-models'
const { ScenarioSqliteStorage } = await import('../../server/local/' + 'scenario-sqlite')
const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite')
const { MasterDataSqliteStorage } = await import('../../server/local/' + 'master-data-sqlite')
const { TemplateSqliteStorage } = await import('../../server/local/' + 'template-sqlite')
import { createScenarioSnapshot, parseScenarioSnapshot } from '../../src/features/scenarios/scenario-snapshot'
import { buildLocalSceneImport } from '../../src/features/scenarios/local-scene-import'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'
import { readPortParameters } from '../../src/features/scenarios/template-defaults'
import { portParameterTargets, preparePortEquipment, preparePortMasterData } from '../../src/features/scenarios/port-parameter-source'
import { createTemplateScenario } from '../fixtures/template-scenario'
import { createBackupFixture } from '../fixtures/system-backup'
const { auditTemplateScenarios } = await import('../../scripts/' + 'template-alignment-audit')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection')
const { createMemoryParameterSourceCoordinator } = await import('../../server/scenarios/' + 'parameter-sources')
const { prepareEquipmentScenes } = await import('../../server/admin/' + 'equipment-sync')
const { buildMissionPackage } = await import('../../server/scripts/' + 'mission-generator')

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()) })
function stores(sources = false) {
  const directory = mkdtempSync(join(tmpdir(), 'wrj-template-storage-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const scenePath = join(directory, 'scenes.db'), equipmentPath = join(directory, 'equipment.db'), masterDataPath = join(directory, 'master.db')
  const scenes = new ScenarioSqliteStorage(scenePath, sources ? { equipmentPath, masterDataPath } : undefined)
  cleanup.push(() => scenes.close())
  const equipment = new EquipmentSqliteStorage(equipmentPath, scenePath), master = new MasterDataSqliteStorage(masterDataPath)
  cleanup.push(() => { equipment.close(); master.close() })
  return { directory, scenePath, scenes, equipment, master }
}
function draft() {
  const value = createTemplateScenario()
  value.config.deviceParameters = { ports: { MISSION_UAV_PLATFORM: { microwave_link: readPortParameters(value.config, 'MISSION_UAV_PLATFORM', 'microwave_link')! } }, antennaGains: { LASER_COMM_ANTENNA: 42 } }
  return value
}
const radio: EquipmentParameter = { equipmentId: 'PORT-RADIO', type: '微波通信设备', version: 1, readOnly: false, active: true,
  frequencyMinMHz: 7000, frequencyMaxMHz: 9000, bandwidthMHz: 5, txPowerW: 20, dataRateMbps: 80, modulation: 'BPSK', berThreshold: 0.001 }
const dictionary: MasterData = { dataId: 'PORT-NOISE', kind: 'PARAMETER_DICTIONARY', version: 1, active: true, referenceCount: 0,
  content: { name: '端口噪声', description: '', entries: [{ key: 'noiseFigureDb', valueType: 'NUMBER', value: 6, unit: 'dB' }] } }

describe('新模板字段存储与来源', () => {
  it('SQLite和JSON快照保留新字段，旧场景不在存储层补入默认端口', () => {
    const { scenes } = stores()
    const value = draft()
    expect(inspectScenarioConfig(value.config, 'write').result.errors).toEqual([])
    expect(scenes.save(value, undefined)).toBe(true)
    expect(scenes.load(value.config.scenario.id)?.config).toEqual(value.config)
    const snapshot = JSON.parse(JSON.stringify(createScenarioSnapshot(value)))
    expect(parseScenarioSnapshot(snapshot)?.config).toEqual(value.config)
    const old = createTemplateScenario()
    old.config.scenario.id = 'SCN-OLD'
    delete old.config.deviceParameters
    delete old.config.scenario.realtime
    old.config.platforms.forEach(platform => { delete platform.loiterWaypoints; delete platform.returnPlan })
    old.config.jammers.forEach(jammer => { delete jammer.detectionMinimumRange })
    expect(scenes.save(old, undefined)).toBe(true)
    const loaded = scenes.load('SCN-OLD')!
    expect(loaded.config.deviceParameters).toBeUndefined()
    expect(loaded.config.scenario.realtime).toBeUndefined()
    expect(loaded.config.platforms.every((platform: Platform) => platform.loiterWaypoints === undefined && platform.returnPlan === undefined)).toBe(true)
    expect(buildMissionPackage(loaded).files['comm_platform_MISSION_UAV.txt']).toContain('platform_type MISSION_UAV_PLATFORM')
    expect(scenes.load('SCN-OLD')?.config.deviceParameters).toBeUndefined()
  })

  it('模板库往返保留端口、盘旋、返航与侦测最小距离', () => {
    const { directory } = stores()
    const templates = new TemplateSqliteStorage(join(directory, 'templates.db'))
    cleanup.push(() => templates.close())
    const value = draft()
    const template = { templateId: 'TPL-NEW', name: '新模板字段', version: '1', official: false, referenceCount: 0, config: value.config, uiExtensions: value.uiExtensions }
    expect(templates.save(template)).toBe(true)
    expect(templates.load()[0]?.config).toEqual(value.config)
  })

  it('本地节点导入只更新选中位置，不丢失现有端口和平台的新字段', () => {
    const value = draft()
    const platform = value.config.platforms.find(platform => platform.id === 'mission_uav_02')!
    const initial = { fileName: 'events.csv', sha256: 'a'.repeat(64), nodes: [{ platformId: 'raw-uav', name: platform.name, type: 'MISSION_UAV_PLATFORM',
      ...platform.initialPosition, speed: 0, time: 0, sourceEventId: 'LOG-1' }] }
    const result = buildLocalSceneImport(value.config, { initial, positions: null, nodes: [{ sourceId: 'raw-uav', targetId: platform.id, selected: true, useLatest: false }], links: [] })
    expect(result.errors).toEqual([])
    expect(result.config).toEqual(value.config)
  })

  it('端口来源在同一事务校验、登记、重载；伪造参数回滚，取消来源才释放装备引用', () => {
    const { scenes, equipment, master } = stores(true)
    equipment.save(radio)
    master.save(dictionary)
    const value = draft()
    const target = portParameterTargets(value.config)[0]!
    const prepared = preparePortEquipment(target, radio)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.message)
    Object.assign(target.parameters, prepared.parameters, { parameterSource: { kind: 'EQUIPMENT', sourceId: radio.equipmentId, sourceVersion: 1, fields: prepared.fields } })
    expect(scenes.save(value, undefined)).toBe(true)
    expect(equipment.details(radio.equipmentId).references).toEqual([{ equipmentId: radio.equipmentId, scenarioId: value.config.scenario.id, linkId: target.id, equipmentVersion: 1 }])
    expect(equipment.delete(radio.equipmentId, 1)).toBe(false)
    const bad = structuredClone(value)
    bad.revision++
    bad.config.deviceParameters!.ports!.MISSION_UAV_PLATFORM!.microwave_link!.txPower = 99
    expect(() => scenes.save(bad, { id: value.config.scenario.id, revision: value.revision })).toThrow(/端口参数与/)
    expect(scenes.load(value.config.scenario.id)?.revision).toBe(value.revision)
    const saved = scenes.load(value.config.scenario.id)!
    saved.revision++
    delete saved.config.deviceParameters!.ports!.MISSION_UAV_PLATFORM!.microwave_link!.parameterSource
    expect(scenes.save(saved, { id: value.config.scenario.id, revision: value.revision })).toBe(true)
    expect(equipment.details(radio.equipmentId).references).toEqual([])
    expect(equipment.delete(radio.equipmentId, 1)).toBe(true)
  })

  it('公共来源按明确字段及单位核对，错单位/枚举/不符设备类型不能冒充端口值', () => {
    const { scenes, master } = stores(true)
    master.save(dictionary)
    const value = draft(), target = portParameterTargets(value.config)[0]!
    const prepared = preparePortMasterData(target, dictionary)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(prepared.message)
    Object.assign(target.parameters, prepared.parameters, { parameterSource: { kind: 'MASTER_DATA', sourceId: dictionary.dataId, sourceVersion: 1, fields: prepared.fields } })
    expect(scenes.save(value, undefined)).toBe(true)
    expect(master.details(dictionary.dataId).references).toHaveLength(1)
    expect(scenes.load(value.config.scenario.id)?.config.deviceParameters).toEqual(value.config.deviceParameters)
    expect(preparePortMasterData(target, { ...dictionary, content: { ...dictionary.content!, entries: [{ key: 'noiseFigureDb', valueType: 'NUMBER', value: 6, unit: 'MHz' }] } }).ok).toBe(false)
    expect(preparePortEquipment(target, { ...radio, type: '卫星通信设备' }).ok).toBe(false)
    expect(preparePortEquipment(target, { ...radio, frequencyMinMHz: 1, frequencyMaxMHz: 2 }).ok).toBe(false)
    expect(preparePortMasterData(target, { ...dictionary, kind: 'ENUMERATION', content: { name: '枚举', description: '', entries: [{ key: 'modulation.BPSK', valueType: 'TEXT', value: 'BPSK' }] } }).ok).toBe(false)
  })

  it('体检只读数据库且不补默认值，库内容哈希不变', () => {
    const { scenes, scenePath } = stores()
    const value = draft()
    scenes.save(value, undefined)
    const hash = () => createHash('sha256').update(readFileSync(scenePath)).digest('hex')
    const before = hash()
    expect(auditTemplateScenarios(scenePath)).toMatchObject([{ scenarioId: value.config.scenario.id, valid: true, errors: [] }])
    expect(hash()).toBe(before)
  })

  it('完整系统备份恢复保留新配置字段，历史文件归档仍保持原快照', () => {
    const f = createBackupFixture()
    cleanup.push(() => f.close())
    const value = draft()
    expect(f.scenario.save(value, undefined)).toBe(true)
    const archiveBefore = f.archive.get(f.archived.archiveId)
    expect(f.backup.backup('TEMPLATE', '新模板字段备份').ok).toBe(true)
    const changed = structuredClone(value)
    changed.revision++
    changed.config.scenario.realtime = false
    changed.config.deviceParameters!.antennaGains!.LASER_COMM_ANTENNA = 12
    expect(f.scenario.save(changed, { id: value.config.scenario.id, revision: value.revision })).toBe(true)
    expect(f.backup.restore('TEMPLATE')).toMatchObject({ ok: true, data: { integrityValid: true } })
    expect(f.scenario.load(value.config.scenario.id)?.config).toEqual(value.config)
    expect(f.archive.get(f.archived.archiveId)).toEqual(archiveBefore)
  })

  it('内存正式场景入口同样登记端口来源，装备更新只同步匹配端口且锁定时整批拒绝', () => {
    let references: EquipmentReference[] = []
    const coordinator = createMemoryParameterSourceCoordinator({ equipment: () => [radio], equipmentHistory: () => [radio], masterData: () => [], masterHistory: () => [],
      setEquipmentReference: (reference: EquipmentReference, remove: boolean) => { references = remove ? references.filter(row => row.linkId !== reference.linkId) : [...references, reference] },
      addMasterReference: () => { throw new Error('No master source in this case') },
    })
    const scenes = new ScenarioProjection(undefined, coordinator)
    const value = draft(), target = portParameterTargets(value.config)[0]!
    const prepared = preparePortEquipment(target, radio)
    if (!prepared.ok) throw new Error(prepared.message)
    Object.assign(target.parameters, prepared.parameters, { parameterSource: { kind: 'EQUIPMENT', sourceId: radio.equipmentId, sourceVersion: 1, fields: prepared.fields } })
    expect(scenes.create({ config: value.config, uiExtensions: value.uiExtensions, expectedRevision: 0 }).ok).toBe(true)
    expect(references).toHaveLength(1)
    const updated = prepareEquipmentScenes({ ...radio, txPowerW: 25, version: 2 }, references, scenes)
    expect(updated.ok).toBe(true)
    if (!updated.ok) throw new Error(updated.message)
    expect(updated.data[0].after.config.deviceParameters.ports.MISSION_UAV_PLATFORM.microwave_link).toMatchObject({ txPower: 25, parameterSource: { sourceVersion: 2 } })
    expect(updated.data[0].after.config.links).toEqual(value.config.links)
    scenes.setLocked(value.config.scenario.id, true)
    expect(prepareEquipmentScenes({ ...radio, txPowerW: 25, version: 2 }, references, scenes)).toMatchObject({ ok: false, code: 'CONFIG_LOCKED' })
  })
})
