import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElPagination, ElSelect, ElSelectV2 } from 'element-plus'
import { afterEach, describe, expect, it } from 'vitest'
import LocalReportTabs from '../../src/components/reports/LocalReportTabs.vue'
import { LOCAL_REPORT } from '../fixtures/local-report'

const wrappers: VueWrapper[] = []
function setup(connectionCount?: number) {
  const evidence = structuredClone(LOCAL_REPORT.localEvidence)
  evidence.nodes.push({ platformId: 'C', name: '中继丙', type: 'AIR', side: 'blue', positionCount: 0, firstTimeS: 0, lastTimeS: 0 })
  evidence.connections.push({ eventId: 'LOG-L3', time: 8, scope: 'INTER_PLATFORM', sourcePlatformId: 'B', sourceDeviceId: 'tx2', targetPlatformId: 'C', targetDeviceId: 'rx2' })
  evidence.deviceEvents.push({ eventId: 'LOG-L4', type: 'COMM_TURNED_ON', time: 8, platformId: 'C', deviceId: 'rx2' })
  evidence.eventCount = 4
  evidence.eventCounts = evidence.eventCounts.map(row => ({ ...row, count: 2 }))
  if (connectionCount !== undefined) {
    evidence.connections = Array.from({ length: connectionCount }, (_, index) => ({
      ...evidence.connections[0]!, eventId: `LINK-${index}`, time: index % 10,
      sourcePlatformId: index >= 110 ? 'C' : 'A',
    }))
    evidence.eventCounts[0]!.count = connectionCount
    evidence.eventCount = connectionCount + evidence.deviceEvents.length
  }
  const wrapper = mount(LocalReportTabs, { props: { evidence }, global: { plugins: [ElementPlus] } })
  wrappers.push(wrapper)
  return { wrapper: wrapper as VueWrapper, evidence }
}
async function tab(wrapper: VueWrapper, name: string) {
  await wrapper.findAll('[role="tab"]').find(row => row.text() === name)!.trigger('click')
  await flushPromises()
}
async function select(wrapper: VueWrapper, index: number, value: string) {
  const control = index === 0 ? wrapper.findComponent(ElSelect) : wrapper.findComponent(ElSelectV2)
  control.vm.$emit('update:modelValue', value)
  await flushPromises()
}
const rows = (wrapper: VueWrapper, name: string) => wrapper.get(`[aria-label="${name}"]`).findAll('.el-table__body tbody tr')
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })

