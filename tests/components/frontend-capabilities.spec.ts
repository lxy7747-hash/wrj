import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { Component } from 'vue'
import ElementPlus, { ElDialog, ElMessage, ElMessageBox, ElSelect, ElInputNumber } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import LocalReportTabs from '../../src/components/reports/LocalReportTabs.vue'
import ReportChart from '../../src/components/reports/ReportChart.vue'
import QualityMetricPanel from '../../src/components/situation/QualityMetricPanel.vue'
import EquipmentRelations from '../../src/components/admin/EquipmentRelations.vue'
import RoleProfiles from '../../src/components/admin/RoleProfiles.vue'
import AccountManagement from '../../src/components/admin/AccountManagement.vue'
import { useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'
import { SITUATION_LINKS_F00042 } from '../../src/features/situation/situation-model'
import { LOCAL_REPORT } from '../fixtures/local-report'
import { EQUIPMENT } from '../fixtures/equipment'
import { APP_CONFIG } from '../../src/config/app.config'

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
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); ElMessage.closeAll() })
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
  it('负值柱状图以零轴向左延伸，跨零和正值共用数轴', async () => {
    const wrapper = setup(ReportChart, { title: '干扰功率', unit: 'dBm', rows: [{ label: 'A', value: -80 }, { label: 'B', value: -40 }] })
    const widths = () => wrapper.findAll('.bar-track > div').map(bar => (bar.element as HTMLElement).style.width)
    expect(widths()).toEqual(['100%', '50%'])
    expect(wrapper.get('.bar-zero').attributes('style')).toContain('left: 100%')
    await wrapper.setProps({ rows: [{ label: 'A', value: -40 }, { label: 'B', value: 40 }, { label: 'C', value: 0 }] })
    expect(widths()).toEqual(['50%', '50%', '0%'])
    expect(wrapper.findAll('.bar-track > div').map(bar => (bar.element as HTMLElement).style.left)).toEqual(['0%', '50%', '50%'])
    expect(wrapper.get('.bar-zero').attributes('style')).toContain('left: 50%')
    await wrapper.setProps({ rows: [{ label: 'B', value: 40 }] })
    expect(widths()).toEqual(['100%'])
    expect(wrapper.find('.bar-zero').exists()).toBe(false)
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
  it('干信比、时延、可用率无数据显示暂无数据，引擎提供后直接展示', async () => {
    const links = structuredClone(SITUATION_LINKS_F00042.slice(0, 1))
    const wrapper = setup(QualityMetricPanel, { links, nodes: [links[0]!.sourceName], sourceKey: 'A' })
    await flushPromises()
    const cells = () => wrapper.findAll('.el-table__body tbody tr')[0]!.findAll('td').slice(-3).map(cell => cell.text())
    expect(cells()).toEqual(['暂无数据', '暂无数据', '暂无数据'])
    const measured = structuredClone(links)
    measured[0]!.detailed = { ...measured[0]!.detailed!, jsrDb: -4.5, latencyMs: 12.34, availabilityPercent: 99.5 }
    await (wrapper as unknown as { setProps(props: { links: unknown[] }): Promise<void> }).setProps({ links: measured })
    expect(cells()).toEqual(['-4.50', '12.3', '99.5'])
  })
  it('质量指标按链路类型筛选，只列出已出现的体制，换来源重置', async () => {
    const links = [
      { linkId: 'L1', sourceName: 'A', destinationName: 'B', type: 'SAT' as const },
      { linkId: 'L2', sourceName: 'A', destinationName: 'C', type: 'MICROWAVE' as const },
      { linkId: 'L3', sourceName: 'B', destinationName: 'C', type: 'MICROWAVE' as const },
    ]
    const wrapper = setup(QualityMetricPanel, { links, nodes: ['A', 'B', 'C'], sourceKey: 'A' })
    await flushPromises()
    const rows = () => wrapper.findAll('.el-table__body tbody tr')
    const typeSelect = wrapper.findAllComponents(ElSelect)[3]!
    expect(typeSelect.findAllComponents({ name: 'ElOption' }).map(option => option.props('label'))).toEqual(['卫星链路', '微波链路'])
    typeSelect.vm.$emit('update:modelValue', 'MICROWAVE')
    await flushPromises()
    expect(rows()).toHaveLength(2)
    wrapper.findAllComponents(ElSelect)[0]!.vm.$emit('update:modelValue', 'B')
    await flushPromises()
    expect(rows()).toHaveLength(1)
    await wrapper.setProps({ sourceKey: 'B' })
    expect(typeSelect.props('modelValue')).toBe('')
    expect(rows()).toHaveLength(3)
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
      '无人机01 → 后方通信车', ...Array(8).fill('暂无数据'),
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
  it('引用登记调用当前服务接口；拒绝另一装备的响应并清除历史', async () => {
    const reference = { equipmentId: EQUIPMENT.equipmentId, equipmentVersion: 1, scenarioId: 'SCN-001', linkId: 'L-MW-01' }
    const details = [response({ history: [EQUIPMENT], references: [] }), response({ history: [EQUIPMENT], references: [reference] }),
      response({ history: [{ ...EQUIPMENT, equipmentId: 'OTHER' }], references: [] })]
    // 场景列表读取失败时回退为手工输入编号。
    const fetch = vi.fn((url: string) => Promise.resolve(String(url).endsWith('/api/v1/scenarios') ? new Response('{}', { status: 503 }) : details.shift()!))
    vi.stubGlobal('fetch', fetch)
    const wrapper = setup(EquipmentRelations, { equipment: EQUIPMENT })
    await flushPromises()
    await button(wrapper, '登记当前版本引用').trigger('click')
    expect(wrapper.text()).toContain('请填写已有场景编号和链路编号')
    const inputs = wrapper.findAll('input')
    await inputs[0]!.setValue('SCN-001'); await inputs[1]!.setValue('L-MW-01')
    await button(wrapper, '登记当前版本引用').trigger('click'); await flushPromises()
    const put = fetch.mock.calls.find(call => (call as unknown as [string, RequestInit])[1]?.method === 'PUT') as unknown as [string, RequestInit]
    expect(JSON.parse(String(put[1].body))).toEqual({ reference, remove: false })
    const expectedOrigin = 'http://127.0.0.1:4173'
    expect(fetch.mock.calls.every(([url]) => url.startsWith(`${expectedOrigin}/api/`))).toBe(true)
    expect(wrapper.text()).toContain('当前版本')
    await button(wrapper, '重新加载引用与版本').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('装备引用与版本响应不正确')
    expect(wrapper.text()).not.toContain(EQUIPMENT.type)
  })
  it('停用装备保留历史展示但禁用新引用登记', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ history: [{ ...EQUIPMENT, active: false }], references: [] }))
    vi.stubGlobal('fetch', fetch)
    const wrapper = setup(EquipmentRelations, { equipment: { ...EQUIPMENT, active: false } })
    await flushPromises()
    const register = button(wrapper, '登记当前版本引用')
    expect(register.attributes('disabled')).toBeDefined()
    await register.trigger('click')
    expect(fetch.mock.calls.filter(call => (call as unknown as [string, RequestInit])[1]?.method === 'PUT')).toHaveLength(0)
  })
  it('从已保存场景选择链路登记引用，标出频率不在装备范围的链路', async () => {
    const scene = { config: { scenario: { id: 'SCN-001', name: '演示场景' }, links: [
      { id: 'L-MW-01', type: 'MICROWAVE', frequency: EQUIPMENT.frequencyMinMHz },
      { id: 'L-OUT', type: 'MICROWAVE', frequency: 1 },
    ] }, locked: false }
    const fetch = vi.fn((url: string) => Promise.resolve(String(url).endsWith('/api/v1/scenarios') ? response([scene]) : response({ history: [EQUIPMENT], references: [] })))
    vi.stubGlobal('fetch', fetch)
    const wrapper = setup(EquipmentRelations, { equipment: EQUIPMENT })
    await flushPromises()
    const selects = wrapper.findAllComponents(ElSelect)
    expect(selects).toHaveLength(2)
    selects[0]!.vm.$emit('update:modelValue', 'SCN-001')
    await flushPromises()
    const options = selects[1]!.findAllComponents({ name: 'ElOption' }).map(option => String(option.props('label')))
    expect(options[0]).not.toContain('不在装备范围')
    expect(options[1]).toContain('不在装备范围')
    selects[1]!.vm.$emit('update:modelValue', 'L-MW-01')
    await flushPromises()
    await button(wrapper, '登记当前版本引用').trigger('click'); await flushPromises()
    const put = fetch.mock.calls.find(call => (call as unknown as [string, RequestInit])[1]?.method === 'PUT') as unknown as [string, RequestInit]
    expect(JSON.parse(String(put[1].body)).reference).toMatchObject({ scenarioId: 'SCN-001', linkId: 'L-MW-01' })
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
  it.each([true, false])('备份入口开启=%s 时管理员菜单遵循配置，操作员不获得管理员菜单', async enabled => {
    // 只验证备份开关，其余系统管理入口固定为关闭，避免受默认配置影响。
    const others = { ...APP_CONFIG.systemManagement }
    Object.assign(APP_CONFIG.systemManagement, { showMasterData: false, showSimulationData: false, showRuntimeStatus: false, showDataExchange: false })
    onTestFinished(() => { Object.assign(APP_CONFIG.systemManagement, others) })
    const original = APP_CONFIG.systemManagement.showDatabaseBackup
    APP_CONFIG.systemManagement.showDatabaseBackup = enabled
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ version: 1, profiles: [], assignments: [] })))
      const wrapper = setup(RoleProfiles, { users: [] })
      await flushPromises()
      await button(wrapper, '新增角色').trigger('click')
      const base = wrapper.findComponent(ElSelect)
      base.vm.$emit('update:modelValue', 'ADMIN')
      base.vm.$emit('change', 'ADMIN')
      await flushPromises()
      const choices = () => wrapper.get('[aria-label="菜单权限"]').findAllComponents({ name: 'ElCheckbox' })
        .filter((row: VueWrapper<{ $props: { value: string } }>) => row.props('value').startsWith('/admin'))
      const adminMenus = ['账号管理', '场景模板维护', '操作审计日志', ...(enabled ? ['备份恢复'] : [])]
      expect(choices().map((row: VueWrapper) => row.text())).toEqual(adminMenus)
      expect(wrapper.get('[aria-label="菜单权限"]').findAll('label').map(row => row.text()))
        .toEqual(['态势主界面', '场景配置', '评估报表', '历史回放', '感知、干扰与选路', ...adminMenus])
      base.vm.$emit('update:modelValue', 'OPERATOR')
      base.vm.$emit('change', 'OPERATOR')
      await flushPromises()
      expect(choices()).toHaveLength(0)
      expect(wrapper.get('[aria-label="菜单权限"]').findAll('label').map(row => row.text()))
        .toEqual(['态势主界面', '场景配置', '评估报表', '历史回放', '感知、干扰与选路'])
    } finally { APP_CONFIG.systemManagement.showDatabaseBackup = original }
  })
  it('角色菜单中的评估报表跟随主导航显隐配置', async () => {
    const original = APP_CONFIG.showReports
    try {
      APP_CONFIG.showReports = false
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ version: 1, profiles: [], assignments: [] })))
      const wrapper = setup(RoleProfiles, { users: [] })
      await flushPromises()
      await button(wrapper, '新增角色').trigger('click')
      expect(wrapper.get('[aria-label="菜单权限"]').findAll('label').map(row => row.text()))
        .toEqual(['态势主界面', '场景配置', '历史回放', '感知、干扰与选路', ...(APP_CONFIG.systemManagement.showDataExchange ? ['数据交换与接口'] : [])])
    } finally { APP_CONFIG.showReports = original }
  })
  it.each([
    ['showMasterData', '/admin?section=master-data'],
    ['showDatabaseBackup', '/admin?section=database-backup'],
    ['showSimulationData', '/admin?section=simulation-data'],
    ['showRuntimeStatus', '/admin?section=runtime-status'],
    ['showDataExchange', '/admin/data-exchange'],
  ] as const)('角色菜单跟随 %s 开关，而非永久删除合同选项', async (flag, path) => {
    const original = APP_CONFIG.systemManagement[flag]
    try {
      APP_CONFIG.systemManagement[flag] = true
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ version: 1, profiles: [], assignments: [] })))
      const wrapper = setup(RoleProfiles, { users: [] })
      await flushPromises()
      await button(wrapper, '新增角色').trigger('click')
      const base = wrapper.findComponent(ElSelect)
      base.vm.$emit('update:modelValue', 'ADMIN')
      base.vm.$emit('change', 'ADMIN')
      await flushPromises()
      const choices = wrapper.get('[aria-label="菜单权限"]').findAllComponents({ name: 'ElCheckbox' })
      expect(choices.some((row: VueWrapper<{ $props: { value: string } }>) => row.props('value') === path)).toBe(true)
      if (flag === 'showMasterData') expect(choices.some((row: VueWrapper<{ $props: { value: string } }>) => row.props('value') === '/admin?section=equipment-library')).toBe(true)
    } finally { APP_CONFIG.systemManagement[flag] = original }
  })
  it('编辑并保存旧角色时保留未显示的菜单授权，不静默修改既有权限', async () => {
    const original = { ...APP_CONFIG.systemManagement }
    Object.assign(APP_CONFIG.systemManagement, { showMasterData: false, showDataExchange: false })
    onTestFinished(() => { Object.assign(APP_CONFIG.systemManagement, original) })
    const profile = { profileId: 'CUSTOM', name: '旧角色', baseRole: 'ADMIN', permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'], menuPaths: ['/admin', '/admin?section=master-data', '/admin/data-exchange', '/blueprint', '/interactions', '/traceability'] }
    const config = { version: 1, profiles: [profile], assignments: [] }
    const fetch = vi.fn().mockResolvedValueOnce(response(config)).mockImplementationOnce((_url, init) => Promise.resolve(response(JSON.parse(init.body))))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const wrapper = setup(RoleProfiles, { users: [] })
    await flushPromises()
    await button(wrapper, '编辑').trigger('click')
    const menus = wrapper.get('[aria-label="菜单权限"]')
    expect(menus.text()).not.toContain('基础数据管理')
    expect(menus.text()).not.toContain('数据交换与接口')
    expect(menus.text()).toContain('感知、干扰与选路')
    for (const hiddenLabel of ['批量仿真', '能力蓝图', '需求追踪']) {
      expect(menus.text()).not.toContain(hiddenLabel)
    }
    await wrapper.get('[data-testid="profile-name"]').setValue('修改名称')
    await button(wrapper, '确认配置').trigger('click')
    await button(wrapper, '保存权限配置').trigger('click')
    await flushPromises()
    expect(JSON.parse(fetch.mock.calls[1]![1].body).profiles[0]).toEqual({ ...profile, name: '修改名称' })
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
