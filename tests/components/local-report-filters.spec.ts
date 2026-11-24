import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElSelect, ElSelectV2 } from 'element-plus'
import { afterEach, describe, expect, it } from 'vitest'
import LocalReportTabs from '../../src/components/reports/LocalReportTabs.vue'
import { LOCAL_REPORT } from '../fixtures/local-report'

const wrappers: VueWrapper[] = []
function setup() {
  const evidence = structuredClone(LOCAL_REPORT.localEvidence)
  evidence.nodes.push({ platformId: 'C', name: '中继丙', type: 'AIR', side: 'blue', positionCount: 0, firstTimeS: 0, lastTimeS: 0 })
  evidence.connections.push({ eventId: 'LOG-L3', time: 8, scope: 'INTER_PLATFORM', sourcePlatformId: 'B', sourceDeviceId: 'tx2', targetPlatformId: 'C', targetDeviceId: 'rx2' })
  evidence.deviceEvents.push({ eventId: 'LOG-L4', type: 'COMM_TURNED_ON', time: 8, platformId: 'C', deviceId: 'rx2' })
  evidence.eventCount = 4
  const wrapper = mount(LocalReportTabs, { props: { evidence }, global: { plugins: [ElementPlus] } })
  wrappers.push(wrapper)
  return { wrapper: wrapper as VueWrapper, evidence }
}
async function openTimeline(wrapper: VueWrapper) {
  await wrapper.findAll('[role="tab"]').find(row => row.text() === '事件时间线')!.trigger('click')
  await flushPromises()
}
async function select(wrapper: VueWrapper, index: number, value: string) {
  const control = index === 0 ? wrapper.findComponent(ElSelect) : wrapper.findComponent(ElSelectV2)
  control.vm.$emit('update:modelValue', value)
  await flushPromises()
}
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })

describe('本地报告事件时间线筛选', () => {
  it('汇总不显示明细筛选；时间线按节点、关联和时间筛选，空结果可见并可重置', async () => {
    const { wrapper, evidence } = setup()
    const original = structuredClone(evidence)
    expect(wrapper.find('[data-testid="report-details"]').exists()).toBe(false)
    expect(wrapper.find('[aria-label="报告明细筛选"]').exists()).toBe(false)
    await openTimeline(wrapper)
    expect(wrapper.find('[aria-label="报告明细筛选"]').exists()).toBe(true)
    await select(wrapper, 0, 'C')
    await select(wrapper, 1, 'LOG-L3')
    const inputs = wrapper.findAllComponents(ElInputNumber)
    inputs[0]!.vm.$emit('update:modelValue', 8)
    inputs[1]!.vm.$emit('update:modelValue', 8)
    await flushPromises()
    expect(wrapper.findAll('.el-timeline-item')).toHaveLength(2)
    inputs[0]!.vm.$emit('update:modelValue', 9)
    inputs[1]!.vm.$emit('update:modelValue', 10)
    await flushPromises()
    expect(wrapper.get('.el-empty').text()).toContain('暂无符合条件的数据')
    expect(wrapper.findAll('.el-timeline-item')).toHaveLength(0)
    await wrapper.findAll('button').find(row => row.text() === '重置筛选')!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.el-timeline-item').length).toBeGreaterThan(0)
    expect(evidence).toEqual(original)
  })

  it('无效时间范围只在事件时间线提示，切换报告清空条件且不改写原始数据', async () => {
    const { wrapper, evidence } = setup()
    const original = structuredClone(evidence)
    await openTimeline(wrapper)
    await select(wrapper, 0, 'A')
    const inputs = wrapper.findAllComponents(ElInputNumber)
    inputs[0]!.vm.$emit('update:modelValue', 9)
    inputs[1]!.vm.$emit('update:modelValue', 1)
    await flushPromises()
    expect(wrapper.find('.el-alert--error').text()).toContain('开始时刻不得晚于结束时刻')
    expect(wrapper.findAll('.el-timeline-item')).toHaveLength(0)
    await wrapper.findAll('[role="tab"]').find(row => row.text() === '汇总')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.el-alert--error').exists()).toBe(false)
    expect(wrapper.find('[aria-label="报告明细筛选"]').exists()).toBe(false)
    expect(evidence).toEqual(original)
    await wrapper.setProps({ evidence: structuredClone(original) })
    await openTimeline(wrapper)
    expect(wrapper.findAllComponents(ElInputNumber).every(input => input.props('modelValue') === null)).toBe(true)
    expect(wrapper.findAll('.el-timeline-item').length).toBeGreaterThan(0)
  })
})
