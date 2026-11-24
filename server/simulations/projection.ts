import type {
  ApiErrorCode,
  ClosedLoopContext,
  JammingDecision,
  JammingCommand,
  JammingParameterSet,
  JammerPlanSaveRequest,
  JammerPlanSaved,
  JammerRuntimeParameters,
  Jammer,
  JammerState,
  SimulationCommand,
  SimulationCreateRequest,
  SimulationRun,
  TelemetryFrame,
  DetectionEvent,
  SwitchEvent,
  SyncResult,
} from '../../src/contracts/domain-models.js'
import { loadFixtureProjection } from '../fixtures/source.js'
import { InMemoryJammerPlanStorage, toRuntimeParameters, type JammerPlanRecord, type JammerPlanStorage } from './jammer-plan-storage.js'
import { frameJammerExecutions } from '../../src/features/situation/frame-evidence.js'
import { isControlledPowerWatts, JAMMER_RANGE_METERS } from '../../src/features/scenarios/jammer-settings.js'
import { canSendEngineControl, engineControlAction } from '../../src/features/situation/engine-control.js'
import type { ScenarioProjection } from '../scenarios/projection.js'
import type { MissionOutcome } from './mission-execution.js'

export type SimulationProjectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 404 | 409 | 422 | 428 | 503; fieldPath?: string; message: string }

const STARTED_AT = '2026-08-06T08:05:00Z'
const FIXTURE_PROCESS_ID = 2900
const ACTIVE_STATUSES = new Set<SimulationRun['uiStatus']>(['RUNNING', 'PAUSED'])
const MODES = new Set(['INTERACTIVE_SINGLE', 'PARAMETER_SCAN', 'HISTORICAL_REPLAY'])

/** 从未受信任值读取闭合的 RF 干扰控制命令。 */
function readJammingCommand(value: unknown): JammingCommand | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<JammingCommand>
  const keys = Object.keys(value)
  const numbers = [candidate.frequency, candidate.bandwidth, candidate.power, candidate.direction, candidate.duration]
  return keys.length === 6
    && keys.every((key) => ['enabled', 'frequency', 'bandwidth', 'power', 'direction', 'duration'].includes(key))
    && typeof candidate.enabled === 'boolean'
    && numbers.every((item) => typeof item === 'number' && Number.isFinite(item))
    ? candidate as JammingCommand
    : undefined
}

/** 从未受信任值读取闭合的逐帧干扰闭环上下文。 */
function readClosedLoopContext(value: unknown): ClosedLoopContext | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<ClosedLoopContext>
  const keys = Object.keys(value)
  return keys.length === 4
    && keys.every((key) => ['frameId', 'detectionEventId', 'targetPlatformId', 'affectedLinkId'].includes(key))
    && [candidate.frameId, candidate.detectionEventId, candidate.targetPlatformId, candidate.affectedLinkId]
      .every((item) => typeof item === 'string' && item.length > 0)
    ? candidate as ClosedLoopContext
    : undefined
}

/** 从未受信任值读取带版本、生效帧和可选探测范围的干扰参数集。 */
function readJammingParameterSet(value: unknown): JammingParameterSet | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<JammingParameterSet>
  const keys = Object.keys(value)
  const hasDetectionRange = keys.includes('detectionRangeM')
  return keys.length === 3 + Number(hasDetectionRange)
    && keys.every((key) => ['version', 'effectiveFrameId', 'parameters', 'detectionRangeM'].includes(key))
    && Number.isSafeInteger(candidate.version) && Number(candidate.version) > 0
    && typeof candidate.effectiveFrameId === 'string' && candidate.effectiveFrameId.startsWith('F-')
    && (!hasDetectionRange
      || (typeof candidate.detectionRangeM === 'number' && Number.isFinite(candidate.detectionRangeM) && candidate.detectionRangeM > 0))
    && readJammingCommand(candidate.parameters) !== undefined
    ? candidate as JammingParameterSet
    : undefined
}

