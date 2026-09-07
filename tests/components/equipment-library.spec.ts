import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it, vi } from 'vitest'
import EquipmentLibrary from '../../src/components/admin/EquipmentLibrary.vue'

describe('EquipmentLibrary', () => {
  it('supports viewing and saving an equipment record', async () => {
    const warn = vi.spyOn(console, 'warn')
    const wrapper = mount(EquipmentLibrary, {
      global: {
        plugins: [ElementPlus],
        stubs: {
          ElDialog: {
            props: ['modelValue', 'title'],
            template: '<section v-if="modelValue" role="dialog"><h4>{{ title }}</h4><slot /><slot name="footer" /></section>',
          },
        },
      },
    })
    await flushPromises()
    const button = (label: string) => wrapper.findAll('button').find((item) => item.text() === label)

    expect(wrapper.get('[data-testid="equipment-library"]').text()).toContain('UAV-STD')
    expect(button('查看')?.classes()).toContain('is-link')
    expect(button('编辑')?.classes()).toContain('is-link')

    await button('查看')?.trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('高空前出中继节点')
    await button('关闭')?.trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)

    await button('编辑')?.trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('编辑参数')
    await button('保存')?.trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="equipment-library"]').text()).toContain('UAV-STD')
    expect(warn.mock.calls.flat().map(String).some((message) => message.includes('type.text') || message.includes('type=text'))).toBe(false)
    wrapper.unmount()
    warn.mockRestore()
  })
})
