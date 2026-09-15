import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type {
  ApiFailure,
  ConfirmationContext,
  Principal,
  ScenarioConfig,
  ScenarioDraft,
  SimulationRun,
} from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'
import { isSimulationRun, useSimulationStore } from '../../src/stores/simulation'

const OPERATOR: Principal = {
  userId: 'USR-OPERATOR',
  username: 'operator',
  role: 'OPERATOR',
  permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
}

/** 创建测试使用的确定性仿真运行。 */
function run(uiStatus: SimulationRun['uiStatus'] = 'IDLE', configLocked = uiStatus === 'RUNNING' || uiStatus === 'PAUSED'): SimulationRun {
  const canonicalStatus = uiStatus === 'STOPPED' ? 'IDLE' : uiStatus
  return {
    runId: 'RUN-001',
    taskId: 'TASK-001',
    scenarioId: 'SCN-001',
    uiStatus,
    canonical: {
      status: canonicalStatus,
      currentTime: uiStatus === 'COMPLETED' ? 7200 : 0,
      totalDuration: 7200,
      processId: uiStatus === 'RUNNING' || uiStatus === 'PAUSED' ? 2900 : null,
      progress: uiStatus === 'COMPLETED' ? 100 : 0,
    },
    configLocked,
    ...(uiStatus === 'RUNNING' || uiStatus === 'PAUSED' || uiStatus === 'COMPLETED'
      ? { startedAt: '2026-08-06T08:05:00Z' }
      : {}),
    ...(uiStatus === 'COMPLETED' ? { completedAt: '2026-08-06T10:05:00Z' } : {}),
  }
}

/** 创建测试使用的场景草稿。 */
function scenarioDraft(): ScenarioDraft {
  const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
  return {
    config,
    uiExtensions: {
      jammers: config.jammers.map((jammer) => ({
        jammerId: jammer.id,
        direction: jammer.type === 'BARRAGE' ? 360 : 45,
        duration: 60,
        enabled: true,
      })),
      sensors: config.sensors.map((sensor) => ({
        sensorId: sensor.id,
        type: 'ESM',
        direction: 'OMNI',
        probability: 0.95,
        enabled: true,
      })),
    },
    revision: 4,
    officialLibraryChanged: false,
    locked: false,
  }
}

