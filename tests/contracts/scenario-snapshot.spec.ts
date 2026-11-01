import { describe, expect, it } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models'
import { createScenarioSnapshot, parseScenarioSnapshot, scenarioSnapshotId } from '../../src/features/scenarios/scenario-snapshot'

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
})
