import type {
  ApiErrorCode,
  ClosedLoopContext,
  JammingDecision,
  JammingCommand,
  JammingParameterSet,
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
import type { ScenarioProjection } from '../scenarios/projection.js'
import type { MissionOutcome } from './mission-execution.js'

export type SimulationProjectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 404 | 409 | 422 | 428 | 503; fieldPath?: string; message: string }

const STARTED_AT = '2026-08-06T08:05:00Z'
const FIXTURE_PROCESS_ID = 2900
const ACTIVE_STATUSES = new Set<SimulationRun['uiStatus']>(['RUNNING', 'PAUSED'])
const MODES = new Set(['INTERACTIVE_SINGLE', 'BATCH_PARAMETER_TRAVERSAL', 'PARAMETER_SCAN', 'HISTORICAL_REPLAY'])

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

/** 从未受信任值读取带版本和生效帧的干扰参数集。 */
function readJammingParameterSet(value: unknown): JammingParameterSet | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<JammingParameterSet>
  const keys = Object.keys(value)
  return keys.length === 3
    && keys.every((key) => ['version', 'effectiveFrameId', 'parameters'].includes(key))
    && Number.isSafeInteger(candidate.version) && Number(candidate.version) > 0
    && typeof candidate.effectiveFrameId === 'string' && candidate.effectiveFrameId.startsWith('F-')
    && readJammingCommand(candidate.parameters) !== undefined
    ? candidate as JammingParameterSet
    : undefined
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
  return run?.scenarioId === loadFixtureProjection().scenario.scenario.id
}

/** 固定演示帧只替换运行身份；测量与业务证据仍来自同一冻结夹具。 */
export function fixedFrameForRun(runId: SimulationRun['runId']): TelemetryFrame {
  const frame = structuredClone(loadFixtureProjection().frame)
  frame.runId = runId
  frame.evidence.routeDecisions.forEach(decision => { decision.runId = runId })
  return frame
}

export class SimulationProjection {
  private run = structuredClone(loadFixtureProjection().run)
  private nextRunSequence = 2
  private readonly processedClosedLoops = new Set<string>()
  private readonly jammerParameterVersions = new Map<string, number>()

  constructor(private readonly scenarios: ScenarioProjection) {}

  startMission(pid: number, startedAt: string): SimulationRun {
    this.run.uiStatus = 'RUNNING'
    this.run.canonical.status = 'RUNNING'
    this.run.canonical.processId = pid
    this.run.startedAt = startedAt
    delete this.run.completedAt
    delete this.run.canonical.errorMessage
    return structuredClone(this.run)
  }