/** 创建成功 API 响应。 */
function successResponse(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

/** 创建失败 API 响应。 */
function failureResponse(code = 'INVALID_TRANSITION', message = '当前状态不允许执行该命令。'): Response {
  const body: ApiFailure = {
    ok: false,
    error: { code: code as ApiFailure['error']['code'], message, retryable: false, correlationId: 'CORR-P3-TEST' },
    meta: { requestId: 'REQ-P3-TEST', generatedAt: '2026-08-06T08:00:00Z' },
  }
  return { ok: false, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

/** 创建指定状态的一次性确认。 */
function confirmation(state: ConfirmationContext['state']): ConfirmationContext {
  return {
    confirmationId: 'CONF-P2-001',
    state,
    actor: 'operator',
    role: 'OPERATOR',
    createdAt: '2026-08-06T08:00:00Z',
    expiresAt: '2026-08-06T08:05:00Z',
  }
}

/** 创建可由测试控制完成时机的 Promise。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('P3-1 仿真 Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  /** 为当前 Pinia 注入具备仿真控制权限的操作员。 */
  function authorizeOperator(): void {
    useAuthStore().$patch({ principal: OPERATOR, role: OPERATOR.role, permissions: [...OPERATOR.permissions] })
  }

  it('刷新只恢复同账号场景编号，无运行也能重新加载最新配置，失败重试不换场景', async () => {
    authorizeOperator()
    const draft = scenarioDraft()
    draft.config.scenario.id = 'SCN-B'
    let failed = false
    const fetcher = vi.fn(async (url: string) => url.endsWith('/simulations')
      ? successResponse([])
      : failed ? failureResponse('NOT_FOUND', '场景暂不可用。') : successResponse(draft))
    vi.stubGlobal('fetch', fetcher)
    expect(await useSimulationStore().selectScene('SCN-B')).toBe(true)
    expect(JSON.parse(sessionStorage.getItem('wrj.simulation.selectedScene')!)).toEqual({ userId: OPERATOR.userId, scenarioId: 'SCN-B' })
    setActivePinia(createPinia())
    authorizeOperator()
    const restored = useSimulationStore()
    expect(restored.selectedScene).toBeNull()
    expect(restored.readSelectedSceneId()).toBe('SCN-B')
    failed = true
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await restored.selectScene(restored.readSelectedSceneId()!)).toBe(false)
      expect(restored.selectedScene).toBeNull()
      expect(restored.readSelectedSceneId()).toBe('SCN-B')
    }
    failed = false
    draft.revision = 7
    expect(await restored.selectScene(restored.readSelectedSceneId()!)).toBe(true)
    expect(restored.selectedScene?.revision).toBe(7)
    expect(fetcher.mock.calls.filter(([url]) => url.includes('/scenarios/')).every(([url]) => url.endsWith('/SCN-B'))).toBe(true)
    restored.resetToSafeEmpty()
    expect(restored.readSelectedSceneId()).toBeNull()
  })

  it.each([
    '{broken',
    JSON.stringify({ userId: 'OTHER', scenarioId: 'SCN-B' }),
    JSON.stringify({ userId: OPERATOR.userId, scenarioId: ['SCN-B'] }),
  ])('拒绝损坏或其他账号的场景选择缓存：%s', saved => {
    authorizeOperator()
    sessionStorage.setItem('wrj.simulation.selectedScene', saved)
    expect(useSimulationStore().readSelectedSceneId()).toBeNull()
    expect(sessionStorage.getItem('wrj.simulation.selectedScene')).toBeNull()
  })

  it('选择已保存场景并在开始前重读，创建请求使用选中编号而非编辑草稿', async () => {
    authorizeOperator()
    const draft = scenarioDraft()
    draft.config.scenario.id = 'SCN-B'
    let current = run('STOPPED')
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/scenarios/SCN-B')) return successResponse(draft)
      if (init?.method === 'POST' && url.endsWith('/simulations')) {
        expect(JSON.parse(String(init.body)).scenarioId).toBe('SCN-B')
        current = { ...run('IDLE', true), scenarioId: 'SCN-B' }
        return successResponse(current)
      }
      if (url.endsWith('/commands')) return successResponse({ ...run('RUNNING', true), scenarioId: 'SCN-B' })
      return successResponse([current])
    })
    vi.stubGlobal('fetch', fetcher)
    const store = useSimulationStore()
    expect(await store.selectScene('SCN-B')).toBe(true)
    draft.revision = 5
    draft.config.scenario.name = '最新保存名称'
    expect(await store.start()).toBe(true)
    expect(store.selectedScene?.revision).toBe(5)
    expect(store.selectedScene?.config.scenario.name).toBe('最新保存名称')
    expect(store.run?.scenarioId).toBe('SCN-B')
    expect(store.uiStatus).toBe('RUNNING')
  })

  it('运行锁阻止切换，失败选择不替换当前已选快照，清空选择不改编辑草稿', async () => {
    authorizeOperator()
    const draft = scenarioDraft()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(successResponse([run('STOPPED')]))
      .mockResolvedValueOnce(successResponse(draft)).mockResolvedValueOnce(successResponse([run('RUNNING', true)])))
    const store = useSimulationStore()
    expect(await store.selectScene('SCN-001')).toBe(true)
    expect(await store.selectScene('SCN-B')).toBe(false)
    expect(store.selectedScene?.config.scenario.id).toBe('SCN-001')
    expect(store.resultMessage).toContain('先停止')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(successResponse([run('STOPPED')])).mockResolvedValueOnce(successResponse({})))
    expect(await store.selectScene('SCN-B')).toBe(false)
    expect(store.selectedScene?.config.scenario.id).toBe('SCN-001')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse([run('STOPPED')])))
    expect(await store.selectScene('')).toBe(true)
    expect(store.selectedScene).toBeNull()
    expect(store.readSelectedSceneId()).toBeNull()
  })

  it.each(['run', 'scene', 'body'] as const)('取消选择后 %s 阶段迟到响应不写入所选场景', async phase => {
    authorizeOperator()
    const late = deferred<Response>()
    const lateBody = deferred<unknown>()
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/simulations')) return phase === 'run' ? late.promise : Promise.resolve(successResponse([run('STOPPED')]))
      return phase === 'scene' ? late.promise : Promise.resolve({ ok: true, json: () => lateBody.promise })
    })
    vi.stubGlobal('fetch', fetcher)
    const store = useSimulationStore()
    const lifetime = new AbortController()
    const pending = store.selectScene('SCN-001', lifetime.signal)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(phase === 'run' ? 1 : 2))
    lifetime.abort()
    if (phase === 'body') lateBody.resolve({ ok: true, data: scenarioDraft() })
    else late.resolve(successResponse(phase === 'run' ? [run('STOPPED')] : scenarioDraft()))
    expect(await pending).toBe(false)
    expect(store.selectedScene).toBeNull()
    expect(store.selectingScene).toBe(false)
    expect(store.capabilityState).not.toBe('ERROR')
    expect(fetcher).toHaveBeenCalledTimes(phase === 'run' ? 1 : 2)
  })

  it('登出清空后迟到的场景选择不回写', async () => {
    authorizeOperator()
    const deferredScene = deferred<Response>()
    const fetcher = vi.fn().mockResolvedValueOnce(successResponse([run('STOPPED')])).mockReturnValueOnce(deferredScene.promise)
    vi.stubGlobal('fetch', fetcher)
    const store = useSimulationStore()
    const pending = store.selectScene('SCN-001')
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    store.resetToSafeEmpty()
    deferredScene.resolve(successResponse(scenarioDraft()))
    expect(await pending).toBe(false)
    expect(store.selectedScene).toBeNull()
    expect(store.selectingScene).toBe(false)
    expect(sessionStorage.getItem('wrj.simulation.selectedScene')).toBeNull()
  })

  it('在网络边界接受闭合运行并拒绝损坏字段', () => {
    const valid = run('RUNNING', true)
    expect(isSimulationRun(valid)).toBe(true)
    const invalidValues = [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, runId: 'BAD' },
      { ...valid, taskId: 'BAD' },
      { ...valid, scenarioId: 'BAD' },
      { ...valid, uiStatus: 'UNKNOWN' },
      { ...valid, configLocked: 'yes' },
      { ...valid, canonical: null },
      { ...valid, canonical: { ...valid.canonical, extra: true } },
      { ...valid, canonical: { ...valid.canonical, status: 'STOPPED' } },
      { ...valid, canonical: { ...valid.canonical, currentTime: -1 } },
      { ...valid, canonical: { ...valid.canonical, totalDuration: Number.NaN } },
      { ...valid, canonical: { ...valid.canonical, processId: 0 } },
      { ...valid, canonical: { ...valid.canonical, progress: 101 } },
      { ...valid, canonical: { ...valid.canonical, errorMessage: 1 } },
      { ...valid, startedAt: 1 },
      { ...valid, completedAt: 1 },
    ]
    invalidValues.forEach((value) => expect(isSimulationRun(value)).toBe(false))
    expect(isSimulationRun({ ...valid, canonical: { ...valid.canonical, processId: 100, errorMessage: '失败' } })).toBe(true)
  })

  it('加载 RUN-001 并处理空列表、无效响应和 API 错误', async () => {
    authorizeOperator()
    const simulation = useSimulationStore()
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(successResponse([run('COMPLETED', false)]))
      .mockResolvedValueOnce(successResponse([]))
      .mockResolvedValueOnce(successResponse([{ bad: true }]))
      .mockResolvedValueOnce(failureResponse('NOT_FOUND', '未找到运行。'))
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error('JSON 损坏')) } as unknown as Response)
    vi.stubGlobal('fetch', fetchSpy)

    await expect(simulation.resetProjection()).resolves.toBe(true)
    expect(simulation.uiStatus).toBe('COMPLETED')
    await expect(simulation.resetProjection()).resolves.toBe(true)
    expect(simulation.run).toBeNull()
    await expect(simulation.resetProjection()).resolves.toBe(false)
    expect(simulation.resultCode).toBe('INVALID_RESPONSE')
    await expect(simulation.resetProjection()).resolves.toBe(false)
    expect(simulation.resultCode).toBe('NOT_FOUND')
    await expect(simulation.resetProjection()).resolves.toBe(false)
    expect(simulation.resultCode).toBe('INVALID_RESPONSE')
  })

  it('实时运行同步失败可见，并可由后续通知恢复完整状态', async () => {
    authorizeOperator()
    const simulation = useSimulationStore()
    simulation.applyRun(run('COMPLETED', false))
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('连接已断开'))
      .mockResolvedValueOnce(successResponse([run('RUNNING', true)])))

    await expect(simulation.synchronizeRuntimeState()).resolves.toBe(false)
    expect(simulation).toMatchObject({
      resultCode: 'RUNTIME_SYNC_FAILED',
      resultMessage: '仿真运行状态同步失败：连接已断开',
    })
    await expect(simulation.synchronizeRuntimeState()).resolves.toBe(true)
    expect(simulation).toMatchObject({
      uiStatus: 'RUNNING',
      configurationLockState: 'LOCKED',
      resultCode: 'SUCCESS',
      resultMessage: '仿真运行状态已同步。',
    })
  })

  it('请求超时进入错误态并释放超时定时器', async () => {
    vi.useFakeTimers()
    authorizeOperator()
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('已超时', 'AbortError')))
    })))
    const simulation = useSimulationStore()

    const loading = simulation.resetProjection()
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(loading).resolves.toBe(false)
    expect(simulation).toMatchObject({ capabilityState: 'ERROR', resultCode: 'TIMEOUT', resultMessage: '仿真服务响应超时。' })
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('创建并开始运行，同时同步已加载场景的配置锁', async () => {
    authorizeOperator()
    const scenario = useScenarioStore()
    scenario.draft = scenarioDraft()
    const simulation = useSimulationStore()
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(successResponse(run('IDLE', true)))
      .mockResolvedValueOnce(successResponse(run('RUNNING', true)))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(simulation.start()).resolves.toBe(true)

    expect(simulation.uiStatus).toBe('RUNNING')
    expect(simulation.configurationLockState).toBe('LOCKED')
    expect(scenario.draft.locked).toBe(true)
    expect(fetchSpy).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:4173/api/v1/simulations', expect.objectContaining({ method: 'POST' }))
    expect(fetchSpy).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:4173/api/v1/simulations/RUN-001/commands', expect.objectContaining({
      body: JSON.stringify({ command: 'START', mode: 'INTERACTIVE_SINGLE' }),
    }))
  })

  it('覆盖暂停、继续、单步和运行期倍速命令', async () => {
    authorizeOperator()
    const simulation = useSimulationStore()
    simulation.applyRun(run('RUNNING', true))
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(successResponse(run('PAUSED', true)))
      .mockResolvedValueOnce(successResponse({ ...run('PAUSED', true), canonical: { ...run('PAUSED', true).canonical, currentTime: 1 } }))
      .mockResolvedValueOnce(successResponse(run('RUNNING', true)))
      .mockResolvedValueOnce(successResponse(run('RUNNING', true)))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(simulation.pause()).resolves.toBe(true)
    await expect(simulation.step()).resolves.toBe(true)
    await expect(simulation.start()).resolves.toBe(true)
    await expect(simulation.setSpeed(4)).resolves.toBe(true)

    expect(simulation.uiStatus).toBe('RUNNING')
    expect(simulation.speedMultiplier).toBe(4)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('空闲时只保存有效倍速和运行模式', async () => {
    const simulation = useSimulationStore()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(simulation.setSpeed(2)).resolves.toBe(true)
    simulation.setMode('PARAMETER_SCAN')
    expect(simulation.speedMultiplier).toBe(2)
    expect(simulation.mode).toBe('PARAMETER_SCAN')
    expect(fetchSpy).not.toHaveBeenCalled()

    await expect(simulation.setSpeed(0)).resolves.toBe(false)
    expect(simulation.resultCode).toBe('INVALID_TRANSITION')
  })

  it('经一次性确认停止运行并解除场景锁', async () => {
    authorizeOperator()
    const scenario = useScenarioStore()
    scenario.draft = { ...scenarioDraft(), locked: true }
    const simulation = useSimulationStore()
    simulation.applyRun(run('PAUSED', true))
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(successResponse(confirmation('AWAITING_CONFIRMATION')))
      .mockResolvedValueOnce(successResponse(confirmation('CONFIRMED')))
      .mockResolvedValueOnce(successResponse(run('STOPPED', false)))
    vi.stubGlobal('fetch', fetchSpy)

    await expect(simulation.stop()).resolves.toBe(true)

    expect(simulation.uiStatus).toBe('STOPPED')
    expect(simulation.currentTime).toBe(0)
    expect(simulation.configurationLockState).toBe('UNLOCKED')
    expect(simulation.lastConfirmation?.state).toBe('CLOSED')
    expect(scenario.draft.locked).toBe(false)
  })

  it('拒绝无权限、空运行、无效创建响应和命令失败', async () => {
    const simulation = useSimulationStore()
    await expect(simulation.create()).resolves.toBe(false)
    expect(simulation.resultCode).toBe('PERMISSION_DENIED')
    await expect(simulation.sendCommand({ command: 'PAUSE' })).resolves.toBe(false)
    expect(simulation.resultCode).toBe('EMPTY')
    await expect(simulation.stop()).resolves.toBe(false)

    authorizeOperator()
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(successResponse(run('IDLE', false)))
      .mockResolvedValueOnce(failureResponse())
    vi.stubGlobal('fetch', fetchSpy)
    await expect(simulation.create()).resolves.toBe(false)
    simulation.applyRun(run('RUNNING', true))
    await expect(simulation.pause()).resolves.toBe(false)
    expect(simulation.resultCode).toBe('INVALID_TRANSITION')
    expect(simulation.configurationLockState).toBe('LOCKED')
  })

  it('使 reset 前发起的运行加载结果失效', async () => {
    authorizeOperator()
    const simulation = useSimulationStore()
    const pendingResponse = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pendingResponse.promise))

    const pending = simulation.resetProjection()
    simulation.resetToSafeEmpty()
    pendingResponse.resolve(successResponse([run('COMPLETED', false)]))

    await expect(pending).resolves.toBe(false)
    expect(simulation.run).toBeNull()
  })

  it.each(['create', 'command'] as const)('使 reset 前发起的 %s 响应失效', async (operation) => {
    authorizeOperator()
    const simulation = useSimulationStore()
    if (operation === 'command') simulation.applyRun(run('RUNNING', true))
    const pendingResponse = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pendingResponse.promise))

    const pending = operation === 'create' ? simulation.create() : simulation.pause()
    simulation.resetToSafeEmpty()
    pendingResponse.resolve(successResponse(operation === 'create' ? run('IDLE', true) : run('PAUSED', true)))

    await expect(pending).resolves.toBe(false)
    expect(simulation.$state).toMatchObject({ run: null, capabilityState: 'EMPTY', configurationLockState: 'UNLOCKED' })
  })

  it.each(['create', 'command'] as const)('使 reset 期间仍在解析的 %s 载荷失效', async (operation) => {
    authorizeOperator()
    const simulation = useSimulationStore()
    if (operation === 'command') simulation.applyRun(run('RUNNING', true))
    const pendingPayload = deferred<unknown>()
    const response = { ok: true, json: vi.fn().mockReturnValue(pendingPayload.promise) } as unknown as Response
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response))

    const pending = operation === 'create' ? simulation.create() : simulation.pause()
    await vi.waitFor(() => expect(response.json).toHaveBeenCalledOnce())
    simulation.resetToSafeEmpty()
    pendingPayload.resolve({ ok: true, data: operation === 'create' ? run('IDLE', true) : run('PAUSED', true) })

    await expect(pending).resolves.toBe(false)
    expect(simulation.$state).toMatchObject({ run: null, capabilityState: 'EMPTY', configurationLockState: 'UNLOCKED' })
  })

  it('重置后忽略在途停止确认且不保留确认状态', async () => {
    authorizeOperator()
    const simulation = useSimulationStore()
    simulation.applyRun(run('RUNNING', true))
    const pendingResponse = deferred<Response>()
    const fetchSpy = vi.fn().mockReturnValueOnce(pendingResponse.promise)
    vi.stubGlobal('fetch', fetchSpy)

    const pending = simulation.stop()
    simulation.resetToSafeEmpty()
    pendingResponse.resolve(successResponse(confirmation('AWAITING_CONFIRMATION')))

    await expect(pending).resolves.toBe(false)
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(simulation.$state).toMatchObject({ run: null, capabilityState: 'EMPTY', lastConfirmation: null })
  })

  it.each(['create', 'confirm'] as const)('重置后忽略仍在解析的停止 %s 载荷', async (phase) => {
    authorizeOperator()
    const simulation = useSimulationStore()
    simulation.applyRun(run('RUNNING', true))
    const pendingPayload = deferred<unknown>()
    const pendingResponse = { ok: true, json: vi.fn().mockReturnValue(pendingPayload.promise) } as unknown as Response
    const fetchSpy = phase === 'create'
      ? vi.fn().mockResolvedValueOnce(pendingResponse)
      : vi.fn()
        .mockResolvedValueOnce(successResponse(confirmation('AWAITING_CONFIRMATION')))
        .mockResolvedValueOnce(pendingResponse)
    vi.stubGlobal('fetch', fetchSpy)

    const pending = simulation.stop()
    await vi.waitFor(() => expect(pendingResponse.json).toHaveBeenCalledOnce())
    simulation.resetToSafeEmpty()
    pendingPayload.resolve({ ok: true, data: confirmation(phase === 'create' ? 'AWAITING_CONFIRMATION' : 'CONFIRMED') })

    await expect(pending).resolves.toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(phase === 'create' ? 1 : 2)
    expect(simulation.$state).toMatchObject({ run: null, capabilityState: 'EMPTY', lastConfirmation: null })
  })

  it('空闲运行停止时不创建确认上下文', async () => {
    authorizeOperator()
    const simulation = useSimulationStore()
    simulation.applyRun(run('IDLE', true))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(simulation.stop()).resolves.toBe(false)

    expect(simulation.resultCode).toBe('INVALID_TRANSITION')
    expect(simulation.resultMessage).toBe('只有运行中或已暂停的仿真可以停止。')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('覆盖已存在锁、启动创建失败、无权限运行和倍速命令失败', async () => {
    const simulation = useSimulationStore()
    simulation.applyRun(run('RUNNING', true))
    await expect(simulation.sendCommand({ command: 'PAUSE' })).resolves.toBe(false)
    expect(simulation.resultCode).toBe('PERMISSION_DENIED')
    await expect(simulation.stop()).resolves.toBe(false)
    expect(simulation.resultCode).toBe('PERMISSION_DENIED')

    authorizeOperator()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(failureResponse())
      .mockResolvedValueOnce(failureResponse())
      .mockResolvedValueOnce(failureResponse()))
    await expect(simulation.create()).resolves.toBe(false)
    expect(simulation.configurationLockState).toBe('LOCKED')
    simulation.resetToSafeEmpty()
    await expect(simulation.start()).resolves.toBe(false)
    simulation.applyRun(run('PAUSED', true))
    await expect(simulation.setSpeed(8)).resolves.toBe(false)
    expect(simulation.speedMultiplier).toBe(1)
  })

  it('分别处理停止确认创建、确认消费和最终命令失败', async () => {
    authorizeOperator()
    const simulation = useSimulationStore()
    simulation.applyRun(run('RUNNING', true))
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(failureResponse('CONFIRMATION_EXPIRED', '二次确认已失效。'))
      .mockResolvedValueOnce(successResponse(confirmation('AWAITING_CONFIRMATION')))
      .mockResolvedValueOnce(failureResponse('CONFIRMATION_EXPIRED', '二次确认已失效。'))
      .mockResolvedValueOnce(successResponse(confirmation('AWAITING_CONFIRMATION')))
      .mockResolvedValueOnce(successResponse(confirmation('CONFIRMED')))
      .mockResolvedValueOnce(failureResponse())
    vi.stubGlobal('fetch', fetchSpy)

    await expect(simulation.stop()).resolves.toBe(false)
    await expect(simulation.stop()).resolves.toBe(false)
    await expect(simulation.stop()).resolves.toBe(false)

    expect(simulation.lastConfirmation?.state).toBe('CONFIRMED')
    expect(simulation.configurationLockState).toBe('LOCKED')
    expect(fetchSpy).toHaveBeenCalledTimes(6)
  })

  it('在确认失败和安全重置时不保留半完成状态', async () => {
    authorizeOperator()
    const scenario = useScenarioStore()
    scenario.draft = { ...scenarioDraft(), locked: true }
    const simulation = useSimulationStore()
    simulation.applyRun(run('RUNNING', true))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(successResponse({ bad: true })))

    await expect(simulation.stop()).resolves.toBe(false)
    expect(simulation.resultCode).toBe('INVALID_RESPONSE')

    simulation.resetToSafeEmpty()
    expect(simulation.$state).toMatchObject({
      run: null,
      capabilityState: 'EMPTY',
      configurationLockState: 'UNLOCKED',
      resultCode: 'EMPTY',
      lastConfirmation: null,
    })
    expect(scenario.draft.locked).toBe(false)
  })
})
