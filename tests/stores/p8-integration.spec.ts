import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import { useUiStore } from '../../src/stores/ui'
import { useAuthStore } from '../../src/stores/auth'
import { useAdminStore } from '../../src/stores/admin'
import type { ConfirmationContext, User } from '../../src/contracts/domain-models'
import { useBatchStore } from '../../src/stores/batch'
import { useDataExchangeStore } from '../../src/stores/data-exchange'
import { useReplayStore } from '../../src/stores/replay'
import { useReportStore } from '../../src/stores/report'
import { useScenarioStore } from '../../src/stores/scenario'
import { useSimulationStore } from '../../src/stores/simulation'
import { useTelemetryStore } from '../../src/stores/telemetry'
import { useTraceabilityStore } from '../../src/stores/traceability'

const principal = { userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN' as const, permissions: [] }
const resetResult = { requestId: 'REQ-RESET-001', generatedAt: fixtures.epoch, nextSequence: 1 }

/** 保持传输信封结构，允许测试注入无效业务载荷。 */
function response(data: unknown): Response {
  return { ok: true, json: async () => ({ ok: true, data, meta: { requestId: 'P8', generatedAt: fixtures.epoch, page: 1, pageSize: 99, total: 99 } }) } as Response
}

/** 记录加载顺序；不替换清空方法，以验证真实安全空态。 */
function loads() {
  return [
    vi.spyOn(useAuthStore(), 'refreshPermissions').mockResolvedValue(true),
    vi.spyOn(useScenarioStore(), 'loadScenario').mockResolvedValue(true),
    vi.spyOn(useSimulationStore(), 'resetProjection').mockResolvedValue(true),
    vi.spyOn(useTelemetryStore(), 'loadFrame').mockResolvedValue(true),
    vi.spyOn(useBatchStore(), 'loadComparison').mockResolvedValue(true),
    vi.spyOn(useReportStore(), 'load').mockResolvedValue(true),
    vi.spyOn(useReplayStore(), 'load').mockResolvedValue(true),
    vi.spyOn(useAdminStore(), 'loadAll').mockResolvedValue(true),
    vi.spyOn(useTraceabilityStore(), 'loadMetadata').mockResolvedValue(true),
  ]
}

/** 九个业务投影均为空，且没有存活确认、重连或播放计时器。 */
function expectEmpty() {
  expect(useScenarioStore().draft).toBeNull()
  expect(useSimulationStore().run).toBeNull()
  expect(useTelemetryStore().frame).toBeNull()
  expect(useTelemetryStore().connectionState).toBe('DISCONNECTED')
  expect(useBatchStore().batch).toBeNull()
  expect(useReportStore().selectedReport).toBeNull()
  expect(useReportStore().confirmation).toBeNull()
  expect(useReplayStore().replay).toBeNull()
  expect(useAdminStore().users).toEqual([])
  expect(useAdminStore().auditConfirmation).toBeNull()
  expect(useAdminStore().maintenanceConfirmation).toBeNull()
  expect(useDataExchangeStore().csvContracts).toEqual([])
  expect(useTraceabilityStore().metadata).toBeNull()
}

beforeEach(() => {
  sessionStorage.clear()
  setActivePinia(createPinia())
  useAuthStore().$patch({ principal, role: 'ADMIN' })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('P8 全局重置', () => {
  it('清理和确认失效在单次 reset 前完成，随后顺序加载，禁止重复提交', async () => {
    const actions = loads()
    const close = vi.spyOn(useTelemetryStore(), 'disconnectAndReset')
    const timers = vi.spyOn(useSimulationStore(), 'clearTimers')
    const stop = vi.spyOn(useReplayStore(), 'stopPlaybackTimer')
    const reportConfirm = vi.spyOn(useReportStore(), 'invalidateConfirmation')
    const adminConfirm = vi.spyOn(useAdminStore(), 'invalidateConfirmation')
    const fetchMock = vi.fn().mockResolvedValue(response(resetResult))
    vi.stubGlobal('fetch', fetchMock)
    const ui = useUiStore()
    const pending = ui.resetAllProjections()
    expect(await ui.resetAllProjections()).toBe(false)
    expect(await pending).toBe(true)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:4173/api/v1/reset', expect.objectContaining({ method: 'POST', body: '{"confirm":true}' }))
    const order = [close, timers, stop, reportConfirm, adminConfirm, fetchMock, ...actions].map((spy) => spy.mock.invocationCallOrder[0]!)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(ui.resetState).toBe('SUCCESS')
    expect(useTelemetryStore().connectionBlocked).toBe(false)
  })

  it.each(Array.from({ length: 9 }, (_, index) => index))('加载步骤 %i 失败后清除所有半初始化投影并支持重试', async (index) => {
    const actions = loads()
    actions[index]!.mockResolvedValueOnce(false)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(resetResult)))
    const ui = useUiStore()
    expect(await ui.resetAllProjections()).toBe(false)
    expect(ui.resetState).toBe('ERROR')
    expect(ui.correlationId).toBe('REQ-RESET-001')
    expectEmpty()
    expect(useTelemetryStore().connectionBlocked).toBe(true)
    const socket = vi.fn(); vi.stubGlobal('WebSocket', socket)
    useTelemetryStore().connect()
    expect(socket).not.toHaveBeenCalled()
    for (const action of actions.slice(index + 1)) expect(action).not.toHaveBeenCalled()
    expect(await ui.resetAllProjections()).toBe(true)
  })

  it.each([null, { ...resetResult, nextSequence: 3 }, { ...resetResult, generatedAt: 'invalid' }])('拒绝损坏的 reset 响应 %j', async (result) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(result)))
    expect(await useUiStore().resetAllProjections()).toBe(false)
    expectEmpty()
  })

  it('服务端关联编号、网络失败和清理异常均保留安全错误态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ ok: false, error: { correlationId: 'CORR-P8' } }) }))
    const ui = useUiStore()
    await ui.resetAllProjections()
    expect(ui.correlationId).toBe('CORR-P8')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await ui.resetAllProjections()
    expect(ui.correlationId).toBe('P8-RESET-LOCAL')
    vi.spyOn(useSimulationStore(), 'clearTimers').mockImplementationOnce(() => { throw new Error() })
    await ui.resetAllProjections()
    expect(ui.resetMessage).toContain('清理旧数据失败')
    expectEmpty()
  })

  it.each(['before', 'fetch', 'load', 'error'] as const)('在 %s 阶段登出不会继续加载或回写重置结果', async (stage) => {
    let finish!: (value?: unknown) => void
    const pending = new Promise((resolve) => { finish = resolve })
    const actions = loads()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      if (stage === 'fetch' || stage === 'error') await pending
      if (stage === 'error') throw new Error()
      return response(resetResult)
    }))
    if (stage === 'load') actions[0]!.mockImplementation(async () => { await pending; return true })
    const ui = useUiStore()
    const result = ui.resetAllProjections()
    if (stage !== 'before') for (let i = 0; i < 8; i++) await Promise.resolve()
    ui.cancelReset(); finish()
    expect(await result).toBe(false)
    expect(ui.resetState).toBe('EMPTY')
    expectEmpty()
    useAuthStore().resetToSafeEmpty()
    expect(await ui.resetAllProjections()).toBe(false)
  })

  it('全局清理取消已有仿真超时请求，不留下计时器', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const result = useSimulationStore().resetProjection()
    expect(vi.getTimerCount()).toBe(1)
    useUiStore().clearBusinessProjections()
    expect(await result).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('P8 目录与管理重载', () => {
  it('加载 29/7/8/11，筛选并仅解析已知定位目标', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(fixtures.metadata[url.split('/').at(-1)! as keyof typeof fixtures.metadata])))
    const store = useTraceabilityStore()
    expect(store.rows).toEqual([])
    expect(store.resolveDestination('cap-stxr')).toBeNull()
    expect(await store.loadMetadata()).toBe(true)
    expect(store.rows).toHaveLength(36)
    store.query = '参数校验'
    expect(store.rows).toHaveLength(1)
    expect(store.resolveDestination('cap-stxr')).toBe('/blueprint#cap-stxr')
    expect(store.resolveDestination('https://evil.test')).toBeNull()
    store.resetToSafeEmpty()
    expect(store.query).toBe('')
  })

  it.each([
    ['capabilities', null], ['capabilities', {}], ['capabilities', { module: '' }], ['capabilities', { destination: 'https://evil.test' }],
    ['capabilities', { coverage: 'bad' }], ['capabilities', { states: ['BOGUS'] }], ['capabilities', { states: [] }],
    ['interfaces', { kind: 'bad' }], ['decisions', { id: 'bad' }], ['routes', { path: '//external.test' }], ['routes', { stores: [1] }],
  ])('拒绝 %s 目录的非法条目 %j', async (section, patch) => {
    const metadata = structuredClone(fixtures.metadata) as Record<string, unknown[]>
    metadata[String(section)]![0] = patch === null ? null : { ...(metadata[String(section)]![0] as object), ...(patch as object), ...(Object.keys(patch as object).length === 0 ? { id: 0 } : {}) }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(metadata[url.split('/').at(-1)!])))
    expect(await useTraceabilityStore().loadMetadata()).toBe(false)
    expect(useTraceabilityStore().metadata).toBeNull()
  })

  it('重复编号、错误数量、网络异常与迟到响应不留下目录', async () => {
    const store = useTraceabilityStore()
    for (const data of [[], Array(29).fill(fixtures.metadata.capabilities[0])]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)))
      expect(await store.loadMetadata()).toBe(false)
    }
    for (const error of [new Error('断开'), '断开']) {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
      expect(await store.loadMetadata()).toBe(false)
    }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { store.resetToSafeEmpty(); return response([]) }))
    expect(await store.loadMetadata()).toBe(false)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => { store.resetToSafeEmpty(); throw new Error() }))
    expect(await store.loadMetadata()).toBe(false)
    expect(store.state).toBe('EMPTY')
  })

  it('管理员顺序加载全部目录，操作员不发管理请求', async () => {
    const admin = useAdminStore()
    vi.spyOn(admin, 'refreshUsers').mockImplementation(async () => { admin.resultCode = 'SUCCESS' })
    vi.spyOn(admin, 'loadAudit').mockResolvedValue(true)
    const maintenance = vi.spyOn(admin, 'loadMaintenance').mockResolvedValue(true)
    expect(await admin.loadAll()).toBe(true)
    expect(maintenance.mock.calls).toEqual([['master'], ['backup'], ['archive'], ['health']])
    maintenance.mockResolvedValueOnce(false)
    expect(await admin.loadAll()).toBe(false)
    vi.mocked(admin.loadAudit).mockResolvedValueOnce(false)
    expect(await admin.loadAll()).toBe(false)
    vi.mocked(admin.refreshUsers).mockImplementationOnce(async () => { admin.resultCode = 'ERROR' })
    expect(await admin.loadAll()).toBe(false)
    vi.mocked(admin.refreshUsers).mockImplementationOnce(async () => { admin.resetToSafeEmpty() })
    expect(await admin.loadAll()).toBe(false)
    useAuthStore().role = 'OPERATOR'
    expect(await admin.loadAll()).toBe(true)
    expectEmpty()
  })
})