/** 从未受信任值读取运行期干扰计划保存请求（样式/俯仰/计划帧；均只做结构读取，范围在保存时校验）。 */
function readJammerPlanSaveRequest(value: unknown): JammerPlanSaveRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<JammerPlanSaveRequest>
  const allowed = ['style', 'elevation', 'plannedStartFrame', 'plannedStopFrame']
  if (!Object.keys(value).every((key) => allowed.includes(key))) return undefined
  if (candidate.style !== 'BARRAGE' && candidate.style !== 'SPOT') return undefined
  if (typeof candidate.elevation !== 'number' || !Number.isFinite(candidate.elevation)) return undefined
  for (const key of ['plannedStartFrame', 'plannedStopFrame'] as const) {
    const frame = candidate[key]
    if (frame !== undefined && (!Number.isSafeInteger(frame) || frame < 0)) return undefined
  }
  return candidate as JammerPlanSaveRequest
}

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

/** 创建一次不复用编号的运行投影，状态内容仍由 Mock 投影维护。 */
function createIdleRun(request: SimulationCreateRequest, totalDuration: number, runId: SimulationRun['runId']): SimulationRun {
  return {
    runId,
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

/** 固定证据仅属于默认演示场景，不能作为其他场景的运行结果。 */
export function ownsFixedEvidence(run: SimulationRun | undefined): boolean {
  const fixture = loadFixtureProjection()
  return !run?.executionSource && run?.taskId === fixture.task.taskId && run.scenarioId === fixture.scenario.scenario.id
}

/** 固定演示帧只替换运行身份；测量与业务证据仍来自同一冻结夹具。 */
export function fixedFrameForRun(runId: SimulationRun['runId']): TelemetryFrame {
  const frame = structuredClone(loadFixtureProjection().frame)
  // 多台证据保留完整数组，同时向旧客户端提供第一台的单对象。
  frame.evidence.jammerExecution = frameJammerExecutions(frame)[0]!
  frame.runId = runId
  frame.evidence.routeDecisions.forEach(decision => { decision.runId = runId })
  return frame
}

export class SimulationProjection {
  private run = structuredClone(loadFixtureProjection().run)
  private nextRunSequence = 2
  // 已替换但尚未由注册表确认的运行；提交失败时据此恢复被替换的运行与场景锁。
  private unconfirmed: { runId: string; scenarioId: string; locked: boolean; previous: SimulationRun } | null = null
  private readonly processedClosedLoops = new Set<string>()
  private readonly jammerParameterVersions = new Map<string, number>()

  constructor(private readonly scenarios: ScenarioProjection, private readonly taskId = loadFixtureProjection().task.taskId,
    private readonly remote = false, private readonly jammerPlanStorage: JammerPlanStorage = new InMemoryJammerPlanStorage()) {
    if (remote) {
      this.run = createIdleRun({ taskId, scenarioId: this.run.scenarioId }, this.run.canonical.totalDuration, this.run.runId)
      this.run.executionSource = 'REMOTE_WS'
      this.run.uiStatus = 'STOPPED'
      this.run.configLocked = false
    }
  }

  startRemote(startedAt: string): SimulationRun {
    this.run.uiStatus = 'RUNNING'
    this.run.canonical.status = 'RUNNING'
    this.run.canonical.processId = null
    this.run.startedAt = startedAt
    this.run.engineControl = { connected: false, action: null, delivery: 'IDLE' }
    return structuredClone(this.run)
  }

  updateRemoteTime(time: number): SimulationRun {
    this.run.canonical.currentTime = time
    this.run.canonical.progress = Math.min(100, this.run.canonical.totalDuration > 0 ? time / this.run.canonical.totalDuration * 100 : 0)
    return structuredClone(this.run)
  }

  finishRemote(completedAt: string): SimulationRun {
    this.run.uiStatus = 'STOPPED'
    this.run.canonical.status = 'IDLE'
    this.run.completedAt = completedAt
    if (this.run.engineControl) this.run.engineControl.connected = false
    delete this.run.canonical.errorMessage
    if (!this.run.fileSource) this.scenarios.setLocked(this.run.scenarioId, false)
    this.run.configLocked = false
    return structuredClone(this.run)
  }

  startMission(pid: number, startedAt: string): SimulationRun {
    this.run.uiStatus = 'RUNNING'
    this.run.canonical.status = 'RUNNING'
    this.run.canonical.mode = 'INTERACTIVE_SINGLE'
    this.run.canonical.speedMultiplier = 1
    this.run.canonical.processId = pid
    this.run.startedAt = startedAt
    delete this.run.completedAt
    delete this.run.canonical.errorMessage
    return structuredClone(this.run)
  }

  finishMission(outcome: MissionOutcome, explicitlyStopped = false): SimulationRun {
    const failed = outcome.code !== 0 || Boolean(outcome.errorMessage)
    const stopped = !failed && (explicitlyStopped || this.run.engineControl?.action === 'stop')
    this.run.uiStatus = failed ? 'ERROR' : stopped ? 'STOPPED' : 'COMPLETED'
    this.run.canonical.status = failed ? 'ERROR' : stopped ? 'IDLE' : 'COMPLETED'
    delete this.run.engineControl
    this.run.canonical.processId = null
    delete this.run.canonical.mode
    delete this.run.canonical.speedMultiplier
    this.run.completedAt = outcome.completedAt
    if (failed) this.run.canonical.errorMessage = outcome.errorMessage ?? 'mission 执行失败。'
    else if (stopped) delete this.run.canonical.errorMessage
    else {
      this.run.canonical.currentTime = this.run.canonical.totalDuration
      this.run.canonical.progress = 100
    }
    this.scenarios.setLocked(this.run.scenarioId, false)
    this.run.configLocked = false
    return structuredClone(this.run)
  }

  markMissionStopUncertain(message: string): SimulationRun {
    this.run.uiStatus = 'ERROR'
    this.run.canonical.status = 'ERROR'
    this.run.canonical.errorMessage = message
    return structuredClone(this.run)
  }

  setEngineControl(state: NonNullable<SimulationRun['engineControl']>): SimulationRun {
    this.run.engineControl = structuredClone(state)
    return structuredClone(this.run)
  }

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
    return ownsFixedEvidence(this.run) && runId === this.run.runId && frameId === frame.frameId
      ? { ok: true, data: fixedFrameForRun(runId) }
      : { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定遥测帧。' }
  }

  /**
   * 读取指定运行的冻结侦测与切换事件。
   * @param runId 事件所属仿真运行编号。
   * @returns 找到运行时返回独立事件列表，否则返回 404 结果。
   * @remarks 只读取冻结事实，不接受或生成新事件。
   */
  listEvents(runId: string): SimulationProjectionResult<Array<DetectionEvent | SwitchEvent>> {
    return ownsFixedEvidence(this.run) && runId === this.run.runId
      ? { ok: true, data: structuredClone(loadFixtureProjection().events) }
      : { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定仿真运行。' }
  }

  /**
   * 创建单实例运行并锁定对应场景。
   * @param value 未受信任的创建请求体。
   * @returns 新的空闲运行，或请求、场景及单实例冲突错误。
   * @remarks 只创建内存投影和配置锁，不启动进程或浏览器计时器。
   */
  create(value: unknown, assignedRunId?: SimulationRun['runId']): SimulationProjectionResult<SimulationRun> {
    const request = readCreateRequest(value)
    if (request === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '仿真创建请求结构不正确。' }
    }
    if (ACTIVE_STATUSES.has(this.run.uiStatus) || this.run.configLocked) {
      return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '当前已有仿真运行，不能重复创建。' }
    }
    if (request.taskId !== this.taskId) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'taskId', message: '任务编号与当前演示任务不匹配。' }
    }
    const locked = this.scenarios.setLocked(request.scenarioId, true)
    if (!locked.ok) return locked

    const runId: SimulationRun['runId'] = assignedRunId ?? `RUN-${String(this.nextRunSequence).padStart(3, '0')}`
    this.nextRunSequence += 1
    const previous = structuredClone(this.run)
    this.run = createIdleRun(request, locked.data.config.scenario.duration, runId)
    this.unconfirmed = { runId, scenarioId: request.scenarioId, locked: true, previous }
    if (this.remote) this.run.executionSource = 'REMOTE_WS'
    this.processedClosedLoops.clear()
    this.jammerParameterVersions.clear()
    // 新运行从空白开始，不继承同一编号的旧本地计划。
    this.jammerPlanStorage.deleteRun(this.run.runId)
    return { ok: true, data: structuredClone(this.run) }
  }

  /** 文件会话不创建或修改场景配置；来源已由 API 校验并固定。 */
  createFile(request: SimulationCreateRequest, duration: number, runId: SimulationRun['runId']): SimulationRun {
    const previous = structuredClone(this.run)
    this.run = createIdleRun(request, duration, runId)
    // 文件会话不持有场景锁，回滚时只恢复被替换的运行。
    this.unconfirmed = { runId, scenarioId: request.scenarioId, locked: false, previous }
    this.run.executionSource = 'REMOTE_WS'
    this.run.fileSource = structuredClone(request.fileSource!)
    this.processedClosedLoops.clear()
    this.jammerParameterVersions.clear()
    this.jammerPlanStorage.deleteRun(this.run.runId)
    return structuredClone(this.run)
  }

  /**
   * 注册表登记成功后确认本次运行提交；此后丢弃请求不再回滚。
   * @returns 无返回值。
   * @sideEffects 清除待确认运行快照。
   */
  confirmUnconfirmed(): void { this.unconfirmed = null }

  /**
   * 提交失败时丢弃本次未确认运行，恢复被替换的运行并释放本次持有的场景锁。
   * @param runId 期望回滚的本次运行编号。
   * @returns 无返回值。
   * @remarks 只回滚匹配的待确认运行；重复调用或成功提交后调用均为无操作。
   *          先恢复运行再释放锁，避免中间态出现空运行却仍被锁定的组合。
   */
  discardUnconfirmed(runId?: string): void {
    const pending = this.unconfirmed
    if (!pending || (runId !== undefined && pending.runId !== runId)) return
    this.run = pending.previous
    this.unconfirmed = null
    this.processedClosedLoops.clear()
    this.jammerParameterVersions.clear()
    if (pending.locked) this.scenarios.setLocked(pending.scenarioId, false)
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

    const action = engineControlAction(command.command)
    if (this.remote && command.command === 'STOP') {
      return this.run.configLocked && Boolean(this.run.startedAt) && this.run.engineControl?.delivery !== 'SENDING'
        ? { ok: true, data: command }
        : { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '当前没有可结束的远端接收会话。' }
    }
    if (this.remote && (command.command === 'STEP' || command.command === 'SET_SPEED')) {
      return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '远端数据服务未提供单步或倍速协议。' }
    }
    if (this.run.engineControl && action && action !== 'stop') {
      return ACTIVE_STATUSES.has(this.run.uiStatus) && canSendEngineControl(this.run.engineControl, action)
        ? { ok: true, data: command }
        : { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '引擎连接或控制发送状态不允许此操作；请核实待确认结果。' }
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
    if (this.remote) return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '远端接收会话必须经过实际连接及归档通道。' }
    if (this.run.engineControl && command.command !== 'STOP' && engineControlAction(command.command)) {
      return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: 'WebSocket 控制必须经过发送通道，不能直接修改运行状态。' }
    }
    if (command.command === 'STOP' && !stopConfirmed) {
      return { ok: false, code: 'CONFIRMATION_REQUIRED', status: 428, message: '停止仿真前需要二次确认。' }
    }

    if (command.command === 'START') {
      this.run.uiStatus = 'RUNNING'
      this.run.canonical.status = 'RUNNING'
      this.run.canonical.mode = command.mode
      this.run.canonical.speedMultiplier = 1
      this.run.canonical.processId = FIXTURE_PROCESS_ID
      this.run.startedAt = STARTED_AT
      delete this.run.completedAt
    } else if (command.command === 'SET_SPEED') {
      this.run.canonical.speedMultiplier = command.speedMultiplier
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
      delete this.run.engineControl
      delete this.run.completedAt
    }

    if (this.run.uiStatus === 'STOPPED' || this.run.uiStatus === 'COMPLETED') {
      delete this.run.canonical.mode
      delete this.run.canonical.speedMultiplier
    }
    return { ok: true, data: structuredClone(this.run) }
  }

  /**
   * 纯干扰命令范围校验（频率/带宽/功率/方向/时长），供控制命令与本地参数接受复用。
   * @param jammer 场景中的干扰设备。
   * @param command 已通过结构校验的命令。
   * @param scenarioDuration 场景时长（秒）。
   * @returns 通过返回 `{ ok: true }`，否则返回可定位的 422 错误。
   * @remarks 不读写运行期状态，也不依赖固定演示证据。
   */
  private validateJammerRange(jammer: Jammer, command: JammingCommand, scenarioDuration: number):
    { ok: true } | { ok: false; code: 'OUT_OF_RANGE'; status: 422; fieldPath: keyof JammingCommand; message: string } {
    // ponytail: 原始设备合同未给独立上下限；频率/带宽/方向/时长沿用 Mock 可测边界，接入真实设备能力合同后替换。
    // 功率按 GNZB-15 统一为 -10～+30 dBm、5 dB 档位（合同仍存 W）；defaultPower 只是默认值，不再作为额定上限。
    // 停扰 enabled=false 允许 0 W 安全停止，仅要求有限非负值，不受未编辑的旧功率回显阻断。
    const frequencyMin = jammer.frequency - jammer.bandwidth / 2
    const frequencyMax = jammer.frequency + jammer.bandwidth / 2
    const powerWithinRange = command.enabled ? isControlledPowerWatts(command.power) : command.power >= 0
    const checks: Array<[boolean, keyof JammingCommand, string]> = [
      [command.frequency >= frequencyMin && command.frequency <= frequencyMax, 'frequency', `频率必须在 ${frequencyMin}–${frequencyMax} MHz 范围内。`],
      [command.bandwidth > 0 && command.bandwidth <= jammer.bandwidth, 'bandwidth', `带宽必须大于 0 且不超过 ${jammer.bandwidth} MHz。`],
      [powerWithinRange, 'power', command.enabled
        ? '启扰功率必须为 -10～30 dBm 且按 5 dB 档位设置。'
        : '停机功率必须为不小于 0 的有限值。'],
      [command.direction >= 0 && command.direction <= 360, 'direction', '方向必须在 0–360° 范围内。'],
      [command.duration > 0 && command.duration <= scenarioDuration, 'duration', `持续时间必须大于 0 且不超过 ${scenarioDuration} 秒。`],
    ]
    const rejected = checks.find(([valid]) => !valid)
    return rejected === undefined
      ? { ok: true }
      : { ok: false, code: 'OUT_OF_RANGE', status: 422, fieldPath: rejected[1], message: rejected[2] }
  }

  /**
   * 校验并执行任务级 RF 干扰机命令。
   * @param taskId 命令所属任务编号。
   * @param jammerId 目标干扰设备编号。
   * @param value 未受信任的命令请求体。
   * @returns 成功时返回带生效帧的设备状态，失败时返回可定位的拒绝原因。
   * @remarks 能力上限直接取当前场景配置；仅更新确定性控制结果，不连接真实设备。
   */
  controlJammer(taskId: string, jammerId: string, value: unknown): SimulationProjectionResult<JammerState> {
    if (!ownsFixedEvidence(this.run)) return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'scenarioId', message: '当前场景暂无对应运行证据。' }
    if (taskId !== this.run.taskId) {
      return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'taskId', message: '未找到指定任务。' }
    }
    const command = readJammingCommand(value)
    if (command === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'command', message: 'RF 干扰控制命令结构不正确。' }
    }
    const draft = this.scenarios.get(this.run.scenarioId)
    if (!draft.ok) return draft
    const jammer = draft.data.config.jammers.find((item) => item.id === jammerId)
    const extension = draft.data.uiExtensions.jammers.find((item) => item.jammerId === jammerId)
    if (jammer === undefined || extension === undefined || !extension.enabled) {
      return { ok: false, code: 'DEVICE_DISABLED', status: 409, fieldPath: 'jammerId', message: '所选干扰设备不可用。' }
    }

    const range = this.validateJammerRange(jammer, command, draft.data.config.scenario.duration)
    if (!range.ok) return range

    return {
      ok: true,
      data: {
        taskId: this.run.taskId,
        jammerId,
        ...command,
        executionStatus: 'SUCCESS',
        effectiveFrameId: loadFixtureProjection().frame.frameId,
        reason: command.enabled ? '任务手动启扰' : '任务手动停扰',
      },
    }
  }

  /**
   * 执行侦测、启扰和链路劣化的同帧闭环。
   * @param runId 闭环所属仿真运行编号。
   * @param value 未受信任的闭环上下文。
   * @returns 首次有效迁移返回干扰决策；同目标同帧重复请求返回幂等冲突。
   * @sideEffects 成功后登记同目标同帧的迁移键，防止第二次动作。
   */
  runClosedLoop(runId: string, value: unknown): SimulationProjectionResult<JammingDecision> {
    if (!ownsFixedEvidence(this.run)) return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'scenarioId', message: '当前场景暂无对应运行证据。' }
    if (runId !== this.run.runId) {
      return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'runId', message: '未找到指定仿真运行。' }
    }
    const context = readClosedLoopContext(value)
    if (context === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'context', message: '闭环上下文结构不正确。' }
    }
    const fixture = loadFixtureProjection()
    const detection = fixture.events.find((event) => event.type === 'DETECTION' && event.eventId === context.detectionEventId)
    if (context.frameId !== fixture.frame.frameId || detection?.frameId !== context.frameId || detection.type !== 'DETECTION') {
      return { ok: false, code: 'FRAME_MISMATCH', status: 409, fieldPath: 'frameId', message: '侦测事件与闭环上下文不属于同一帧。' }
    }
    if (detection.detected === false) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'detectionEventId', message: '未发现目标的侦测事件不能触发闭环。' }
    }
    if (detection.targetPlatformId !== context.targetPlatformId) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'targetPlatformId', message: '闭环目标与侦测目标不一致。' }
    }
    const execution = frameJammerExecutions(fixture.frame).find(item => item.targetPlatformId === context.targetPlatformId)
    const affectedLink = fixture.frame.uiLinks.find((link) => link.linkId === context.affectedLinkId)
    const closedLoopLinkIds = new Set(fixture.frame.evidence.routeDecisions.map((decision) => decision.previousLinkId))
    if (execution === undefined
      || affectedLink === undefined
      || !closedLoopLinkIds.has(affectedLink.linkId)
      || (affectedLink.status !== 'DEGRADED' && affectedLink.status !== 'DOWN')) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'affectedLinkId', message: '闭环执行证据与目标链路或链路状态不一致。' }
    }

    const transitionKey = `${context.frameId}:${context.targetPlatformId}`
    if (this.processedClosedLoops.has(transitionKey)) {
      return { ok: false, code: 'DUPLICATE_EVENT', status: 409, fieldPath: 'detectionEventId', message: '同一目标同一帧已完成闭环处理。' }
    }
    this.processedClosedLoops.add(transitionKey)
    return {
      ok: true,
      data: {
        decisionId: `DEC-${context.detectionEventId}`,
        runId: this.run.runId,
        frameId: context.frameId,
        detectionEventId: context.detectionEventId,
        targetPlatformId: context.targetPlatformId,
        jammerId: execution.jammerId,
        affectedLinkId: context.affectedLinkId,
        action: 'START',
        linkStatus: affectedLink.status,
        effectiveFrameId: execution.startTime === fixture.frame.simulationTime ? context.frameId : fixture.frame.frameId,
        reason: execution.reason,
      },
    }
  }

  /**
   * 读取当前运行/设备的本地参数记录；持久化无记录时按场景探测范围与当前版本返回默认值（不落库）。
   * @param jammerId 目标干扰设备编号。
   * @returns 运行期参数记录（可修改后再持久化）。
   */
  private readRuntimeRecord(jammerId: string): JammerPlanRecord {
    const stored = this.jammerPlanStorage.load(this.run.taskId, this.run.runId, jammerId)
    if (stored !== undefined) return stored
    const draft = this.scenarios.get(this.run.scenarioId)
    const jammer = draft.ok ? draft.data.config.jammers.find((item) => item.id === jammerId) : undefined
    return { version: this.jammerParameterVersions.get(jammerId) ?? 4, detectionRangeM: jammer?.detectionRange ?? 0 }
  }

  /**
   * 读取当前运行的干扰机运行期本地参数（版本 + 本地已接受值与计划）；不依赖固定演示证据。
   * @param taskId 参数所属任务编号。
   * @param jammerId 目标干扰设备编号。
   * @returns 运行期参数，或任务/场景/设备不匹配的 404。
   */
  getJammerRuntimeParameters(taskId: string, jammerId: string): SimulationProjectionResult<JammerRuntimeParameters> {
    if (taskId !== this.run.taskId) return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'taskId', message: '未找到指定任务。' }
    const draft = this.scenarios.get(this.run.scenarioId)
    if (!draft.ok) return draft
    if (!draft.data.config.jammers.some((item) => item.id === jammerId)) {
      return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'jammerId', message: '未找到指定干扰设备。' }
    }
    const record = this.readRuntimeRecord(jammerId)
    return { ok: true, data: toRuntimeParameters(this.run.taskId, jammerId, record) as JammerRuntimeParameters }
  }

  /**
   * 保存当前运行的干扰计划与新增控制字段（仅本地留存并持久化，不修改场景原配置、不代表引擎执行）。
   * @param taskId 计划所属任务编号。
   * @param jammerId 目标干扰设备编号。
   * @param value 未受信任的计划保存请求。
   * @returns 保存结果（storage=LOCAL_RUN），或参数、范围、任务/设备错误。
   */
  saveJammerPlan(taskId: string, jammerId: string, value: unknown): SimulationProjectionResult<JammerPlanSaved> {
    if (taskId !== this.run.taskId) return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'taskId', message: '未找到指定任务。' }
    const request = readJammerPlanSaveRequest(value)
    if (request === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'plan', message: '干扰计划保存请求结构不正确。' }
    }
    if (request.elevation < -10 || request.elevation > 60) {
      return { ok: false, code: 'OUT_OF_RANGE', status: 422, fieldPath: 'elevation', message: '俯仰角必须在 -10～60° 之间。' }
    }
    if (request.plannedStartFrame !== undefined && request.plannedStopFrame !== undefined
      && request.plannedStopFrame <= request.plannedStartFrame) {
      return { ok: false, code: 'OUT_OF_RANGE', status: 422, fieldPath: 'plannedStopFrame', message: '计划停止帧必须大于计划启动帧。' }
    }
    const draft = this.scenarios.get(this.run.scenarioId)
    if (!draft.ok) return draft
    const jammer = draft.data.config.jammers.find((item) => item.id === jammerId)
    if (jammer === undefined) {
      return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'jammerId', message: '未找到指定干扰设备。' }
    }
    const record = this.readRuntimeRecord(jammerId)
    record.style = request.style
    record.elevation = request.elevation
    if (request.plannedStartFrame === undefined) delete record.plannedStartFrame
    else record.plannedStartFrame = request.plannedStartFrame
    if (request.plannedStopFrame === undefined) delete record.plannedStopFrame
    else record.plannedStopFrame = request.plannedStopFrame
    this.jammerPlanStorage.save(this.run.taskId, this.run.runId, jammerId, record)
    return {
      ok: true,
      data: {
        taskId: this.run.taskId,
        jammerId,
        style: request.style,
        elevation: request.elevation,
        plannedStartFrame: request.plannedStartFrame,
        plannedStopFrame: request.plannedStopFrame,
        storage: 'LOCAL_RUN',
      },
    }
  }

  /**
   * 本地接受并持久化一版干扰参数（含可选探测范围）。
   * @param taskId 参数所属任务编号。
   * @param jammerId 目标干扰设备编号。
   * @param value 未受信任的版本化参数集。
   * @returns 本地接受结果（LOCAL_ACCEPTED / engineSync=NOT_CONNECTED），或版本、范围、任务/设备错误。
   * @remarks 与真实插件执行分离：不调用受固定证据限制的 controlJammer；先持久化成功再推进内存版本，
   *          写盘失败不改变版本/参数/状态，允许同一版本重试。固定证据运行保留原帧校验，非固定运行接受请求帧号为本地记录。
   */
  syncJammerParameters(taskId: string, jammerId: string, value: unknown): SimulationProjectionResult<SyncResult> {
    if (taskId !== this.run.taskId) {
      return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'taskId', message: '未找到指定任务。' }
    }
    const parameterSet = readJammingParameterSet(value)
    if (parameterSet === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'parameters', message: '干扰参数同步请求结构不正确。' }
    }
    // 探测范围为可选扩展字段；提供时按合同米制范围（1～100 km）校验，旧请求缺省不受影响。
    if (parameterSet.detectionRangeM !== undefined
      && (parameterSet.detectionRangeM < JAMMER_RANGE_METERS.min || parameterSet.detectionRangeM > JAMMER_RANGE_METERS.max)) {
      return {
        ok: false,
        code: 'OUT_OF_RANGE',
        status: 422,
        fieldPath: 'detectionRangeM',
        message: `探测范围必须在 ${JAMMER_RANGE_METERS.min / 1000}～${JAMMER_RANGE_METERS.max / 1000} km 之间。`,
      }
    }
    const draft = this.scenarios.get(this.run.scenarioId)
    if (!draft.ok) return draft
    const jammer = draft.data.config.jammers.find((item) => item.id === jammerId)
    if (jammer === undefined) {
      return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'jammerId', message: '未找到指定干扰设备。' }
    }
    const extension = draft.data.uiExtensions.jammers.find((item) => item.jammerId === jammerId)
    if (extension === undefined || !extension.enabled) {
      return { ok: false, code: 'DEVICE_DISABLED', status: 409, fieldPath: 'jammerId', message: '所选干扰设备不可用。' }
    }
    // 本地参数接受只做纯范围校验，不调用受固定证据限制的 controlJammer。
    const range = this.validateJammerRange(jammer, parameterSet.parameters, draft.data.config.scenario.duration)
    if (!range.ok) return range

    // 固定证据运行保留原帧严格校验；非固定/远端运行接受请求帧号作为本地记录，不宣称引擎帧生效。
    const fixedEvidence = ownsFixedEvidence(this.run)
    let effectiveSimulationTime: number
    let targetPlatform: string | undefined
    if (fixedEvidence) {
      const frame = loadFixtureProjection().frame
      if (parameterSet.effectiveFrameId !== frame.frameId) {
        return { ok: false, code: 'FRAME_MISMATCH', status: 409, fieldPath: 'effectiveFrameId', message: '参数只能在当前明确帧边界生效。' }
      }
      effectiveSimulationTime = frame.simulationTime
      targetPlatform = frame.platforms.flatMap((platform) => platform.jammers)
        .find((item) => item.jammerId === jammerId)?.targetPlatform
    } else {
      effectiveSimulationTime = this.run.canonical.currentTime
    }

    const storedRecord = this.jammerPlanStorage.load(this.run.taskId, this.run.runId, jammerId)
    const currentVersion = storedRecord?.version ?? this.jammerParameterVersions.get(jammerId) ?? 4
    if (parameterSet.version <= currentVersion) {
      return { ok: false, code: 'VERSION_CONFLICT', status: 409, fieldPath: 'version', message: `参数版本必须大于当前版本 ${currentVersion}。` }
    }

    const record = this.readRuntimeRecord(jammerId)
    record.version = parameterSet.version
    if (parameterSet.detectionRangeM !== undefined) record.detectionRangeM = parameterSet.detectionRangeM
    try {
      this.jammerPlanStorage.save(this.run.taskId, this.run.runId, jammerId, record)
    } catch {
      // 写盘失败：不推进内存版本，旧记录保持完整；返回明确失败以允许同版本重试。
      return {
        ok: false,
        code: 'ATOMIC_REPLACE_FAILED',
        status: 503,
        fieldPath: 'parameters',
        message: '干扰参数保存失败，请重试；本次未推进版本。',
      }
    }
    // 仅在持久化成功后推进内存已接受版本。
    this.jammerParameterVersions.set(jammerId, parameterSet.version)
    return {
      ok: true,
      data: {
        taskId: this.run.taskId,
        jammerId,
        parameterVersion: parameterSet.version,
        configParameterVersion: parameterSet.version,
        nodeParameterVersion: parameterSet.version,
        uiParameterVersion: parameterSet.version,
        effectiveFrameId: parameterSet.effectiveFrameId,
        effectiveSimulationTime,
        status: 'LOCAL_ACCEPTED',
        engineSync: 'NOT_CONNECTED',
        detectionRangeM: record.detectionRangeM,
        jammerStatus: {
          time: effectiveSimulationTime,
          jammerId,
          platformId: jammer.platformId,
          ...(targetPlatform === undefined ? {} : { targetPlatform }),
          power: parameterSet.parameters.power,
          frequency: parameterSet.parameters.frequency,
          bandwidth: parameterSet.parameters.bandwidth,
          active: parameterSet.parameters.enabled,
        },
      },
    }
  }

  /** 恢复冻结的完成态运行；场景投影由全局 reset 独立恢复。 */
  reset(): void {
    this.run = structuredClone(loadFixtureProjection().run)
    delete this.run.canonical.mode
    delete this.run.canonical.speedMultiplier
    this.processedClosedLoops.clear()
    this.jammerParameterVersions.clear()
    this.jammerPlanStorage.deleteRun(this.run.runId)
  }
}
