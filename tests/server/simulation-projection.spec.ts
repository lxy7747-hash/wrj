// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DeterministicFixtureSet, DetectionEvent, JammingDecision, JammerPlanSaved, JammerRuntimeParameters, JammerState, ScenarioDraft, SimulationCommand, SimulationRun, SwitchEvent, SyncResult, TelemetryFrame } from '../../src/contracts/domain-models'

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
  controlJammer(taskId: string, jammerId: string, value: unknown): ProjectionResult<JammerState>
  runClosedLoop(runId: string, value: unknown): ProjectionResult<JammingDecision>
  syncJammerParameters(taskId: string, jammerId: string, value: unknown): ProjectionResult<SyncResult>
  getJammerRuntimeParameters(taskId: string, jammerId: string): ProjectionResult<JammerRuntimeParameters>
  saveJammerPlan(taskId: string, jammerId: string, value: unknown): ProjectionResult<JammerPlanSaved>
  startMission(pid: number, startedAt: string): SimulationRun
  finishMission(outcome: { code: number; completedAt: string }): SimulationRun
  reset(): void
}

type ScenarioProjectionConstructor = new () => ScenarioProjectionInstance
type SimulationProjectionConstructor = new (scenarios: ScenarioProjectionInstance) => SimulationProjectionInstance

let fixtureModule: { loadFixtureProjection(): DeterministicFixtureSet }
let ScenarioProjection: ScenarioProjectionConstructor
let SimulationProjection: SimulationProjectionConstructor

