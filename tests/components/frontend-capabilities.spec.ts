import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { Component } from 'vue'
import ElementPlus, { ElDialog, ElMessage, ElMessageBox, ElSelect, ElInputNumber } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalReportTabs from '../../src/components/reports/LocalReportTabs.vue'
import ReportChart from '../../src/components/reports/ReportChart.vue'
import QualityMetricPanel from '../../src/components/situation/QualityMetricPanel.vue'
import EquipmentRelations from '../../src/components/admin/EquipmentRelations.vue'
import RoleProfiles from '../../src/components/admin/RoleProfiles.vue'
import AccountManagement from '../../src/components/admin/AccountManagement.vue'
import { useAdminStore } from '../../src/stores/admin'
import { SITUATION_LINKS_F00042 } from '../../src/features/situation/situation-model'
import { LOCAL_REPORT } from '../fixtures/local-report'
import { EQUIPMENT } from '../fixtures/equipment'

const response = (data: unknown) => new Response(JSON.stringify({ ok: true, data }))
const dialogStub = { props: ['modelValue', 'title'], template: '<section v-if="modelValue"><h4>{{ title }}</h4><slot/><slot name="footer"/></section>' }
const wrappers: Array<{ unmount(): void }> = []
function setup(component: Component, props: Record<string, unknown>): VueWrapper {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(component, { props, global: { plugins: [pinia, ElementPlus], stubs: { ElDialog: dialogStub } } })
  wrappers.push(wrapper)
  return wrapper
}
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); ElMessage.closeAll() })
const button = (wrapper: ReturnType<typeof setup>, text: string) => wrapper.findAll('button').find(row => row.text() === text)!

