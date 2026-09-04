import type {
  ApiErrorCode,
  Batch,
  BatchCommand,
  BatchRequest,
  BatchRunResult,
  Replay,
  ReplayCommand,
  Report,
} from '../../src/contracts/domain-models.js'
import { loadFixtureProjection } from '../fixtures/source.js'

export type BatchReplayResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 404 | 409 | 422; fieldPath?: string; message: string }

export interface BatchDetail {
  batch: Batch
  runs: BatchRunResult[]
  aggregateReport: Report
}

/** 判断未知值是否为冻结合同允许的批量参数请求。 */
function readBatchRequest(value: unknown): BatchRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const request = value as Partial<BatchRequest>
  const keys = Object.keys(value)
  const validNumbers = (items: unknown): items is number[] => Array.isArray(items)
    && items.length > 0
    && items.every((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0)
  return keys.length === 4
    && keys.every((key) => ['scenarioId', 'powersW', 'distancesKm', 'deterministicOrder'].includes(key))
    && typeof request.scenarioId === 'string'
    && request.scenarioId.startsWith('SCN-')
    && validNumbers(request.powersW)
    && validNumbers(request.distancesKm)
    && request.deterministicOrder === true
    ? request as BatchRequest
    : undefined
}

/** 判断数值列表是否与冻结批次矩阵完全一致。 */
function sameNumbers(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

/** 判断未知值是否为不含额外字段的批量控制命令。 */
function readBatchCommand(value: unknown): BatchCommand | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const command = value as Partial<BatchCommand>
  return Object.keys(value).length === 1 && (command.command === 'START' || command.command === 'CANCEL')
    ? command as BatchCommand
    : undefined
}

/** 判断未知值是否为参数组合正确的回放命令。 */
function readReplayCommand(value: unknown): ReplayCommand | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const command = value as Partial<ReplayCommand>
  if (command.command === 'SEEK' || command.command === 'SPEED') {
    return Object.keys(value).length === 2
      && typeof command.value === 'number'
      && Number.isFinite(command.value)
      ? command as ReplayCommand
      : undefined
  }
  return Object.keys(value).length === 1
    && ['PLAY', 'PAUSE', 'STEP_FORWARD', 'STEP_BACK'].includes(String(command.command))
    ? command as ReplayCommand
    : undefined
}

/**
 * 管理冻结批次和历史回放的可变内存投影。
 * @remarks 批量启动在一次同步命令内完成 RUNNING→COMPLETED；回放命令只改变回放状态或游标，
 * 不修改 RUN-001、遥测帧或仿真控制状态。
 */
export class BatchReplayProjection {
  private batch = structuredClone(loadFixtureProjection().batch)
  private replay = structuredClone(loadFixtureProjection().replay)

  /** 返回当前批次目录的独立副本。 */
  listBatches(): Batch[] {
    return [structuredClone(this.batch)]
  }

