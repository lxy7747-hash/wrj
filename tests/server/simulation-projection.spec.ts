import { beforeAll, describe, expect, it } from 'vitest'
import type { DetectionEvent, ScenarioDraft, SimulationCommand, SimulationRun, SwitchEvent, TelemetryFrame } from '../../src/contracts/domain-models'

type ProjectionResult<T> = { ok: true; data: T } | { ok: false; code: string; status: number; fieldPath?: string }

interface ScenarioProjectionInstance {
  get(scenarioId: string): ProjectionResult<ScenarioDraft>
  save(scenarioId: string, value: unknown): ProjectionResult<ScenarioDraft>
}

interface SimulationProjectionInstance {
  list(): SimulationRun[]
  get(runId: string): ProjectionResult<SimulationRun>
  getFrame(runId: string, frameId: string): ProjectionResult<TelemetryFrame>
  listEvents(runId: string): ProjectionResult<Array<DetectionEvent | SwitchEvent>>
  create(value: unknown): ProjectionResult<SimulationRun>
  inspectCommand(runId: string, value: unknown): ProjectionResult<SimulationCommand>
  command(runId: string, value: unknown, stopConfirmed?: boolean): ProjectionResult<SimulationRun>
  reset(): void
}

type ScenarioProjectionConstructor = new () => ScenarioProjectionInstance
type SimulationProjectionConstructor = new (scenarios: ScenarioProjectionInstance) => SimulationProjectionInstance

let ScenarioProjection: ScenarioProjectionConstructor
let SimulationProjection: SimulationProjectionConstructor

beforeAll(async () => {
  const scenarioPath = '../../server/scenarios/' + 'projection.js'
  const simulationPath = '../../server/simulations/' + 'projection.js'
  const scenarioModule = await import(scenarioPath) as { ScenarioProjection: ScenarioProjectionConstructor }
  const simulationModule = await import(simulationPath) as { SimulationProjection: SimulationProjectionConstructor }
  ;({ ScenarioProjection } = scenarioModule)
  ;({ SimulationProjection } = simulationModule)
})

/** 创建共享同一场景锁所有者的仿真测试投影。 */
function projections(): { scenarios: ScenarioProjectionInstance; simulations: SimulationProjectionInstance } {
  const scenarios = new ScenarioProjection()
  return { scenarios, simulations: new SimulationProjection(scenarios) }
}

