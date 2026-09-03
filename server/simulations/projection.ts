import type {
  ApiErrorCode,
  SimulationCommand,
  SimulationCreateRequest,
  SimulationRun,
  TelemetryFrame,
  DetectionEvent,
  SwitchEvent,
} from '../../src/contracts/domain-models.js'
import { loadFixtureProjection } from '../fixtures/source.js'
import type { ScenarioProjection } from '../scenarios/projection.js'

export type SimulationProjectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 404 | 409 | 422 | 428; fieldPath?: string; message: string }

const STARTED_AT = '2026-08-06T08:05:00Z'
const FIXTURE_PROCESS_ID = 2900
const ACTIVE_STATUSES = new Set<SimulationRun['uiStatus']>(['RUNNING', 'PAUSED'])
const MODES = new Set(['INTERACTIVE_SINGLE', 'BATCH_PARAMETER_TRAVERSAL', 'PARAMETER_SCAN', 'HISTORICAL_REPLAY'])

/** 判断未知值是否为闭合的仿真创建请求。 */
function readCreateRequest(value: unknown): SimulationCreateRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<SimulationCreateRequest>
  const keys = Object.keys(value)
  return keys.length === 2
    && keys.every((key) => key === 'taskId' || key === 'scenarioId')
    && typeof candidate.taskId === 'string'
    && candidate.taskId.startsWith('TASK-')
    && typeof candidate.scenarioId === 'string'
    && candidate.scenarioId.startsWith('SCN-')
    ? candidate as SimulationCreateRequest
    : undefined
}

/** 判断命令对象是否只包含当前命令允许的字段。 */
function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

/**
 * 从未知请求体读取命令，并校验每种命令自己的参数组合。
 * @param value 未受信任的命令请求体。
 * @returns 参数闭合且满足命令规则时返回规范命令，否则返回 `undefined`。
 * @remarks 只做边界校验，不读取或修改仿真状态。
 */
function readCommand(value: unknown): SimulationCommand | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<SimulationCommand>
  if (candidate.command === 'START') {
    return hasOnlyKeys(value, ['command', 'mode']) && typeof candidate.mode === 'string' && MODES.has(candidate.mode)
      ? candidate as SimulationCommand
      : undefined
  }
  if (candidate.command === 'STEP') {
    return hasOnlyKeys(value, ['command', 'stepCount']) && candidate.stepCount === 1
      ? candidate as SimulationCommand
      : undefined
  }
  if (candidate.command === 'SET_SPEED') {
    return hasOnlyKeys(value, ['command', 'speedMultiplier'])
      && typeof candidate.speedMultiplier === 'number'
      && Number.isFinite(candidate.speedMultiplier)
      && candidate.speedMultiplier > 0
      ? candidate as SimulationCommand
      : undefined
  }
  if (candidate.command === 'STOP') {
    return hasOnlyKeys(value, ['command', 'confirmationId'])
      && (candidate.confirmationId === undefined
        || (typeof candidate.confirmationId === 'string' && candidate.confirmationId.length > 0))
      ? candidate as SimulationCommand
      : undefined
  }
  if (candidate.command === 'PAUSE' || candidate.command === 'RESUME') {
    return hasOnlyKeys(value, ['command']) ? candidate as SimulationCommand : undefined
  }
  return undefined
}

/** 创建一次新的确定性运行投影。 */
function createIdleRun(request: SimulationCreateRequest, totalDuration: number): SimulationRun {
  return {
    runId: 'RUN-001',
    taskId: request.taskId,
    scenarioId: request.scenarioId,
    uiStatus: 'IDLE',
    canonical: {
      status: 'IDLE',
      currentTime: 0,
      totalDuration,
      processId: null,
      progress: 0,
    },
    configLocked: true,
  }
}

export class SimulationProjection {
  private run = structuredClone(loadFixtureProjection().run)

  constructor(private readonly scenarios: ScenarioProjection) {}

  /** 返回当前确定性运行列表的独立副本。 */
  list(): SimulationRun[] {
    return [structuredClone(this.run)]
  }

  /**
   * 读取指定运行。
   * @param runId 需要读取的运行编号。
   * @returns 找到时返回独立副本，否则返回 404 结果。
   */
  get(runId: string): SimulationProjectionResult<SimulationRun> {
    return runId === this.run.runId
      ? { ok: true, data: structuredClone(this.run) }
      : { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定仿真运行。' }
  }

  /**
   * 读取指定运行的冻结遥测帧。
   * @param runId 帧所属仿真运行编号。
   * @param frameId 要读取的固定帧编号。
   * @returns 找到时返回独立帧副本，否则返回 404 结果。
   * @remarks 只读取冻结事实，不随控制命令改写帧内容。
   */
  getFrame(runId: string, frameId: string): SimulationProjectionResult<TelemetryFrame> {
    const frame = loadFixtureProjection().frame
    return runId === this.run.runId && frameId === frame.frameId
      ? { ok: true, data: structuredClone(frame) }
      : { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定遥测帧。' }
  }

  /**
   * 读取指定运行的冻结侦测与切换事件。
   * @param runId 事件所属仿真运行编号。
   * @returns 找到运行时返回独立事件列表，否则返回 404 结果。
   * @remarks 只读取冻结事实，不接受或生成新事件。
   */
  listEvents(runId: string): SimulationProjectionResult<Array<DetectionEvent | SwitchEvent>> {
    return runId === this.run.runId
      ? { ok: true, data: structuredClone(loadFixtureProjection().events) }
      : { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定仿真运行。' }
  }

  /**
   * 创建单实例运行并锁定对应场景。
   * @param value 未受信任的创建请求体。
   * @returns 新的空闲运行，或请求、场景及单实例冲突错误。
   * @remarks 只创建内存投影和配置锁，不启动进程或浏览器计时器。
   */
  create(value: unknown): SimulationProjectionResult<SimulationRun> {
    const request = readCreateRequest(value)
    if (request === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '仿真创建请求结构不正确。' }
    }
    if (ACTIVE_STATUSES.has(this.run.uiStatus) || this.run.configLocked) {
      return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '当前已有仿真运行，不能重复创建。' }
    }
    const fixture = loadFixtureProjection()
    if (request.taskId !== fixture.task.taskId || request.scenarioId !== fixture.scenario.scenario.id) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'scenarioId', message: '任务与场景不匹配。' }
    }
    const locked = this.scenarios.setLocked(request.scenarioId, true)
    if (!locked.ok) return locked

