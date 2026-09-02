import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { Principal, RealtimeEnvelope, SimulationRun, TelemetryFrame } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
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

  it('只应用与当前帧一致的链路指标，并投影 runtime.state', () => {
    const store = useTelemetryStore()
    const linkEnvelope = {
      type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-001', sequence: 3,
      simulationTime: 42, frameId: 'F-00042', payload: frame.linkSummaries,
    } as const
    expect(store.acceptEnvelope(linkEnvelope)).toBe(false)
    store.frame = structuredClone(frame)
    const simulation = useSimulationStore()
    simulation.applyRun(structuredClone(fixtureSource.run) as SimulationRun)

    expect(store.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'link.metric', taskId: 'TASK-001', sequence: 3,
      simulationTime: 41, frameId: 'F-00042', payload: frame.linkSummaries,
    })).toBe(false)
    expect(store.acceptEnvelope({ ...linkEnvelope, frameId: 'F-WRONG' })).toBe(false)
    expect(store.acceptEnvelope({ ...linkEnvelope, payload: null })).toBe(false)
    expect(store.acceptEnvelope({ ...linkEnvelope, payload: [null] })).toBe(false)
    expect(store.acceptEnvelope(linkEnvelope)).toBe(true)
    expect(store.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'runtime.state', taskId: 'TASK-001', sequence: 8,
      simulationTime: 43,
      payload: { status: 'RUNNING', currentTime: 43, totalDuration: 7200, processId: 12, progress: 1 },
    })).toBe(true)
    expect(simulation.run).toMatchObject({ uiStatus: 'RUNNING', canonical: { currentTime: 43 } })
    expect(store.acceptEnvelope({
      type: 'event', schemaVersion: '1.0', topic: 'runtime.state', taskId: 'TASK-001', sequence: 9, payload: null,
    })).toBe(false)
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
      type: 'subscribe', taskId: 'TASK-001', topics: ['simulation.frame', 'runtime.state', 'link.metric'], lastSequence: 0,
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

  it('识别最小帧合同并拒绝损坏帧', () => {
    expect(isTelemetryFrame(frame)).toBe(true)
    expect(isTelemetryFrame({ ...frame, platforms: [{}] })).toBe(false)
    expect(isTelemetryFrame({ ...frame, platforms: [null] })).toBe(false)
    expect(isTelemetryFrame({ ...frame, linkSummaries: [null] })).toBe(false)
    expect(isTelemetryFrame({ ...frame, evidence: {} })).toBe(false)
    expect(isTelemetryFrame(null)).toBe(false)
  })
})