beforeAll(async () => {
  const fixturePath = '../../server/fixtures/' + 'source.js'
  fixtureModule = await import(fixturePath) as typeof fixtureModule
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

  it('START 和 SET_SPEED 投影模式倍速，STOP、reset 和 mission 结束清除', () => {
    const { simulations } = projections()
    const created = simulations.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    if (!created.ok) throw new Error('create failed')
    const runId = created.data.runId
    expect(simulations.command(runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' }))
      .toMatchObject({ ok: true, data: { canonical: { mode: 'INTERACTIVE_SINGLE', speedMultiplier: 1 } } })
    expect(simulations.command(runId, { command: 'SET_SPEED', speedMultiplier: 32 }))
      .toMatchObject({ ok: true, data: { canonical: { mode: 'INTERACTIVE_SINGLE', speedMultiplier: 32 } } })
    const stopped = simulations.command(runId, { command: 'STOP' }, true)
    expect(stopped.ok).toBe(true)
    if (!stopped.ok) return
    expect(stopped.data.canonical).not.toHaveProperty('mode')
    expect(stopped.data.canonical).not.toHaveProperty('speedMultiplier')
    expect(simulations.startMission(123, '2026-11-05T00:00:00Z').canonical).toMatchObject({ mode: 'INTERACTIVE_SINGLE', speedMultiplier: 1 })
    const finished = simulations.finishMission({ code: 0, completedAt: '2026-11-05T00:01:00Z' })
    expect(finished.canonical).not.toHaveProperty('mode')
    expect(finished.canonical).not.toHaveProperty('speedMultiplier')
    simulations.startMission(123, '2026-11-05T00:00:00Z')
    simulations.reset()
    expect(simulations.list()[0]!.canonical).not.toHaveProperty('mode')
    expect(simulations.list()[0]!.canonical).not.toHaveProperty('speedMultiplier')
  })

  it('未发现的侦测事件不能执行闭环', () => {
    const fixture = fixtureModule.loadFixtureProjection()
    const detection = fixture.events.find(event => event.type === 'DETECTION')!
    if (detection.type !== 'DETECTION') throw new Error('missing detection')
    detection.detected = false
    const stub = vi.spyOn(fixtureModule, 'loadFixtureProjection').mockImplementation(() => structuredClone(fixture))
    try {
      expect(projections().simulations.runClosedLoop('RUN-001', { frameId: 'F-00042', detectionEventId: 'DET-042',
        targetPlatformId: 'UAV-01', affectedLinkId: 'L-DL-03' }))
        .toMatchObject({ ok: false, status: 422, fieldPath: 'detectionEventId' })
    } finally { stub.mockRestore() }
  })

  it('多台证据响应同时保留完整数组和第一台单对象，闭环按目标选择第二台', () => {
    const fixture = fixtureModule.loadFixtureProjection()
    const second = { ...fixture.frame.evidence.jammerExecution, jammerId: 'JAM-SPOT-01-TX' }
    const first = { ...fixture.frame.evidence.jammerExecution, targetPlatformId: 'CMD-01' }
    fixture.frame.evidence.jammerExecutions = [first, second]
    const stub = vi.spyOn(fixtureModule, 'loadFixtureProjection').mockImplementation(() => structuredClone(fixture))
    try {
      const { simulations } = projections()
      const result = simulations.getFrame('RUN-001', 'F-00042')
      expect(result).toMatchObject({ ok: true, data: { evidence: { jammerExecution: first, jammerExecutions: [first, second] } } })
      expect(simulations.runClosedLoop('RUN-001', { frameId: 'F-00042', detectionEventId: 'DET-042', targetPlatformId: 'UAV-01', affectedLinkId: 'L-DL-03' }))
        .toMatchObject({ ok: true, data: { jammerId: second.jammerId, targetPlatformId: 'UAV-01' } })
    } finally { stub.mockRestore() }
    expect(fixtureModule.loadFixtureProjection().frame.evidence).not.toHaveProperty('jammerExecutions')
  })

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
    expect(simulations.listEvents('RUN-001')).toMatchObject({ ok: true, data: [{ frameId: 'F-00042' }, { frameId: 'F-00042' }, { frameId: 'F-00042' }] })
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
      fieldPath: 'taskId',
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
    const created = simulations.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    if (!created.ok) throw new Error('创建运行失败')
    const runId = created.data.runId

    expect(simulations.command(runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' })).toMatchObject({
      ok: true,
      data: { uiStatus: 'RUNNING', canonical: { status: 'RUNNING', processId: 2900 } },
    })
    expect(simulations.command(runId, { command: 'SET_SPEED', speedMultiplier: 4 })).toMatchObject({ ok: true })
    expect(simulations.command(runId, { command: 'PAUSE' })).toMatchObject({ ok: true, data: { uiStatus: 'PAUSED' } })
    expect(simulations.command(runId, { command: 'STEP', stepCount: 1 })).toMatchObject({
      ok: true,
      data: { canonical: { currentTime: 1 } },
    })
    expect(simulations.command(runId, { command: 'RESUME' })).toMatchObject({ ok: true, data: { uiStatus: 'RUNNING' } })
    simulations.command(runId, { command: 'PAUSE' })
    expect(simulations.command(runId, { command: 'STOP' })).toMatchObject({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      status: 428,
    })
    expect(simulations.command(runId, { command: 'STOP', confirmationId: 'CONF-P2-001' }, true)).toMatchObject({
      ok: true,
      data: { uiStatus: 'STOPPED', configLocked: false, canonical: { status: 'IDLE', currentTime: 0, progress: 0, processId: null } },
    })
    expect(scenarios.get('SCN-001')).toMatchObject({ ok: true, data: { locked: false } })
  })

  it('单步到场景末尾时完成运行并自动解锁', () => {
    const { scenarios, simulations } = projections()
    const draft = scenarios.get('SCN-001')
    if (!draft.ok) throw new Error('测试场景不存在')
    Object.assign(draft.data.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    draft.data.config.scenario.timeStep = draft.data.config.scenario.duration
    draft.data.config.output.writeInterval = draft.data.config.scenario.duration
    expect(scenarios.save('SCN-001', {
      config: draft.data.config,
      uiExtensions: draft.data.uiExtensions,
      expectedRevision: draft.data.revision,
    })).toMatchObject({ ok: true })

    const created = simulations.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    if (!created.ok) throw new Error('创建运行失败')
    const runId = created.data.runId
    simulations.command(runId, { command: 'START', mode: 'INTERACTIVE_SINGLE' })
    simulations.command(runId, { command: 'PAUSE' })
    expect(simulations.command(runId, { command: 'STEP', stepCount: 1 })).toMatchObject({
      ok: true,
      data: {
        uiStatus: 'COMPLETED',
        configLocked: false,
        completedAt: '2026-08-06T10:05:00Z',
        canonical: { status: 'COMPLETED', currentTime: draft.data.config.scenario.duration, progress: 100, processId: null },
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
    const created = simulations.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    if (!created.ok) throw new Error('创建运行失败')
    simulations.reset()
    expect(simulations.get('RUN-001')).toMatchObject({ ok: true, data: { uiStatus: 'COMPLETED', configLocked: false } })
    const next = simulations.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })
    expect(next).toMatchObject({ ok: true })
    if (!next.ok) throw new Error('再次创建运行失败')
    expect(next.data.runId).not.toBe(created.data.runId)
  })

  it('执行合法 RF 干扰命令并返回确定性生效帧', () => {
    const { simulations } = projections()
    expect(simulations.controlJammer('TASK-001', 'JAM-WB-01-TX', {
      enabled: true,
      frequency: 2200,
      bandwidth: 40,
      power: 1,
      direction: 360,
      duration: 1200,
    })).toEqual({
      ok: true,
      data: {
        taskId: 'TASK-001',
        jammerId: 'JAM-WB-01-TX',
        enabled: true,
        frequency: 2200,
        bandwidth: 40,
        power: 1,
        direction: 360,
        duration: 1200,
        executionStatus: 'SUCCESS',
        effectiveFrameId: 'F-00042',
        reason: '任务手动启扰',
      },
    })
  })

  it('遍历 -10～+30 dBm 九档并按合同 W 往返，拒绝越档与非法输入', () => {
    const { simulations } = projections()
    const tiers = [-10, -5, 0, 5, 10, 15, 20, 25, 30]
    const expectedWatts: Record<number, number> = {
      '-10': 0.0001, '-5': 10 ** (-3.5), '0': 0.001, '5': 10 ** (-2.5), '10': 10 ** (-2),
      '15': 10 ** (-1.5), '20': 0.1, '25': 10 ** (-0.5), '30': 1,
    }
    for (const dbm of tiers) {
      const watts = 10 ** ((dbm - 30) / 10)
      expect(watts).toBeCloseTo(expectedWatts[dbm]!, 9)
      const result = simulations.controlJammer('TASK-001', 'JAM-WB-01-TX', {
        enabled: true, frequency: 2200, bandwidth: 40, power: watts, direction: 360, duration: 1200,
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.power).toBeCloseTo(watts, 10)
    }
    // +40 dBm(10 W)、-15 dBm 与非档位瓦数必须拒绝。
    for (const power of [10, 10 ** ((40 - 30) / 10), 10 ** ((-15 - 30) / 10), 2, 0.0005]) {
      expect(simulations.controlJammer('TASK-001', 'JAM-WB-01-TX', {
        enabled: true, frequency: 2200, bandwidth: 40, power, direction: 360, duration: 1200,
      })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE', fieldPath: 'power' })
    }
    for (const power of [null, '1', Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(simulations.controlJammer('TASK-001', 'JAM-WB-01-TX', {
        enabled: true, frequency: 2200, bandwidth: 40, power, direction: 360, duration: 1200,
      })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    }
  })

  it('停扰 enabled=false 允许 0 W 安全停止，拒绝负值且不因超范围旧功率阻断', () => {
    const { simulations } = projections()
    for (const power of [0, 72]) {
      expect(simulations.controlJammer('TASK-001', 'JAM-WB-01-TX', {
        enabled: false, frequency: 2200, bandwidth: 40, power, direction: 360, duration: 1200,
      })).toMatchObject({ ok: true, data: { enabled: false, power, reason: '任务手动停扰' } })
    }
    expect(simulations.controlJammer('TASK-001', 'JAM-WB-01-TX', {
      enabled: false, frequency: 2200, bandwidth: 40, power: -1, direction: 360, duration: 1200,
    })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE', fieldPath: 'power' })
  })

  it('分别拒绝越界参数、不可用设备和未知任务', () => {
    const valid = { enabled: true, frequency: 2200, bandwidth: 40, power: 1, direction: 360, duration: 1200 }
    const { simulations } = projections()
    for (const [field, value] of [['frequency', 2100], ['power', 73], ['duration', 7201]] as const) {
      expect(simulations.controlJammer('TASK-001', 'JAM-WB-01-TX', { ...valid, [field]: value })).toMatchObject({
        ok: false,
        code: 'OUT_OF_RANGE',
        fieldPath: field,
      })
    }
    expect(simulations.controlJammer('TASK-001', 'JAM-SPOT-01-TX', valid)).toMatchObject({
      ok: false,
      code: 'DEVICE_DISABLED',
      fieldPath: 'jammerId',
    })
    expect(simulations.controlJammer('TASK-MISSING', 'JAM-WB-01-TX', valid)).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
      fieldPath: 'taskId',
    })
    expect(simulations.controlJammer('TASK-001', 'JAM-WB-01-TX', { ...valid, extra: true })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    })
  })

  it('同目标同帧只执行一次侦测启扰闭环', () => {
    const { simulations } = projections()
    const context = { frameId: 'F-00042', detectionEventId: 'DET-042', targetPlatformId: 'UAV-01', affectedLinkId: 'L-DL-03' }
    expect(simulations.runClosedLoop('RUN-001', context)).toMatchObject({
      ok: true,
      data: { detectionEventId: 'DET-042', jammerId: 'JAM-WB-01-TX', affectedLinkId: 'L-DL-03', linkStatus: 'DEGRADED' },
    })
    expect(simulations.runClosedLoop('RUN-001', context)).toMatchObject({ ok: false, code: 'DUPLICATE_EVENT', fieldPath: 'detectionEventId' })
  })

  it('拒绝闭环中的未知运行、错误帧、目标和链路', () => {
    const { simulations } = projections()
    const context = { frameId: 'F-00042', detectionEventId: 'DET-042', targetPlatformId: 'UAV-01', affectedLinkId: 'L-DL-03' }
    expect(simulations.runClosedLoop('RUN-MISSING', context)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(simulations.runClosedLoop('RUN-001', null)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', fieldPath: 'context' })
    expect(simulations.runClosedLoop('RUN-001', { ...context, frameId: 'F-00043' })).toMatchObject({ ok: false, code: 'FRAME_MISMATCH' })
    expect(simulations.runClosedLoop('RUN-001', { ...context, targetPlatformId: 'AIR-01' })).toMatchObject({ ok: false, fieldPath: 'targetPlatformId' })
    expect(simulations.runClosedLoop('RUN-001', { ...context, affectedLinkId: 'L-MISSING' })).toMatchObject({ ok: false, fieldPath: 'affectedLinkId' })
    expect(simulations.runClosedLoop('RUN-001', { ...context, affectedLinkId: 'L-MW-01' })).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      fieldPath: 'affectedLinkId',
    })
  })

  it('只接受递增版本且在明确帧同步四端干扰参数', () => {
    const { simulations } = projections()
    const parameters = { enabled: true, frequency: 2200, bandwidth: 40, power: 1, direction: 360, duration: 1200 }
    expect(simulations.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
      version: 5, effectiveFrameId: 'F-00042', parameters,
    })).toMatchObject({
      ok: true,
      data: {
        parameterVersion: 5, configParameterVersion: 5, nodeParameterVersion: 5,
        engineSync: 'NOT_CONNECTED', uiParameterVersion: 5, effectiveFrameId: 'F-00042', status: 'LOCAL_ACCEPTED',
      },
    })
    expect(simulations.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
      version: 5, effectiveFrameId: 'F-00042', parameters,
    })).toMatchObject({ ok: false, code: 'VERSION_CONFLICT', fieldPath: 'version' })
    expect(simulations.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
      version: 6, effectiveFrameId: 'F-00043', parameters,
    })).toMatchObject({ ok: false, code: 'FRAME_MISMATCH', fieldPath: 'effectiveFrameId' })
    expect(simulations.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', null)).toMatchObject({
      ok: false, code: 'VALIDATION_FAILED', fieldPath: 'parameters',
    })
    expect(simulations.syncJammerParameters('TASK-MISSING', 'JAM-WB-01-TX', {
      version: 6, effectiveFrameId: 'F-00042', parameters,
    })).toMatchObject({ ok: false, code: 'NOT_FOUND', fieldPath: 'taskId' })
  })

  it('运行期本地参数：同步写入探测范围并在读取层回显，非法范围不更新版本，计划保存按运行归属且 reset 清理', () => {
    const { simulations } = projections()
    const parameters = { enabled: true, frequency: 2200, bandwidth: 40, power: 1, direction: 360, duration: 1200 }
    // 初始读取层取场景探测范围 44448 m、版本 4。
    expect(simulations.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { taskId: 'TASK-001', jammerId: 'JAM-WB-01-TX', version: 4, detectionRangeM: 44448 } })
    // 同步接受 25000 m：响应回显与读取层一致（不是场景旧默认）。
    expect(simulations.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
      version: 5, effectiveFrameId: 'F-00042', parameters, detectionRangeM: 25000,
    })).toMatchObject({ ok: true, data: { parameterVersion: 5, detectionRangeM: 25000 } })
    expect(simulations.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { version: 5, detectionRangeM: 25000 } })
    // 非法探测范围（>100km）被拒绝且不更新版本/读取层。
    expect(simulations.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
      version: 6, effectiveFrameId: 'F-00042', parameters, detectionRangeM: 200000,
    })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE', fieldPath: 'detectionRangeM' })
    expect(simulations.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { version: 5, detectionRangeM: 25000 } })
    // 旧请求（无 detectionRangeM）不覆盖既有探测范围，仅推进版本。
    expect(simulations.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
      version: 6, effectiveFrameId: 'F-00042', parameters,
    })).toMatchObject({ ok: true, data: { parameterVersion: 6, detectionRangeM: 25000 } })
    expect(simulations.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { version: 6, detectionRangeM: 25000 } })

    // 计划保存：成功写入运行期读取层（storage=LOCAL_RUN）。
    expect(simulations.saveJammerPlan('TASK-001', 'JAM-WB-01-TX', {
      style: 'BARRAGE', elevation: 10, plannedStartFrame: 300, plannedStopFrame: 900,
    })).toMatchObject({ ok: true, data: { style: 'BARRAGE', elevation: 10, plannedStartFrame: 300, plannedStopFrame: 900, storage: 'LOCAL_RUN' } })
    expect(simulations.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { style: 'BARRAGE', elevation: 10, plannedStartFrame: 300, plannedStopFrame: 900 } })
    // 非法计划（俯仰越界 / 帧顺序倒置 / 非整数帧）被拒绝且不覆盖既有计划。
    expect(simulations.saveJammerPlan('TASK-001', 'JAM-WB-01-TX', { style: 'BARRAGE', elevation: 61 }))
      .toMatchObject({ ok: false, fieldPath: 'elevation' })
    expect(simulations.saveJammerPlan('TASK-001', 'JAM-WB-01-TX', { style: 'SPOT', elevation: 0, plannedStartFrame: 900, plannedStopFrame: 300 }))
      .toMatchObject({ ok: false, fieldPath: 'plannedStopFrame' })
    expect(simulations.saveJammerPlan('TASK-001', 'JAM-WB-01-TX', { style: 'BARRAGE', elevation: 0, plannedStartFrame: 1.5 }))
      .toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    expect(simulations.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { plannedStartFrame: 300, plannedStopFrame: 900 } })
    // reset 清理运行期参数（回到场景初值）。
    simulations.reset()
    expect(simulations.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { version: 4, detectionRangeM: 44448 } })
  })

  it('远端运行（非固定证据）仍可保存并读取本地计划，不依赖固定演示证据', () => {
    const { scenarios } = projections()
    const RemoteProjection = SimulationProjection as unknown as new (
      scenarios: ScenarioProjectionInstance, taskId: string, remote: boolean,
    ) => SimulationProjectionInstance
    const remote = new RemoteProjection(scenarios, 'TASK-001', true)
    expect(remote.saveJammerPlan('TASK-001', 'JAM-WB-01-TX', {
      style: 'SPOT', elevation: 12, plannedStartFrame: 300, plannedStopFrame: 900,
    })).toMatchObject({ ok: true, data: { storage: 'LOCAL_RUN', style: 'SPOT', elevation: 12, plannedStartFrame: 300, plannedStopFrame: 900 } })
    expect(remote.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { style: 'SPOT', elevation: 12, plannedStartFrame: 300, plannedStopFrame: 900 } })
  })

  it('非固定运行仍拒绝本地投影控制，不回退到本地 SUCCESS', () => {
    const { scenarios } = projections()
    const RemoteProjection = SimulationProjection as unknown as new (
      scenarios: ScenarioProjectionInstance, taskId: string, remote: boolean,
    ) => SimulationProjectionInstance
    const remote = new RemoteProjection(scenarios, 'TASK-001', true)
    const command = { enabled: true, frequency: 2200, bandwidth: 40, power: 1, direction: 360, duration: 1200 }
    expect(remote.controlJammer('TASK-001', 'JAM-WB-01-TX', command))
      .toMatchObject({ ok: false, code: 'NOT_FOUND', fieldPath: 'scenarioId' })
    expect(remote.runClosedLoop('RUN-001', { frameId: 'F-00042', detectionEventId: 'DET-042', targetPlatformId: 'UAV-01', affectedLinkId: 'L-DL-03' }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' })
    // 本地参数接受与真实控制分离：非固定/远端运行允许本地保存与回读，但不宣称引擎帧生效。
    expect(remote.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
      version: 5, effectiveFrameId: 'F-00042', parameters: command, detectionRangeM: 25000,
    })).toMatchObject({
      ok: true,
      data: { status: 'LOCAL_ACCEPTED', engineSync: 'NOT_CONNECTED', parameterVersion: 5, effectiveFrameId: 'F-00042', detectionRangeM: 25000 },
    })
    expect(remote.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { version: 5, detectionRangeM: 25000 } })
    // 真实控制保护仍有效：命令仍 404。
    expect(remote.controlJammer('TASK-001', 'JAM-WB-01-TX', command))
      .toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('运行期干扰计划持久化：关闭并重建 SQLite 存储与服务后同运行仍可读回，版本递增保护保留', async () => {
    // 与既有 Node 专用测试一致，用字符串拼接动态导入，避免浏览器类型工程解析 node:/server 模块。
    const fsModule = 'node:fs/' + 'promises'
    const osModule = 'node:' + 'os'
    const pathModule = 'node:' + 'path'
    const storageModule = '../../server/local/' + 'jammer-plan-sqlite.js'
    const { mkdtemp, rm } = await import(fsModule)
    const { tmpdir } = await import(osModule)
    const { join } = await import(pathModule)
    const { JammerPlanSqliteStorage } = await import(storageModule)
    const dir = await mkdtemp(join(tmpdir(), 'wrj-jammer-plan-'))
    const dbPath = join(dir, 'jammer-plans.db')
    const StorageConstructor = SimulationProjection as unknown as new (
      scenarios: ScenarioProjectionInstance, taskId?: string, remote?: boolean, storage?: unknown,
    ) => SimulationProjectionInstance
    const parameters = { enabled: true, frequency: 2200, bandwidth: 40, power: 1, direction: 360, duration: 1200 }
    try {
      const storageA = new JammerPlanSqliteStorage(dbPath)
      const simA = new StorageConstructor(new ScenarioProjection(), 'TASK-001', false, storageA)
      expect(simA.saveJammerPlan('TASK-001', 'JAM-WB-01-TX', {
        style: 'SPOT', elevation: 12, plannedStartFrame: 300, plannedStopFrame: 900,
      })).toMatchObject({ ok: true, data: { storage: 'LOCAL_RUN', plannedStartFrame: 300, plannedStopFrame: 900 } })
      expect(simA.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
        version: 5, effectiveFrameId: 'F-00042', parameters, detectionRangeM: 25000,
      })).toMatchObject({ ok: true, data: { detectionRangeM: 25000 } })
      // 关闭连接（等价进程退出/存储关闭）。
      storageA.close()

      // 重建 SQLite 存储与场景/仿真服务对象，同一运行仍可读回。
      const storageB = new JammerPlanSqliteStorage(dbPath)
      const simB = new StorageConstructor(new ScenarioProjection(), 'TASK-001', false, storageB)
      expect(simB.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX')).toMatchObject({
        ok: true,
        data: { version: 5, detectionRangeM: 25000, style: 'SPOT', elevation: 12, plannedStartFrame: 300, plannedStopFrame: 900 },
      })
      // 版本递增保护跨重建仍生效（读取已持久化版本）。
      expect(simB.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
        version: 5, effectiveFrameId: 'F-00042', parameters,
      })).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' })
      expect(simB.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
        version: 6, effectiveFrameId: 'F-00042', parameters,
      })).toMatchObject({ ok: true, data: { detectionRangeM: 25000 } })
      storageB.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('写盘失败不推进内存版本：失败后同版本可重试，已有记录旧值保持完整，重开 DB 一致', async () => {
    const fsModule = 'node:fs/' + 'promises'
    const osModule = 'node:' + 'os'
    const pathModule = 'node:' + 'path'
    const storageModule = '../../server/local/' + 'jammer-plan-sqlite.js'
    const { mkdtemp, rm } = await import(fsModule)
    const { tmpdir } = await import(osModule)
    const { join } = await import(pathModule)
    const { JammerPlanSqliteStorage } = await import(storageModule)
    const dir = await mkdtemp(join(tmpdir(), 'wrj-jammer-plan-fail-'))
    const dbPath = join(dir, 'jammer-plans.db')
    const { scenarios } = projections()
    const StorageConstructor = SimulationProjection as unknown as new (
      scenarios: ScenarioProjectionInstance, taskId?: string, remote?: boolean, storage?: unknown,
    ) => SimulationProjectionInstance
    const inner = new JammerPlanSqliteStorage(dbPath)
    let failNext = false
    // “首次 save 抛错、随后委托真实 SQLite”的存储包装，走真实持久化路径。
    const flaky = {
      load: (t: string, r: string, j: string) => inner.load(t, r, j),
      save: (t: string, r: string, j: string, record: Parameters<typeof inner.save>[3]) => {
        if (failNext) { failNext = false; throw new Error('disk full') }
        inner.save(t, r, j, record)
      },
      deleteRun: (r: string) => inner.deleteRun(r),
      close: () => inner.close(),
    }
    try {
      const sim = new StorageConstructor(scenarios, 'TASK-001', false, flaky)
      const parameters = { enabled: true, frequency: 2200, bandwidth: 40, power: 1, direction: 360, duration: 1200 }
      const submit = (version: number, detectionRangeM: number) => sim.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', {
        version, effectiveFrameId: 'F-00042', parameters, detectionRangeM,
      })

      // 首次写盘失败：不推进版本、不写新记录、返回明确失败。
      failNext = true
      expect(submit(5, 25000)).toMatchObject({ ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503 })
      expect(sim.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
        .toMatchObject({ ok: true, data: { version: 4, detectionRangeM: 44448 } })
      expect(inner.load('TASK-001', 'RUN-001', 'JAM-WB-01-TX')).toBeUndefined()
      // 同一版本直接重试成功。
      expect(submit(5, 25000)).toMatchObject({ ok: true, data: { parameterVersion: 5, detectionRangeM: 25000 } })
      // 重试成功后紧接再提交同版本：必须冲突（内存版本已推进）。
      expect(submit(5, 25000)).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' })
      expect(sim.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
        .toMatchObject({ ok: true, data: { version: 5, detectionRangeM: 25000 } })
      // 已有记录时写失败：旧记录/版本完整，允许同版本重试。
      failNext = true
      expect(submit(6, 30000)).toMatchObject({ ok: false, code: 'ATOMIC_REPLACE_FAILED' })
      expect(sim.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
        .toMatchObject({ ok: true, data: { version: 5, detectionRangeM: 25000 } })
      expect(inner.load('TASK-001', 'RUN-001', 'JAM-WB-01-TX')).toMatchObject({ version: 5, detectionRangeM: 25000 })
      expect(submit(6, 30000)).toMatchObject({ ok: true, data: { detectionRangeM: 30000 } })
      // 成功后再提交同版本仍冲突。
      expect(submit(6, 30000)).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' })

      // 关闭并重开数据库：持久化结果一致。
      inner.close()
      const reopened = new JammerPlanSqliteStorage(dbPath)
      expect(reopened.load('TASK-001', 'RUN-001', 'JAM-WB-01-TX')).toMatchObject({ version: 6, detectionRangeM: 30000 })
      reopened.close()
    } finally {
      try { inner.close() } catch { /* already closed */ }
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('非固定运行允许本地参数接受与回读；非法/未知设备/旧版本/跨任务拒绝且不写；新运行不继承', async () => {
    const planStorageModule = '../../server/simulations/' + 'jammer-plan-storage.js'
    const { InMemoryJammerPlanStorage } = await import(planStorageModule)
    const { scenarios } = projections()
    const StorageConstructor = SimulationProjection as unknown as new (
      scenarios: ScenarioProjectionInstance, taskId?: string, remote?: boolean, storage?: unknown,
    ) => SimulationProjectionInstance
    const storage = new InMemoryJammerPlanStorage()
    const remote = new StorageConstructor(scenarios, 'TASK-001', true, storage)
    const parameters = { enabled: true, frequency: 2200, bandwidth: 40, power: 1, direction: 360, duration: 1200 }
    const submit = (taskId: string, version: number, detectionRangeM: number, effectiveFrameId = 'F-LOCAL-1') => remote.syncJammerParameters(taskId, 'JAM-WB-01-TX', {
      version, effectiveFrameId, parameters, detectionRangeM,
    })

    // 非固定/远端运行：本地接受，帧号为本地记录，不宣称引擎帧生效。
    expect(submit('TASK-001', 5, 25000)).toMatchObject({
      ok: true,
      data: { status: 'LOCAL_ACCEPTED', engineSync: 'NOT_CONNECTED', parameterVersion: 5, effectiveFrameId: 'F-LOCAL-1', effectiveSimulationTime: 0, detectionRangeM: 25000 },
    })
    expect(remote.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { version: 5, detectionRangeM: 25000 } })
    // 非法范围 / 未知设备 / 旧版本 / 跨任务：拒绝且不写。
    expect(submit('TASK-001', 6, 200000)).toMatchObject({ ok: false, code: 'OUT_OF_RANGE', fieldPath: 'detectionRangeM' })
    expect(remote.syncJammerParameters('TASK-001', 'JAM-MISSING', { version: 6, effectiveFrameId: 'F-LOCAL-1', parameters }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'jammerId' })
    expect(submit('TASK-001', 5, 25000)).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' })
    expect(submit('TASK-OTHER', 6, 25000)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(remote.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { version: 5, detectionRangeM: 25000 } })
    // 真实控制保护仍在。
    expect(remote.controlJammer('TASK-001', 'JAM-WB-01-TX', parameters)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    // 新运行不继承上一运行的本地参数。
    ;(remote as unknown as { create(value: unknown, runId: string): unknown }).create({ taskId: 'TASK-001', scenarioId: 'SCN-001' }, 'RUN-NEW')
    expect(remote.getJammerRuntimeParameters('TASK-001', 'JAM-WB-01-TX'))
      .toMatchObject({ ok: true, data: { version: 4, detectionRangeM: 44448 } })
  })

  it('同步：未知设备返回 404 fieldPath jammerId，扩展停用保留 409 DEVICE_DISABLED', () => {
    const { scenarios, simulations } = projections()
    const parameters = { enabled: true, frequency: 2200, bandwidth: 40, power: 1, direction: 360, duration: 1200 }
    expect(simulations.syncJammerParameters('TASK-001', 'JAM-MISSING', { version: 5, effectiveFrameId: 'F-00042', parameters }))
      .toMatchObject({ ok: false, code: 'NOT_FOUND', status: 404, fieldPath: 'jammerId' })

    const current = scenarios.get('SCN-001')
    if (!current.ok) throw new Error('缺少演示场景')
    const draft = structuredClone(current.data)
    Object.assign(draft.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
    const extension = draft.uiExtensions.jammers.find(item => item.jammerId === 'JAM-WB-01-TX')
    if (extension === undefined) throw new Error('缺少干扰扩展')
    extension.enabled = false
    const saved = scenarios.save('SCN-001', { config: draft.config, uiExtensions: draft.uiExtensions, expectedRevision: draft.revision })
    if (!saved.ok) throw new Error(saved.code)
    expect(simulations.syncJammerParameters('TASK-001', 'JAM-WB-01-TX', { version: 5, effectiveFrameId: 'F-00042', parameters }))
      .toMatchObject({ ok: false, code: 'DEVICE_DISABLED', status: 409, fieldPath: 'jammerId' })
  })
})