  finishMission(outcome: MissionOutcome): SimulationRun {
    const failed = outcome.code !== 0 || Boolean(outcome.errorMessage)
    this.run.uiStatus = failed ? 'ERROR' : 'COMPLETED'
    this.run.canonical.status = failed ? 'ERROR' : 'COMPLETED'
    this.run.canonical.processId = null
    this.run.completedAt = outcome.completedAt
    if (failed) this.run.canonical.errorMessage = outcome.errorMessage ?? 'mission 执行失败。'
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
  create(value: unknown): SimulationProjectionResult<SimulationRun> {
    const request = readCreateRequest(value)
    if (request === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '仿真创建请求结构不正确。' }
    }
    if (ACTIVE_STATUSES.has(this.run.uiStatus) || this.run.configLocked) {
      return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '当前已有仿真运行，不能重复创建。' }
    }
    const fixture = loadFixtureProjection()
    if (request.taskId !== fixture.task.taskId) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'taskId', message: '任务编号与当前演示任务不匹配。' }
    }
    const locked = this.scenarios.setLocked(request.scenarioId, true)
    if (!locked.ok) return locked

    const runId: SimulationRun['runId'] = `RUN-${String(this.nextRunSequence).padStart(3, '0')}`
    this.nextRunSequence += 1
    this.run = createIdleRun(request, locked.data.config.scenario.duration, runId)
    this.processedClosedLoops.clear()
    this.jammerParameterVersions.clear()
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

    // ponytail: 原始设备合同未给独立上下限；Mock 暂以中心频率±半带宽、默认功率和场景时长形成可测边界，接入真实设备能力合同后替换。
    const frequencyMin = jammer.frequency - jammer.bandwidth / 2
    const frequencyMax = jammer.frequency + jammer.bandwidth / 2
    const checks: Array<[boolean, keyof JammingCommand, string]> = [
      [command.frequency >= frequencyMin && command.frequency <= frequencyMax, 'frequency', `频率必须在 ${frequencyMin}–${frequencyMax} MHz 范围内。`],
      [command.bandwidth > 0 && command.bandwidth <= jammer.bandwidth, 'bandwidth', `带宽必须大于 0 且不超过 ${jammer.bandwidth} MHz。`],
      [command.power >= 0 && command.power <= jammer.defaultPower, 'power', `功率必须在 0–${jammer.defaultPower} W 范围内。`],
      [command.direction >= 0 && command.direction <= 360, 'direction', '方向必须在 0–360° 范围内。'],
      [command.duration > 0 && command.duration <= draft.data.config.scenario.duration, 'duration', `持续时间必须大于 0 且不超过 ${draft.data.config.scenario.duration} 秒。`],
    ]
    const rejected = checks.find(([valid]) => !valid)
    if (rejected !== undefined) {
      return { ok: false, code: 'OUT_OF_RANGE', status: 422, fieldPath: rejected[1], message: rejected[2] }
    }

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
    if (detection.targetPlatformId !== context.targetPlatformId) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'targetPlatformId', message: '闭环目标与侦测目标不一致。' }
    }
    const execution = fixture.frame.evidence.jammerExecution
    const affectedLink = fixture.frame.uiLinks.find((link) => link.linkId === context.affectedLinkId)
    const closedLoopLinkIds = new Set(fixture.frame.evidence.routeDecisions.map((decision) => decision.previousLinkId))
    if (execution.targetPlatformId !== context.targetPlatformId
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
   * 在明确帧边界同步一版干扰参数。
   * @param taskId 参数所属任务编号。
   * @param jammerId 目标干扰设备编号。
   * @param value 未受信任的版本化参数集。
   * @returns 四端版本一致的同步结果，或旧版本、乱序帧和设备能力错误。
   * @sideEffects 成功时更新设备的最新参数版本；失败不修改版本。
   */
  syncJammerParameters(taskId: string, jammerId: string, value: unknown): SimulationProjectionResult<SyncResult> {
    if (!ownsFixedEvidence(this.run)) return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'scenarioId', message: '当前场景暂无对应运行证据。' }
    const parameterSet = readJammingParameterSet(value)
    if (parameterSet === undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'parameters', message: '干扰参数同步请求结构不正确。' }
    }
    const frame = loadFixtureProjection().frame
    if (parameterSet.effectiveFrameId !== frame.frameId) {
      return { ok: false, code: 'FRAME_MISMATCH', status: 409, fieldPath: 'effectiveFrameId', message: '参数只能在当前明确帧边界生效。' }
    }
    const currentVersion = this.jammerParameterVersions.get(jammerId) ?? 4
    if (parameterSet.version <= currentVersion) {
      return { ok: false, code: 'VERSION_CONFLICT', status: 409, fieldPath: 'version', message: `参数版本必须大于当前版本 ${currentVersion}。` }
    }
    const controlled = this.controlJammer(taskId, jammerId, parameterSet.parameters)
    if (!controlled.ok) return controlled
    const draft = this.scenarios.get(this.run.scenarioId)
    if (!draft.ok) return draft
    const jammer = draft.data.config.jammers.find((item) => item.id === jammerId)
    if (jammer === undefined) {
      return { ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'jammerId', message: '未找到指定干扰设备。' }
    }
    const existingStatus = frame.platforms.flatMap((platform) => platform.jammers).find((item) => item.jammerId === jammerId)
    this.jammerParameterVersions.set(jammerId, parameterSet.version)
    return {
      ok: true,
      data: {
        taskId: this.run.taskId,
        jammerId,
        parameterVersion: parameterSet.version,
        configParameterVersion: parameterSet.version,
        nodeParameterVersion: parameterSet.version,
        engineParameterVersion: parameterSet.version,
        uiParameterVersion: parameterSet.version,
        effectiveFrameId: parameterSet.effectiveFrameId,
        effectiveSimulationTime: frame.simulationTime,
        status: 'SYNCHRONIZED',
        jammerStatus: {
          time: frame.simulationTime,
          jammerId,
          platformId: jammer.platformId,
          ...(existingStatus?.targetPlatform === undefined ? {} : { targetPlatform: existingStatus.targetPlatform }),
          power: controlled.data.power,
          frequency: controlled.data.frequency,
          bandwidth: controlled.data.bandwidth,
          active: controlled.data.enabled,
        },
      },
    }
  }

  /** 恢复冻结的完成态运行；场景投影由全局 reset 独立恢复。 */
  reset(): void {
    this.run = structuredClone(loadFixtureProjection().run)
    this.processedClosedLoops.clear()
    this.jammerParameterVersions.clear()
  }
}
