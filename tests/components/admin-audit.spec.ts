import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
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
    expect(wrapper.get('[data-testid="audit-table"]').text()).toContain('SCENARIO_CONFIGURATION')
    expect(wrapper.get('[data-testid="audit-table"]').text()).toContain('THRESHOLD_UPDATE')
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

    expect(loadSpy).toHaveBeenCalledWith({
      actor: 'admin',
      role: 'ADMIN',
      module: 'SCENARIO_CONFIGURATION',
      result: 'SUCCESS',
      from: '2026-08-06T08:00:00.000Z',
      to: '2026-08-06T09:00:00.000Z',
    })
  })

  it('delegates export to the one-time confirmation Store flow', async () => {
    const store = useAdminStore()
    vi.spyOn(store, 'loadAudit').mockResolvedValue(true)
    const exportSpy = vi.spyOn(store, 'exportAudit').mockResolvedValue(true)
    const wrapper = mount(AuditLog, { global: { plugins: [ElementPlus] } })
    await flushPromises()

    await wrapper.get('input[placeholder="用户"]').setValue('current-user')
    await wrapper.get('input[placeholder="模块"]').setValue('SIMULATION_CONTROL')

    const button = wrapper.findAll('button').find((candidate) => candidate.text().includes('确认并验证导出'))
    expect(button).toBeDefined()
    await button?.trigger('click')
    expect(exportSpy).toHaveBeenCalledWith({ actor: 'current-user', module: 'SIMULATION_CONTROL' })
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
