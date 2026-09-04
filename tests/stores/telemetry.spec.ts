import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { Principal, RealtimeEnvelope, ScenarioDraft, SimulationRun, TelemetryFrame } from '../../src/contracts/domain-models'
import { validateCandidateSnapshot } from '../../src/features/situation/situation-model'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'
import { useSimulationStore } from '../../src/stores/simulation'
import { isTelemetryFrame, useTelemetryStore } from '../../src/stores/telemetry'

const frame = fixtureSource.frame as unknown as TelemetryFrame
const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
}

/** 创建统一成功响应。 */
function successResponse(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

class TestWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly instances: TestWebSocket[] = []
  readonly url: string
  readyState = TestWebSocket.CONNECTING
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>()

  constructor(url: string) {
    this.url = url
    TestWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(message: string): void {
    this.sent.push(message)
  }

  close(): void {
    this.readyState = 3
  }

  emit(type: string, data?: unknown): void {
    if (type === 'open') this.readyState = TestWebSocket.OPEN
    this.listeners.get(type)?.forEach((listener) => listener({ data }))
  }
}

describe('P3-2 遥测 Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
    TestWebSocket.instances.length = 0
    vi.stubGlobal('WebSocket', TestWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('执行 RF 干扰命令并在失败时清除旧成功结果', async () => {
    const store = useTelemetryStore()
    const command = { enabled: true, frequency: 2200, bandwidth: 40, power: 72, direction: 360, duration: 1470 }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse({
      taskId: 'TASK-001',
      jammerId: 'JAM-WB-01-TX',
      ...command,
      executionStatus: 'SUCCESS',
      effectiveFrameId: 'F-00042',
      reason: '任务手动启扰',
    })))

    await expect(store.controlJammer('TASK-001', 'JAM-WB-01-TX', command)).resolves.toBe(true)
    expect(store).toMatchObject({
      jammerControlState: 'SUCCESS',
      jammerResultCode: 'SUCCESS',
      jammerState: { effectiveFrameId: 'F-00042', power: 72 },
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'OUT_OF_RANGE', message: '功率超出设备能力范围。', fieldPath: 'power' },
      }),
    } as unknown as Response))
    await expect(store.controlJammer('TASK-001', 'JAM-WB-01-TX', { ...command, power: 73 })).resolves.toBe(false)
    expect(store).toMatchObject({
      jammerControlState: 'ERROR',
      jammerResultCode: 'OUT_OF_RANGE',
      jammerResultMessage: '功率超出设备能力范围。',
      jammerResultFieldPath: 'power',
      jammerState: null,
    })
  })

  it('在 RF 干扰命令权限、输入和响应异常时安全失败', async () => {
    const auth = useAuthStore()
    const store = useTelemetryStore()
    const command = { enabled: true, frequency: 2200, bandwidth: 40, power: 72, direction: 360, duration: 1470 }
    auth.principal = { ...operator, permissions: ['BUSINESS_READ'] }
    auth.permissions = ['BUSINESS_READ']
    await expect(store.controlJammer('TASK-001', 'JAM-WB-01-TX', command)).resolves.toBe(false)
    expect(store).toMatchObject({ jammerResultCode: 'PERMISSION_DENIED', jammerControlState: 'ERROR' })

    auth.principal = { ...operator, permissions: [...operator.permissions] }
    auth.permissions = [...operator.permissions]
    await expect(store.controlJammer('TASK-001', 'JAM-WB-01-TX', { ...command, power: Number.NaN })).resolves.toBe(false)
    expect(store.jammerResultCode).toBe('INVALID_REQUEST')

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse({})))
    await expect(store.controlJammer('TASK-001', 'JAM-WB-01-TX', command)).resolves.toBe(false)
    expect(store).toMatchObject({ jammerResultCode: 'INVALID_RESPONSE', jammerResultFieldPath: null })

    const validState = {
      taskId: 'TASK-001',
      jammerId: 'JAM-WB-01-TX',
      ...command,
      executionStatus: 'SUCCESS',
      effectiveFrameId: 'F-00042',
      reason: '任务手动启扰',
    }
    for (const invalidState of [
      { ...validState, taskId: 'TASK-OTHER' },
      { ...validState, jammerId: 'JAM-OTHER' },
      { ...validState, frequency: 0 },
      { ...validState, bandwidth: 0 },
      { ...validState, power: -1 },
      { ...validState, direction: -1 },
      { ...validState, direction: 361 },
      { ...validState, duration: 0 },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse(invalidState)))
      await expect(store.controlJammer('TASK-001', 'JAM-WB-01-TX', command)).resolves.toBe(false)
      expect(store).toMatchObject({ jammerControlState: 'ERROR', jammerResultCode: 'INVALID_RESPONSE', jammerState: null })
    }

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(store.controlJammer('TASK-001', 'JAM-WB-01-TX', command)).resolves.toBe(false)
    expect(store).toMatchObject({ jammerResultCode: 'NETWORK_ERROR', jammerResultMessage: '干扰控制服务暂时不可用。' })
  })

  it('原子加载同帧遥测和事件，失败时不保留旧数据', async () => {
    const fetchSpy = vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      successResponse(String(input).endsWith('/events') ? fixtureSource.events : frame),
    ))
    vi.stubGlobal('fetch', fetchSpy)
    const store = useTelemetryStore()

    await expect(store.loadFrame()).resolves.toBe(true)
    expect(store.frame).toMatchObject({ frameId: 'F-00042', simulationTime: 42 })
    expect(store.events).toHaveLength(2)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    } as unknown as Response))
    await expect(store.loadFrame()).resolves.toBe(false)
    expect(store).toMatchObject({ frame: null, events: [], capabilityState: 'ERROR' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, json: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_FOUND' } }),
    } as unknown as Response))
    await expect(store.loadFrame()).resolves.toBe(false)
  })

  it('拒绝无效调制、编码和质量模型版本并保留字段定位', async () => {
    expect(isTelemetryFrame(frame)).toBe(true)
    const store = useTelemetryStore()

    for (const [field, value, code] of [
      ['modulation', '16QAM', 'UNSUPPORTED_MODULATION'],
      ['coding', 'LDPC', 'UNSUPPORTED_CODING'],
      ['qualityModelVersion', 'SNBER-2.0', 'QUALITY_MODEL_VERSION_MISMATCH'],
    ] as const) {
      const candidate = structuredClone(frame)
      const index = candidate.links.findIndex((link) => link.linkId === 'L-MW-01')
      if (index < 0) throw new Error('测试固定帧缺少 L-MW-01 链路')
      Reflect.set(candidate.links[index]!, field, value)
      expect(isTelemetryFrame(candidate)).toBe(false)

      vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
        successResponse(String(input).endsWith('/events') ? fixtureSource.events : candidate),
      )))
      await expect(store.loadFrame()).resolves.toBe(false)
      expect(store).toMatchObject({
        frame: null,
        capabilityState: 'ERROR',
        resultCode: code,
        resultFieldPath: `links[${index}].${field}`,
      })
    }
  })

  it('拒绝越界坐标和非当前时刻图层并保留错误字段', async () => {
    const cases: Array<{ candidate: TelemetryFrame; code: string; path: string }> = []
    const invalidCoordinate = structuredClone(frame)
    invalidCoordinate.platforms[0]!.longitude = 181
    cases.push({ candidate: invalidCoordinate, code: 'COORDINATE_INVALID', path: 'platforms[0].longitude' })
    const stalePlatform = structuredClone(frame)
    stalePlatform.platforms[0]!.updatedAt = 36
    cases.push({ candidate: stalePlatform, code: 'STALE_FRAME_DATA', path: 'platforms[0].updatedAt' })
    const staleJammer = structuredClone(frame)
    const jammerPlatformIndex = staleJammer.platforms.findIndex((platform) => platform.jammers.length > 0)
    staleJammer.platforms[jammerPlatformIndex]!.jammers[0]!.time = 41
    cases.push({ candidate: staleJammer, code: 'STALE_FRAME_DATA', path: `platforms[${jammerPlatformIndex}].jammers[0].time` })
    const staleDetail = structuredClone(frame)
    staleDetail.links[0]!.time = 41
    cases.push({ candidate: staleDetail, code: 'STALE_FRAME_DATA', path: 'links[0].time' })
    const staleProjection = structuredClone(frame)
    staleProjection.uiLinks[0]!.ageMs = 5_001
    cases.push({ candidate: staleProjection, code: 'STALE_FRAME_DATA', path: 'uiLinks[0].ageMs' })
    const inconsistentAge = structuredClone(frame)
    inconsistentAge.linkSummaries[0]!.updatedAt = 37
    cases.push({ candidate: inconsistentAge, code: 'LINK_AGE_MISMATCH', path: 'uiLinks[0].ageMs' })

    const store = useTelemetryStore()
    for (const item of cases) {
      expect(isTelemetryFrame(item.candidate)).toBe(false)
      vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
        successResponse(String(input).endsWith('/events') ? fixtureSource.events : item.candidate),
      )))
      await expect(store.loadFrame()).resolves.toBe(false)
      expect(store).toMatchObject({
        frame: null,
        capabilityState: 'ERROR',
        resultCode: item.code,
        resultFieldPath: item.path,
      })
    }
  })

  it('通过正式加载入口接受当前、最近 1 秒和最近 5 秒数据', async () => {
    const candidate = structuredClone(frame)
    const oneSecondSummary = candidate.linkSummaries.find((summary) => summary.linkKey === 'L-SAT-05')
    const oneSecondProjection = candidate.uiLinks.find((projection) => projection.linkId === 'L-SAT-05')
    if (oneSecondSummary === undefined || oneSecondProjection === undefined) throw new Error('测试固定帧缺少 L-SAT-05')
    candidate.platforms[0]!.updatedAt = 37
    oneSecondSummary.updatedAt = 41
    oneSecondProjection.ageMs = 1_000
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      successResponse(String(input).endsWith('/events') ? fixtureSource.events : candidate),
    )))
    const store = useTelemetryStore()

    await expect(store.loadFrame()).resolves.toBe(true)
    expect(store.frame?.platforms[0]?.updatedAt).toBe(37)
    expect(store.frame?.uiLinks.find(({ linkId }) => linkId === 'L-SAT-05')?.ageMs).toBe(1_000)
  })

  it('固定证据五态与 T-XQ-013 声明一致', async () => {
    const declaredStates = fixtureSource.metadata.capabilities.find(({ id }) => (
      id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-LLZT'
    ))?.states
    let resolveEvents!: (value: unknown) => void
    const eventsResult = new Promise<unknown>((resolve) => {
      resolveEvents = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      String(input).endsWith('/events')
        ? { ok: true, json: () => eventsResult }
        : successResponse(frame),
    )))
    const store = useTelemetryStore()
    const observed = [store.capabilityState]

    const loading = store.loadFrame()
    observed.push(store.capabilityState)
    await vi.waitFor(() => expect(store.capabilityState).toBe('VALIDATING'))
    observed.push(store.capabilityState)
    resolveEvents({ ok: true, data: fixtureSource.events })
    await expect(loading).resolves.toBe(true)
    observed.push(store.capabilityState)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse({})))
    await expect(store.loadFrame()).resolves.toBe(false)
    observed.push(store.capabilityState)

    expect([...new Set(observed)]).toEqual(['EMPTY', 'LOADING', 'VALIDATING', 'SUCCESS', 'ERROR'])
    expect(new Set(declaredStates)).toEqual(new Set(observed))
  })

  it('拒绝跨帧链路状态投影并清空旧数据', async () => {
    const candidate = structuredClone(frame)
    candidate.uiLinks[0]!.frameId = 'F-OTHER'
    expect(isTelemetryFrame(candidate)).toBe(false)

    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      successResponse(String(input).endsWith('/events') ? fixtureSource.events : candidate),
    )))
    const store = useTelemetryStore()
    store.frame = structuredClone(frame)

    await expect(store.loadFrame()).resolves.toBe(false)
    expect(store).toMatchObject({
      frame: null,
      capabilityState: 'ERROR',
      resultCode: 'FRAME_ID_MISMATCH',
      resultFieldPath: 'uiLinks[0].frameId',
    })
  })

  it.each([
    ['空阈值版本', 'thresholdVersion', ''],
    ['未知阈值版本', 'thresholdVersion', 'LLZT-2.0'],
    ['空判定原因', 'reason', ''],
    ['负稳定帧数', 'consecutiveFrames', -1],
    ['小数稳定帧数', 'consecutiveFrames', 1.5],
    ['负数据年龄', 'ageMs', -1],
  ])('拒绝%s', (_label, field, value) => {
    const candidate = structuredClone(frame)
    Reflect.set(candidate.uiLinks[0]!, field, value)

    expect(isTelemetryFrame(candidate)).toBe(false)
  })

  it('在途加载失效或跨帧事件出现时拒绝原子替换', async () => {
    let resolveFrame!: (value: Response) => void
    let resolveEvents!: (value: Response) => void
    const framePromise = new Promise<Response>((resolve) => { resolveFrame = resolve })
    const eventsPromise = new Promise<Response>((resolve) => { resolveEvents = resolve })
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(framePromise)
      .mockReturnValueOnce(eventsPromise))
    const store = useTelemetryStore()
    const loading = store.loadFrame()
    store.resetToSafeEmpty()
    resolveFrame(successResponse(frame))
    resolveEvents(successResponse(fixtureSource.events))
    await expect(loading).resolves.toBe(false)

    const wrongEvents = [{ ...fixtureSource.events[0], frameId: 'F-WRONG' }]
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      successResponse(String(input).endsWith('/events') ? wrongEvents : frame),
    )))
    await expect(store.loadFrame()).resolves.toBe(false)

    for (const invalidEvents of [[null], [{
      eventId: 'BAD-001', frameId: 'F-00042', time: 42, dedupeKey: 'BAD', type: 'UNKNOWN',
    }]]) {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
        successResponse(String(input).endsWith('/events') ? invalidEvents : frame),
      )))
      await expect(store.loadFrame()).resolves.toBe(false)
    }
  })

  it('要求事件 ID 集合完整且事件时间与帧时刻一致', async () => {
    const store = useTelemetryStore()
    const cases = [
      { frame: { ...frame, eventIds: ['DET-042'] }, events: fixtureSource.events },
      { frame: { ...frame, eventIds: ['DET-042', 'DET-042'] }, events: fixtureSource.events },
      { frame, events: [{ ...fixtureSource.events[0], time: 41 }, fixtureSource.events[1]] },
      { frame, events: [fixtureSource.events[0], { ...fixtureSource.events[1], eventId: 'DET-042' }] },
    ]

    for (const item of cases) {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
        successResponse(String(input).endsWith('/events') ? item.events : item.frame),
      )))
      await expect(store.loadFrame()).resolves.toBe(false)
      expect(store).toMatchObject({ frame: null, events: [], capabilityState: 'ERROR' })
    }
  })

  it('校验实时信封、忽略重复消息并在序号断档时补偿', () => {
    const store = useTelemetryStore()
    const recover = vi.spyOn(store, 'recoverFromGap').mockResolvedValue()
    const frameEnvelope: RealtimeEnvelope<TelemetryFrame> = {
      type: 'event', schemaVersion: '1.0', topic: 'simulation.frame', taskId: 'TASK-001', sequence: 4,
      simulationTime: 42, frameId: 'F-00042', payload: structuredClone(frame),
    }

    expect(store.acceptEnvelope(frameEnvelope)).toBe(true)
    expect(store.acceptEnvelope(frameEnvelope)).toBe(true)
    expect(store.topicSequences['simulation.frame']).toBe(4)
    expect(store.acceptEnvelope({ ...frameEnvelope, sequence: 6 })).toBe(false)
    expect(recover).toHaveBeenCalledOnce()
    expect(store.acceptEnvelope({ ...frameEnvelope, frameId: 'F-WRONG', sequence: 5 })).toBe(false)
    expect(store.acceptEnvelope({ type: 'event' })).toBe(false)
  })

  it('只应用与当前帧一致的链路指标，并按 runtime.state 重拉完整运行', async () => {
    const store = useTelemetryStore()
    const linkEnvelope = {
      type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-001', sequence: 3,
      simulationTime: 42, frameId: 'F-00042', payload: frame.linkSummaries,
    } as const
    expect(store.acceptEnvelope(linkEnvelope)).toBe(false)
    store.frame = structuredClone(frame)

    expect(store.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-001', sequence: 3,
      simulationTime: 41, frameId: 'F-00042', payload: frame.linkSummaries,
    })).toBe(false)
    expect(store.acceptEnvelope({ ...linkEnvelope, frameId: 'F-WRONG' })).toBe(false)
    expect(store.acceptEnvelope({ ...linkEnvelope, payload: null })).toBe(false)
    expect(store.acceptEnvelope({ ...linkEnvelope, payload: [null] })).toBe(false)
    expect(store.acceptEnvelope(linkEnvelope)).toBe(true)
    const simulation = useSimulationStore()
    const scenario = useScenarioStore()
    scenario.draft = {
      config: structuredClone(fixtureSource.scenario),
      uiExtensions: { jammers: [], sensors: [] },
      revision: 4,
      officialLibraryChanged: false,
      locked: false,
    } as ScenarioDraft
    simulation.applyRun(structuredClone(fixtureSource.run) as SimulationRun)
    const running = {
      ...structuredClone(fixtureSource.run),
      uiStatus: 'RUNNING',
      canonical: { ...structuredClone(fixtureSource.run.canonical), status: 'RUNNING', currentTime: 43, progress: 1 },
      configLocked: true,
    } as SimulationRun
    const stopped = {
      ...running,
      uiStatus: 'STOPPED',
      canonical: { ...running.canonical, status: 'IDLE', currentTime: 0, progress: 0 },
      configLocked: false,
    } as SimulationRun
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(successResponse([running]))
      .mockResolvedValueOnce(successResponse([stopped]))
    vi.stubGlobal('fetch', fetchSpy)

    expect(store.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'runtime.state', taskId: 'TASK-001', sequence: 8,
      simulationTime: 43,
      payload: running.canonical,
    })).toBe(true)
    await vi.waitFor(() => expect(simulation.run).toMatchObject({ uiStatus: 'RUNNING', configLocked: true }))
    expect(scenario.draft.locked).toBe(true)
    expect(store.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'runtime.state', taskId: 'TASK-001', sequence: 9,
      simulationTime: 0,
      payload: stopped.canonical,
    })).toBe(true)
    await vi.waitFor(() => expect(simulation.run).toMatchObject({ uiStatus: 'STOPPED', configLocked: false }))
    expect(scenario.draft.locked).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:4173/api/v1/simulations', {
      headers: { 'X-Demo-Role': 'OPERATOR' },
      signal: expect.any(AbortSignal),
    })
    expect(store.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'runtime.state', taskId: 'TASK-001', sequence: 10, payload: null,
    })).toBe(false)
  })

  it('按 0～5 秒窗口接收链路指标并同步界面投影数据年龄', () => {
    const store = useTelemetryStore()
    store.frame = structuredClone(frame)
    const recent = structuredClone(frame.linkSummaries)
    const target = recent.find((summary) => (
      summary.sourcePlatform === 'UAV-01'
      && summary.destPlatform === 'GCC-01'
      && summary.linkType === 'MICROWAVE'
    ))
    if (target === undefined) throw new Error('测试固定帧缺少 L-MW-01 摘要')
    target.updatedAt = 40

    const envelope = {
      type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-001', sequence: 1,
      simulationTime: 42, frameId: 'F-00042', payload: recent,
    } as const
    expect(store.acceptEnvelope(envelope)).toBe(true)
    expect(store.frame?.uiLinks.find(({ linkId }) => linkId === 'L-MW-01')?.ageMs).toBe(2_000)

    const acceptedFrame = JSON.parse(JSON.stringify(store.frame)) as TelemetryFrame
    const future = structuredClone(recent)
    future[0]!.updatedAt = 43
    expect(store.acceptEnvelope({ ...envelope, sequence: 2, payload: future })).toBe(false)
    const stale = structuredClone(recent)
    stale[0]!.updatedAt = 36
    expect(store.acceptEnvelope({ ...envelope, sequence: 2, payload: stale })).toBe(false)
    expect(store.topicSequences['link.metric']).toBe(1)
    expect(store.frame).toEqual(acceptedFrame)
  })

  it('从完整快照原子追加同帧 ESM 侦测事件并按事件身份去重', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      successResponse(String(input).endsWith('/events') ? fixtureSource.events : frame),
    )))
    const store = useTelemetryStore()
    await expect(store.loadFrame()).resolves.toBe(true)
    const detection = {
      ...structuredClone(fixtureSource.events[0]!),
      eventId: 'DET-NEW',
      dedupeKey: 'DET-NEW',
    }

    const envelope = {
      type: 'event', schemaVersion: '1.0', topic: 'jammer.event', taskId: 'TASK-001', sequence: 1,
      simulationTime: 42, frameId: 'F-00042', payload: detection,
    } as const
    expect(store.acceptEnvelope(envelope)).toBe(true)
    expect(store.events).toHaveLength(3)
    expect(store.events.at(-1)).toEqual(detection)
    expect(store.frame?.eventIds).toContain('DET-NEW')

    expect(store.acceptEnvelope({ ...envelope, sequence: 2 })).toBe(true)
    expect(store.events).toHaveLength(3)
    expect(store).toMatchObject({ resultCode: 'DUPLICATE_EVENT', resultFieldPath: 'dedupeKey' })

    expect(store.acceptEnvelope({
      ...envelope,
      sequence: 3,
      payload: { ...detection, eventId: 'DET-SAME-KEY' },
    })).toBe(true)
    expect(store.events).toHaveLength(3)

    expect(store.acceptEnvelope({
      ...envelope,
      sequence: 4,
      payload: { ...detection, eventId: 'DET-OTHER', dedupeKey: 'DET-OTHER', targetPlatformId: 'UNKNOWN' },
    })).toBe(false)
    expect(store.acceptEnvelope({
      ...envelope,
      sequence: 4,
      frameId: 'F-OTHER',
      payload: { ...detection, eventId: 'DET-OTHER', dedupeKey: 'DET-OTHER', frameId: 'F-OTHER' },
    })).toBe(false)
    expect(store.acceptEnvelope({
      ...envelope,
      sequence: 4,
      simulationTime: 41,
      payload: { ...detection, eventId: 'DET-OTHER', dedupeKey: 'DET-OTHER', time: 41 },
    })).toBe(false)
    expect(store.topicSequences['jammer.event']).toBe(3)
    expect(store.events).toHaveLength(3)
  })

  it('拒绝四类实时主题的跨任务信封且不推进任何投影', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      successResponse(String(input).endsWith('/events') ? fixtureSource.events : frame),
    )))
    const store = useTelemetryStore()
    const simulation = useSimulationStore()
    await expect(store.loadFrame()).resolves.toBe(true)
    simulation.applyRun(structuredClone(fixtureSource.run) as SimulationRun)
    const detection = {
      ...structuredClone(fixtureSource.events[0]!), eventId: 'DET-NEW', dedupeKey: 'DET-NEW',
    }
    const beforeTelemetry = JSON.parse(JSON.stringify(store.$state)) as typeof store.$state
    const beforeSimulation = JSON.parse(JSON.stringify(simulation.$state)) as typeof simulation.$state
    const envelopes = [
      {
        type: 'event', schemaVersion: '1.0', topic: 'simulation.frame', taskId: 'TASK-OTHER', sequence: 1,
        simulationTime: 42, frameId: 'F-00042', payload: structuredClone(frame),
      },
      {
        type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-OTHER', sequence: 1,
        simulationTime: 42, frameId: 'F-00042', payload: structuredClone(frame.linkSummaries),
      },
      {
        type: 'event', schemaVersion: '1.0', topic: 'runtime.state', taskId: 'TASK-OTHER', sequence: 1,
        simulationTime: 42, payload: structuredClone(fixtureSource.run.canonical),
      },
      {
        type: 'event', schemaVersion: '1.0', topic: 'jammer.event', taskId: 'TASK-OTHER', sequence: 1,
        simulationTime: 42, frameId: 'F-00042', payload: detection,
      },
    ]

    for (const envelope of envelopes) expect(store.acceptEnvelope(envelope)).toBe(false)
    expect(store.$state).toEqual(beforeTelemetry)
    expect(simulation.$state).toEqual(beforeSimulation)
  })

  it('运行状态重拉失败时显示错误、回退序号并触发完整重同步', async () => {
    const store = useTelemetryStore()
    const simulation = useSimulationStore()
    simulation.applyRun(structuredClone(fixtureSource.run) as SimulationRun)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('连接已断开')))
    const recover = vi.spyOn(store, 'recoverFromGap').mockResolvedValue()

    expect(store.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'runtime.state', taskId: 'TASK-001', sequence: 4,
      simulationTime: 43,
      payload: { ...fixtureSource.run.canonical, status: 'RUNNING', currentTime: 43, progress: 1 },
    })).toBe(true)

    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
    expect(store.topicSequences['runtime.state']).toBe(0)
    expect(store).toMatchObject({
      resultCode: 'RUNTIME_STATE_SYNC_FAILED',
      resultMessage: '仿真运行状态同步失败，正在重新同步。',
    })
    expect(simulation).toMatchObject({
      resultCode: 'RUNTIME_SYNC_FAILED',
      resultMessage: '仿真运行状态同步失败：连接已断开',
    })
  })

  it('建立浏览器实时订阅、处理确认并按退避重连', async () => {
    vi.useFakeTimers()
    const store = useTelemetryStore()
    store.frame = structuredClone(frame)
    store.connect()
    const socket = TestWebSocket.instances[0]
    expect(socket?.url).toContain('/ws/v1?role=OPERATOR')
    store.connect()

    socket?.emit('open')
    expect(JSON.parse(socket?.sent[0] ?? '{}')).toMatchObject({
      type: 'subscribe', taskId: 'TASK-001', topics: ['simulation.frame', 'runtime.state', 'link.metric', 'jammer.event'], lastSequence: 0,
    })
    socket?.emit('message', JSON.stringify({ type: 'subscribed' }))
    expect(store.connectionState).toBe('SUBSCRIBED')
    socket?.emit('message', '{bad json')
    const recover = vi.spyOn(store, 'recoverFromGap').mockResolvedValue()
    socket?.emit('message', JSON.stringify({ type: 'rejected', code: 'SEQUENCE_GAP' }))
    expect(recover).toHaveBeenCalledOnce()
    socket?.emit('error')
    expect(store.resultCode).toBe('REALTIME_CONNECTION_FAILED')

    socket?.emit('close')
    expect(store.connectionState).toBe('RETRYING')
    await vi.advanceTimersByTimeAsync(250)
    expect(TestWebSocket.instances).toHaveLength(2)
    store.disconnectAndReset()
    expect(store).toMatchObject({ frame: null, connectionState: 'DISCONNECTED', capabilityState: 'EMPTY' })
  })

  it('处理无 WebSocket 环境、补偿失败和重试耗尽', async () => {
    vi.useFakeTimers()
    const store = useTelemetryStore()
    vi.stubGlobal('WebSocket', undefined)
    store.connect()
    expect(store.connectionState).toBe('DISCONNECTED')

    vi.stubGlobal('WebSocket', TestWebSocket)
    vi.spyOn(store, 'loadFrame').mockResolvedValue(false)
    await store.recoverFromGap()
    expect(TestWebSocket.instances).toHaveLength(0)

    for (let attempt = 0; attempt < 5; attempt += 1) store.scheduleReconnect()
    expect(store.connectionState).toBe('FAILED')
    store.disconnectAndReset()
  })

  it('补偿加载失败后按固定退避继续恢复', async () => {
    vi.useFakeTimers()
    const store = useTelemetryStore()
    const loadFrame = vi.spyOn(store, 'loadFrame')
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const connect = vi.spyOn(store, 'connect').mockImplementation(() => {})

    await store.recoverFromGap()
    expect(store.connectionState).toBe('RETRYING')
    expect(loadFrame).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(250)
    expect(loadFrame).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenCalledOnce()

    let finishCancelledLoad!: (loaded: boolean) => void
    loadFrame.mockImplementationOnce(() => new Promise((resolve) => { finishCancelledLoad = resolve }))
    const cancelledRecovery = store.recoverFromGap()
    store.disconnectAndReset()
    finishCancelledLoad(false)
    await cancelledRecovery
    await vi.runAllTimersAsync()
    expect(loadFrame).toHaveBeenCalledTimes(3)
    expect(store.connectionState).toBe('DISCONNECTED')
  })

  it('按链路身份拒绝不一致的候选快照并保留结构化错误', async () => {
    const candidateFrame = structuredClone(frame)
    const microwave = candidateFrame.evidence.routeCandidates.find(({ linkId }) => linkId === 'L-MW-01')
    const satellite = candidateFrame.evidence.routeCandidates.find(({ linkId }) => linkId === 'L-SAT-02')
    if (microwave === undefined || satellite === undefined) throw new Error('测试固定帧缺少候选链路')
    microwave.ber = satellite.ber

    expect(isTelemetryFrame(frame)).toBe(true)
    expect(isTelemetryFrame(candidateFrame)).toBe(false)
    expect(validateCandidateSnapshot(candidateFrame)).toMatchObject({
      code: 'CANDIDATE_METRIC_MISMATCH',
      fieldPath: 'evidence.routeCandidates[0].ber',
    })

    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      successResponse(String(input).endsWith('/events') ? fixtureSource.events : candidateFrame),
    )))
    const store = useTelemetryStore()
    store.frame = structuredClone(frame)
    await expect(store.loadFrame()).resolves.toBe(false)
    expect(store).toMatchObject({
      frame: null,
      capabilityState: 'ERROR',
      resultCode: 'CANDIDATE_METRIC_MISMATCH',
      resultFieldPath: 'evidence.routeCandidates[0].ber',
    })
  })

  it('拒绝错误身份、重复、跨帧、跨时刻和状态不一致的候选', () => {
    const wrongLink = structuredClone(frame)
    wrongLink.evidence.routeCandidates[0]!.linkId = 'L-UNKNOWN'
    expect(validateCandidateSnapshot(wrongLink)?.code).toBe('CANDIDATE_LINK_NOT_FOUND')

    const duplicate = structuredClone(frame)
    duplicate.evidence.routeCandidates[1] = structuredClone(duplicate.evidence.routeCandidates[0]!)
    expect(validateCandidateSnapshot(duplicate)?.code).toBe('DUPLICATE_ROUTE_CANDIDATE')

    const crossFrame = structuredClone(frame)
    crossFrame.evidence.synchronization.effectiveFrameId = 'F-OTHER'
    expect(validateCandidateSnapshot(crossFrame)?.code).toBe('CANDIDATE_FRAME_MISMATCH')

    const crossTime = structuredClone(frame)
    crossTime.evidence.synchronization.effectiveSimulationTime = 43
    expect(validateCandidateSnapshot(crossTime)?.code).toBe('CANDIDATE_TIME_MISMATCH')

    const statusMismatch = structuredClone(frame)
    statusMismatch.evidence.routeCandidates[0]!.eligible = false
    expect(validateCandidateSnapshot(statusMismatch)?.code).toBe('CANDIDATE_STATUS_MISMATCH')

    const staleSummary = structuredClone(frame)
    staleSummary.linkSummaries[0]!.updatedAt = 41
    expect(validateCandidateSnapshot(staleSummary)?.code).toBe('STALE_ROUTE_CANDIDATE')

    const missingSummary = structuredClone(frame)
    missingSummary.linkSummaries.shift()
    expect(validateCandidateSnapshot(missingSummary)?.code).toBe('CANDIDATE_SUMMARY_NOT_FOUND')

    for (const invalid of [wrongLink, duplicate, crossFrame, crossTime, statusMismatch, staleSummary, missingSummary]) {
      expect(isTelemetryFrame(invalid)).toBe(false)
    }
  })

  it('识别最小帧合同并拒绝损坏帧', () => {
    expect(isTelemetryFrame(frame)).toBe(true)
    expect(isTelemetryFrame({ ...frame, platforms: [{}] })).toBe(false)
    expect(isTelemetryFrame({ ...frame, platforms: [null] })).toBe(false)
    expect(isTelemetryFrame({ ...frame, platforms: [{ ...frame.platforms[0], linkIds: [null] }] })).toBe(false)
    expect(isTelemetryFrame({ ...frame, platforms: [{ ...frame.platforms[0], jammers: [null] }] })).toBe(false)
    expect(isTelemetryFrame({ ...frame, links: [null] })).toBe(false)
    expect(isTelemetryFrame({ ...frame, linkSummaries: [null] })).toBe(false)
    expect(isTelemetryFrame({ ...frame, uiLinks: [null] })).toBe(false)
    expect(isTelemetryFrame({
      ...frame,
      uiLinks: [{ ...frame.uiLinks[0], thresholdVersion: null }],
    })).toBe(false)
    expect(isTelemetryFrame({ ...frame, eventIds: [null] })).toBe(false)
    expect(isTelemetryFrame({ ...frame, evidence: { ...frame.evidence, losses: [null] } })).toBe(false)
    expect(isTelemetryFrame({
      ...frame,
      evidence: {
        ...frame.evidence,
        losses: [{ ...frame.evidence.losses[0], linkId: '' }],
      },
    })).toBe(false)
    const missingLossComponent = structuredClone(frame) as unknown as {
      evidence: { losses: Record<string, unknown>[] }
    }
    delete missingLossComponent.evidence.losses[0]?.systemLossDb
    expect(isTelemetryFrame(missingLossComponent)).toBe(false)
    expect(isTelemetryFrame({
      ...frame,
      evidence: {
        ...frame.evidence,
        losses: [{ ...frame.evidence.losses[0], modelVersion: 'WRONG' }],
      },
    })).toBe(false)
    expect(isTelemetryFrame({
      ...frame,
      evidence: {
        ...frame.evidence,
        losses: [{ ...frame.evidence.losses[0], totalPathLossDb: Number.NaN }],
      },
    })).toBe(false)
    expect(isTelemetryFrame({
      ...frame,
      evidence: {
        ...frame.evidence,
        losses: [{ ...frame.evidence.losses[0], unexpected: true }],
      },
    })).toBe(false)
    expect(isTelemetryFrame({ ...frame, evidence: { ...frame.evidence, routeCandidates: [null] } })).toBe(false)
    expect(isTelemetryFrame({ ...frame, evidence: { ...frame.evidence, routeCandidates: [] } })).toBe(true)
    expect(isTelemetryFrame({
      ...frame,
      evidence: {
        ...frame.evidence,
        routeCandidates: [{ ...frame.evidence.routeCandidates[0], ber: 2 }],
      },
    })).toBe(false)
    expect(isTelemetryFrame({ ...frame, evidence: { ...frame.evidence, synchronization: undefined } })).toBe(false)
    expect(isTelemetryFrame({
      ...frame,
      evidence: { ...frame.evidence, synchronization: { ...frame.evidence.synchronization, uiVersion: 'WRONG' } },
    })).toBe(false)
    expect(isTelemetryFrame({
      ...frame,
      evidence: {
        ...frame.evidence,
        synchronization: { ...frame.evidence.synchronization, unexpected: true },
      },
    })).toBe(false)
    expect(isTelemetryFrame({ ...frame, evidence: {} })).toBe(false)
    expect(isTelemetryFrame(null)).toBe(false)
  })

  it.each([
    ['零频率', (candidate: TelemetryFrame) => { candidate.links[0]!.frequency = 0 }],
    ['零带宽', (candidate: TelemetryFrame) => { candidate.links[0]!.bandwidth = 0 }],
    ['零干扰频率', (candidate: TelemetryFrame) => { candidate.platforms.find(({ jammers }) => jammers.length > 0)!.jammers[0]!.frequency = 0 }],
    ['零干扰带宽', (candidate: TelemetryFrame) => { candidate.platforms.find(({ jammers }) => jammers.length > 0)!.jammers[0]!.bandwidth = 0 }],
    ['负误码率', (candidate: TelemetryFrame) => { candidate.linkSummaries[0]!.currentBer = -0.1 }],
    ['超界误码率', (candidate: TelemetryFrame) => { candidate.links[0]!.ber = 1.1 }],
    ['负速度', (candidate: TelemetryFrame) => { candidate.platforms[0]!.speed = -1 }],
    ['负功率', (candidate: TelemetryFrame) => { candidate.links[0]!.txPower = -1 }],
    ['负时间', (candidate: TelemetryFrame) => { candidate.links[0]!.time = -1 }],
    ['重复链路编号', (candidate: TelemetryFrame) => { candidate.platforms[0]!.linkIds[1] = candidate.platforms[0]!.linkIds[0]! }],
    ['额外字段', (candidate: TelemetryFrame) => { Reflect.set(candidate.links[0]!, 'unexpected', true) }],
  ])('通过正式加载入口拒绝%s', async (_label, mutate) => {
    const candidate = structuredClone(frame)
    mutate(candidate)
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => Promise.resolve(
      successResponse(String(input).endsWith('/events') ? fixtureSource.events : candidate),
    )))
    const store = useTelemetryStore()

    await expect(store.loadFrame()).resolves.toBe(false)
    expect(store).toMatchObject({ frame: null, events: [], capabilityState: 'ERROR' })
  })
})
