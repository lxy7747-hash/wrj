import { describe, expect, it } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models'
import { createScenarioSnapshot, parseScenarioSnapshot, scenarioSnapshotId, scenarioImportMigrationNotes } from '../../src/features/scenarios/scenario-snapshot'

const config = {
  schemaVersion: '1.0', scenario: { id: 'SCN-ROUNDTRIP' },
} as unknown as ScenarioDraft['config']

describe('场景文件快照外壳', () => {
  it('生成版本化快照并保留配置与界面扩展的独立副本', () => {
    const draft = {
      config,
      uiExtensions: { jammers: [], sensors: [{ sensorId: 'SNS-1', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true,
        esm: { sensitivityDbw: -200, detectionThresholdDb: 0, dwellTimeS: 1, revisitTimeS: 1 } }] },
    } as Pick<ScenarioDraft, 'config' | 'uiExtensions'>
    const snapshot = createScenarioSnapshot(draft)
    expect(parseScenarioSnapshot(snapshot)).toMatchObject({ config: draft.config, uiExtensions: draft.uiExtensions, versioned: true })
    expect(scenarioSnapshotId(snapshot)).toBe('SCN-ROUNDTRIP')
    snapshot.uiExtensions.sensors[0]!.enabled = false
    expect(draft.uiExtensions.sensors[0]!.enabled).toBe(true)
  })

  it('兼容旧版纯配置，拒绝未知文件外壳', () => {
    expect(parseScenarioSnapshot(config)).toEqual({ config, versioned: false })
    expect(parseScenarioSnapshot({ format: 'wrj.scenario.snapshot', version: 2, config, uiExtensions: { jammers: [], sensors: [] } })).toBeUndefined()
    expect(scenarioSnapshotId({ config })).toBeUndefined()
  })

  it('旧版纯配置导入时列出被补齐的运动字段实际值，版本化快照不产生迁移提示', () => {
    const legacy = { schemaVersion: '1.0', scenario: { id: 'SCN-LEGACY' }, platforms: [
      { id: 'P1', waypoints: [{ longitude: 120, latitude: 24, altitude: 1000, speed: 50 }] },
    ] } as unknown as ScenarioDraft['config']
    const imported = { config: { scenario: { id: 'SCN-LEGACY' }, platforms: [
      { id: 'P1', waypoints: [{ longitude: 120, latitude: 24, altitude: 1000, speed: 50, arrivalTime: 42 }] },
    ] } } as unknown as Pick<ScenarioDraft, 'config'>
    expect(scenarioImportMigrationNotes(legacy, imported)).toEqual(['platforms[0].waypoints[0].arrivalTime=42'])
    // 已存在 arrivalTime 的字段不重复提示。
    const importedComplete = { config: { scenario: { id: 'SCN-LEGACY' }, platforms: [
      { id: 'P1', waypoints: [{ longitude: 120, latitude: 24, altitude: 1000, speed: 50, arrivalTime: 7 }] },
    ] } } as unknown as Pick<ScenarioDraft, 'config'>
    const withTime = { ...legacy, platforms: [{ id: 'P1', waypoints: [{ longitude: 120, latitude: 24, altitude: 1000, speed: 50, arrivalTime: 7 }] }] } as unknown as ScenarioDraft['config']
    expect(scenarioImportMigrationNotes(withTime, importedComplete)).toEqual([])
    // 版本化外壳不视为可迁移旧配置。
    const versioned = { format: 'wrj.scenario.snapshot', version: 1, config: legacy, uiExtensions: { jammers: [], sensors: [] } }
    expect(scenarioImportMigrationNotes(versioned, imported)).toEqual([])
  })

  it('激光链路 EIRP/G-T/噪声随快照透传，显式 0 不被丢弃', () => {
    const laserConfig = {
      schemaVersion: '1.0', scenario: { id: 'SCN-LASER' },
      links: [{ id: 'L-LASER', type: 'LASER', sourcePlatformId: 'A', targetPlatformId: 'B',
        frequency: 681_300_000, bandwidth: 1_000, txPower: 0.1, antennaGain: { tx: 45, rx: 45 },
        modulation: 'BPSK', berThreshold: 1e-6, dataRate: 2_500, direction: 'FORWARD',
        eirpDbw: 0, gtDbk: 15, noiseFigureDb: 5 }],
    } as unknown as ScenarioDraft['config']
    const draft = { config: laserConfig, uiExtensions: { jammers: [], sensors: [] } } as Pick<ScenarioDraft, 'config' | 'uiExtensions'>
    const parsed = parseScenarioSnapshot(createScenarioSnapshot(draft))!
    const link = (parsed.config as unknown as { links: Array<Record<string, unknown>> }).links[0]!
    expect(link).toMatchObject({ eirpDbw: 0, gtDbk: 15, noiseFigureDb: 5 })
  })
})