describe('前端能力补齐的真实值与空态', () => {
  it('账号管理通过弹框打开角色权限，关闭卸载并在再次打开时重新加载', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    vi.spyOn(useAdminStore(), 'refreshUsers').mockResolvedValue()
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(response({ version: 1, profiles: [], assignments: [] })))
    vi.stubGlobal('fetch', fetch)
    const wrapper = mount(AccountManagement, { global: { plugins: [pinia, ElementPlus] } })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.findComponent(RoleProfiles).exists()).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    expect(wrapper.get('.section-heading__actions .panel-toolbar').findAll('button').map(row => row.text()))
      .toEqual(['角色权限配置', '创建用户'])
    await button(wrapper, '角色权限配置').trigger('click')
    await flushPromises()
    const dialog = wrapper.findAllComponents(ElDialog).find(row => row.props('title') === '角色权限配置')!
    expect(dialog.props('modelValue')).toBe(true)
    expect(dialog.get('[role="dialog"]').attributes('aria-label')).toBe('角色权限配置')
    expect(dialog.findComponent(RoleProfiles).exists()).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    await button(wrapper, '新增角色').trigger('click')
    const editor = wrapper.findAllComponents(ElDialog).find(row => row.props('title') === '新增自定义角色')!
    expect(editor.props('modelValue')).toBe(true)
    expect(editor.props('appendToBody')).toBe(true)
    editor.vm.$emit('close')
    await flushPromises()
    await button(wrapper, '关闭').trigger('click')
    await flushPromises()
    expect(dialog.props('modelValue')).toBe(false)
    expect(wrapper.findComponent(RoleProfiles).exists()).toBe(false)
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
    await button(wrapper, '角色权限配置').trigger('click')
    await flushPromises()
    expect(dialog.props('modelValue')).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(call => call[1].method === undefined)).toBe(true)
  })
  it('柱状图保持真实零值；雷达图不足三项或无数据不造图', async () => {
    const wrapper = setup(ReportChart, { title: '事件', unit: '次', rows: [{ label: '零', value: 0 }, { label: '三', value: 3 }] })
    expect(wrapper.text()).toContain('0 次')
    expect(wrapper.text()).toContain('3 次')
    await wrapper.setProps({ radar: true })
    expect(wrapper.text()).toContain('暂无数据')
    await wrapper.setProps({ rows: [{ label: 'A', value: 20 }, { label: 'B', value: 40 }, { label: 'C', value: 60 }] })
    expect(wrapper.find('svg[role="img"]').exists()).toBe(true)
    await wrapper.setProps({ rows: [] })
    expect(wrapper.find('svg[role="img"]').exists()).toBe(false)
  })
  it('本地报告时间线只来自文件事件，时间筛选生效且来源更换清除筛选', async () => {
    const wrapper = setup(LocalReportTabs, { evidence: LOCAL_REPORT.localEvidence })
    await flushPromises()
    await wrapper.findAll('.el-tabs__item').find(row => row.text() === '事件时间线')!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.el-timeline-item')).toHaveLength(2)
    wrapper.findAllComponents(ElInputNumber)[0]!.vm.$emit('update:modelValue', 1)
    await flushPromises()
    expect(wrapper.findAll('.el-timeline-item')).toHaveLength(1)
    expect(wrapper.find('.el-timeline').text()).toContain('通信关联登记')
    wrapper.findAllComponents(ElInputNumber)[1]!.vm.$emit('update:modelValue', 0)
    await flushPromises()
    expect(wrapper.text()).toContain('开始时刻不得晚于结束时刻')
    expect(wrapper.findAll('.el-timeline-item')).toHaveLength(0)
    await wrapper.setProps({ evidence: structuredClone(LOCAL_REPORT.localEvidence) })
    expect(wrapper.findAll('.el-timeline-item')).toHaveLength(2)
  })
  it('质量窗口展示当前测量；缺失指标不补零，换来源恢复空态', async () => {
    const links = structuredClone(SITUATION_LINKS_F00042.slice(0, 2))
    links[1]!.ageMs = 2000
    const wrapper = setup(QualityMetricPanel, { links, nodes: links.map(row => row.sourceName), sourceKey: 'A' })
    await flushPromises()
    expect(wrapper.findAll('.el-table__body tbody tr')).toHaveLength(1)
    expect(wrapper.text()).toContain('暂无数据')
    wrapper.findAllComponents(ElSelect)[2]!.vm.$emit('update:modelValue', 5000)
    await flushPromises()
    expect(wrapper.findAll('.el-table__body tbody tr')).toHaveLength(2)
    wrapper.findAllComponents(ElSelect)[1]!.vm.$emit('update:modelValue', links[0]!.linkId)
    await flushPromises()
    expect(wrapper.findAll('.el-table__body tbody tr')).toHaveLength(1)
    await wrapper.setProps({ links: [], sourceKey: 'B' })
    expect(wrapper.findAll('.el-table__body tbody tr')).toHaveLength(0)
    expect(wrapper.text()).toContain('暂无数据')
  })
  it('无质量测量的真实链路保留名称，指标和源时刻显示暂无数据；仍可筛选', async () => {
    const links = [
      { linkId: 'FILE-1', sourceName: '无人机01', destinationName: '后方通信车' },
      { linkId: 'FILE-2', sourceName: '无人机02', destinationName: '神通卫星' },
    ]
    const wrapper = setup(QualityMetricPanel, { links, nodes: ['无人机01', '无人机02'], sourceKey: 'FILE' })
    await flushPromises()
    const rows = () => wrapper.findAll('.el-table__body tbody tr')
    expect(rows()).toHaveLength(2)
    expect(rows()[0]!.findAll('td').map(cell => cell.text())).toEqual([
      '无人机01 → 后方通信车', ...Array(7).fill('暂无数据'),
    ])
    wrapper.findAllComponents(ElSelect)[0]!.vm.$emit('update:modelValue', '无人机02')
    await flushPromises()
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.text()).toContain('神通卫星')
    wrapper.findAllComponents(ElSelect)[2]!.vm.$emit('update:modelValue', 5000)
    await flushPromises()
    expect(rows()).toHaveLength(1)
    await wrapper.setProps({ links: [], sourceKey: 'EMPTY' })
    expect(rows()).toHaveLength(0)
    expect(wrapper.text()).toContain('暂无数据')
  })
  it('质量指标同步外部链路选择，清除冲突节点；手动筛选仍可使用', async () => {
    const links = structuredClone(SITUATION_LINKS_F00042.slice(0, 2))
    const wrapper = setup(QualityMetricPanel, { links, nodes: links.map(row => row.sourceName), sourceKey: 'A', selectedLinkId: links[0]!.linkId })
    await flushPromises()
    const selects = wrapper.findAllComponents(ElSelect)
    expect(selects[1]!.props('modelValue')).toBe(links[0]!.linkId)
    selects[0]!.vm.$emit('update:modelValue', links[0]!.sourceName)
    await wrapper.setProps({ selectedLinkId: links[1]!.linkId })
    expect(selects[0]!.props('modelValue')).toBe('')
    expect(selects[1]!.props('modelValue')).toBe(links[1]!.linkId)
    selects[1]!.vm.$emit('update:modelValue', '')
    await flushPromises()
    expect(selects[1]!.props('modelValue')).toBe('')
    await wrapper.setProps({ selectedLinkId: 'MISSING' })
    expect(selects[1]!.props('modelValue')).toBe('')
  })
  it('引用登记调用正式接口；拒绝另一装备的响应并清除历史', async () => {
    const reference = { equipmentId: EQUIPMENT.equipmentId, equipmentVersion: 1, scenarioId: 'SCN-001', linkId: 'L-MW-01' }
    const fetch = vi.fn().mockResolvedValueOnce(response({ history: [EQUIPMENT], references: [] }))
      .mockResolvedValueOnce(response({ history: [EQUIPMENT], references: [reference] }))
      .mockResolvedValueOnce(response({ history: [{ ...EQUIPMENT, equipmentId: 'OTHER' }], references: [] }))
    vi.stubGlobal('fetch', fetch)
    const wrapper = setup(EquipmentRelations, { equipment: EQUIPMENT })
    await flushPromises()
    await button(wrapper, '登记当前版本引用').trigger('click')
    expect(wrapper.text()).toContain('请填写已有场景编号和链路编号')
    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('SCN-001'); await inputs[1]!.setValue('L-MW-01')
    await button(wrapper, '登记当前版本引用').trigger('click'); await flushPromises()
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ reference, remove: false })
    expect(wrapper.text()).toContain('当前版本')
    await button(wrapper, '重新加载引用与版本').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('装备引用与版本响应不正确')
    expect(wrapper.text()).not.toContain(EQUIPMENT.type)
  })
  it('角色由真实加载、表单编辑与二次确认保存，不预置角色或自动分配', async () => {
    const saved = { version: 2, profiles: [{ profileId: 'READ', name: '只读角色', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] }], assignments: [] }
    const fetch = vi.fn().mockResolvedValueOnce(response({ version: 1, profiles: [], assignments: [] })).mockResolvedValueOnce(response(saved))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const wrapper = setup(RoleProfiles, { users: [] })
    await flushPromises()
    expect(wrapper.text()).toContain('暂无数据')
    await button(wrapper, '新增角色').trigger('click')
    await wrapper.get('input[data-testid="profile-id"]').setValue('READ')
    await wrapper.get('input[data-testid="profile-name"]').setValue('只读角色')
    await button(wrapper, '确认配置').trigger('click')
    expect(fetch).toHaveBeenCalledTimes(1)
    await button(wrapper, '保存权限配置').trigger('click'); await flushPromises()
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ ...saved, version: 1 })
    expect(wrapper.text()).toContain('只读角色')
  })
  it('角色畸形响应显示错误；离页迟到响应不再改变视图或提示成功', async () => {
    let resolve!: (response: Response) => void
    const fetch = vi.fn().mockResolvedValueOnce(response({ version: 1, profiles: [{ profileId: 'INVALID' }], assignments: [] }))
      .mockImplementationOnce(() => new Promise<Response>(done => { resolve = done }))
    vi.stubGlobal('fetch', fetch)
    const wrapper = setup(RoleProfiles, { users: [] })
    await flushPromises()
    expect(wrapper.text()).toContain('角色配置响应不正确')
    await button(wrapper, '重新加载').trigger('click')
    wrapper.unmount()
    resolve(response({ version: 1, profiles: [], assignments: [] }))
    await flushPromises()
    expect(fetch.mock.calls[1]![1].signal.aborted).toBe(true)
  })
})