describe('本地报告筛选与当前页签联动', () => {
  it('关联默认每页50条，翻页与每页数量生效；切换页签保留页码和筛选，设备事件不分页', async () => {
    const { wrapper, evidence } = setup(123)
    const original = structuredClone(evidence)
    await tab(wrapper, '通信关联登记')
    const pagination = wrapper.findComponent(ElPagination)
    expect(pagination.props('pageSize')).toBe(50)
    expect(pagination.props('total')).toBe(123)
    expect(rows(wrapper, '通信关联登记')).toHaveLength(50)
    expect(rows(wrapper, '通信关联登记')[0]!.text()).toContain('LINK-0')
    pagination.vm.$emit('update:current-page', 2)
    await flushPromises()
    expect(rows(wrapper, '通信关联登记')[0]!.text()).toContain('LINK-50')
    await tab(wrapper, '汇总')
    await tab(wrapper, '通信关联登记')
    expect(pagination.props('currentPage')).toBe(2)
    expect(rows(wrapper, '通信关联登记')[0]!.text()).toContain('LINK-50')
    pagination.vm.$emit('update:current-page', 3)
    await flushPromises()
    expect(rows(wrapper, '通信关联登记')).toHaveLength(23)
    pagination.vm.$emit('update:page-size', 20)
    await flushPromises()
    expect(pagination.props('currentPage')).toBe(1)
    expect(rows(wrapper, '通信关联登记')).toHaveLength(20)
    pagination.vm.$emit('update:page-size', 100)
    await flushPromises()
    expect(rows(wrapper, '通信关联登记')).toHaveLength(100)
    await tab(wrapper, '设备与干扰请求')
    expect(rows(wrapper, '设备与干扰请求')).toHaveLength(2)
    expect(evidence).toEqual(original)
  })

  it('筛选覆盖全部关联而非当前页，变化和来源重载回到第一页；虚拟选项保留全部可搜索标签', async () => {
    const { wrapper, evidence } = setup(123)
    await tab(wrapper, '通信关联登记')
    expect(wrapper.findComponent(ElSelectV2).props('options')).toHaveLength(123)
    expect(wrapper.findComponent(ElSelectV2).props('options')[122]).toEqual({ value: 'LINK-122', label: '中继丙 → 通信车乙 · LINK-122' })
    wrapper.findComponent(ElPagination).vm.$emit('update:current-page', 3)
    await flushPromises()
    await select(wrapper, 0, 'A')
    expect(wrapper.findComponent(ElPagination).props('currentPage')).toBe(1)
    expect(wrapper.findComponent(ElPagination).props('total')).toBe(110)
    await select(wrapper, 0, 'C')
    expect(rows(wrapper, '通信关联登记')).toHaveLength(13)
    expect(rows(wrapper, '通信关联登记')[0]!.text()).toContain('LINK-110')
    await select(wrapper, 1, 'LINK-122')
    expect(rows(wrapper, '通信关联登记')).toHaveLength(1)
    await tab(wrapper, '汇总')
    await tab(wrapper, '通信关联登记')
    expect(wrapper.findComponent(ElSelectV2).props('modelValue')).toBe('LINK-122')
    expect(rows(wrapper, '通信关联登记')[0]!.text()).toContain('LINK-122')
    await select(wrapper, 1, '')
    expect(rows(wrapper, '通信关联登记')).toHaveLength(13)
    await wrapper.findAll('button').find(row => row.text() === '重置筛选')!.trigger('click')
    await flushPromises()
    wrapper.findComponent(ElPagination).vm.$emit('update:current-page', 3)
    await flushPromises()
    await wrapper.setProps({ evidence: structuredClone(evidence) })
    expect(wrapper.findComponent(ElPagination).props('currentPage')).toBe(1)
    expect(rows(wrapper, '通信关联登记')).toHaveLength(50)
  })

  it('全局页签隐藏筛选；节点页只按节点筛选并保留真实位置统计，重置恢复', async () => {
    const { wrapper } = setup()
    expect(wrapper.find('[aria-label="报告明细筛选"]').exists()).toBe(false)
    await tab(wrapper, '节点与位置')
    expect(wrapper.findAllComponents(ElSelect)).toHaveLength(1)
    expect(wrapper.findAllComponents(ElInputNumber)).toHaveLength(0)
    expect(wrapper.get('[aria-label="报告明细筛选"] > .el-form-item:last-child').text()).toBe('重置筛选')
    expect(rows(wrapper, '节点与位置')).toHaveLength(3)
    expect(wrapper.text()).not.toMatch(/符合条件共|按节点筛选|完整快照统计|导出完整报告不受筛选/)
    await select(wrapper, 0, 'A')
    expect(rows(wrapper, '节点与位置')).toHaveLength(1)
    expect(rows(wrapper, '节点与位置')[0]!.text()).toContain('无人机甲')
    expect(rows(wrapper, '节点与位置')[0]!.text()).toContain('0分3秒')
    for (const name of ['汇总', '事件分类', '柱状图']) {
      await tab(wrapper, name)
      expect(wrapper.find('[aria-label="报告明细筛选"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="report-filter-count"]').exists()).toBe(false)
    }
    await tab(wrapper, '节点与位置')
    await wrapper.findAll('button').find(row => row.text() === '重置筛选')!.trigger('click')
    expect(rows(wrapper, '节点与位置')).toHaveLength(3)
  })

  it('关联选项按节点收窄；匹配的选择保留，不匹配的旧关联清空', async () => {
    const { wrapper } = setup()
    await tab(wrapper, '通信关联登记')
    await select(wrapper, 1, 'LOG-L1')
    await select(wrapper, 0, 'A')
    expect(wrapper.findComponent(ElSelectV2).props('modelValue')).toBe('LOG-L1')
    await select(wrapper, 0, 'C')
    const association = wrapper.findComponent(ElSelectV2)
    expect(association.props('modelValue')).toBe('')
    expect(association.props('options').map(row => row.value)).toEqual(['LOG-L3'])
    expect(rows(wrapper, '通信关联登记')).toHaveLength(1)
    expect(rows(wrapper, '通信关联登记')[0]!.text()).toContain('LOG-L3')
    await select(wrapper, 0, '')
    expect(association.props('options')).toHaveLength(2)
    expect(rows(wrapper, '通信关联登记')).toHaveLength(2)
  })

  it('节点、关联和时间联合筛选，包含时间边界；空结果可见并可重置', async () => {
    const { wrapper } = setup()
    await tab(wrapper, '设备与干扰请求')
    await select(wrapper, 0, 'C')
    await select(wrapper, 1, 'LOG-L3')
    wrapper.findAllComponents(ElInputNumber)[0]!.vm.$emit('update:modelValue', 8)
    wrapper.findAllComponents(ElInputNumber)[1]!.vm.$emit('update:modelValue', 8)
    await flushPromises()
    expect(rows(wrapper, '设备与干扰请求')).toHaveLength(1)
    expect(rows(wrapper, '设备与干扰请求')[0]!.text()).toContain('LOG-L4')
    await tab(wrapper, '事件时间线')
    expect(wrapper.findAll('.el-timeline-item')).toHaveLength(2)
    wrapper.findAllComponents(ElInputNumber)[0]!.vm.$emit('update:modelValue', 9)
    wrapper.findAllComponents(ElInputNumber)[1]!.vm.$emit('update:modelValue', 10)
    await flushPromises()
    expect(wrapper.get('.el-empty').text()).toContain('暂无符合条件的数据')
    expect(wrapper.findAll('.el-timeline-item')).toHaveLength(0)
    await tab(wrapper, '设备与干扰请求')
    expect(wrapper.get('[aria-label="设备与干扰请求"]').text()).toContain('暂无符合条件的数据')
    await wrapper.findAll('button').find(row => row.text() === '重置筛选')!.trigger('click')
    expect(rows(wrapper, '设备与干扰请求')).toHaveLength(2)
  })

  it('无效时间范围仅影响事件页；切换报告清空条件，原始数据不被筛选改写', async () => {
    const { wrapper, evidence } = setup()
    const original = structuredClone(evidence)
    await tab(wrapper, '通信关联登记')
    await select(wrapper, 0, 'A')
    wrapper.findAllComponents(ElInputNumber)[0]!.vm.$emit('update:modelValue', 9)
    wrapper.findAllComponents(ElInputNumber)[1]!.vm.$emit('update:modelValue', 1)
    await flushPromises()
    expect(wrapper.find('.el-alert--error').text()).toContain('开始时刻不得晚于结束时刻')
    expect(rows(wrapper, '通信关联登记')).toHaveLength(0)
    await tab(wrapper, '节点与位置')
    expect(wrapper.find('.el-alert--error').exists()).toBe(false)
    expect(rows(wrapper, '节点与位置')).toHaveLength(1)
    expect(evidence).toEqual(original)
    await wrapper.setProps({ evidence: structuredClone(original) })
    expect(rows(wrapper, '节点与位置')).toHaveLength(3)
    await tab(wrapper, '通信关联登记')
    expect(rows(wrapper, '通信关联登记')).toHaveLength(2)
    expect(wrapper.findAllComponents(ElInputNumber).every(input => input.props('modelValue') === null)).toBe(true)
  })
})
