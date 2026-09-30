import { mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it } from 'vitest'
import SimulationToolbar from '../../src/components/situation/SimulationToolbar.vue'

const baseProps = {
  status: 'RUNNING' as const,
  speed: 1,
  capabilityState: 'SUCCESS' as const,
  pending: false,
  feedback: '',
}

describe('仿真工具栏', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it.each([16, 32])('文件播放工具栏可选择 %s 倍并传出数值', async speed => {
    wrapper = mount(SimulationToolbar, {
      props: { ...baseProps, filePlayback: true }, global: { plugins: [ElementPlus] },
    })
    const select = wrapper.get('[aria-label="仿真倍速"]')
    expect(select.find(`option[value="${speed}"]`).text()).toBe(`×${speed}`)
    await select.setValue(String(speed))
    expect(wrapper.emitted('update:speed')).toEqual([[speed]])
  })

  it('未知模式保守禁用暂停、继续和倍速，但不冒充真实模式', async () => {
    wrapper = mount(SimulationToolbar, { props: { ...baseProps, runtimeUnknown: true }, global: { plugins: [ElementPlus] } })
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[aria-label="仿真倍速"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('运行模式尚未确认')
    expect(wrapper.text()).not.toContain('真实 mission')
    await wrapper.setProps({ status: 'PAUSED' })
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ runtimeUnknown: false, filePlayback: true })
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[aria-label="仿真倍速"]').attributes('disabled')).toBeUndefined()
  })

  it('真实 mission 禁用暂停、继续和倍速并说明原因，Mock 模式保持原控制行为', async () => {
    wrapper = mount(SimulationToolbar, {
      props: { ...baseProps, realMission: true },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('title')).toContain('未接入暂停')
    expect(wrapper.get('[aria-label="仿真倍速"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[aria-label="仿真倍速"]').attributes('title')).toContain('未接入倍速')
    expect(wrapper.text()).not.toContain('真实 mission 模式仅支持开始和停止')
    expect(wrapper.find('.simulation-toolbar__runtime').exists()).toBe(false)

    await wrapper.setProps({ realMission: false })
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[aria-label="仿真倍速"]').attributes('disabled')).toBeUndefined()

    await wrapper.setProps({ realMission: true, status: 'PAUSED' })
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="simulation-step"]').exists()).toBe(false)
  })
})
