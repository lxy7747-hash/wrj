import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ApiFailure, DetectionEvent, Principal, Replay, TelemetryFrame } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { isReplay, replayEventTime, useReplayStore } from '../../src/stores/replay'
import { useTelemetryStore } from '../../src/stores/telemetry'

const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ'],
}

/** 创建回放 Store 测试使用的成功响应。 */
function success(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

/** 创建回放 Store 测试使用的失败响应。 */
function failure(): Response {
  const body: ApiFailure = {
    ok: false,
    error: { code: 'INVALID_TRANSITION', message: '当前状态不允许操作。', retryable: false, correlationId: 'CORR-P6-REPLAY' },
    meta: { requestId: 'REQ-P6-REPLAY', generatedAt: '2026-08-06T08:00:00Z' },
  }
  return { ok: false, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

describe('P6 历史回放 Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('校验回放闭合合同和事件登记时刻', () => {
    expect(isReplay(fixtureSource.replay)).toBe(true)
    const detection = fixtureSource.events[0] as DetectionEvent
    expect(replayEventTime(detection)).toBe(2200)
    expect(replayEventTime({ ...detection, sourceRegistryTime: undefined })).toBe(42)
    for (const invalid of [null, {}, { ...fixtureSource.replay, replayId: 'BAD' }, {
      ...fixtureSource.replay, state: 'BAD',
    }, { ...fixtureSource.replay, currentTimeS: 8000 }, {
      ...fixtureSource.replay, eventIds: ['DET-042', 'DET-042'],
    }, { ...fixtureSource.replay, extra: true }]) expect(isReplay(invalid)).toBe(false)
  })

  it('复用遥测事件加载回放并运行播放、倍速、暂停、定位和单步', async () => {
    vi.useFakeTimers()
    useTelemetryStore().$patch({
      frame: structuredClone(fixtureSource.frame) as unknown as TelemetryFrame,
      events: structuredClone(fixtureSource.events) as never[],
    })
    const replay = useReplayStore()
    let serverReplay = structuredClone(fixtureSource.replay) as Replay
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/replays')) return Promise.resolve(success([serverReplay]))
      if (init?.method !== 'POST') return Promise.resolve(success(serverReplay))
      const command = JSON.parse(String(init.body)) as { command: string; value?: number }
      if (command.command === 'PLAY') serverReplay.state = 'PLAYING'
      if (command.command === 'PAUSE') serverReplay.state = 'PAUSED'
      if (command.command === 'SEEK') {
        serverReplay.currentTimeS = command.value!
        serverReplay.state = command.value === serverReplay.durationS ? 'COMPLETED' : serverReplay.state
      }
      if (command.command === 'STEP_FORWARD') {
        serverReplay.currentTimeS = Math.min(serverReplay.durationS, serverReplay.currentTimeS + 1)
        serverReplay.state = 'PAUSED'
      }
      return Promise.resolve(success(serverReplay))
    })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(replay.load()).resolves.toBe(true)
    expect(replay.events).toHaveLength(3)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    await expect(replay.play()).resolves.toBe(true)
    await expect(replay.setSpeed(2)).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(replay.replay?.currentTimeS).toBe(2539)
    await expect(replay.pause()).resolves.toBe(true)
    expect(replay.replay?.currentTimeS).toBe(2539)
    await expect(replay.seek(2200)).resolves.toBe(true)
    expect(replay.selectedEventId).toBe('DET-042')
    await expect(replay.step('forward')).resolves.toBe(true)
    expect(replay.replay?.currentTimeS).toBe(2201)
  })

  it('从接口补充事件，并区分空态、损坏态和服务错误', async () => {
    const replay = useReplayStore()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success([fixtureSource.replay]))
      .mockResolvedValueOnce(success(fixtureSource.replay))
      .mockResolvedValueOnce(success(fixtureSource.events))
      .mockResolvedValueOnce(success([]))
      .mockResolvedValueOnce(success([fixtureSource.replay]))
      .mockResolvedValueOnce(success({ ...fixtureSource.replay, eventIds: ['EVT-MISSING'] }))
      .mockResolvedValueOnce(success(fixtureSource.events))
      .mockResolvedValueOnce(failure()))

    await expect(replay.load()).resolves.toBe(true)
    expect(replay.state).toBe('PAUSED')
    await expect(replay.load()).resolves.toBe(true)
    expect(replay.state).toBe('EMPTY')
    await expect(replay.load()).resolves.toBe(false)
    expect(replay).toMatchObject({ state: 'CORRUPT', resultCode: 'CORRUPT_FIXTURE', replay: null })
    await expect(replay.load()).resolves.toBe(false)
    expect(replay).toMatchObject({ state: 'ERROR', resultCode: 'INVALID_TRANSITION' })
  })

  it('只保留回放登记事件且游标早于首个事件时不选择未来事件', async () => {
    const store = useReplayStore()
    const replay = { ...fixtureSource.replay, currentTimeS: 0, eventIds: ['DET-042'] } as Replay
    const extra = { ...fixtureSource.events[1]!, eventId: 'SW-EXTRA', dedupeKey: 'SW-EXTRA' }
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success([replay]))
      .mockResolvedValueOnce(success(replay))
      .mockResolvedValueOnce(success([...fixtureSource.events, extra])))

    await expect(store.load()).resolves.toBe(true)
    expect(store.events.map((event) => event.eventId)).toEqual(['DET-042'])
    expect(store.selectedEventId).toBeNull()
  })

  it('拒绝无回放命令、损坏命令结果并在末尾停止计时器', async () => {
    vi.useFakeTimers()
    const store = useReplayStore()
    await expect(store.play()).resolves.toBe(false)
    store.$patch({
      replay: { ...fixtureSource.replay, state: 'PLAYING', currentTimeS: 7199 } as Replay,
      state: 'PLAYING',
      speed: 2,
      events: structuredClone(fixtureSource.events) as never[],
    })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(success({ ...fixtureSource.replay, state: 'COMPLETED', currentTimeS: 7200 }))
      .mockResolvedValueOnce(success({ ...fixtureSource.replay, replayId: 'REPLAY-WRONG' })))
    store.startPlaybackTimer()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store).toMatchObject({ state: 'COMPLETED', replay: { currentTimeS: 7200 } })
    await store.advancePlayback()

    await expect(store.executeCommand({ command: 'SEEK', value: 20 })).resolves.toBe(false)
    expect(store.state).toBe('CORRUPT')
  })

  it('重置会使迟到加载响应失效', async () => {
    const store = useReplayStore()
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveResponse = resolve })))
    const pending = store.load()
    store.resetToSafeEmpty()
    resolveResponse(success([fixtureSource.replay]))
    await expect(pending).resolves.toBe(false)
    expect(store.state).toBe('EMPTY')
  })
})
