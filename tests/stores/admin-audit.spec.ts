import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiFailure, ApiSuccess, AuditRecord, ConfirmationContext, ExportStatus, PageMeta } from '../../src/contracts/domain-models'
import { isAuditRecord, useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'

const META: PageMeta = {
  requestId: 'REQ-AUDIT-TEST',
  generatedAt: '2026-08-06T08:00:00Z',
  page: 1,
  pageSize: 1,
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
  return { ok: true, data, meta: META }
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
    const exported: ExportStatus = {
      objectId: 'AUDIT-LOG',
      generated: false,
      classification: 'INTERNAL',
      watermark: '内部使用 · admin · AUDIT-LOG',
      verifiedAt: '2026-08-06T08:00:00Z',
    }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(success(confirmation('AWAITING_CONFIRMATION'))))
      .mockResolvedValueOnce(response(success(confirmation('CONFIRMED'))))
      .mockResolvedValueOnce(response(success(exported)))
    vi.stubGlobal('fetch', fetchSpy)
    const store = useAdminStore()
    store.auditFilters = { actor: 'old-user' }

    await expect(store.exportAudit({ actor: 'admin', module: 'SCENARIO_CONFIGURATION' })).resolves.toBe(true)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ action: 'AUDIT_EXPORT', objectId: 'AUDIT-LOG' })
    expect(store.auditConfirmation?.state).toBe('AWAITING_CONFIRMATION')
    expect(store.auditExportStatus).toBeNull()

    await expect(store.confirmAuditExport()).resolves.toBe(true)

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchSpy.mock.calls[2]?.[1]?.body))).toEqual({
      actor: 'admin',
      module: 'SCENARIO_CONFIGURATION',
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
})