describe('P3-1 仿真服务端投影', () => {
  it('读取冻结运行并拒绝未知编号', () => {
    const { simulations } = projections()
    expect(simulations.list()).toHaveLength(1)
    expect(simulations.get('RUN-001')).toMatchObject({ ok: true, data: { uiStatus: 'COMPLETED' } })
    expect(simulations.get('RUN-MISSING')).toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404 })
  })

  it('读取指定运行的同帧遥测和事件且拒绝未知编号', () => {
    const { simulations } = projections()
    expect(simulations.getFrame('RUN-001', 'F-00042')).toMatchObject({
      ok: true,
      data: { runId: 'RUN-001', frameId: 'F-00042', simulationTime: 42 },
    })
    expect(simulations.listEvents('RUN-001')).toMatchObject({ ok: true, data: [{ frameId: 'F-00042' }, { frameId: 'F-00042' }] })
    expect(simulations.getFrame('RUN-001', 'F-MISSING')).toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404 })
    expect(simulations.listEvents('RUN-MISSING')).toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404 })
  })

  it('校验创建请求、任务场景匹配和单实例限制', () => {
    const invalidRequests = [null, [], {}, { taskId: 'BAD', scenarioId: 'SCN-001' }, {
      taskId: 'TASK-001', scenarioId: 'SCN-001', extra: true,
    }]
    invalidRequests.forEach((request) => {
      expect(projections().simulations.create(request)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    })

    expect(projections().simulations.create({ taskId: 'TASK-OTHER', scenarioId: 'SCN-001' })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      fieldPath: 'scenarioId',
    })
    const { simulations } = projections()
    expect(simulations.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })).toMatchObject({
      ok: true,
      data: { uiStatus: 'IDLE', configLocked: true },
    })
    expect(simulations.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSITION',
    })
  })

  it('拒绝缺少参数、附加参数、未知运行和非法状态命令', () => {
    const { simulations } = projections()
    expect(simulations.inspectCommand('RUN-MISSING', { command: 'START', mode: 'INTERACTIVE_SINGLE' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    })
    const invalidCommands = [
      null,
      {},
      { command: 'START' },
      { command: 'START', mode: 'UNKNOWN' },
      { command: 'START', mode: 'INTERACTIVE_SINGLE', speedMultiplier: 2 },
      { command: 'STEP' },
      { command: 'STEP', stepCount: 2 },
      { command: 'SET_SPEED' },
      { command: 'SET_SPEED', speedMultiplier: 0 },
      { command: 'SET_SPEED', speedMultiplier: Number.NaN },
      { command: 'STOP', confirmationId: '' },
      { command: 'STOP', mode: 'INTERACTIVE_SINGLE' },
      { command: 'PAUSE', mode: 'INTERACTIVE_SINGLE' },
      { command: 'UNKNOWN' },
    ]
    invalidCommands.forEach((command) => {
      expect(simulations.inspectCommand('RUN-001', command)).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' })
    })
    expect(simulations.inspectCommand('RUN-001', { command: 'PAUSE' })).toMatchObject({
      ok: false,
      code: 'INVALID_TRANSITION',
    })
  })

  it('执行开始、暂停、单步、继续、倍速和受确认停止', () => {
    const { scenarios, simulations } = projections()
    simulations.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })

    expect(simulations.command('RUN-001', { command: 'START', mode: 'INTERACTIVE_SINGLE' })).toMatchObject({
      ok: true,
      data: { uiStatus: 'RUNNING', canonical: { status: 'RUNNING' } },
    })
    expect(simulations.command('RUN-001', { command: 'SET_SPEED', speedMultiplier: 4 })).toMatchObject({ ok: true })
    expect(simulations.command('RUN-001', { command: 'PAUSE' })).toMatchObject({ ok: true, data: { uiStatus: 'PAUSED' } })
    expect(simulations.command('RUN-001', { command: 'STEP', stepCount: 1 })).toMatchObject({
      ok: true,
      data: { canonical: { currentTime: 1 } },
    })
    expect(simulations.command('RUN-001', { command: 'RESUME' })).toMatchObject({ ok: true, data: { uiStatus: 'RUNNING' } })
    simulations.command('RUN-001', { command: 'PAUSE' })
    expect(simulations.command('RUN-001', { command: 'STOP' })).toMatchObject({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      status: 428,
    })
    expect(simulations.command('RUN-001', { command: 'STOP', confirmationId: 'CONF-P2-001' }, true)).toMatchObject({
      ok: true,
      data: { uiStatus: 'STOPPED', configLocked: false, canonical: { status: 'IDLE', currentTime: 0, progress: 0 } },
    })
    expect(scenarios.get('SCN-001')).toMatchObject({ ok: true, data: { locked: false } })
  })

  it('单步到场景末尾时完成运行并自动解锁', () => {
    const { scenarios, simulations } = projections()
    const draft = scenarios.get('SCN-001')
    if (!draft.ok) throw new Error('测试场景不存在')
    draft.data.config.scenario.timeStep = draft.data.config.scenario.duration
    draft.data.config.output.writeInterval = draft.data.config.scenario.duration
    expect(scenarios.save('SCN-001', {
      config: draft.data.config,
      uiExtensions: draft.data.uiExtensions,
    })).toMatchObject({ ok: true })

    simulations.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    simulations.command('RUN-001', { command: 'START', mode: 'INTERACTIVE_SINGLE' })
    simulations.command('RUN-001', { command: 'PAUSE' })
    expect(simulations.command('RUN-001', { command: 'STEP', stepCount: 1 })).toMatchObject({
      ok: true,
      data: {
        uiStatus: 'COMPLETED',
        configLocked: false,
        completedAt: '2026-08-06T10:05:00Z',
        canonical: { status: 'COMPLETED', currentTime: 7200, progress: 100 },
      },
    })
    expect(scenarios.get('SCN-001')).toMatchObject({ ok: true, data: { locked: false } })
  })

  it('reset 恢复冻结完成态且不共享返回对象', () => {
    const { simulations } = projections()
    const first = simulations.list()[0]
    if (first === undefined) throw new Error('冻结运行不存在')
    first.uiStatus = 'ERROR'
    expect(simulations.list()[0]?.uiStatus).toBe('COMPLETED')
    simulations.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    simulations.reset()
    expect(simulations.get('RUN-001')).toMatchObject({ ok: true, data: { uiStatus: 'COMPLETED', configLocked: false } })
  })
})