describe('P8 迟到响应失效', () => {
  it('审计导出最后一个响应迟到，也不恢复校验中状态', async () => {
    const admin = useAdminStore()
    const confirmation: ConfirmationContext = { confirmationId: 'P8', state: 'AWAITING_CONFIRMATION', actor: 'admin', role: 'ADMIN', createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z' }
    admin.auditConfirmation = confirmation
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response({ ...confirmation, state: 'CONFIRMED' }))
      .mockImplementationOnce(async () => { admin.resetToSafeEmpty(); return response({}) }))
    expect(await admin.confirmAuditExport()).toBe(false)
    expect(admin.auditState).toBe('EMPTY')
  })

  it.each(['users', 'mutate', 'audit', 'export', 'confirm'] as const)('清空后 %s 的迟到响应与异常不回写', async (kind) => {
    const admin = useAdminStore()
    for (const phase of ['response', 'json', 'error']) {
      admin.auditConfirmation = { confirmationId: 'P8', state: 'AWAITING_CONFIRMATION', actor: 'admin', role: 'ADMIN', createdAt: fixtures.epoch, expiresAt: fixtures.epoch }
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
        if (phase !== 'json') admin.resetToSafeEmpty()
        if (phase === 'error') throw new Error('迟到错误')
        return { ok: true, json: async () => { admin.resetToSafeEmpty(); return {} } }
      }))
      const user = fixtures.principals[0] as User
      if (kind === 'users') await admin.refreshUsers()
      if (kind === 'mutate') await admin.mutateUser(user, 'UPDATE', user)
      if (kind === 'audit') await admin.loadAudit()
      if (kind === 'export') await admin.exportAudit()
      if (kind === 'confirm') await admin.confirmAuditExport()
      expect(admin.users).toEqual([])
      expect(admin.auditRecords).toEqual([])
      expect(admin.auditConfirmation).toBeNull()
      expect(admin.panelState).toBe('EMPTY')
      expect(admin.auditState).toBe('EMPTY')
    }
  })

  it.each([false, true])('登出后权限刷新%s不重新创建身份', async (reject) => {
    const auth = useAuthStore()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      auth.resetToSafeEmpty()
      if (reject) throw new Error()
      return response({ role: 'ADMIN', permissions: [] })
    }))
    expect(await auth.refreshPermissions()).toBe(false)
    expect(auth.principal).toBeNull()
    expect(auth.authState).toBe('EMPTY')
  })

  it('确认报告导出的响应到达前重置，不恢复旧确认', async () => {
    const report = useReportStore()
    const confirmation: ConfirmationContext = { confirmationId: 'P8', state: 'AWAITING_CONFIRMATION', actor: 'admin', role: 'ADMIN', createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z' }
    report.$patch({ confirmation, pendingFormat: 'PDF' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      report.resetToSafeEmpty()
      return response({ ...confirmation, state: 'CONFIRMED' })
    }))
    expect(await report.confirmExport()).toBe(false)
    expect(report.confirmation).toBeNull()
    expect(report.capabilityState).toBe('EMPTY')
  })
})
