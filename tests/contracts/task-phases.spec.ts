import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import source from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import { taskPhaseIssue } from '../../src/features/scenarios/task-phases'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'
import { snapshotMissionResultParameters, isMissionResultParameters, isMissionResultRecord } from '../../src/features/results/mission-result'
import type { ScenarioDraft } from '../../src/contracts/domain-models'

const phases = [{ id: 'TRANSIT', name: '转场', startTimeS: 0, endTimeS: 5 }, { id: 'MISSION', name: '任务执行', startTimeS: 5, endTimeS: 10 }]
describe('明确保存的任务阶段', () => {
  it('旧配置兼容；相邻阶段合法，保存投影和参数快照不丢失计划且不共用引用', () => {
    expect(taskPhaseIssue(undefined)).toBeNull()
    expect(taskPhaseIssue([])).toBeNull()
    expect(taskPhaseIssue(phases, 10)).toBeNull()
    const config = { ...structuredClone(source.scenario), scenario: { ...source.scenario.scenario, phases: structuredClone(phases) } }
    const inspected = inspectScenarioConfig(config)
    expect(inspected.result.valid).toBe(true)
    expect(inspected.identity?.phases).toEqual(phases)
    const reactiveConfig = reactive(config)
    expect(inspectScenarioConfig(reactiveConfig).identity?.phases).toEqual(phases)
    expect(inspectScenarioConfig(reactiveConfig).identity?.phases).not.toBe(reactiveConfig.scenario.phases)
    const draft = { config, uiExtensions: { sensors: [], jammers: [] }, revision: 1, officialLibraryChanged: false, locked: false } as ScenarioDraft
    const saved = snapshotMissionResultParameters(draft)
    draft.config.scenario.phases![0]!.name = '后来修改'
    expect(saved.phases?.[0]?.name).toBe('转场')
    expect(isMissionResultParameters(saved)).toBe(true)
    expect(isMissionResultParameters({ ...saved, phases: [{ ...phases[0], endTimeS: -1 }] })).toBe(false)
  })
  it.each([
    null, {}, [{ ...phases[0], extra: true }], [{ ...phases[0], id: '' }], [{ ...phases[0], name: ' ' }],
    [{ ...phases[0], startTimeS: -1 }], [{ ...phases[0], endTimeS: Infinity }], [{ ...phases[0], endTimeS: 0 }],
    [{ ...phases[0], endTimeS: 11 }], [phases[0], { ...phases[1], id: 'TRANSIT' }],
    [phases[0], { ...phases[1], startTimeS: 4 }], Array(65).fill(phases[0]),
  ].map(value => ({ value })))('非法阶段计划拒绝写入：%j', ({ value }) => {
    expect(taskPhaseIssue(value, 10)).not.toBeNull()
    const config = structuredClone(source.scenario) as unknown as { scenario: { phases: unknown; duration: number } }
    config.scenario.duration = 10
    config.scenario.phases = value
    expect(inspectScenarioConfig(config).result.errors.some(error => error.code === 'TASK_PHASE_INVALID')).toBe(true)
  })
  it('运行结果显式关联真实run/task，旧六字段记录仍可读', () => {
    const record = { resultId: 'RESULT-00000000-0000-4000-8000-000000000001', scenarioId: 'SCN-001', scenarioName: '场景', revision: 1, startedAt: '2026-10-27T00:00:00Z', completedAt: '2026-10-27T00:00:01Z' }
    expect(isMissionResultRecord(record)).toBe(true)
    expect(isMissionResultRecord({ ...record, runId: 'RUN-TEST', taskId: 'TASK-TEST' })).toBe(true)
    expect(isMissionResultRecord({ ...record, runId: 'RUN-TEST' })).toBe(false)
    expect(isMissionResultRecord({ ...record, runId: '../bad', taskId: 'TASK-TEST' })).toBe(false)
  })
})
