import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EquipmentLibrary from '../../src/components/admin/EquipmentLibrary.vue'
import { useAuthStore } from '../../src/stores/auth'
import type { EquipmentParameter } from '../../src/contracts/domain-models'
import { EQUIPMENT } from '../fixtures/equipment'

function response(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: { requestId: 'REQ-EQ', generatedAt: '2026-08-06T08:00:00Z', page: 1, pageSize: 10, total: Array.isArray(data) ? data.length : 1 } }))
}

function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ role: 'ADMIN' })
  return mount(EquipmentLibrary, { global: { plugins: [pinia, ElementPlus], stubs: {
    ElDialog: { props: ['modelValue', 'title'], template: '<section v-if="modelValue" role="dialog"><h4>{{ title }}</h4><slot/><slot name="footer"/></section>' },
  } } })
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); ElMessage.closeAll() })

describe('装备参数库', () => {
  it('取消不删除，确认后真实 Store 调用删除并刷新，成功只提示一次', async () => {
    let deleted = false
    const context = { confirmationId: 'CONF-DELETE', actor: 'admin', role: 'ADMIN', createdAt: '2026-08-06T08:00:00Z', expiresAt: '2026-08-06T08:05:00Z' }
    const fetcher = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') { deleted = true; return response({ objectId: EQUIPMENT.equipmentId, deleted: true }) }
      if (init?.method === 'POST') return response({ ...context, state: String(url).endsWith('/confirmations') ? 'AWAITING_CONFIRMATION' : 'CONFIRMED' })
      return response(deleted ? [] : [EQUIPMENT])
    })
    vi.stubGlobal('fetch', fetcher)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValueOnce('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const success = vi.spyOn(ElMessage, 'success')
    const wrapper = setup()
    await flushPromises()
    const remove = () => wrapper.findAll('button').find(item => item.text() === '删除')!
    await remove().trigger('click')
    await flushPromises()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await remove().trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(success).toHaveBeenCalledExactlyOnceWith('装备参数已删除。')
    expect(wrapper.get('[data-testid="equipment-table"]').text()).not.toContain(EQUIPMENT.equipmentId)
    expect(wrapper.find('[data-testid="equipment-feedback"]').exists()).toBe(false)
    expect(fetcher.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(2)
    wrapper.unmount()
  })

  it('离页后的迟到删除确认不发送任何请求', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([EQUIPMENT])))
    let resolve!: (value: Awaited<ReturnType<typeof ElMessageBox.confirm>>) => void
    vi.spyOn(ElMessageBox, 'confirm').mockImplementation(() => new Promise(done => { resolve = done }))
    const wrapper = setup()
    await flushPromises()
    await wrapper.findAll('button').find(item => item.text() === '删除')!.trigger('click')
    wrapper.unmount()
    resolve('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('空库新增、非法字段阻断、修改保存、离页重载一致；成功消息仅一次', async () => {
    let records: EquipmentParameter[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init?.method) return response(records)
      const input = JSON.parse(String(init.body)) as EquipmentParameter
      const saved = { ...input, version: init.method === 'POST' ? 1 : input.version + 1 }
      records = [saved]
      return response(saved)
    })
    vi.stubGlobal('fetch', fetcher)
    const success = vi.spyOn(ElMessage, 'success')
    const wrapper = setup()
    await flushPromises()
    expect(wrapper.text()).toContain('暂无数据')
    expect(wrapper.find('[data-testid="equipment-feedback"]').exists()).toBe(false)
    expect(wrapper.get('.card-header').findAll('button').map(button => button.text())).toEqual(['刷新', '新增装备'])
    expect(wrapper.text()).not.toMatch(/UAV-STD|导入参数包|SUCCESS/)
    await wrapper.get('[data-testid="equipment-create"]').trigger('click')
    expect(wrapper.findAll('.equipment-editor__section h3').map(heading => heading.text()))
      .toEqual(['基本信息', '通信参数', '质量阈值'])
    expect(wrapper.findAll('.equipment-editor .el-form-item')).toHaveLength(9)
    expect(wrapper.get('[data-testid="equipment-frequency-min"]').classes()).toContain('is-controls-right')
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('编号须为')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await wrapper.get('input[data-testid="equipment-id"]').setValue(EQUIPMENT.equipmentId)
    await wrapper.get('input[data-testid="equipment-type"]').setValue(EQUIPMENT.type)
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(records[0]).toMatchObject({ equipmentId: EQUIPMENT.equipmentId, frequencyMinMHz: null, modulation: null, version: 1 })
    expect(success).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="equipment-feedback"]').exists()).toBe(false)
    const button = (label: string) => wrapper.findAll('button').find(item => item.text() === label)!
    await button('查看').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('暂无数据')
    await button('关闭').trigger('click')
    await button('编辑').trigger('click')
    expect(wrapper.get('input[data-testid="equipment-id"]').attributes('disabled')).toBeDefined()
    await wrapper.get('input[data-testid="equipment-type"]').setValue('管理员修改的设备')
    await wrapper.get('input[data-testid="equipment-modulation"]').setValue('QPSK')
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(success).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    const reloaded = setup()
    await flushPromises()
    expect(reloaded.get('[data-testid="equipment-table"]').text()).toContain('管理员修改的设备')
    expect(records[0]).toMatchObject({ modulation: 'QPSK', version: 2 })
    expect(reloaded.text()).toContain('QPSK')
    reloaded.unmount()
  })

  it('加载失败明确显示错误，重试恢复；只读装备不可编辑', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response([{ ...EQUIPMENT, readOnly: true }])))
    const success = vi.spyOn(ElMessage, 'success')
    const wrapper = setup()
    await flushPromises()
    expect(wrapper.get('[data-testid="equipment-feedback"]').text()).toContain('暂时不可用')
    await wrapper.findAll('button').find(item => item.text() === '刷新')!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('button').find(item => item.text() === '编辑')!.attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('button').find(item => item.text() === '删除')!.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('100～200 MHz')
    expect(success).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
