import type {
  DeterministicFixtureSet,
  ResetResult,
  TaskId,
  WsTopic,
} from '../../src/contracts/domain-models.js'
import { loadFixtureProjection } from '../fixtures/source.js'

type SequenceCounters = Map<TaskId, Map<WsTopic, number>>

interface RuntimeState {
  projection: DeterministicFixtureSet
  sequenceCounters: SequenceCounters
}

function createRuntimeState(): RuntimeState {
  return {
    projection: loadFixtureProjection(),
    sequenceCounters: new Map(),
  }
}

export class MockProjection {
  private runtimeState = createRuntimeState()

  snapshot(): DeterministicFixtureSet {
    return structuredClone(this.runtimeState.projection)
  }

  reset(): ResetResult {
    // Replacing the owner object resets the projection and all sequence counters as one boundary.
    const nextRuntimeState = createRuntimeState()
    this.runtimeState = nextRuntimeState

    const { requestId, responseGeneratedAt, nextSequence } = nextRuntimeState.projection.reset
    return structuredClone({
      requestId,
      generatedAt: responseGeneratedAt,
      nextSequence,
    })
  }

  nextSequence(taskId: TaskId, topic: WsTopic): number {
    let topicCounters = this.runtimeState.sequenceCounters.get(taskId)
    if (topicCounters === undefined) {
      topicCounters = new Map()
      this.runtimeState.sequenceCounters.set(taskId, topicCounters)
    }

    const sequence = topicCounters.get(topic) ?? 1
    topicCounters.set(topic, sequence + 1)
    return sequence
  }
}
