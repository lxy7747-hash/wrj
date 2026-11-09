import type { SimulationRun, TaskId } from '../../src/contracts/domain-models.js'
import type { ScenarioProjection } from '../scenarios/projection.js'
import type { MissionOutcome } from './mission-execution.js'
import { SimulationProjection, type SimulationProjectionResult } from './projection.js'
import type { LocalReplaySnapshot } from '../../src/features/replays/local-replay.js'
import { fileReceptionScenarioId, isPlaybackFileSource, playbackFileSource } from '../../src/features/situation/file-reception.js'

/** 每任务沿用原有单运行状态机；并行只发生在不同任务、不同场景之间。 */
export class SimulationRegistry {
  private readonly tasks = new Map<string, SimulationProjection>()
  private nextRunSequence = 2

  constructor(private readonly scenarios: ScenarioProjection, private readonly capacity = 1,
    private readonly createRunId?: () => SimulationRun['runId'], private readonly remote = false) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4) throw new RangeError('并行任务数必须是1至4的整数。')
    this.tasks.set('TASK-001', new SimulationProjection(scenarios, 'TASK-001', remote))
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
  startMission(runId: string, pid: number, startedAt: string): SimulationRun {
    return this.requiredOwner(runId).startMission(pid, startedAt)
  }
  finishMission(runId: string, outcome: MissionOutcome): SimulationRun { return this.requiredOwner(runId).finishMission(outcome) }
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

  create(value: unknown, file?: LocalReplaySnapshot): SimulationProjectionResult<SimulationRun> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['taskId', 'scenarioId', 'fileSource'].includes(key)) || !('taskId' in value) || !('scenarioId' in value)
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
    const task = this.tasks.get(value.taskId) ?? new SimulationProjection(this.scenarios, value.taskId as TaskId, this.remote)
    const runId = this.createRunId?.() ?? `RUN-${String(this.nextRunSequence).padStart(3, '0')}`
    if (!/^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || this.owner(runId)) throw new Error('运行编号生成失败，未锁定场景。')
    const result: SimulationProjectionResult<SimulationRun> = file && isPlaybackFileSource(source)
      ? { ok: true, data: task.createFile({ taskId: value.taskId as TaskId, scenarioId: value.scenarioId as SimulationRun['scenarioId'], fileSource: source }, file.durationS, runId) }
      : task.create(value, runId)
    if (result.ok) { this.nextRunSequence++; this.tasks.set(value.taskId, task) }
    return result
  }

  reset(): void {
    this.tasks.clear()
    this.tasks.set('TASK-001', new SimulationProjection(this.scenarios, 'TASK-001', this.remote))
  }
}