  /**
   * 创建冻结批次的排队投影。
   * @param value 未受信任的批量参数请求。
   * @returns 请求有效时返回 BATCH-001，否则返回字段校验错误。
   */
  createBatch(value: unknown): BatchReplayResult<Batch> {
    const request = readBatchRequest(value)
    if (request === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '批量参数请求结构不正确。' }
    }
    if (request.scenarioId !== loadFixtureProjection().scenario.scenario.id) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'scenarioId', message: '场景编号不存在。' }
    }
    if (request.powersW.length * request.distancesKm.length !== 12) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '批量参数必须形成 12 个组合。' }
    }
    const fixture = loadFixtureProjection()
    const powersW = [...new Set(fixture.batchRuns.map((run) => run.powerW))]
    const distancesKm = [...new Set(fixture.batchRuns.map((run) => run.distanceKm))]
    if (!sameNumbers(request.powersW, powersW) || !sameNumbers(request.distancesKm, distancesKm)) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '本阶段只接受冻结的 50/100/150/200 W × 80/100/120 km 参数矩阵。' }
    }
    this.batch = { ...fixture.batch, state: 'QUEUED' }
    return { ok: true, data: structuredClone(this.batch) }
  }

  /**
   * 返回含 12 个运行结果和三级聚合报告的批次详情。
   * @param batchId 要读取的批次编号。
   */
  getBatch(batchId: string): BatchReplayResult<BatchDetail> {
    if (batchId !== this.batch.batchId) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定批次。' }
    }
    if (this.batch.state !== 'COMPLETED' && this.batch.state !== 'PARTIAL_FAILURE') {
      return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '批次尚未形成可读取的运行结果。' }
    }
    const fixture = loadFixtureProjection()
    const hasCompleted = fixture.batchRuns.some((run) => run.status === 'COMPLETED')
    const hasError = fixture.batchRuns.some((run) => run.status === 'ERROR')
    const stateMatchesRuns = this.batch.state === 'COMPLETED' ? !hasError : hasCompleted && hasError
    if (!stateMatchesRuns) {
      return { ok: false, code: 'INTERNAL_FIXTURE_ERROR', status: 409, message: '批次状态与运行结果不一致。' }
    }
    return {
      ok: true,
      data: {
        batch: structuredClone(this.batch),
        runs: structuredClone(fixture.batchRuns),
        aggregateReport: structuredClone(fixture.batchAggregateReport),
      },
    }
  }

  /**
   * 执行批量启动或取消命令。
   * @param batchId 目标批次编号。
   * @param value 未受信任的命令体。
   */
  commandBatch(batchId: string, value: unknown): BatchReplayResult<Batch> {
    if (batchId !== this.batch.batchId) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定批次。' }
    }
    const command = readBatchCommand(value)
    if (command === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'command', message: '批量控制命令不正确。' }
    }
    if (this.batch.state !== 'QUEUED' && this.batch.state !== 'RUNNING') {
      return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '当前批次状态不允许执行该命令。' }
    }
    if (command.command === 'CANCEL') {
      this.batch.state = 'CANCELLED'
    } else {
      // 本机确定性数据不启动真实进程，因此在同一命令内完成运行并返回最终结果。
      this.batch.state = 'RUNNING'
      this.batch.state = 'COMPLETED'
    }
    return { ok: true, data: structuredClone(this.batch) }
  }

  /** 返回当前回放目录的独立副本。 */
  listReplays(): Replay[] {
    return [structuredClone(this.replay)]
  }

  /** 返回指定历史回放；未知编号返回 404。 */
  getReplay(replayId: string): BatchReplayResult<Replay> {
    return replayId === this.replay.replayId
      ? { ok: true, data: structuredClone(this.replay) }
      : { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定回放。' }
  }

  /**
   * 执行回放播放、暂停、定位、单步或倍速校验。
   * @param replayId 目标回放编号。
   * @param value 未受信任的回放命令体。
   * @remarks SPEED 只校验正倍速；倍速是客户端播放属性，不写入冻结 Replay 合同。
   */
  commandReplay(replayId: string, value: unknown): BatchReplayResult<Replay> {
    if (replayId !== this.replay.replayId) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定回放。' }
    }
    const command = readReplayCommand(value)
    if (command === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'command', message: '回放命令不正确。' }
    }
    if (command.command === 'SEEK') {
      if (command.value! < 0 || command.value! > this.replay.durationS) {
        return { ok: false, code: 'OUT_OF_RANGE', status: 422, fieldPath: 'value', message: '回放位置超出有效范围。' }
      }
      const wasPlaying = this.replay.state === 'PLAYING'
      this.replay.currentTimeS = command.value!
      this.replay.state = command.value === this.replay.durationS ? 'COMPLETED' : wasPlaying ? 'PLAYING' : 'PAUSED'
    } else if (command.command === 'SPEED') {
      if (command.value! <= 0) {
        return { ok: false, code: 'OUT_OF_RANGE', status: 422, fieldPath: 'value', message: '回放倍速必须大于 0。' }
      }
    } else if (command.command === 'STEP_FORWARD' || command.command === 'STEP_BACK') {
      const offset = command.command === 'STEP_FORWARD' ? 1 : -1
      this.replay.currentTimeS = Math.min(this.replay.durationS, Math.max(0, this.replay.currentTimeS + offset))
      this.replay.state = this.replay.currentTimeS === this.replay.durationS ? 'COMPLETED' : 'PAUSED'
    } else if (command.command === 'PLAY') {
      if (!['PAUSED', 'COMPLETED'].includes(this.replay.state)) {
        return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '当前回放状态不能播放。' }
      }
      if (this.replay.currentTimeS === this.replay.durationS) this.replay.currentTimeS = 0
      this.replay.state = 'PLAYING'
    } else {
      if (this.replay.state !== 'PLAYING') {
        return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '当前回放状态不能暂停。' }
      }
      this.replay.state = 'PAUSED'
    }
    return { ok: true, data: structuredClone(this.replay) }
  }

  /** 恢复冻结的批次与回放投影。 */
  reset(): void {
    const fixture = loadFixtureProjection()
    this.batch = structuredClone(fixture.batch)
    this.replay = structuredClone(fixture.replay)
  }
}
