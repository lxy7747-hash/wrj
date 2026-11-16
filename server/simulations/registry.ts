import type { SimulationRun, TaskId } from '../../src/contracts/domain-models.js'
import type { ScenarioProjection } from '../scenarios/projection.js'
import type { MissionOutcome } from './mission-execution.js'
import { SimulationProjection, type SimulationProjectionResult } from './projection.js'
import type { JammerPlanStorage } from './jammer-plan-storage.js'
import type { LocalReplaySnapshot } from '../../src/features/replays/local-replay.js'
import { fileReceptionScenarioId, isPlaybackFileSource, playbackFileSource } from '../../src/features/situation/file-reception.js'

/** 已通过提交前校验的创建请求；暂存编号与目标身份，创建提交时据此核对。 */
interface PreparedRun {
  runId: SimulationRun['runId']
  taskId: TaskId
  scenarioId: SimulationRun['scenarioId']
}

/** 创建请求通过校验后的目标身份；编号由 prepare 或 create 分配。 */
interface AdmittedRun {
  taskId: TaskId
  scenarioId: SimulationRun['scenarioId']
  source: unknown
}

/** 本次提交尝试的任务投影；用于把未确认运行回滚到提交前状态。 */
interface RunAttempt {
  runId: SimulationRun['runId']
  taskId: TaskId
  task: SimulationProjection
  committed: boolean
}

/** 每任务沿用原有单运行状态机；并行只发生在不同任务、不同场景之间。 */
export class SimulationRegistry {
  private readonly tasks = new Map<string, SimulationProjection>()
  private readonly reservations = new Map<string, PreparedRun>()
  private attempt: RunAttempt | null = null
  private nextRunSequence = 2

