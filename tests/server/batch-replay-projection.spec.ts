import { beforeAll, describe, expect, it } from 'vitest'
import type { Batch, Replay } from '../../src/contracts/domain-models'

type ProjectionResult<T> = { ok: true; data: T } | { ok: false; code: string; status: number; fieldPath?: string }

interface BatchReplayProjectionInstance {
  listBatches(): Batch[]
  createBatch(value: unknown): ProjectionResult<Batch>
  getBatch(batchId: string): ProjectionResult<{ batch: Batch; runs: unknown[]; aggregateReport: unknown }>
  commandBatch(batchId: string, value: unknown): ProjectionResult<Batch>
  listReplays(): Replay[]
  getReplay(replayId: string): ProjectionResult<Replay>
  commandReplay(replayId: string, value: unknown): ProjectionResult<Replay>
  reset(): void
}

let BatchReplayProjection: new () => BatchReplayProjectionInstance

const validBatchRequest = {
  scenarioId: 'SCN-001',
  powersW: [50, 100, 150, 200],
  distancesKm: [80, 100, 120],
  deterministicOrder: true,
}

beforeAll(async () => {
  const modulePath = '../../server/batch-replay/' + 'projection.js'
  const module = await import(modulePath) as { BatchReplayProjection: typeof BatchReplayProjection }
  ;({ BatchReplayProjection } = module)
})

