import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiFailure, ApiSuccess, AuditRecord, AuditExportResult, ConfirmationContext, PageMeta } from '../../src/contracts/domain-models'
import { isAuditRecord, useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'

const META: PageMeta = {
  requestId: 'REQ-AUDIT-TEST',
  generatedAt: '2026-08-06T08:00:00Z',
  page: 1,
  pageSize: 20,
  total: 1,
}

const RECORD: AuditRecord = {
  auditId: 'AUD-001',
  actor: 'admin',
  role: 'ADMIN',
  module: 'SCENARIO_CONFIGURATION',
  action: 'THRESHOLD_UPDATE',
  objectId: 'MW-COMM',
  result: 'SUCCESS',
  occurredAt: '2026-08-06T08:04:00Z',
  immutableFixture: true,
}

function success<T>(data: T): ApiSuccess<T> {
  return { ok: true, data, meta: { ...META, ...(Array.isArray(data) ? { total: data.length } : {}) } }
}

function response(body: unknown, ok = true): Response {
  return { ok, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

function failure(code: ApiFailure['error']['code'], message: string): ApiFailure {
  return {
    ok: false,
    error: { code, message, retryable: false, correlationId: `CORR-${code}` },
    meta: { requestId: META.requestId, generatedAt: META.generatedAt },
  }
}

function confirmation(state: ConfirmationContext['state']): ConfirmationContext {
  return {
    confirmationId: 'CONF-AUDIT-001',
    state,
    actor: 'admin',
    role: 'ADMIN',
    createdAt: '2026-08-06T08:00:00Z',
    expiresAt: '2026-08-06T08:05:00Z',
  }
}

function setAdmin(): void {
  useAuthStore().$patch({
    role: 'ADMIN',
    principal: {
      userId: 'USR-ADMIN',
      username: 'admin',
      role: 'ADMIN',
      permissions: ['AUDIT_READ'],
    },
    permissions: ['AUDIT_READ'],
  })
}

describe('admin audit store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    setAdmin()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('validates the closed AuditRecord contract', () => {
    expect(isAuditRecord(RECORD)).toBe(true)
    for (const invalid of [
      { ...RECORD, auditId: '' },
      { ...RECORD, actor: '' },
      { ...RECORD, role: 'ROOT' },
      { ...RECORD, module: '' },
      { ...RECORD, action: '' },
      { ...RECORD, objectId: '' },
      { ...RECORD, result: 'UNKNOWN' },
      { ...RECORD, occurredAt: '2026-02-30T08:00:00Z' },
      { ...RECORD, immutableFixture: false },
      { ...RECORD, extra: true },
      null,
      [],
    ]) expect(isAuditRecord(invalid)).toBe(false)
  })

  it('loads filtered records through all active states and preserves contract role values', async () => {
    let resolveResponse!: (value: Response) => void
    const responsePromise = new Promise<Response>((resolve) => { resolveResponse = resolve })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(responsePromise))
    const store = useAdminStore()
    const load = store.loadAudit({
      actor: 'admin',
      role: 'ADMIN',
      module: 'SCENARIO_CONFIGURATION',
      action: 'THRESHOLD_UPDATE',
      result: 'SUCCESS',
      from: '2026-08-06T08:00:00Z',
      to: '2026-08-06T09:00:00Z',
    })

    expect(store.auditState).toBe('LOADING')
    await Promise.resolve()
    expect(store.auditState).toBe('VALIDATING')
    await Promise.resolve()
    expect(store.auditState).toBe('EXECUTING')
    resolveResponse(response(success([RECORD])))
    await load

    expect(store.auditState).toBe('SUCCESS')
    expect(store.auditRecords).toEqual([RECORD])
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('role=ADMIN')
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('module=SCENARIO_CONFIGURATION')
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain('action=THRESHOLD_UPDATE')
  })

  it('enters EMPTY and clears stale records for malformed or failed responses', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(success([])))
      .mockResolvedValueOnce(response({ ...success([RECORD]), extra: true }))
      .mockResolvedValueOnce(response({ ...success([RECORD]), meta: { ...META, pageSize: 0 } }))
      .mockResolvedValueOnce(response(failure('PERMISSION_DENIED', '无权读取审计日志。'), false))
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockRejectedValue(new Error('bad json')) } as unknown as Response)
    vi.stubGlobal('fetch', fetchSpy)
    const store = useAdminStore()

    await expect(store.loadAudit()).resolves.toBe(true)
    expect(store.auditState).toBe('EMPTY')

    store.auditRecords = [RECORD]
    await expect(store.loadAudit()).resolves.toBe(false)
    expect(store.auditRecords).toEqual([])
    expect(store.auditResultCode).toBe('INVALID_RESPONSE')

    await expect(store.loadAudit()).resolves.toBe(false)
    expect(store.auditResultCode).toBe('INVALID_RESPONSE')

    await expect(store.loadAudit()).resolves.toBe(false)
    expect(store.auditResultCode).toBe('PERMISSION_DENIED')
    expect(store.auditResultMessage).toBe('无权读取审计日志。')

    await expect(store.loadAudit()).resolves.toBe(false)
    expect(store.auditResultCode).toBe('INVALID_RESPONSE')
  })

  it('creates a confirmation before consuming the current export filters', async () => {
    const exported: AuditExportResult = {
      objectId: 'AUDIT-LOG',
      generated: true,
      classification: 'INTERNAL',
      watermark: '内部使用 · admin · AUDIT-LOG',
      verifiedAt: '2026-08-06T08:00:00Z',
      fileName: 'operation_audit_20260806160000_CONF-AUDIT-001.txt', content: '操作审计日志\r\n测试记录\r\n', recordCount: 1,
    }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(success(confirmation('AWAITING_CONFIRMATION'))))
      .mockResolvedValueOnce(response(success(confirmation('CONFIRMED'))))
      .mockResolvedValueOnce(response(success(exported)))
    vi.stubGlobal('fetch', fetchSpy)
    const store = useAdminStore()
    store.auditFilters = { actor: 'old-user' }

    const filters = { actor: 'admin', module: 'SCENARIO_CONFIGURATION', action: 'THRESHOLD_UPDATE' }
    await expect(store.exportAudit(filters)).resolves.toBe(true)
    filters.action = 'AUTH_LOGIN'

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ action: 'AUDIT_EXPORT', objectId: 'AUDIT-LOG' })
    expect(store.auditConfirmation?.state).toBe('AWAITING_CONFIRMATION')
    expect(store.auditExportStatus).toBeNull()

    await expect(store.confirmAuditExport()).resolves.toBe(true)

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body))).toEqual({
      actor: 'admin',
      module: 'SCENARIO_CONFIGURATION',
      action: 'THRESHOLD_UPDATE',
      export: true,
      confirmationId: 'CONF-AUDIT-001',
    })
    expect(store.auditExportStatus).toEqual(exported)
    expect(store.auditConfirmation).toBeNull()
    expect(store.auditState).toBe('SUCCESS')
  })

  it('fails closed when confirmation or export evidence violates its contract', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(success({ ...confirmation('AWAITING_CONFIRMATION'), extra: true })))
      .mockResolvedValueOnce(response(success(confirmation('AWAITING_CONFIRMATION'))))
      .mockResolvedValueOnce(response(success(confirmation('CONFIRMED'))))
      .mockResolvedValueOnce(response(success({
        objectId: 'OTHER',
        generated: false,
        classification: 'INTERNAL',
        watermark: 'x',
        verifiedAt: '2026-08-06T08:00:00Z',
      })))
    vi.stubGlobal('fetch', fetchSpy)
    const store = useAdminStore()

    await expect(store.exportAudit()).resolves.toBe(false)
    expect(store.auditResultCode).toBe('INVALID_RESPONSE')
    expect(store.auditExportStatus).toBeNull()

    await expect(store.exportAudit()).resolves.toBe(true)
    await expect(store.confirmAuditExport()).resolves.toBe(false)
    expect(store.auditResultCode).toBe('INVALID_RESPONSE')
    expect(store.auditExportStatus).toBeNull()
  })

  it.each([
    { generated: false }, { objectId: 'OTHER' }, { classification: 'PUBLIC' }, { watermark: '' },
    { verifiedAt: '2026-02-30T00:00:00Z' }, { fileName: '../audit.txt' }, { fileName: 'audit.html' },
    { content: '' }, { content: 12 }, { recordCount: -1 }, { recordCount: 1.5 }, { extra: true },
  ])('rejects a malformed downloadable artifact: %j', async (invalid) => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(success(confirmation('AWAITING_CONFIRMATION'))))
      .mockResolvedValueOnce(response(success(confirmation('CONFIRMED'))))
      .mockResolvedValueOnce(response(success({ objectId: 'AUDIT-LOG', generated: true, classification: 'INTERNAL',
        watermark: '内部使用', verifiedAt: META.generatedAt, fileName: 'operation_audit_20260806160000_CONF-AUDIT-001.txt',
        content: '审计日志', recordCount: 0, ...invalid }))))
    const store = useAdminStore()
    expect(await store.exportAudit()).toBe(true)
    expect(await store.confirmAuditExport()).toBe(false)
    expect(store.auditState).toBe('ERROR')
    expect(store.auditResultCode).toBe('INVALID_RESPONSE')
    expect(store.auditExportStatus).toBeNull()
  })

  it.each(['reset', 'cancel'] as const)('discards a late export after %s', async (operation) => {
    let resolveExport!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(success(confirmation('AWAITING_CONFIRMATION'))))
      .mockResolvedValueOnce(response(success(confirmation('CONFIRMED'))))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveExport = resolve })))
    const store = useAdminStore()
    await store.exportAudit()
    const pending = store.confirmAuditExport()
    await vi.waitFor(() => expect(resolveExport).toBeTypeOf('function'))
    if (operation === 'reset') store.resetToSafeEmpty()
    else store.cancelAuditExport()
    resolveExport(response(success({ objectId: 'AUDIT-LOG', generated: true, classification: 'INTERNAL',
      watermark: '内部使用', verifiedAt: META.generatedAt, fileName: 'operation_audit_20260806160000_CONF-AUDIT-001.txt', content: '旧日志', recordCount: 0 })))
    expect(await pending).toBe(false)
    expect(store.auditExportStatus).toBeNull()
    expect(store.auditState).toBe('EMPTY')
  })

  it('cancels a pending export without consuming its confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success(confirmation('AWAITING_CONFIRMATION')))))
    const store = useAdminStore()
    store.auditRecords = [RECORD]

    await store.exportAudit({ actor: 'admin' })
    store.cancelAuditExport()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(store.auditConfirmation).toBeNull()
    expect(store.auditExportFilters).toEqual({})
    expect(store.auditState).toBe('SUCCESS')
    expect(store.auditResultCode).toBe('CANCELLED')
  })

  it('uses server pagination and default descending time order, preserving applied filters across pages', async () => {
    const records = [RECORD, { ...RECORD, auditId: 'AUD-002' }]
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ ...success(records), meta: { ...META, pageSize: 2, total: 3 } }))
      .mockResolvedValueOnce(response({ ...success([RECORD]), meta: { ...META, page: 2, pageSize: 2, total: 3 } })))
    const store = useAdminStore()
    expect(await store.loadAudit({ actor: 'admin' }, { pageSize: 2 })).toBe(true)
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain('sortOrder=desc')
    expect(store.auditTotal).toBe(3)
    expect(store.auditPageSize).toBe(2)
    expect(await store.loadAudit(store.auditFilters, { page: 2, sortOrder: 'asc' })).toBe(true)
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toContain('actor=admin&page=2&pageSize=2&sortOrder=asc')
    expect(store.auditPage).toBe(2)
    expect(store.auditSortOrder).toBe('asc')
  })

  it.each([
    { meta: { ...META, page: 2 } },
    { meta: { ...META, pageSize: 50 } },
    { meta: { ...META, total: 0 } },
    { data: [RECORD, RECORD], meta: { ...META, total: 2 } },
  ])('rejects inconsistent page metadata or duplicate record identities: %j', async invalid => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(success([RECORD])))
      .mockResolvedValueOnce(response({ ...success([RECORD]), ...invalid })))
    const store = useAdminStore()
    expect(await store.loadAudit()).toBe(true)
    expect(await store.loadAudit()).toBe(false)
    expect(store.auditState).toBe('ERROR')
    expect(store.auditResultCode).toBe('INVALID_RESPONSE')
    expect(store.auditRecords).toEqual([])
    expect(store.auditTotal).toBe(0)
  })

  it('discards older page responses and late responses after session reset', async () => {
    let resolveOld!: (value: Response) => void
    let resolveReset!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(response(success([{ ...RECORD, auditId: 'AUD-NEW' }])))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveReset = resolve })))
    const store = useAdminStore()
    const old = store.loadAudit()
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'))
    expect(await store.loadAudit()).toBe(true)
    resolveOld(response(success([RECORD])))
    expect(await old).toBe(false)
    expect(store.auditRecords[0]?.auditId).toBe('AUD-NEW')
    const pending = store.loadAudit()
    await vi.waitFor(() => expect(resolveReset).toBeTypeOf('function'))
    store.resetToSafeEmpty()
    resolveReset(response(success([RECORD])))
    expect(await pending).toBe(false)
    expect(store.auditRecords).toEqual([])
    expect(store.auditTotal).toBe(0)
    expect(store.auditState).toBe('EMPTY')
  })

  it('deletes the exact ID snapshot and reloads the applied query, returning from an empty last page', async () => {
    let resolveDelete!: (value: Response) => void
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response({ ...success([RECORD]), meta: { ...META, page: 2, total: 21 } }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveDelete = resolve }))
      .mockResolvedValueOnce(response({ ...success([]), meta: { ...META, page: 2, total: 1 } }))
      .mockResolvedValueOnce(response(success([{ ...RECORD, auditId: 'AUD-REMAINING' }])))
    vi.stubGlobal('fetch', fetchSpy)
    const store = useAdminStore()
    expect(await store.loadAudit({ module: 'SCENARIO_CONFIGURATION' }, { page: 2 })).toBe(true)
    const ids = [RECORD.auditId]
    const pending = store.deleteAudit(ids)
    await vi.waitFor(() => expect(resolveDelete).toBeTypeOf('function'))
    ids.push('AUD-NOT-CONFIRMED')
    expect(await store.loadAudit()).toBe(false)
    expect(await store.deleteAudit([RECORD.auditId])).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1].body))).toEqual({ auditIds: [RECORD.auditId] })
    resolveDelete(response(success({ deletedIds: [RECORD.auditId] })))
    expect(await pending).toBe(true)
    expect(store.auditPage).toBe(1)
    expect(store.auditRecords[0]?.auditId).toBe('AUD-REMAINING')
    expect(store.auditDeletionPending).toBe(false)
    expect(String(fetchSpy.mock.calls[2]![0])).toContain('module=SCENARIO_CONFIGURATION&page=2')
  })

  it('supports a batch delete and validates the complete response ID set', async () => {
    const ids = ['AUD-001', 'AUD-002']
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(success({ deletedIds: [...ids].reverse() })))
      .mockResolvedValueOnce(response(success([]))))
    const store = useAdminStore()
    expect(await store.deleteAudit(ids)).toBe(true)
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body))).toEqual({ auditIds: ids })
    expect(store.auditRecords).toEqual([])
    expect(store.auditState).toBe('EMPTY')
  })

  it.each([
    { deletedIds: [] }, { deletedIds: ['AUD-OTHER'] }, { deletedIds: ['AUD-001', 'AUD-001'] },
    { deletedIds: ['AUD-001'], extra: true }, { deletedIds: [12] }, null,
  ])('rejects malformed deletion evidence without a success result: %j', async data => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(success([RECORD])))
      .mockResolvedValueOnce(response(success(data))))
    const store = useAdminStore()
    await store.loadAudit()
    expect(await store.deleteAudit([RECORD.auditId])).toBe(false)
    expect(store.auditRecords).toEqual([])
    expect(store.auditResultCode).toBe('INVALID_RESPONSE')
    expect(store.auditDeletionPending).toBe(false)
  })

  it('shows a deletion failure and never reloads or reports success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(failure('NOT_FOUND', '审计记录不存在。'), false)))
    const store = useAdminStore()
    expect(await store.deleteAudit([RECORD.auditId])).toBe(false)
    expect(store.auditState).toBe('ERROR')
    expect(store.auditResultMessage).toBe('审计记录不存在。')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([[], [''], [' '], ['AUD-001', 'AUD-001'], Array.from({ length: 101 }, (_, index) => `AUD-${index}`)].map(ids => ({ ids })))('rejects invalid delete selections before issuing a request: %j', async ({ ids }) => {
    vi.stubGlobal('fetch', vi.fn())
    const store = useAdminStore()
    expect(await store.deleteAudit(ids)).toBe(false)
    expect(store.auditResultCode).toBe('INVALID_REQUEST')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('prevents non-administrator deletion and discards a deletion response after logout', async () => {
    let resolveDelete!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { resolveDelete = resolve })))
    const store = useAdminStore()
    useAuthStore().role = 'OPERATOR'
    expect(await store.deleteAudit([RECORD.auditId])).toBe(false)
    expect(store.auditResultCode).toBe('PERMISSION_DENIED')
    expect(fetch).not.toHaveBeenCalled()
    setAdmin()
    const pending = store.deleteAudit([RECORD.auditId])
    await vi.waitFor(() => expect(resolveDelete).toBeTypeOf('function'))
    store.resetToSafeEmpty()
    resolveDelete(response(success({ deletedIds: [RECORD.auditId] })))
    expect(await pending).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
    expect(store.auditState).toBe('EMPTY')
    expect(store.auditRecords).toEqual([])
  })
})