  constructor(private readonly scenarios: ScenarioProjection, private readonly capacity = 1,
    private readonly createRunId?: () => SimulationRun['runId'], private readonly remote = false,
    private readonly jammerPlanStorage?: JammerPlanStorage) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4) throw new RangeError('并行任务数必须是1至4的整数。')
    this.tasks.set('TASK-001', new SimulationProjection(scenarios, 'TASK-001', remote, this.jammerPlanStorage))
  }

  list(): SimulationRun[] { return [...this.tasks.values()].flatMap(task => task.list()) }
  current(taskId: TaskId = 'TASK-001'): SimulationRun | undefined { return this.tasks.get(taskId)?.list()[0] }
  private owner(runId: string): SimulationProjection | undefined {
    return [...this.tasks.values()].find(task => task.get(runId).ok)
  }
  private read<T>(runId: string, action: (task: SimulationProjection) => SimulationProjectionResult<T>): SimulationProjectionResult<T> {
    const task = this.owner(runId)
    return task ? action(task) : { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定仿真运行。' }
  }
  get(runId: string) { return this.read(runId, task => task.get(runId)) }
  getFrame(runId: string, frameId: string) { return this.read(runId, task => task.getFrame(runId, frameId)) }
  listEvents(runId: string) { return this.read(runId, task => task.listEvents(runId)) }
  inspectCommand(runId: string, value: unknown) { return this.read(runId, task => task.inspectCommand(runId, value)) }
  command(runId: string, value: unknown, confirmed = false) { return this.read(runId, task => task.command(runId, value, confirmed)) }
  runClosedLoop(runId: string, value: unknown) { return this.read(runId, task => task.runClosedLoop(runId, value)) }
  controlJammer(taskId: string, jammerId: string, value: unknown) {
    return this.tasks.get(taskId)?.controlJammer(taskId, jammerId, value)
      ?? { ok: false as const, code: 'NOT_FOUND' as const, status: 404 as const, message: '未找到指定任务。' }
  }
  syncJammerParameters(taskId: string, jammerId: string, value: unknown) {
    return this.tasks.get(taskId)?.syncJammerParameters(taskId, jammerId, value)
      ?? { ok: false as const, code: 'NOT_FOUND' as const, status: 404 as const, message: '未找到指定任务。' }
  }
  getJammerRuntimeParameters(taskId: string, jammerId: string) {
    return this.tasks.get(taskId)?.getJammerRuntimeParameters(taskId, jammerId)
      ?? { ok: false as const, code: 'NOT_FOUND' as const, status: 404 as const, message: '未找到指定任务。' }
  }
  saveJammerPlan(taskId: string, jammerId: string, value: unknown) {
    return this.tasks.get(taskId)?.saveJammerPlan(taskId, jammerId, value)
      ?? { ok: false as const, code: 'NOT_FOUND' as const, status: 404 as const, message: '未找到指定任务。' }
  }
  startMission(runId: string, pid: number, startedAt: string): SimulationRun {
    return this.requiredOwner(runId).startMission(pid, startedAt)
  }
  finishMission(runId: string, outcome: MissionOutcome, explicitlyStopped = false): SimulationRun { return this.requiredOwner(runId).finishMission(outcome, explicitlyStopped) }
  startRemote(runId: string, startedAt: string): SimulationRun { return this.requiredOwner(runId).startRemote(startedAt) }
  updateRemoteTime(runId: string, time: number): SimulationRun { return this.requiredOwner(runId).updateRemoteTime(time) }
  finishRemote(runId: string, completedAt: string): SimulationRun { return this.requiredOwner(runId).finishRemote(completedAt) }
  setEngineControl(runId: string, state: NonNullable<SimulationRun['engineControl']>): SimulationRun {
    return this.requiredOwner(runId).setEngineControl(state)
  }
  markMissionStopUncertain(runId: string, message: string): SimulationRun { return this.requiredOwner(runId).markMissionStopUncertain(message) }
  private requiredOwner(runId: string): SimulationProjection {
    const owner = this.owner(runId)
    if (!owner) throw new Error('未找到指定仿真运行。')
    return owner
  }

  /** 校验创建请求、容量、场景与文件来源；prepare 与 create 共用同一顺序，保证失败早于编号分配。 */
  private admit(value: unknown, file?: LocalReplaySnapshot): SimulationProjectionResult<AdmittedRun> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['taskId', 'scenarioId', 'fileSource', 'referenceScenarioId'].includes(key)) || !('taskId' in value) || !('scenarioId' in value)
      || typeof value.taskId !== 'string' || !/^TASK-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.taskId)
      || typeof value.scenarioId !== 'string' || !value.scenarioId.startsWith('SCN-')) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '仿真创建请求结构不正确。' }
    }
    if (this.capacity === 1 && value.taskId !== 'TASK-001') {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'taskId', message: '任务编号与单任务模式不匹配；并行需配置运行容量。' }
    }
    const active = this.list().filter(run => run.configLocked || run.uiStatus === 'RUNNING' || run.uiStatus === 'PAUSED')
    if (active.length >= this.capacity || active.some(run => run.taskId === value.taskId || run.scenarioId === value.scenarioId)) {
      return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '任务或场景已有活动运行，或已达到并行任务容量。' }
    }
    const scene = this.scenarios.get(value.scenarioId)
    const source = 'fileSource' in value ? value.fileSource : undefined
    if ('referenceScenarioId' in value && (!source || typeof value.referenceScenarioId !== 'string' || !this.scenarios.get(value.referenceScenarioId).ok)) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'referenceScenarioId', message: '文件播放仅可关联已有项目场景作为参考配置。' }
    }
    if ('fileSource' in value) {
      const actual = file && playbackFileSource(file)
      if (!this.remote || !isPlaybackFileSource(source) || !actual || source.eventSha256 !== actual.eventSha256
        || source.positionSha256 !== actual.positionSha256 || value.scenarioId !== fileReceptionScenarioId(source)) {
        return { ok: false, code: 'VERSION_CONFLICT', status: 409, message: '文件已改变或来源不匹配，请重新加载后播放。' }
      }
    } else {
      if (!scene.ok) return scene
      if (scene.data.locked) return { ok: false, code: 'CONFIG_LOCKED', status: 409, message: '场景已锁定，不能创建另一运行。' }
    }
    // 限制长期登记数量，历史结果由独立持久快照保存，不靠此内存表累积。
    if (!this.tasks.has(value.taskId) && this.tasks.size >= 64) {
      return { ok: false, code: 'INVALID_TRANSITION', status: 409, message: '任务登记已达64项；请结束活动任务并重置运行上下文。' }
    }
    return { ok: true, data: { taskId: value.taskId as TaskId, scenarioId: value.scenarioId as SimulationRun['scenarioId'], source } }
  }

  /**
   * 在登记装备来源之前预留运行编号与目标身份。
   * @param value 未受信任的创建请求体。
   * @param file 已校验的本地回放快照。
   * @returns 预留编号与目标身份，或创建请求本身的校验错误。
   * @remarks 校验失败不分配编号；显式编号生成器在此处调用一次，数字编号在此处消费一次。
   */
  prepare(value: unknown, file?: LocalReplaySnapshot): SimulationProjectionResult<PreparedRun> {
    const admitted = this.admit(value, file)
    if (!admitted.ok) return admitted
    const runId: SimulationRun['runId'] = this.createRunId?.() ?? `RUN-${String(this.nextRunSequence).padStart(3, '0')}`
    if (this.createRunId === undefined) this.nextRunSequence += 1
    if (!/^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || this.owner(runId)) throw new Error('运行编号生成失败，未锁定场景。')
    const prepared: PreparedRun = { runId, taskId: admitted.data.taskId, scenarioId: admitted.data.scenarioId }
    this.reservations.set(runId, prepared)
    return { ok: true, data: prepared }
  }

  create(value: unknown, file?: LocalReplaySnapshot, reservedRunId?: SimulationRun['runId']): SimulationProjectionResult<SimulationRun> {
    const admitted = this.admit(value, file)
    if (!admitted.ok) return admitted
    const reservation = reservedRunId === undefined ? undefined : this.reservations.get(reservedRunId)
    if (reservedRunId !== undefined && (reservation === undefined
      || reservation.taskId !== admitted.data.taskId || reservation.scenarioId !== admitted.data.scenarioId)) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '仿真创建请求结构不正确。' }
    }
    const task = this.tasks.get(admitted.data.taskId) ?? new SimulationProjection(this.scenarios, admitted.data.taskId, this.remote, this.jammerPlanStorage)
    const runId: SimulationRun['runId'] = reservedRunId ?? this.createRunId?.() ?? `RUN-${String(this.nextRunSequence).padStart(3, '0')}`
    if (!/^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || this.owner(runId)) throw new Error('运行编号生成失败，未锁定场景。')
    this.attempt = { runId, taskId: admitted.data.taskId, task, committed: false }
    const result: SimulationProjectionResult<SimulationRun> = file && isPlaybackFileSource(admitted.data.source)
      ? { ok: true, data: task.createFile({ taskId: admitted.data.taskId, scenarioId: admitted.data.scenarioId, fileSource: admitted.data.source }, file.durationS, runId) }
      : task.create(value, runId)
    if (!result.ok) return result
    // 数字编号已在 prepare 消费；显式编号与未预留创建成功时各消费一次，保持既有序列语义。
    if (reservedRunId === undefined || this.createRunId !== undefined) this.nextRunSequence += 1
    this.tasks.set(admitted.data.taskId, task)
    task.confirmUnconfirmed()
    this.reservations.delete(runId)
    this.attempt = null
    return result
  }

  /**
   * 丢弃本次未提交的运行尝试：恢复被替换的运行、释放本次锁并删除预留编号。
   * @param runId 期望丢弃的本次运行编号；省略时丢弃当前尝试。
   * @returns 无返回值。
   * @remarks 只回滚本次尝试；成功提交后重复调用为无操作，恢复失败时保留未确认快照以便重试。
   */
  discardUnconfirmed(runId?: string): void {
    const attempt = this.attempt
    if (attempt && (runId === undefined || attempt.runId === runId)) {
      this.attempt = null
      attempt.task.discardUnconfirmed(attempt.runId)
      this.reservations.delete(attempt.runId)
      return
    }
    // 尚未进入创建阶段（登记失败）时只清理预留，不触碰任何已提交运行。
    if (runId !== undefined) this.reservations.delete(runId)
  }

  reset(): void {
    this.reservations.clear()
    this.attempt = null
    this.tasks.clear()
    this.tasks.set('TASK-001', new SimulationProjection(this.scenarios, 'TASK-001', this.remote, this.jammerPlanStorage))
  }
}
