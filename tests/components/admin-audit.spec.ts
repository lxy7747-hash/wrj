import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox, ElPagination } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AuditLog from '../../src/components/admin/AuditLog.vue'
import type { ApiSuccess, AuditRecord, ConfirmationContext, PageMeta } from '../../src/contracts/domain-models'
import { useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'

const META: PageMeta = {
  requestId: 'REQ-AUDIT-COMPONENT',
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
  return { ok: true, data, meta: Array.isArray(data) ? { ...META, total: data.length } : META }
}

function response(body: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

describe('AuditLog', () => {
  beforeEach(() => {
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ role: 'ADMIN' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loads formal audit records and preserves the labelled page title', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success([RECORD]))))
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    expect(wrapper.get('#audit-logs-title').text()).toBe('操作审计日志')
    expect(wrapper.get('[data-testid="audit-table"]').text()).toContain('2026-08-06 16:04:00')
    expect(useAdminStore().auditRecords[0]?.occurredAt).toBe(RECORD.occurredAt)
    expect(wrapper.get('[data-testid="audit-table"]').text()).toContain('场景配置')
    expect(wrapper.get('[data-testid="audit-table"]').text()).toContain('阈值配置（MW-COMM）')
    expect(wrapper.get('[data-testid="audit-table"]').text()).toContain('成功')
    expect(wrapper.get('[data-testid="audit-table"]').text()).toContain('修改阈值')
    expect(wrapper.get('[data-testid="audit-table"]').text()).toContain('管理员')
    expect(useAdminStore().auditRecords[0]?.action).toBe('THRESHOLD_UPDATE')
    wrapper.unmount()
  })

  it('localizes roles and audit actions without changing records or hiding unknown action codes', async () => {
    const cases = [
      ['AUTH_LOGIN', '登录'], ['AUTH_LOGOUT', '退出登录'],
      ['AUTH_SESSION_DENIED', '会话鉴权拒绝'], ['USER_CREATE', '创建用户'],
      ['SCENARIO_UPDATE', '保存场景配置'], ['SIMULATION_COMMAND', '执行仿真控制指令'],
      ['UNKNOWN_ACTION', 'UNKNOWN_ACTION'], ['constructor', 'constructor'],
    ]
    const records = cases.map(([action], index) => ({ ...RECORD, auditId: `AUD-${index}`, role: 'OPERATOR', action }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success(records))))
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const rows = wrapper.get('[data-testid="audit-table"]').findAll('.el-table__row')
    expect(rows).toHaveLength(cases.length)
    cases.forEach(([code, label], index) => {
      expect(rows[index]?.text()).toContain('操作员')
      expect(rows[index]?.text()).toContain(label)
      if (code !== label) expect(rows[index]?.text()).not.toContain(code)
    })
    expect(useAdminStore().auditRecords).toEqual(records)
    wrapper.unmount()
  })

  it('localizes modules, objects and results while preserving source records and unknown identifiers', async () => {
    const cases: [string, string, string | undefined, AuditRecord['result'], string, string][] = [
      ['AUTHENTICATION', 'AUTH_LOGIN', 'USR-ADMIN', 'SUCCESS', '登录认证', '账号（USR-ADMIN）'],
      ['SIMULATION_CONTROL', 'SIMULATION_JAMMER_SYNC', 'JAM-001', 'DENIED', '仿真控制', '干扰设备（JAM-001）'],
      ['AUDIT', 'AUDIT_EXPORT', 'AUDIT-LOG', 'ERROR', '操作审计', '操作审计日志（AUDIT-LOG）'],
      ['SYSTEM', 'FULL_CONFIG_EXPORT', 'FULL-CONFIG', 'SUCCESS', '系统管理', '完整配置（FULL-CONFIG）'],
      ['AUTHENTICATION', 'AUTH_SESSION_DENIED', undefined, 'DENIED', '登录认证', '未指定对象'],
      ['UNKNOWN_MODULE', 'UNKNOWN_ACTION', 'CUSTOM-001', 'ERROR', 'UNKNOWN_MODULE', 'CUSTOM-001'],
      ['constructor', 'constructor', 'CUSTOM-002', 'SUCCESS', 'constructor', 'CUSTOM-002'],
      ['SYSTEM', 'MASTER_DATA_CREATE', 'DICT-001', 'SUCCESS', '系统管理', '通用数据（DICT-001）'],
      ['SYSTEM', 'MASTER_DATA_EQUIPMENT_CREATE', 'EQ-001', 'SUCCESS', '系统管理', '装备参数（EQ-001）'],
    ]
    const records = cases.map(([module, action, objectId, result], index) => ({
      ...RECORD, auditId: `AUD-${index}`, module, action, objectId, result,
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success(records))))
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const rows = wrapper.get('[data-testid="audit-table"]').findAll('.el-table__row')
    expect(rows).toHaveLength(cases.length)
    cases.forEach(([, , , result, moduleLabel, objectLabel], index) => {
      expect(rows[index]!.classes().includes('risk-row')).toBe(result !== 'SUCCESS')
      const cells = rows[index]!.findAll('td')
      expect(cells[4]!.text()).toBe(moduleLabel)
      expect(cells[6]!.text()).toBe(objectLabel)
      expect(cells[7]!.text()).toBe({ SUCCESS: '成功', DENIED: '已拒绝', ERROR: '错误' }[result])
    })
    expect(useAdminStore().auditRecords).toEqual(records)
    wrapper.unmount()
  })

  it('renders EMPTY and ERROR without retaining invalid records', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(success([])))
      .mockResolvedValueOnce(response(success([{ ...RECORD, extra: true }])))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.get('[data-testid="audit-empty"]').text()).toContain('没有符合条件的审计记录')

    await wrapper.get('.el-button--primary').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="audit-error"]').text()).toContain('INVALID_RESPONSE')
    expect(wrapper.find('[data-testid="audit-table"]').exists()).toBe(false)
  })

  it('submits user, role, module, result, and time filters through the Store action', async () => {
    const store = useAdminStore()
    const loadSpy = vi.spyOn(store, 'loadAudit').mockResolvedValue(true)
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    loadSpy.mockClear()

    await wrapper.get('input[placeholder="用户"]').setValue('admin')
    await wrapper.get('input[placeholder="模块"]').setValue('SCENARIO_CONFIGURATION')
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    selects[0]?.vm.$emit('update:modelValue', 'ADMIN')
    selects[1]?.vm.$emit('update:modelValue', 'SUCCESS')
    wrapper.getComponent({ name: 'ElDatePicker' }).vm.$emit('update:modelValue', [
      new Date('2026-08-06T08:00:00Z'),
      new Date('2026-08-06T09:00:00Z'),
    ])
    await wrapper.vm.$nextTick()
    await wrapper.get('.el-button--primary').trigger('click')

    expect(loadSpy).toHaveBeenCalledWith(
      {
        actor: 'admin',
        role: 'ADMIN',
        module: 'SCENARIO_CONFIGURATION',
        result: 'SUCCESS',
        from: '2026-08-06T08:00:00.000Z',
        to: '2026-08-06T09:00:00.000Z',
      },
      { page: 1, pageSize: 20, sortOrder: 'desc' },
    )
  })

  it('delegates export to the one-time confirmation Store flow', async () => {
    const store = useAdminStore()
    vi.spyOn(store, 'loadAudit').mockResolvedValue(true)
    const exportSpy = vi.spyOn(store, 'exportAudit').mockResolvedValue(true)
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    await wrapper.get('input[placeholder="用户"]').setValue('current-user')
    await wrapper.get('input[placeholder="模块"]').setValue('SIMULATION_CONTROL')

    const button = wrapper.findAll('button').find((candidate) => candidate.text() === '导出日志')
    expect(button).toBeDefined()
    await button?.trigger('click')
    expect(exportSpy).toHaveBeenCalledWith({ actor: 'current-user', module: 'SIMULATION_CONTROL' })
  })

  it('uses the selected operation type for query and export, then clears it without changing source records', async () => {
    const store = useAdminStore()
    store.auditRecords = [{ ...RECORD, action: 'CUSTOM_HISTORY_ACTION' }]
    const loadSpy = vi.spyOn(store, 'loadAudit').mockResolvedValue(true)
    const exportSpy = vi.spyOn(store, 'exportAudit').mockResolvedValue(true)
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const action = wrapper.findAllComponents({ name: 'ElSelect' }).find(component => component.attributes('data-testid') === 'audit-action-filter')!
    expect(action.findAllComponents({ name: 'ElOption' }).some(option => option.props('value') === 'CUSTOM_HISTORY_ACTION')).toBe(true)
    action.vm.$emit('update:modelValue', 'USER_DISABLE')
    await wrapper.vm.$nextTick()
    await wrapper.get('.el-button--primary').trigger('click')
    await wrapper.findAll('button').find(button => button.text() === '导出日志')!.trigger('click')
    expect(loadSpy).toHaveBeenLastCalledWith({ action: 'USER_DISABLE' }, { page: 1, pageSize: 20, sortOrder: 'desc' })
    expect(exportSpy).toHaveBeenLastCalledWith({ action: 'USER_DISABLE' })
    action.vm.$emit('update:modelValue', undefined)
    await wrapper.vm.$nextTick()
    await wrapper.get('.el-button--primary').trigger('click')
    expect(loadSpy).toHaveBeenLastCalledWith({}, { page: 1, pageSize: 20, sortOrder: 'desc' })
    expect(store.auditRecords[0]!.action).toBe('CUSTOM_HISTORY_ACTION')
    wrapper.unmount()
  })

  it('uses descending time order by default and sends server-side sort and paging requests', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(response(success([RECORD])))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const store = useAdminStore()
    const timeColumn = wrapper.findAllComponents({ name: 'ElTableColumn' }).find(column => column.props('prop') === 'occurredAt')!
    expect(store.auditSortOrder).toBe('desc')
    expect(wrapper.findComponent({ name: 'ElTable' }).props('defaultSort')).toEqual({ prop: 'occurredAt', order: 'descending' })
    expect(timeColumn.props('sortable')).toBe('custom')
    expect(timeColumn.props('sortOrders')).toEqual(['descending', 'ascending'])
    expect(fetchSpy).toHaveBeenCalledOnce()

    store.auditFilters = { actor: 'applied-user' }
    const loadSpy = vi.spyOn(store, 'loadAudit').mockResolvedValue(true)
    wrapper.findComponent({ name: 'ElTable' }).vm.$emit('sort-change', { prop: 'occurredAt', order: 'ascending' })
    expect(loadSpy).toHaveBeenLastCalledWith({ actor: 'applied-user' }, { page: 1, pageSize: 20, sortOrder: 'asc' })

    const pagination = wrapper.getComponent(ElPagination)
    pagination.vm.$emit('update:current-page', 2)
    expect(loadSpy).toHaveBeenLastCalledWith({ actor: 'applied-user' }, { page: 2, pageSize: 20, sortOrder: 'desc' })
    pagination.vm.$emit('update:page-size', 50)
    expect(loadSpy).toHaveBeenLastCalledWith({ actor: 'applied-user' }, { page: 1, pageSize: 50, sortOrder: 'desc' })
    wrapper.unmount()
  })

  it('resets a new query to the first page while retaining its size and order', async () => {
    const store = useAdminStore()
    store.$patch({ auditPage: 3, auditPageSize: 50, auditSortOrder: 'asc' })
    const loadSpy = vi.spyOn(store, 'loadAudit').mockResolvedValue(true)
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    loadSpy.mockClear()
    await wrapper.get('input[placeholder="用户"]').setValue('new-query')
    await wrapper.get('.el-button--primary').trigger('click')
    expect(loadSpy).toHaveBeenCalledWith({ actor: 'new-query' }, { page: 1, pageSize: 50, sortOrder: 'asc' })
    wrapper.unmount()
  })

  it('deletes selected or individual audit records only after confirmation', async () => {
    const records = [RECORD, { ...RECORD, auditId: 'AUD-002' }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success(records))))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const successMessage = vi.spyOn(ElMessage, 'success').mockImplementation(() => undefined as never)
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const deleteSpy = vi.spyOn(useAdminStore(), 'deleteAudit').mockResolvedValue(true)
    wrapper.findComponent({ name: 'ElTable' }).vm.$emit('selection-change', records)
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-testid="audit-delete-selected"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith('确认删除选中的 2 条审计日志？删除后不可恢复。', '删除审计日志', expect.any(Object))
    expect(deleteSpy).toHaveBeenLastCalledWith(['AUD-001', 'AUD-002'])
    expect(successMessage).toHaveBeenCalledTimes(1)

    await wrapper.get('[data-testid="delete-audit-AUD-001"]').trigger('click')
    await flushPromises()
    expect(deleteSpy).toHaveBeenLastCalledWith(['AUD-001'])
    expect(successMessage).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('does not delete or announce success when confirmation is cancelled or deletion fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success([RECORD]))))
    vi.spyOn(ElMessageBox, 'confirm')
      .mockRejectedValueOnce('cancel')
      .mockResolvedValueOnce('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const successMessage = vi.spyOn(ElMessage, 'success').mockImplementation(() => undefined as never)
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const deleteSpy = vi.spyOn(useAdminStore(), 'deleteAudit').mockResolvedValue(false)
    const button = wrapper.get('[data-testid="delete-audit-AUD-001"]')
    await button.trigger('click')
    await flushPromises()
    expect(deleteSpy).not.toHaveBeenCalled()
    await button.trigger('click')
    await flushPromises()
    expect(deleteSpy).toHaveBeenCalledWith(['AUD-001'])
    expect(successMessage).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each(['leave', 'reset'])('does not send a delete after %s while confirmation is pending', async operation => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(success([RECORD]))))
    let resolveConfirmation!: (value: Awaited<ReturnType<typeof ElMessageBox.confirm>>) => void
    vi.spyOn(ElMessageBox, 'confirm').mockImplementation(() => new Promise(resolve => { resolveConfirmation = resolve }))
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const store = useAdminStore()
    const deleteSpy = vi.spyOn(store, 'deleteAudit').mockResolvedValue(true)
    await wrapper.get('[data-testid="delete-audit-AUD-001"]').trigger('click')
    if (operation === 'leave') wrapper.unmount()
    else store.resetToSafeEmpty()
    resolveConfirmation('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    await flushPromises()
    expect(deleteSpy).not.toHaveBeenCalled()
    if (operation === 'reset') wrapper.unmount()
  })

  it.each([false, true])('downloads confirmed HTTP contents unless the panel has left (left=%s)', async (left) => {
    const createUrl = vi.fn().mockReturnValue('blob:audit-test')
    const revokeUrl = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createUrl
      static revokeObjectURL = revokeUrl
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    let resolveExport!: (value: Response) => void
    const context = { confirmationId: 'CONF-AUDIT-001', actor: 'admin', role: 'ADMIN', createdAt: META.generatedAt, expiresAt: '2026-08-06T08:05:00Z' }
    const file = { objectId: 'AUDIT-LOG', generated: true, classification: 'INTERNAL', watermark: '内部使用 · admin · AUDIT-LOG',
      verifiedAt: META.generatedAt, fileName: 'operation_audit_20260806160000_CONF-AUDIT-001.txt', content: '操作审计日志\r\n真实响应记录\r\n', recordCount: 1 }
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(response(success([RECORD])))
      .mockResolvedValueOnce(response(success({ ...context, state: 'AWAITING_CONFIRMATION' })))
      .mockResolvedValueOnce(response(success({ ...context, state: 'CONFIRMED' })))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveExport = resolve }))
    vi.stubGlobal('fetch', fetchSpy)
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus], stubs: {
      ElDialog: { props: ['modelValue'], template: '<div v-if="modelValue"><slot /><slot name="footer" /></div>' },
    } } })
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '导出日志')!.trigger('click')
    await flushPromises()
    expect(createUrl).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('尚未加密')
    await wrapper.get('[data-testid="confirm-audit-export"]').trigger('click')
    await flushPromises()
    if (left) wrapper.unmount()
    resolveExport(response(success(file)))
    await flushPromises()
    if (left) {
      expect(createUrl).not.toHaveBeenCalled()
      expect(click).not.toHaveBeenCalled()
    } else {
      expect(click).toHaveBeenCalledOnce()
      expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe(file.fileName)
      expect(revokeUrl).toHaveBeenCalledWith('blob:audit-test')
      const blob = createUrl.mock.calls[0]![0] as Blob
      expect(blob.type).toBe('text/plain;charset=utf-8')
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.readAsText(blob)
      })
      expect(text.replace(/^\uFEFF/, '')).toBe(file.content)
      expect(wrapper.get('[data-testid="audit-export-status"]').text()).toContain(file.fileName)
      wrapper.unmount()
    }
  })

  it('requires an explicit dialog confirmation and supports cancellation', async () => {
    const store = useAdminStore()
    vi.spyOn(store, 'loadAudit').mockResolvedValue(true)
    const confirmSpy = vi.spyOn(store, 'confirmAuditExport').mockResolvedValue(true)
    const cancelSpy = vi.spyOn(store, 'cancelAuditExport')
    store.auditConfirmation = {
      confirmationId: 'CONF-AUDIT-001',
      state: 'AWAITING_CONFIRMATION',
      actor: 'admin',
      role: 'ADMIN',
      createdAt: '2026-08-06T08:00:00Z',
      expiresAt: '2026-08-06T08:05:00Z',
    } satisfies ConfirmationContext
    const wrapper = mount(AuditLog, {
      global: {
        plugins: [ElementPlus],
        stubs: {
          ElDialog: {
            props: ['modelValue'],
            template: '<div v-if="modelValue" role="dialog"><slot /><slot name="footer" /></div>',
          },
        },
      },
    })
    await flushPromises()

    await wrapper.get('[data-testid="confirm-audit-export"]').trigger('click')
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    const cancel = wrapper.findAll('button').find((candidate) => candidate.text() === '取消')
    await cancel?.trigger('click')
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })
})
