import { beforeAll, describe, expect, it } from 'vitest'
import type {
  DeterministicFixtureSet,
  ResetResult,
  TaskId,
  WsTopic,
} from '../../src/contracts/domain-models.js'

interface MockProjectionInstance {
  snapshot(): DeterministicFixtureSet
  reset(): ResetResult
  nextSequence(taskId: TaskId, topic: WsTopic): number
}

let loadFixtureProjection: () => DeterministicFixtureSet
let MockProjection: new () => MockProjectionInstance

describe('fixture projection', () => {
  beforeAll(async () => {
    const fixtureModulePath = '../../server/fixtures/' + 'source.js'
    const projectionModulePath = '../../server/state/' + 'projection.js'
    const fixtureModule = await import(fixtureModulePath) as {
      loadFixtureProjection: typeof loadFixtureProjection
    }
    const projectionModule = await import(projectionModulePath) as {
      MockProjection: typeof MockProjection
    }

    ;({ loadFixtureProjection } = fixtureModule)
    ;({ MockProjection } = projectionModule)
  })

  it('isolates fixture loads and snapshots from caller mutation', () => {
    const loaded = loadFixtureProjection()
    const projection = new MockProjection()
    const snapshot = projection.snapshot()

    loaded.scenario.scenario.name = 'mutated fixture load'
    loaded.frame.platforms[0].name = 'mutated nested fixture load'
    snapshot.scenario.scenario.name = 'mutated snapshot'
    snapshot.frame.platforms[0].name = 'mutated nested snapshot'

    const cleanLoad = loadFixtureProjection()
    const cleanSnapshot = projection.snapshot()

    expect(cleanLoad.scenario.scenario.name).toBe('跨海通联演示')
    expect(cleanLoad.frame.platforms[0].name).toBe('公共服务平台后方指挥节点')
    expect(cleanSnapshot).toEqual(cleanLoad)
  })

  it('restores a deeply equal baseline without retaining snapshot mutations', () => {
    const baseline = loadFixtureProjection()
    const projection = new MockProjection()
    const mutatedSnapshot = projection.snapshot()

    mutatedSnapshot.run.uiStatus = 'RUNNING'
    mutatedSnapshot.replay.currentTimeS = 900
    mutatedSnapshot.audit[0].action = 'CALLER_MUTATION'

    projection.reset()

    expect(projection.snapshot()).toEqual(baseline)
    expect(loadFixtureProjection()).toEqual(baseline)
  })

  it('increments independently by task and topic and restarts at one after reset', () => {
    const projection = new MockProjection()

    expect(projection.nextSequence('TASK-001', 'simulation.frame')).toBe(1)
    expect(projection.nextSequence('TASK-001', 'simulation.frame')).toBe(2)
    expect(projection.nextSequence('TASK-001', 'runtime.state')).toBe(1)
    expect(projection.nextSequence('TASK-002', 'simulation.frame')).toBe(1)

    projection.reset()

    expect(projection.nextSequence('TASK-001', 'simulation.frame')).toBe(1)
    expect(projection.nextSequence('TASK-001', 'runtime.state')).toBe(1)
    expect(projection.nextSequence('TASK-002', 'simulation.frame')).toBe(1)
  })

  it('returns fixed fixture reset constants in isolated results', () => {
    const projection = new MockProjection()

    const firstResult = projection.reset()
    const expected = {
      requestId: 'REQ-RESET-001',
      generatedAt: '2026-08-06T08:00:00Z',
      nextSequence: 1,
    }

    expect(firstResult).toEqual(expected)

    ;(firstResult as { requestId: string }).requestId = 'CALLER-MUTATION'

    expect(projection.reset()).toEqual(expected)
  })
})