describe('P6 批次与回放服务端投影', () => {
  it('读取固定 12 行批次详情且返回防御性副本', () => {
    const projection = new BatchReplayProjection()
    expect(projection.listBatches()).toMatchObject([{ batchId: 'BATCH-001', state: 'COMPLETED' }])
    const detail = projection.getBatch('BATCH-001')
    expect(detail).toMatchObject({ ok: true, data: { batch: { runIds: expect.any(Array) }, runs: expect.any(Array) } })
    if (detail.ok) {
      expect(detail.data.runs).toHaveLength(12)
      detail.data.batch.state = 'ERROR'
    }
    expect(projection.listBatches()[0]?.state).toBe('COMPLETED')
    expect(projection.getBatch('BATCH-MISSING')).toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404 })
  })

  it('校验批量请求并执行启动、取消和非法迁移', () => {
    const projection = new BatchReplayProjection()
    for (const request of [null, {}, { scenarioId: 'BAD', powersW: [50], distancesKm: [80], deterministicOrder: true }, {
      scenarioId: 'SCN-001', powersW: [-1], distancesKm: [80], deterministicOrder: true,
    }, { scenarioId: 'SCN-001', powersW: [50], distancesKm: [80], deterministicOrder: false }, {
      scenarioId: 'SCN-001', powersW: [50], distancesKm: [80], deterministicOrder: true, extra: true,
    }]) expect(projection.createBatch(request)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(projection.createBatch({ scenarioId: 'SCN-MISSING', powersW: [50], distancesKm: [80], deterministicOrder: true }))
      .toMatchObject({ ok: false, fieldPath: 'scenarioId' })
    expect(projection.createBatch({ scenarioId: 'SCN-001', powersW: [50], distancesKm: [80], deterministicOrder: true }))
      .toMatchObject({ ok: false, fieldPath: 'request' })
    expect(projection.createBatch({ scenarioId: 'SCN-001', powersW: [1, 2, 3], distancesKm: [4, 5, 6, 7], deterministicOrder: true }))
      .toMatchObject({ ok: false, fieldPath: 'request' })

    expect(projection.commandBatch('BATCH-MISSING', { command: 'START' })).toMatchObject({ ok: false, status: 404 })
    expect(projection.commandBatch('BATCH-001', { command: 'START' })).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' })
    expect(projection.createBatch(validBatchRequest))
      .toMatchObject({ ok: true, data: { state: 'QUEUED' } })
    expect(projection.getBatch('BATCH-001')).toMatchObject({ ok: false, status: 409 })
    expect(projection.commandBatch('BATCH-001', { command: 'BAD' })).toMatchObject({ ok: false, status: 422 })
    expect(projection.commandBatch('BATCH-001', { command: 'START' })).toMatchObject({ ok: true, data: { state: 'COMPLETED' } })
    projection.createBatch(validBatchRequest)
    expect(projection.commandBatch('BATCH-001', { command: 'CANCEL' })).toMatchObject({ ok: true, data: { state: 'CANCELLED' } })
    expect(projection.getBatch('BATCH-001')).toMatchObject({ ok: false, status: 409 })
  })

  it('拒绝批次终态与固定运行结果不一致', () => {
    const projection = new BatchReplayProjection()
    ;(projection as unknown as { batch: Batch }).batch.state = 'PARTIAL_FAILURE'
    expect(projection.getBatch('BATCH-001')).toMatchObject({ ok: false, code: 'INTERNAL_FIXTURE_ERROR', status: 409 })
  })

  it('回放命令只改变游标、播放状态和倍速校验', () => {
    const projection = new BatchReplayProjection()
    expect(projection.listReplays()).toMatchObject([{ replayId: 'REPLAY-001', runId: 'RUN-001' }])
    expect(projection.getReplay('REPLAY-MISSING')).toMatchObject({ ok: false, status: 404 })
    expect(projection.commandReplay('REPLAY-MISSING', { command: 'PLAY' })).toMatchObject({ ok: false, status: 404 })
    for (const command of [{}, { command: 'PLAY', value: 1 }, { command: 'SEEK' }, { command: 'SPEED', value: Number.NaN }]) {
      expect(projection.commandReplay('REPLAY-001', command)).toMatchObject({ ok: false, status: 422 })
    }
    expect(projection.commandReplay('REPLAY-001', { command: 'PAUSE' })).toMatchObject({ ok: false, status: 409 })
    expect(projection.commandReplay('REPLAY-001', { command: 'PLAY' })).toMatchObject({ ok: true, data: { state: 'PLAYING' } })
    expect(projection.commandReplay('REPLAY-001', { command: 'PLAY' })).toMatchObject({ ok: false, status: 409 })
    expect(projection.commandReplay('REPLAY-001', { command: 'SEEK', value: 2539 })).toMatchObject({ ok: true, data: { state: 'PLAYING', currentTimeS: 2539 } })
    expect(projection.commandReplay('REPLAY-001', { command: 'PAUSE' })).toMatchObject({ ok: true, data: { state: 'PAUSED', currentTimeS: 2539 } })
    expect(projection.commandReplay('REPLAY-001', { command: 'SEEK', value: -1 })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' })
    expect(projection.commandReplay('REPLAY-001', { command: 'SEEK', value: 7200 })).toMatchObject({ ok: true, data: { state: 'COMPLETED', currentTimeS: 7200 } })
    expect(projection.commandReplay('REPLAY-001', { command: 'STEP_FORWARD' })).toMatchObject({ ok: true, data: { currentTimeS: 7200 } })
    expect(projection.commandReplay('REPLAY-001', { command: 'STEP_BACK' })).toMatchObject({ ok: true, data: { state: 'PAUSED', currentTimeS: 7199 } })
    expect(projection.commandReplay('REPLAY-001', { command: 'SPEED', value: 0 })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' })
    expect(projection.commandReplay('REPLAY-001', { command: 'SPEED', value: 2 })).toMatchObject({ ok: true, data: { currentTimeS: 7199 } })
  })

  it('reset 恢复冻结批次和回放游标', () => {
    const projection = new BatchReplayProjection()
    projection.createBatch(validBatchRequest)
    projection.commandReplay('REPLAY-001', { command: 'SEEK', value: 12 })
    projection.reset()
    expect(projection.listBatches()[0]?.state).toBe('COMPLETED')
    expect(projection.getReplay('REPLAY-001')).toMatchObject({ ok: true, data: { state: 'PAUSED', currentTimeS: 2537 } })
  })
})
