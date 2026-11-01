import type { ApiErrorCode, Replay, ReplayCommand } from '../../src/contracts/domain-models.js'
import { loadFixtureProjection } from '../fixtures/source.js'

export type ReplayResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 404 | 409 | 422; fieldPath?: string; message: string }

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

/** 管理冻结历史回放的可变内存投影。 */
export class ReplayProjection {
  private replay = structuredClone(loadFixtureProjection().replay)

  /** 返回当前回放目录的独立副本。 */
  list(): Replay[] {
    return [structuredClone(this.replay)]
  }

  /** 返回指定历史回放；未知编号返回 404。 */
  get(replayId: string): ReplayResult<Replay> {
    return replayId === this.replay.replayId
      ? { ok: true, data: structuredClone(this.replay) }
      : { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定回放。' }
  }

  /** 执行仅改变回放游标和播放状态的命令。 */
  command(replayId: string, value: unknown): ReplayResult<Replay> {
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

  /** 恢复冻结回放游标。 */
  reset(): void {
    this.replay = structuredClone(loadFixtureProjection().replay)
  }
}
