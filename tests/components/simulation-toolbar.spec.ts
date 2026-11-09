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

  it('远端仅显示播放、暂停、停止，暂停后播放恢复，断线或保存失败仍可停止', async () => {
    wrapper = mount(SimulationToolbar, { props: { ...baseProps, status: 'STOPPED', remoteEngine: true, receptionActive: false }, global: { plugins: [ElementPlus] } })
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('播放')
    expect(wrapper.find('[data-testid="simulation-disconnect"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ status: 'RUNNING', receptionActive: true, engineControl: { connected: true, action: null, delivery: 'IDLE' } })
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[aria-label="仿真倍速"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ engineControl: { connected: true, action: 'pause', delivery: 'SENT' } })
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('播放')
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ engineControl: { connected: true, action: 'stop', delivery: 'SENDING' } })
    expect(wrapper.get('[data-testid="simulation-stop"]').attributes('disabled')).toBeDefined()
    await wrapper.setProps({ status: 'ERROR', engineControl: { connected: false, action: 'pause', delivery: 'UNKNOWN' } })
    expect(wrapper.get('[data-testid="simulation-stop"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="simulation-stop"]').trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
    await wrapper.setProps({ status: 'STOPPED', receptionActive: false, engineControl: { connected: false, action: 'stop', delivery: 'SENT' } })
    expect(wrapper.find('[data-testid="simulation-disconnect"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('数据已保存、配置已解锁')
    expect(wrapper.text()).toContain('执行结果待确认')
  })

  it('真实引擎连接开放暂停；发送后允许手动恢复，始终标记待确认且不开放倍速', async () => {
    wrapper = mount(SimulationToolbar, { props: { ...baseProps, realMission: true,
      engineControl: { connected: true, action: null, delivery: 'IDLE' } }, global: { plugins: [ElementPlus] } })
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[aria-label="仿真倍速"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="simulation-pause"]').trigger('click')
    expect(wrapper.emitted('pause')).toHaveLength(1)
    await wrapper.setProps({ engineControl: { connected: true, action: 'pause', delivery: 'SENT' } })
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="simulation-start"]').text()).toContain('恢复')
    expect(wrapper.get('[data-testid="simulation-start"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('[data-testid="simulation-start"]').trigger('click')
    expect(wrapper.emitted('start')).toHaveLength(1)
    expect(wrapper.get('[data-testid="engine-control-status"]').text()).toContain('执行结果待确认')
    expect(wrapper.text()).not.toContain('仿真已暂停')
    await wrapper.setProps({ engineControl: { connected: true, action: 'stop', delivery: 'SENT' } })
    for (const button of ['start', 'pause', 'stop']) expect(wrapper.get(`[data-testid="simulation-${button}"]`).attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('配置保持锁定')
  })

  it.each(['SENDING', 'UNKNOWN'] as const)('%s 或断线时禁用引擎控制，不通过重复点击重发', async delivery => {
    wrapper = mount(SimulationToolbar, { props: { ...baseProps, realMission: true,
      engineControl: { connected: true, action: 'pause', delivery } }, global: { plugins: [ElementPlus] } })
    for (const button of ['start', 'pause', 'stop']) expect(wrapper.get(`[data-testid="simulation-${button}"]`).attributes('disabled')).toBeDefined()
    await wrapper.setProps({ engineControl: { connected: false, action: null, delivery: 'IDLE' } })
    expect(wrapper.text()).toContain('WebSocket 未连接')
    expect(wrapper.get('[data-testid="simulation-pause"]').attributes('disabled')).toBeDefined()
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