    this.run = createIdleRun(request, locked.data.config.scenario.duration)
    return { ok: true, data: structuredClone(this.run) }
  }

  /**
   * 判断命令在当前运行状态下是否允许执行。
   * @param runId 命令目标运行编号。
   * @param value 未受信任的命令请求体。
   * @returns 校验通过时返回规范命令，失败时返回可直接转换为 API 错误的结果。
   * @remarks 只校验参数和状态，不消费确认上下文或修改运行。
   */
  inspectCommand(runId: string, value: unknown): SimulationProjectionResult<SimulationCommand> {
    if (runId !== this.run.runId) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定仿真运行。' }
    }
    const command = readCommand(value)
    if (command === undefined) {
      return { ok: false, code: 'INVALID_TRANSITION', status: 409, fieldPath: 'command', message: '仿真命令参数组合不正确。' }
    }

    const allowed = command.command === 'START'
      ? this.run.uiStatus === 'IDLE' && this.run.configLocked
      : command.command === 'PAUSE'
        ? this.run.uiStatus === 'RUNNING'
        : command.command === 'RESUME' || command.command === 'STEP'
          ? this.run.uiStatus === 'PAUSED'
          : command.command === 'SET_SPEED'
            ? ACTIVE_STATUSES.has(this.run.uiStatus)
            : ACTIVE_STATUSES.has(this.run.uiStatus)
    return allowed
      ? { ok: true, data: command }
      : { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '当前仿真状态不允许执行该命令。' }
  }

  /**
   * 执行已通过状态校验的确定性仿真命令。
   * @param runId 命令目标运行编号。
   * @param value 命令请求体。
   * @param stopConfirmed STOP 的一次性确认是否已由 API 层消费。
   * @returns 更新后的运行，或参数、状态和确认错误。
   * @remarks 只修改内存投影；STEP 使用场景时间步长，STOP 同步解除场景锁。
   */
  command(runId: string, value: unknown, stopConfirmed = false): SimulationProjectionResult<SimulationRun> {
    const inspected = this.inspectCommand(runId, value)
    if (!inspected.ok) return inspected
    const command = inspected.data
    if (command.command === 'STOP' && !stopConfirmed) {
      return { ok: false, code: 'CONFIRMATION_REQUIRED', status: 428, message: '停止仿真前需要二次确认。' }
    }

    if (command.command === 'START') {
      this.run.uiStatus = 'RUNNING'
      this.run.canonical.status = 'RUNNING'
      this.run.canonical.processId = FIXTURE_PROCESS_ID
      this.run.startedAt = STARTED_AT
      delete this.run.completedAt
    } else if (command.command === 'PAUSE') {
      this.run.uiStatus = 'PAUSED'
      this.run.canonical.status = 'PAUSED'
    } else if (command.command === 'RESUME') {
      this.run.uiStatus = 'RUNNING'
      this.run.canonical.status = 'RUNNING'
    } else if (command.command === 'STEP') {
      const draft = this.scenarios.get(this.run.scenarioId)
      if (!draft.ok) return draft
      this.run.canonical.currentTime = Math.min(
        this.run.canonical.totalDuration,
        this.run.canonical.currentTime + draft.data.config.scenario.timeStep,
      )
      this.run.canonical.progress = this.run.canonical.totalDuration === 0
        ? 100
        : Number(((this.run.canonical.currentTime / this.run.canonical.totalDuration) * 100).toFixed(6))
      if (this.run.canonical.currentTime === this.run.canonical.totalDuration) {
        this.run.uiStatus = 'COMPLETED'
        this.run.canonical.status = 'COMPLETED'
        this.run.configLocked = false
        this.run.canonical.processId = null
        this.run.completedAt = loadFixtureProjection().run.completedAt
        this.scenarios.setLocked(this.run.scenarioId, false)
      }
    } else if (command.command === 'STOP') {
      const unlocked = this.scenarios.setLocked(this.run.scenarioId, false)
      if (!unlocked.ok) return unlocked
      this.run.uiStatus = 'STOPPED'
      this.run.canonical.status = 'IDLE'
      this.run.canonical.currentTime = 0
      this.run.canonical.progress = 0
      this.run.canonical.processId = null
      this.run.configLocked = false
      delete this.run.completedAt
    }

    return { ok: true, data: structuredClone(this.run) }
  }

  /** 恢复冻结的完成态运行；场景投影由全局 reset 独立恢复。 */
  reset(): void {
    this.run = structuredClone(loadFixtureProjection().run)
  }
}
