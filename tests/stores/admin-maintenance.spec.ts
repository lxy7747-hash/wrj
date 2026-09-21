import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ConfirmationContext, MasterData, MasterDataDetails, RestoreResult } from '../../src/contracts/domain-models'
import { isArchiveRecord, isBackupRecord, isMasterData, isMasterDetails, isRestoreResult, isSystemHealth } from '../../src/features/admin/admin-contract'
import { useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'

const master: MasterData = {
  dataId: 'DICT-P7', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
  content: { name: '测试参数字典', description: '测试保存真实内容。', entries: [{ key: 'frequencyMHz', valueType: 'NUMBER', value: 1200, unit: 'MHz', minimum: 1, maximum: 2000 }] },
}
const backup = fixtures.backups[0]!
const restore: RestoreResult = { prebackupId: backup.backupId, integrityValid: true, progress: 100, result: 'SUCCESS', rolledBack: false, generated: false }
const exported = { objectId: 'FULL-CONFIG', generated: false, classification: 'INTERNAL', watermark: '内部使用', verifiedAt: fixtures.epoch }

/** 包装严格的成功信封，测试只替换业务载荷。 */
function response(data: unknown): Response {
  return { ok: true, json: async () => ({ ok: true, data, meta: { requestId: 'REQ-P7', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: Array.isArray(data) ? data.length : 1 } }) } as Response
}

/** 返回已知的确认状态；确认字段结构与真实接口一致。 */
function confirmation(state: ConfirmationContext['state']): ConfirmationContext {
  return { confirmationId: 'CONF-P7', state, actor: 'admin', role: 'ADMIN', createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z' }
}

/** 给敏感操作准备创建确认、确认完成、操作结果三段响应。 */
function actionResponses(result: unknown) {
  const fetchMock = vi.fn().mockResolvedValueOnce(response(confirmation('AWAITING_CONFIRMATION')))
    .mockResolvedValueOnce(response(confirmation('CONFIRMED'))).mockResolvedValueOnce(response(result))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('P7 系统维护状态', () => {
  beforeEach(() => { setActivePinia(createPinia()); useAuthStore().$patch({ role: 'ADMIN' }) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('真实 SQLite 备份和恢复使用正式响应，不再显示未生成文件；非法摘要拒绝入库', async () => {
    const store = useAdminStore()
    const actual = { ...backup, backupId: 'BACKUP-SQLITE', status: 'VALID', checksum: 'A'.repeat(64) }
    actionResponses(actual)
    expect(await store.runMaintenanceAction('BACKUP')).toBe(true)
    expect(store.backups).toEqual([actual])
    expect(store.maintenance.backup.message).toContain('SQLite 备份文件已创建')
    actionResponses({ ...restore, generated: true })
    expect(await store.runMaintenanceAction('RESTORE', actual.backupId)).toBe(true)
    expect(store.restoreResult?.generated).toBe(true)
    expect(store.maintenance.backup.message).toContain('请重新登录')
    actionResponses({ ...actual, backupId: 'BROKEN', checksum: 'MOCK-INVALID' })
    expect(await store.runMaintenanceAction('BACKUP')).toBe(false)
    expect(store.backups).toEqual([actual])
  })

  it('四类列表从接口加载、清空、拒绝重复编号和无效结构', async () => {
    const store = useAdminStore()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const [section, data] of [['master', [master]], ['backup', [backup]], ['archive', [fixtures.archive]], ['health', fixtures.diagnostics]] as const) {
      fetchMock.mockResolvedValueOnce(response(data))
      expect(await store.loadMaintenance(section)).toBe(true)
      expect(store.maintenance[section].state).toBe('SUCCESS')
      fetchMock.mockResolvedValueOnce(response(section === 'health' ? {} : [null]))
      expect(await store.loadMaintenance(section)).toBe(false)
      expect(store.maintenance[section].state).toBe('ERROR')
      if (section !== 'health') {
        fetchMock.mockResolvedValueOnce(response([]))
        expect(await store.loadMaintenance(section)).toBe(true)
        expect(store.maintenance[section].state).toBe('EMPTY')
      }
    }
    fetchMock.mockResolvedValueOnce(response([master, master]))
    expect(await store.loadMaintenance('master')).toBe(false)
    expect(store.masterData).toEqual([])
    expect(store.backups).toEqual([])
    expect(store.archives).toEqual([])
    expect(store.health).toBeNull()
  })

  it('主数据保存使用当前版本，返回不匹配时保留旧数据', async () => {
    const store = useAdminStore()
    const fetchMock = vi.fn().mockResolvedValueOnce(response(master)).mockResolvedValueOnce(response({ ...master, version: 2, active: false }))
      .mockResolvedValueOnce(response({ ...master, dataId: 'WRONG' })).mockResolvedValueOnce(response({ ...master, version: 2, referenceCount: 9 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await store.saveMasterData(master, true)).toBe(true)
    expect(await store.saveMasterData({ ...master, active: false }, false)).toBe(true)
    expect(store.masterData).toEqual([{ ...master, version: 2, active: false }])
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('PUT')
    expect(await store.saveMasterData(master, false)).toBe(false)
    expect(await store.saveMasterData(master, false)).toBe(false)
    expect(await store.saveMasterData({ ...master, dataId: '' }, true)).toBe(false)
    expect(store.masterData[0]?.version).toBe(2)
  })

  it('加载真实版本、目标并登记显式引用，不自动应用参数', async () => {
    const store = useAdminStore()
    const details: MasterDataDetails = {
      dataId: master.dataId,
      history: [{ ...master, version: 2 }, master],
      references: [],
    }
    const target = { targetType: 'SCENARIO' as const, targetId: 'SCN-REAL', targetVersion: '8', name: '真实场景' }
    const reference = { dataId: master.dataId, dataVersion: 2, targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }
    const registered: MasterDataDetails = { ...details, history: [{ ...master, version: 2, referenceCount: 1 }, master], references: [reference] }
    const fetchMock = vi.fn().mockResolvedValueOnce(response(details)).mockResolvedValueOnce(response([target])).mockResolvedValueOnce(response(registered))
    vi.stubGlobal('fetch', fetchMock)
    expect(await store.loadMasterDetails(master.dataId)).toBe(true)
    expect(store.masterTargets).toEqual([target])
    expect(await store.registerMasterReference(reference)).toBe(true)
    expect(store.masterDetails).toEqual(registered)
    expect(store.masterData).toEqual([])
    expect(fetchMock.mock.calls[2]?.[0]).toContain(`/admin/master-data/${master.dataId}/reference`)
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual(reference)
  })

  it('详情请求迟到、畸形详情或目标不会恢复旧版本与引用', async () => {
    const store = useAdminStore()
    let resolveDetails!: (value: Response) => void
    const deferred = new Promise<Response>((resolve) => { resolveDetails = resolve })
    const fetchMock = vi.fn().mockReturnValueOnce(deferred).mockResolvedValueOnce(response([]))
    vi.stubGlobal('fetch', fetchMock)
    const load = store.loadMasterDetails(master.dataId)
    store.clearMasterDetails()
    resolveDetails(response({ dataId: master.dataId, history: [master], references: [] }))
    expect(await load).toBe(false)
    expect(store.masterDetails).toBeNull()
    expect(store.masterTargets).toEqual([])
    fetchMock.mockResolvedValueOnce(response({ dataId: master.dataId, history: [master], references: [] })).mockResolvedValueOnce(response([{ targetType: 'SCENARIO', targetId: 'SCN-1', targetVersion: '', name: '坏目标' }]))
    expect(await store.loadMasterDetails(master.dataId)).toBe(false)
    expect(store.masterDetailsState).toBe('ERROR')
  })

  it('主数据详情与引用登记拒绝错目标、停用版本、重复请求和迟到结果', async () => {
    const store = useAdminStore()
    const target = { targetType: 'SCENARIO' as const, targetId: 'SCN-REAL', targetVersion: '8', name: '真实场景' }
    const details: MasterDataDetails = { dataId: master.dataId, history: [master], references: [] }
    const reference = { dataId: master.dataId, dataVersion: 1, targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await store.registerMasterReference(reference)).toBe(false)
    expect(await store.loadMasterDetails('')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(response({ ...details, dataId: 'WRONG' })).mockResolvedValueOnce(response([target]))
    expect(await store.loadMasterDetails(master.dataId)).toBe(false)
    fetchMock.mockResolvedValueOnce(response(details)).mockResolvedValueOnce(response([target, target]))
    expect(await store.loadMasterDetails(master.dataId)).toBe(false)
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, error: { code: 'OFFLINE', message: '离线', retryable: false, correlationId: 'C', fieldPath: '' } }) }).mockResolvedValueOnce(response([target]))
    expect(await store.loadMasterDetails(master.dataId)).toBe(false)

    fetchMock.mockResolvedValueOnce(response(details)).mockResolvedValueOnce(response([target]))
    expect(await store.loadMasterDetails(master.dataId)).toBe(true)
    expect(await store.registerMasterReference({ ...reference, dataVersion: 9 })).toBe(false)
    expect(await store.registerMasterReference({ ...reference, targetId: 'SCN-OTHER' })).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(8)

    fetchMock.mockResolvedValueOnce(response({ ...details, history: [{ ...master, active: false }] })).mockResolvedValueOnce(response([target]))
    expect(await store.loadMasterDetails(master.dataId)).toBe(true)
    expect(await store.registerMasterReference(reference)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(10)

    const selectedInactive: MasterDataDetails = { dataId: master.dataId, history: [{ ...master, version: 2 }, { ...master, active: false }], references: [] }
    fetchMock.mockResolvedValueOnce(response(selectedInactive)).mockResolvedValueOnce(response([target]))
    expect(await store.loadMasterDetails(master.dataId)).toBe(true)
    expect(await store.registerMasterReference(reference)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(12)

    fetchMock.mockResolvedValueOnce(response(details)).mockResolvedValueOnce(response([target]))
    expect(await store.loadMasterDetails(master.dataId)).toBe(true)
    fetchMock.mockResolvedValueOnce(response(details))
    expect(await store.registerMasterReference(reference)).toBe(false)
    expect(store.masterDetailsState).toBe('ERROR')

    fetchMock.mockResolvedValueOnce(response(details)).mockResolvedValueOnce(response([target]))
    expect(await store.loadMasterDetails(master.dataId)).toBe(true)
    let resolve!: (value: Response) => void
    let reject!: (error: Error) => void
    const deferred = new Promise<Response>((res, rej) => { resolve = res; reject = rej })
    fetchMock.mockReturnValueOnce(deferred)
    const first = store.registerMasterReference(reference)
    expect(await store.registerMasterReference(reference)).toBe(false)
    store.resetToSafeEmpty()
    resolve(response({ ...details, references: [reference] }))
    expect(await first).toBe(false)
    expect(store.masterDetails).toBeNull()

    fetchMock.mockResolvedValueOnce(response(details)).mockResolvedValueOnce(response([target]))
    expect(await store.loadMasterDetails(master.dataId)).toBe(true)
    fetchMock.mockReturnValueOnce(Promise.reject(new Error('late')))
    const lateFailure = store.registerMasterReference(reference)
    store.clearMasterDetails()
    reject(new Error('unused'))
    expect(await lateFailure).toBe(false)
    expect(store.masterDetails).toBeNull()
  })

  it('拒绝会被 URL 规范化的主数据编号且不发送写入请求', async () => {
    const store = useAdminStore()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const dataId of ['.', '..']) {
      expect(isMasterData({ ...master, dataId })).toBe(false)
      expect(await store.saveMasterData({ ...master, dataId }, true)).toBe(false)
      expect(await store.saveMasterData({ ...master, dataId }, false)).toBe(false)
      expect(store.maintenance.master.state).toBe('ERROR')
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.masterData).toEqual([])
  })

  it.each(['DELETE', 'BACKUP', 'RESTORE', 'EXPORT'] as const)('执行 %s 绑定正确对象且清除一次性确认', async (operation) => {
    const store = useAdminStore()
    store.masterData = [master, { ...master, dataId: 'KEEP' }]
    const data = { DELETE: { deleted: true, objectId: master.dataId }, BACKUP: backup, RESTORE: restore, EXPORT: exported }[operation]
    const fetchMock = actionResponses(data)
    const target = operation === 'DELETE' ? master.dataId : backup.backupId
    expect(await store.runMaintenanceAction(operation, target)).toBe(true)
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(request).toEqual({
      action: operation === 'DELETE' ? 'MASTER_DATA_DELETE' : operation === 'EXPORT' ? 'FULL_CONFIG_EXPORT' : 'BACKUP_RESTORE',
      objectId: operation === 'DELETE' ? target : operation === 'RESTORE' ? `RESTORE:${target}` : operation === 'BACKUP' ? 'BACKUP:NEW' : 'FULL-CONFIG',
    })
    expect(store.maintenanceConfirmation).toBeNull()
    if (operation === 'DELETE') expect(store.masterData.map((item) => item.dataId)).toEqual(['KEEP'])
    if (operation === 'BACKUP') expect(store.backups).toEqual([backup])
    if (operation === 'RESTORE') expect(store.restoreResult).toEqual(restore)
    if (operation === 'EXPORT') expect(store.fullConfigExport).toEqual(exported)
  })

  it('恢复失败区分完整性错误和回滚，不能显示成功', async () => {
    const store = useAdminStore()
    for (const integrityValid of [true, false]) {
      actionResponses({ ...restore, result: 'FAILURE', integrityValid, rolledBack: integrityValid, progress: integrityValid ? 100 : 0 })
      expect(await store.runMaintenanceAction('RESTORE', backup.backupId)).toBe(false)
      expect(store.maintenance.backup.state).toBe('ERROR')
      expect(store.restoreResult?.rolledBack).toBe(integrityValid)
    }
  })

  it('拒绝无效确认、错对象删除、重复备份、不实恢复和导出', async () => {
    const store = useAdminStore()
    for (const [operation, invalid] of [
      ['DELETE', { deleted: true, objectId: 'WRONG' }], ['BACKUP', {}], ['RESTORE', { ...restore, generated: 'true' }], ['EXPORT', { ...exported, objectId: 'WRONG' }], ['EXPORT', { ...exported, classification: 'LEVEL_III' }],
    ] as const) {
      actionResponses(invalid)
      expect(await store.runMaintenanceAction(operation, 'ID')).toBe(false)
    }
    store.backups = [backup] as typeof store.backups
    actionResponses(backup)
    expect(await store.runMaintenanceAction('BACKUP')).toBe(false)
    const badCreation = vi.fn().mockResolvedValueOnce(response({}))
    vi.stubGlobal('fetch', badCreation)
    expect(await store.runMaintenanceAction('BACKUP')).toBe(false)
    expect(badCreation).toHaveBeenCalledTimes(1)
    const badConfirmation = vi.fn().mockResolvedValueOnce(response(confirmation('AWAITING_CONFIRMATION'))).mockResolvedValueOnce(response({ ...confirmation('CONFIRMED'), confirmationId: 'WRONG' }))
    vi.stubGlobal('fetch', badConfirmation)
    expect(await store.runMaintenanceAction('BACKUP')).toBe(false)
    expect(badConfirmation).toHaveBeenCalledTimes(2)
    expect(store.maintenanceConfirmation).toBeNull()
  })

  it('无权限、缺少对象、忙状态和网络异常不会产生伪成功', async () => {
    const store = useAdminStore()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    useAuthStore().$patch({ role: 'OPERATOR' })
    expect(await store.loadMaintenance('master')).toBe(false)
    expect(await store.runMaintenanceAction('BACKUP')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    useAuthStore().$patch({ role: 'ADMIN' })
    expect(await store.runMaintenanceAction('DELETE')).toBe(false)
    store.maintenance.master.state = 'EXECUTING'
    expect(await store.saveMasterData(master, true)).toBe(false)
    expect(await store.loadMaintenance('master')).toBe(false)
    expect(await store.runMaintenanceAction('BACKUP')).toBe(false)
    store.resetMaintenance()
    fetchMock.mockRejectedValueOnce(new Error('network'))
    expect(await store.loadMaintenance('health')).toBe(false)
    expect(store.maintenance.health.message).toContain('暂时不可用')
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) })
    expect(await store.loadMaintenance('health')).toBe(false)
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('json') } })
    expect(await store.loadMaintenance('health')).toBe(false)
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, error: { code: 'CONFLICT', message: '已有引用。', retryable: false, correlationId: 'CORR-P7', fieldPath: 'referenceCount' }, meta: { requestId: 'REQ-P7', generatedAt: fixtures.epoch } }) })
    expect(await store.loadMaintenance('master')).toBe(false)
    expect(store.maintenance.master.fieldPath).toBe('referenceCount')
    store.showMaintenanceError('master', undefined)
    expect(store.maintenance.master.message).toBe('系统管理操作失败。')
  })

  it('离开页面后忽略读写及确认链的延迟响应与异常', async () => {
    const store = useAdminStore()
    for (const reject of [false, true]) {
      for (const action of ['load', 'save', 'confirm-create', 'confirm-accept', 'execute'] as const) {
        store.resetMaintenance()
        let resolve!: (value: Response) => void
        let fail!: (error: Error) => void
        const deferred = new Promise<Response>((res, rej) => { resolve = res; fail = rej })
        const fetchMock = vi.fn()
        if (action === 'confirm-accept' || action === 'execute') fetchMock.mockResolvedValueOnce(response(confirmation('AWAITING_CONFIRMATION')))
        if (action === 'execute') fetchMock.mockResolvedValueOnce(response(confirmation('CONFIRMED')))
        fetchMock.mockReturnValueOnce(deferred)
        vi.stubGlobal('fetch', fetchMock)
        const task = action === 'load' ? store.loadMaintenance('master') : action === 'save' ? store.saveMasterData(master, true) : store.runMaintenanceAction('BACKUP')
        await vi.waitFor(() => expect(fetchMock.mock.results.some((item) => item.value === deferred)).toBe(true))
        store.resetToSafeEmpty()
        if (reject) fail(new Error('late'))
        else resolve(response(action === 'load' ? [master] : action === 'save' ? master : backup))
        expect(await task).toBe(false)
        expect(store.masterData).toEqual([])
        expect(store.backups).toEqual([])
        expect(store.maintenanceConfirmation).toBeNull()
        expect(store.maintenance.master.state).toBe('EMPTY')
        expect(store.maintenance.backup.state).toBe('EMPTY')
      }
    }
  })

  it('共享边界校验拒绝畸形字段及互相矛盾的结果', () => {
    expect(isMasterData(master)).toBe(true)
    expect(isMasterDetails({ dataId: master.dataId, history: [master], references: [] })).toBe(true)
    for (const bad of [null, [], { ...master, extra: 1 }, { ...master, kind: '' }, { ...master, version: 0 }, { ...master, referenceCount: -1 }, { ...master, active: 1 }]) expect(isMasterData(bad)).toBe(false)
    expect(isBackupRecord(backup)).toBe(true)
    for (const bad of [{ ...backup, status: 'BAD' }, { ...backup, checksum: '' }, { ...backup, createdAt: '2026-02-30T08:00:00Z' }, { ...backup, createdAt: '2026-99-01T08:00:00Z' }, { ...backup, createdAt: '' }]) expect(isBackupRecord(bad)).toBe(false)
    expect(isArchiveRecord(fixtures.archive)).toBe(true)
    expect(isArchiveRecord({ ...fixtures.archive, replayId: 'REPLAY-' })).toBe(false)
    expect(isSystemHealth({ ...fixtures.diagnostics, engine: 'HEALTHY' })).toBe(false)
    for (const bad of [{ ...restore, integrityValid: 1 }, { ...restore, rolledBack: 1 }, { ...restore, progress: NaN }, { ...restore, progress: -1 }, { ...restore, progress: 101 }, { ...restore, progress: '100' }, { ...restore, result: 'BAD' }, { ...restore, integrityValid: false }, { ...restore, result: 'FAILURE', rolledBack: false }, { ...restore, result: 'FAILURE', integrityValid: false, progress: 1 }]) expect(isRestoreResult(bad)).toBe(false)
  })
})
