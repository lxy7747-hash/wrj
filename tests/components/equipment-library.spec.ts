import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
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
afterEach(() => { vi.unstubAllGlobals(); ElMessage.closeAll() })

describe('装备参数库', () => {
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
    expect(wrapper.text()).toContain('暂无装备参数')
    expect(wrapper.text()).not.toMatch(/UAV-STD|导入参数包|SUCCESS/)
    await wrapper.get('[data-testid="equipment-create"]').trigger('click')
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
    expect(wrapper.get('[role="dialog"]').text()).toContain('未配置')
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
    expect(wrapper.text()).toContain('100～200 MHz')
    expect(success).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
