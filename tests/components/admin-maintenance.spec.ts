import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import MasterDataPanel from '../../src/components/admin/MasterDataPanel.vue'
import BackupRestoreWizard from '../../src/components/admin/BackupRestoreWizard.vue'
import ScenarioConfigExport from '../../src/components/scenarios/ScenarioConfigExport.vue'
import { useAdminStore } from '../../src/stores/admin'
import { useAuthStore } from '../../src/stores/auth'

let wrapper: VueWrapper | undefined

/** 根据中文按钮文字操作当前面板，避免依赖布局顺序。 */
async function selectBackupRow(backupId: string): Promise<void> {
  const row = wrapper!.findAll('[data-testid="backup-table"] .el-table__row').find((item) => item.text().includes(backupId))
  const button = row?.findAll('button').find((item) => item.text() === '选择恢复')
  expect(button).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}

async function click(text: string): Promise<void> {
  const button = wrapper!.findAll('button').find((item) => item.text() === text)
  expect(button).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}

function selectByAria(label: string) {
  const control = wrapper!.findAllComponents({ name: 'ElSelect' })
    .find((component) => component.find(`input[aria-label="${label}"]`).exists())
  expect(control, `缺少 ${label} 选择框`).toBeDefined()
  return control!
}

async function selectValue(label: string, value: string): Promise<void> {
  selectByAria(label).vm.$emit('update:modelValue', value)
  await flushPromises()
}

describe('P7 系统管理面板', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.spyOn(useAdminStore(), 'loadMaintenance').mockResolvedValue(true)
    vi.spyOn(useAdminStore(), 'loadBackupPlan').mockResolvedValue(true)
  })
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; ElMessage.closeAll(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('旧通用记录保留读取，设备字段提示归属并禁止保存，手动整理为公共字段后恢复保存', async () => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    const legacy = { dataId: 'LEGACY-EQUIPMENT-DEFAULT', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '旧参数', description: '', entries: [{ key: 'bandwidthMHz', valueType: 'NUMBER' as const, value: 5, unit: 'MHz' }] } }
    const updated = { ...legacy, version: 2, content: { ...legacy.content, entries: [{ key: 'noiseFigureDb', valueType: 'NUMBER' as const, value: 5, unit: 'dB' }] } }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-OWNERSHIP', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: 1 },
    }) }) as Response
    const fetchMock = vi.fn().mockResolvedValueOnce(response([legacy])).mockResolvedValueOnce(response(updated))
    vi.stubGlobal('fetch', fetchMock)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('编辑')
    expect(wrapper.get('[data-testid="master-equipment-field-warning"]').text()).toContain('bandwidthMHz 属于设备固有参数')
    expect(wrapper.get('[data-testid="master-save"]').attributes('disabled')).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await selectValue('参数键', 'noiseFigureDb')
    expect(wrapper.find('[data-testid="master-equipment-field-warning"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="master-save"]').attributes('disabled')).toBeUndefined()
    expect(legacy.content.entries[0]!.key).toBe('bandwidthMHz')
    const parameterValue = wrapper.findAllComponents({ name: 'ElInputNumber' }).find(component => component.find('input[aria-label="参数值"]').exists())
    parameterValue!.vm.$emit('update:modelValue', 5)
    await flushPromises()
    await click('保存')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(store.masterData).toEqual([updated])
  })

  it.each([true, false])('通用数据保存与删除通过真实 Store 反馈，成功=%s', async success => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    const master = { dataId: 'DICT-FEEDBACK', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '反馈字典', description: '', entries: [{ key: 'sample', valueType: 'TEXT' as const, value: 'value' }] } }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-FEEDBACK', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: 1 },
    }) }) as Response
    const context = { confirmationId: 'CONF-MASTER', actor: 'admin', role: 'ADMIN', createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z' }
    const fetchMock = vi.fn().mockResolvedValueOnce(response([master]))
      .mockResolvedValueOnce(response(success ? { ...master, version: 2 } : {}))
      .mockResolvedValueOnce(response({ ...context, state: 'AWAITING_CONFIRMATION' }))
      .mockResolvedValueOnce(response({ ...context, state: 'CONFIRMED' }))
      .mockResolvedValueOnce(response({ deleted: success, objectId: master.dataId }))
      .mockResolvedValueOnce(response([]))
    vi.stubGlobal('fetch', fetchMock)
    const message = vi.spyOn(ElMessage, 'success')
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.attributes('aria-label')).toBe('基础数据管理')
    expect(wrapper.get('h3').text()).toBe('基础数据管理')
    expect(wrapper.get('header.maintenance-toolbar').text()).not.toContain('已完成')
    expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
    expect(message).not.toHaveBeenCalled()
    await click('编辑')
    await click('保存')
    if (success) {
      expect(message).toHaveBeenCalledTimes(1)
      expect(message).toHaveBeenLastCalledWith('通用数据已保存。')
      expect(wrapper.get('header.maintenance-toolbar').text()).not.toContain('已完成')
      expect(store.maintenance.master).toMatchObject({ state: 'SUCCESS', message: '' })
      expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
    } else {
      expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="master-editor-feedback"]').text()).toContain('保存结果与当前通用数据不一致。')
      expect(message).not.toHaveBeenCalled()
      await click('取消')
    }
    await click('删除')
    if (success) {
      expect(message).toHaveBeenCalledTimes(2)
      expect(message).toHaveBeenLastCalledWith('通用数据已删除。')
      expect(store.maintenance.master).toMatchObject({ state: 'SUCCESS', message: '' })
      expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
      expect(store.masterData).toEqual([])
    } else {
      expect(wrapper.get('[data-testid="master-feedback"]').text()).toContain('删除结果与当前对象不一致。')
      expect(message).not.toHaveBeenCalled()
      expect(store.masterData).toEqual([master])
    }
    await click('刷新')
    expect(wrapper.get('[data-testid="master-feedback"]').text()).toBe('暂无记录。')
    expect(message).toHaveBeenCalledTimes(success ? 2 : 0)
  })

  it('通用数据空消息不渲染空白提示条', async () => {
    useAdminStore().maintenance.master = { state: 'EMPTY', message: '', fieldPath: '' }
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
  })

  it('不显示解释及填写规则，新增校验失败仍在弹框定位字段且不发保存请求', async () => {
    useAuthStore().role = 'ADMIN'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('新增通用数据')
    await click('保存')
    const message = '编号不能为空或全是空格。'
    expect(wrapper.get('[data-testid="master-editor-feedback"]').text()).toBe(message)
    expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
    expect(wrapper.findAll('.el-alert').filter(alert => alert.text() === message)).toHaveLength(1)
    expect(wrapper.get('.master-field-help').text()).toContain('不能为 . 或 ..')
    expect(wrapper.find('.master-entry-help').exists()).toBe(false)
    expect(wrapper.find('.master-entries > .maintenance-note').exists()).toBe(false)
    await wrapper.get('[data-testid="master-id"]').setValue('DICT-VALIDATION')
    await click('保存')
    expect(wrapper.get('[data-testid="master-editor-feedback"]').text()).toBe('名称不能为空或全是空格。')
    await wrapper.get('[data-testid="master-name"]').setValue('公共接收参数')
    await click('保存')
    expect(wrapper.get('[data-testid="master-editor-feedback"]').text()).toBe('参数条目不能为空，请至少新增并填写一条参数。')
    await click('新增条目')
    await click('保存')
    expect(wrapper.get('[data-testid="master-editor-feedback"]').text()).toBe('第 1 条参数：参数键不能为空。')
    await selectValue('参数键', 'noiseFigureDb')
    await click('保存')
    expect(wrapper.get('[data-testid="master-editor-feedback"]').text()).toBe('第 1 条参数：数值不能为空，且必须为有效的整数或小数。')
    expect(wrapper.find('[data-testid="master-feedback"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="master-editor-feedback"]')).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { section: 'master', component: MasterDataPanel, data: fixtures.masterData, content: 'MW-COMM', refresh: '刷新' },
    { section: 'backup', component: BackupRestoreWizard, data: fixtures.backups, content: 'PREBACKUP-002', refresh: '刷新记录' },
  ] as const)('$section 加载成功不显示常驻提示，加载中和失败仍可见', async ({ section, component, data, content, refresh }) => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    let resolveLoad!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveLoad = resolve }))
      .mockRejectedValueOnce(new Error('offline')))
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/admin')
    wrapper = mount(component, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    expect(wrapper.get(`[data-testid="${section}-feedback"]`).text()).toContain('正在加载数据。')
    resolveLoad({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-MAINTENANCE', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: Array.isArray(data) ? data.length : 1 },
    }) } as Response)
    await flushPromises()
    expect(store.maintenance[section].state).toBe('SUCCESS')
    expect(store.maintenance[section].message).toBe('')
    expect(wrapper.find(`[data-testid="${section}-feedback"]`).exists()).toBe(false)
    expect(wrapper.get(`[data-testid="${section}-table"]`).text()).toContain(content)
    await click(refresh)
    expect(store.maintenance[section].state).toBe('ERROR')
    expect(wrapper.get(`[data-testid="${section}-feedback"]`).text()).toContain('系统管理服务暂时不可用，请稍后重试。')
  })

  it('通用数据列表筛选、内容编辑、新增与删除确认复用既有组件', async () => {
    const store = useAdminStore()
    const writable = { dataId: 'DICT-UI', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: false,
      content: { name: '界面参数', description: '', entries: [{ key: 'sample', valueType: 'TEXT' as const, value: 'value' }] } }
    store.masterData = [writable]
    const save = vi.spyOn(store, 'saveMasterData').mockResolvedValueOnce(false).mockResolvedValue(true)
    const run = vi.spyOn(store, 'runMaintenanceAction').mockResolvedValue(true)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(wrapper.text()).toContain('DICT-UI')
    await wrapper.get('input[aria-label="通用数据检索"]').setValue('missing')
    expect(wrapper.text()).toContain('暂无匹配的通用数据')
    await wrapper.get('input[aria-label="通用数据检索"]').setValue('')
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'DEVICE')
    await flushPromises()
    expect(wrapper.text()).toContain('暂无匹配的通用数据')
    wrapper.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', '')
    await flushPromises()
    await click('编辑')
    expect(wrapper.get('[data-testid="master-id"]').attributes('disabled')).toBeDefined()
    expect(wrapper.findComponent({ name: 'ElSwitch' }).props('modelValue')).toBe(false)
    await click('保存')
    expect(save).toHaveBeenLastCalledWith(writable, false)
    await click('取消')
    await click('新增通用数据')
    expect(wrapper.get('.master-editor-basics').findAll('.el-form-item__label').map(label => label.text())).toEqual(['编号', '类型', '名称'])
    expect(wrapper.findComponent({ name: 'ElSwitch' }).exists()).toBe(false)
    await wrapper.get('[data-testid="master-id"]').setValue(' DEVICE-P7 ')
    await wrapper.get('[data-testid="master-name"]').setValue('新增字典')
    await click('新增条目')
    await selectValue('参数键', 'noiseFigureDb')
    await click('保存')
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ dataId: 'DEVICE-P7', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true, content: expect.objectContaining({ name: '新增字典' }) }), true)
    await click('删除')
    expect(run).not.toHaveBeenCalled()
    await click('删除')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledWith('DELETE', 'DICT-UI')
    await click('刷新')
    expect(store.loadMaintenance).toHaveBeenCalledWith('master')
  })

  it('体制参数、参数字典及枚举独立显示与筛选，编辑保留原分类、说明和引用', async () => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    const communication = { dataId: 'COMM-LEGACY', kind: 'COMMUNICATION_SYSTEM' as const, version: 1, referenceCount: 1, active: true,
      content: { name: '旧通信体制', description: '保留已有说明。', entries: [{ key: 'noiseFigureDb', valueType: 'NUMBER' as const, value: 3, unit: 'dB' }] } }
    const dictionary = { dataId: 'DICT-PUBLIC', kind: 'PARAMETER_DICTIONARY' as const, version: 1, referenceCount: 0, active: true,
      content: { name: '公共参数字典', description: '', entries: [{ key: 'rxBandwidthMHz', valueType: 'NUMBER' as const, value: 10, unit: 'MHz' }] } }
    const enumeration = { dataId: 'ENUM-MODULATION', kind: 'ENUMERATION' as const, version: 1, referenceCount: 0, active: true,
      content: { name: '调制枚举', description: '', entries: [{ key: 'modulation.QPSK', valueType: 'TEXT' as const, value: 'QPSK' }] } }
    const updated = { ...communication, version: 2, content: { ...communication.content, name: '更新后的通信体制' } }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-PUBLIC-KIND', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: 3 },
    }) }) as Response
    const fetchMock = vi.fn().mockResolvedValueOnce(response([communication, dictionary, enumeration])).mockResolvedValueOnce(response(updated))
    vi.stubGlobal('fetch', fetchMock)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    const table = wrapper.get('[data-testid="master-table"]')
    expect(table.text()).toContain('COMM-LEGACY')
    expect(table.text()).toContain('DICT-PUBLIC')
    expect(table.text()).toContain('体制参数')
    expect(table.text()).toContain('参数字典')
    expect(table.text()).not.toContain('公共链路参数')
    await selectValue('通用数据类型筛选', 'COMMUNICATION_SYSTEM')
    expect(table.text()).toContain('COMM-LEGACY')
    expect(table.text()).not.toContain('DICT-PUBLIC')
    expect(table.text()).not.toContain('ENUM-MODULATION')
    await selectValue('通用数据类型筛选', 'PARAMETER_DICTIONARY')
    expect(table.text()).toContain('DICT-PUBLIC')
    expect(table.text()).not.toContain('COMM-LEGACY')
    expect(table.text()).not.toContain('ENUM-MODULATION')
    await selectValue('通用数据类型筛选', 'ENUMERATION')
    expect(table.text()).toContain('ENUM-MODULATION')
    expect(table.text()).not.toContain('COMM-LEGACY')
    expect(table.text()).not.toContain('DICT-PUBLIC')
    await selectValue('通用数据类型筛选', '')
    await click('编辑')
    const basics = wrapper.get('.master-editor-basics')
    expect(basics.findAll('.el-form-item__label').map(label => label.text())).toEqual(['编号', '类型', '名称', '状态'])
    expect(basics.find('textarea').exists()).toBe(false)
    expect(basics.find('.el-descriptions').exists()).toBe(false)
    await wrapper.get('[data-testid="master-name"]').setValue('更新后的通信体制')
    await click('保存')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).data).toMatchObject({ dataId: 'COMM-LEGACY', kind: 'COMMUNICATION_SYSTEM', version: 1, referenceCount: 1, content: { description: '保留已有说明。' } })
    expect(store.masterData.find(item => item.dataId === 'COMM-LEGACY')).toMatchObject({ kind: 'COMMUNICATION_SYSTEM', version: 2 })
  })

  it('参数字典从中文字段选择，自动带出类型和单位；换字段后必须重新填写数值', async () => {
    const store = useAdminStore()
    useAuthStore().role = 'ADMIN'
    const source = { dataId: 'DICT-PARAMETER-FORMAT', kind: 'PARAMETER_DICTIONARY' as const, version: 1, referenceCount: 0, active: true,
      content: { name: '接收参数', description: '', entries: [{ key: 'noiseFigureDb', valueType: 'NUMBER' as const, value: 5, unit: 'dB', minimum: 0, maximum: 10 }] } }
    store.masterData = [structuredClone(source)]
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('编辑')
    expect(selectByAria('参数键').props('modelValue')).toBe('noiseFigureDb')
    await selectValue('参数键', 'rxAntennaGainDbi')
    const parameterValue = wrapper.findAllComponents({ name: 'ElInputNumber' }).find(component => component.find('input[aria-label="参数值"]').exists())
    expect(parameterValue).toBeDefined()
    expect(parameterValue!.props('modelValue')).toBeUndefined()
    expect((wrapper.get('input[placeholder="单位（可选）"]').element as HTMLInputElement).value).toBe('dBi')
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' })).toHaveLength(3)
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' }).slice(1).every(component => component.props('modelValue') === undefined)).toBe(true)
    await click('保存')
    expect(wrapper.get('[data-testid="master-editor-feedback"]').text()).toBe('第 1 条参数：数值不能为空，且必须为有效的整数或小数。')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.masterData).toEqual([source])
    await click('取消')
    expect(store.masterData).toEqual([source])
  })

  it('切换类型只提供所属字段，不匹配的原有条目保留回显且不能再次选入', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('新增通用数据')
    await click('新增条目')
    const enabledKeys = () => selectByAria('参数键').findAllComponents({ name: 'ElOption' })
      .filter(option => !option.props('disabled')).map(option => option.props('value'))
    expect(enabledKeys()).toEqual(['txAntennaGainDbi', 'rxAntennaGainDbi', 'antennaGainCorrectionDb', 'noiseFigureDb'])
    await selectValue('参数键', 'frequencyMHz')
    expect(selectByAria('参数键').props('modelValue')).toBe('')
    await selectValue('参数键', 'noiseFigureDb')
    wrapper.findAllComponents({ name: 'ElInputNumber' })[0]!.vm.$emit('update:modelValue', 5)
    await selectValue('编辑通用数据类型', 'COMMUNICATION_SYSTEM')
    expect(enabledKeys()).toEqual(['frequencyMHz', 'rxFrequencyMHz', 'rxBandwidthMHz'])
    expect(selectByAria('参数键').props('modelValue')).toBe('noiseFigureDb')
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' })[0]!.props('modelValue')).toBe(5)
    const oldOption = selectByAria('参数键').findAllComponents({ name: 'ElOption' }).find(option => option.props('value') === 'noiseFigureDb')
    expect(oldOption?.props('disabled')).toBe(true)
    expect(oldOption?.props('label')).toBe('接收机噪声系数（原有字段）')
    await selectValue('参数键', 'frequencyMHz')
    expect(selectByAria('参数键').props('modelValue')).toBe('frequencyMHz')
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' })[0]!.props('modelValue')).toBeUndefined()
    await selectValue('编辑通用数据类型', 'PARAMETER_DICTIONARY')
    expect(enabledKeys()).toEqual(['txAntennaGainDbi', 'rxAntennaGainDbi', 'antennaGainCorrectionDb', 'noiseFigureDb'])
    expect(selectByAria('参数键').props('modelValue')).toBe('frequencyMHz')
    expect(fetchMock).not.toHaveBeenCalled()
    await click('取消')
  })

  it.each([
    { kind: 'COMMUNICATION_SYSTEM', keys: ['frequencyMHz', 'rxFrequencyMHz', 'rxBandwidthMHz'] },
    { kind: 'PARAMETER_DICTIONARY', keys: ['txAntennaGainDbi', 'rxAntennaGainDbi', 'antennaGainCorrectionDb', 'noiseFigureDb'] },
  ])('$kind 已选字段在其他条目中置灰，全部选完不能新增，移除后恢复可选', async ({ kind, keys }) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('新增通用数据')
    await selectValue('编辑通用数据类型', kind)
    await click('新增条目')
    await selectValue('参数键', keys[0]!)
    wrapper.findAllComponents({ name: 'ElInputNumber' })[0]!.vm.$emit('update:modelValue', 5)
    await click('新增条目')
    const selects = () => wrapper!.findAllComponents({ name: 'ElSelect' }).filter(component => component.find('input[aria-label="参数键"]').exists())
    const option = (index: number, key: string) => selects()[index]!.findAllComponents({ name: 'ElOption' }).find(item => item.props('value') === key)!
    expect(option(0, keys[0]!).props('disabled')).toBe(false)
    expect(option(1, keys[0]!).props('disabled')).toBe(true)
    selects()[1]!.vm.$emit('update:modelValue', keys[0])
    await flushPromises()
    expect(selects()[1]!.props('modelValue')).toBe('')
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' })[0]!.props('modelValue')).toBe(5)
    for (let index = 1; index < keys.length; index++) {
      if (index > 1) await click('新增条目')
      selects()[index]!.vm.$emit('update:modelValue', keys[index])
      await flushPromises()
    }
    const addButton = wrapper.findAllComponents({ name: 'ElButton' }).find(button => button.text() === '新增条目')!
    expect(addButton.props('disabled')).toBe(true)
    addButton.vm.$emit('click', new MouseEvent('click'))
    await flushPromises()
    expect(selects()).toHaveLength(keys.length)
    await wrapper.findAll('.master-entry')[0]!.get('button').trigger('click')
    await flushPromises()
    expect(addButton.props('disabled')).toBe(false)
    expect(option(0, keys[0]!).props('disabled')).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    await click('取消')
  })

  it('旧别名和未知参数原样回显，取消编辑不会改写其类型、单位、数值、边界或引用历史', async () => {
    const store = useAdminStore()
    const source = { dataId: 'COMM-ALIASES', kind: 'COMMUNICATION_SYSTEM' as const, version: 4, referenceCount: 1, active: true,
      content: { name: '历史通信参数', description: '', entries: [
        { key: 'rxFrequency', valueType: 'NUMBER' as const, value: 2200, unit: 'MHz', minimum: 2000, maximum: 2400 },
        { key: 'rxBandwidth', valueType: 'NUMBER' as const, value: 15 },
        { key: 'legacyText', valueType: 'TEXT' as const, value: '保留原文本' },
        { key: 'legacySwitch', valueType: 'BOOLEAN' as const, value: true },
      ] } }
    store.masterData = [structuredClone(source)]
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('编辑')
    const keys = wrapper.findAllComponents({ name: 'ElSelect' }).filter(component => component.find('input[aria-label="参数键"]').exists())
    expect(keys).toHaveLength(4)
    expect(keys.map(component => component.props('modelValue'))).toEqual(['rxFrequency', 'rxBandwidth', 'legacyText', 'legacySwitch'])
    const types = wrapper.findAllComponents({ name: 'ElSelect' }).filter(component => component.find('input[aria-label="参数值类型"]').exists())
    expect(types.map(component => component.props('modelValue'))).toEqual(['NUMBER', 'NUMBER', 'TEXT', 'BOOLEAN'])
    const units = wrapper.findAll('input[placeholder="单位（可选）"]')
    expect((units[0]!.element as HTMLInputElement).value).toBe('MHz')
    expect((units[1]!.element as HTMLInputElement).value).toBe('')
    await click('新增条目')
    const added = wrapper.findAllComponents({ name: 'ElSelect' }).filter(component => component.find('input[aria-label="参数键"]').exists()).at(-1)!
    for (const key of ['rxFrequencyMHz', 'rxBandwidthMHz']) {
      expect(added.findAllComponents({ name: 'ElOption' }).find(option => option.props('value') === key)!.props('disabled')).toBe(true)
    }
    added.vm.$emit('update:modelValue', 'rxFrequencyMHz')
    await flushPromises()
    expect(added.props('modelValue')).toBe('')
    await click('取消')
    expect(store.masterData).toEqual([source])
  })

  it('通用数据编辑副本支持数值和布尔条目切换，取消不污染原记录', async () => {
    const store = useAdminStore()
    const source = { dataId: 'DICT-TYPES', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '类型测试', description: '', entries: [{ key: 'enabled', valueType: 'TEXT' as const, value: 'original' }] } }
    store.masterData = [structuredClone(source)]
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('编辑')
    const valueType = wrapper.findAllComponents({ name: 'ElSelect' }).find((component) => component.find('input[aria-label="参数值类型"]').exists())
    expect(valueType).toBeDefined()
    valueType!.vm.$emit('update:modelValue', 'NUMBER')
    await flushPromises()
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' }).length).toBeGreaterThan(0)
    valueType!.vm.$emit('update:modelValue', 'BOOLEAN')
    await flushPromises()
    expect(wrapper.text()).toContain('是')
    await click('取消')
    expect(store.masterData).toEqual([source])
  })

  it('通用数据内容编辑支持文本、数值范围、布尔值和移除条目，数值清空不能保存', async () => {
    const store = useAdminStore()
    useAuthStore().role = 'ADMIN'
    const source = { dataId: 'DICT-ENTRY', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '条目字典', description: '', entries: [{ key: 'mode', valueType: 'TEXT' as const, value: 'original' }] } }
    store.masterData = [structuredClone(source)]
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('编辑')
    const typeSelectors = wrapper.findAllComponents({ name: 'ElSelect' }).filter((component) => component.find('input[aria-label="参数值类型"]').exists())
    typeSelectors[0]!.vm.$emit('update:modelValue', 'NUMBER')
    await flushPromises()
    const numbers = wrapper.findAllComponents({ name: 'ElInputNumber' })
    numbers[0]!.vm.$emit('update:modelValue', 3)
    numbers[1]!.vm.$emit('update:modelValue', 0)
    numbers[2]!.vm.$emit('update:modelValue', 10)
    await wrapper.get('input[placeholder="单位（可选）"]').setValue('次')
    await flushPromises()
    numbers[0]!.vm.$emit('update:modelValue', undefined)
    await click('保存')
    expect(store.maintenance.master.state).toBe('ERROR')
    expect(fetchMock).not.toHaveBeenCalled()
    typeSelectors[0]!.vm.$emit('update:modelValue', 'BOOLEAN')
    await flushPromises()
    wrapper.findAllComponents({ name: 'ElSwitch' })[0]!.vm.$emit('update:modelValue', true)
    await click('移除')
    expect(wrapper.findAllComponents({ name: 'ElSelect' }).filter(component => component.find('input[aria-label="参数键"]').exists())).toHaveLength(0)
    await click('取消')
    expect(store.masterData).toEqual([source])
  })

  it('通用数据详情显示实际历史和引用，确认后才登记并更新引用数量', async () => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    const master = { dataId: 'DICT-DETAIL', kind: 'PARAMETER_DICTIONARY', version: 2, referenceCount: 0, active: true,
      content: { name: '版本字典', description: '当前版本。', entries: [{ key: 'mode', valueType: 'TEXT' as const, value: 'current' }] } }
    const historical = { ...master, version: 1, content: { ...master.content, description: '历史版本。', entries: [{ key: 'mode', valueType: 'TEXT' as const, value: 'history' }] } }
    const target = { targetType: 'SCENARIO' as const, targetId: 'SCN-DETAIL', targetVersion: '7', name: '详情场景' }
    const reference = { dataId: master.dataId, dataVersion: 1, targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }
    const registered = { dataId: master.dataId, history: [{ ...master, referenceCount: 1 }, historical], references: [reference] }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-MASTER-DETAIL', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: Array.isArray(data) ? data.length : 1 },
    }) }) as Response
    const fetchMock = vi.fn().mockResolvedValueOnce(response([master])).mockResolvedValueOnce(response({ dataId: master.dataId, history: [master, historical], references: [] }))
      .mockResolvedValueOnce(response([target])).mockResolvedValueOnce(response(registered))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValueOnce('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const message = vi.spyOn(ElMessage, 'success')
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('查看')
    const details = wrapper.findAll('[role="dialog"]').find((dialog) => dialog.isVisible())!
    await details.get('.el-table__expand-icon').trigger('click')
    await flushPromises()
    expect(details.text()).toContain('当前版本。')
    expect(details.get('[data-testid="master-history-table"]').text()).toContain('版本字典')
    expect(details.get('[data-testid="master-reference-table"]').text()).toContain('暂无引用记录')
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    const versionSelect = selects.find((component) => component.find('input[aria-label="通用数据版本"]').exists())
    const targetSelect = selects.find((component) => component.find('input[aria-label="引用目标"]').exists())
    expect(versionSelect).toBeDefined()
    expect(targetSelect).toBeDefined()
    versionSelect!.vm.$emit('update:modelValue', 1)
    targetSelect!.vm.$emit('update:modelValue', 'SCENARIO:SCN-DETAIL:7')
    await flushPromises()
    await click('登记引用')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await click('登记引用')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(wrapper.get('[data-testid="master-reference-table"]').text()).toContain('SCN-DETAIL')
    expect(store.masterData[0]?.referenceCount).toBe(1)
    expect(message).toHaveBeenCalledTimes(1)
    await click('关闭')
    expect(store.masterDetails).toBeNull()
    expect(store.masterTargets).toEqual([])
  })

  it('关闭通用数据详情会使在途引用登记失效，迟到响应不会登记', async () => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().role = 'ADMIN'
    const master = { dataId: 'DICT-LATE', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
      content: { name: '迟到字典', description: '', entries: [{ key: 'mode', valueType: 'TEXT' as const, value: 'current' }] } }
    const target = { targetType: 'SCENARIO' as const, targetId: 'SCN-LATE', targetVersion: '3', name: '迟到场景' }
    const reference = { dataId: master.dataId, dataVersion: 1, targetType: target.targetType, targetId: target.targetId, targetVersion: target.targetVersion }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-MASTER-LATE', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: Array.isArray(data) ? data.length : 1 },
    }) }) as Response
    let resolve!: (value: Response) => void
    const deferred = new Promise<Response>((res) => { resolve = res })
    const fetchMock = vi.fn().mockResolvedValueOnce(response([master])).mockResolvedValueOnce(response({ dataId: master.dataId, history: [master], references: [] }))
      .mockResolvedValueOnce(response([target])).mockReturnValueOnce(deferred)
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const message = vi.spyOn(ElMessage, 'success')
    wrapper = mount(MasterDataPanel, { global: { plugins: [ElementPlus] } })
    await flushPromises()
    await click('查看')
    const selects = wrapper.findAllComponents({ name: 'ElSelect' })
    selects.find((component) => component.find('input[aria-label="引用目标"]').exists())!.vm.$emit('update:modelValue', 'SCENARIO:SCN-LATE:3')
    await flushPromises()
    const register = wrapper.findAll('button').find((button) => button.text() === '登记引用')
    await register!.trigger('click')
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await click('关闭')
    resolve(response({ dataId: master.dataId, history: [{ ...master, referenceCount: 1 }], references: [reference] }))
    await flushPromises()
    expect(store.masterDetails).toBeNull()
    expect(store.masterData[0]?.referenceCount).toBe(0)
    expect(message).not.toHaveBeenCalled()
  })

  it('备份选择、取消操作和恢复证据不再包含配置导出入口', async () => {
    const store = useAdminStore()
    store.backups = structuredClone(fixtures.backups) as typeof store.backups
    const run = vi.spyOn(store, 'runMaintenanceAction').mockResolvedValue(true)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/admin')
    wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    await click('创建备份')
    expect(wrapper.get('[data-testid="backup-plan"] form').classes()).toContain('maintenance-toolbar')
    expect((wrapper.get('[data-testid="backup-plan"] form').element as HTMLFormElement).style.marginBottom).toBe('16px')
    const copy = confirm.mock.calls[0]![0]
    expect(copy).not.toMatch(/Mock|不生成文件/i)
    expect(copy).toContain('不包含源 CSV、密码环境变量或密钥')
    expect(copy).toContain('账号库内的密码散列属于恢复所需数据')
    expect(copy).toContain('备份未加密，请妥善保管')
    expect(wrapper.get('[data-testid="backup-table"]').text()).toContain('2026-08-06 18:08:00')
    expect(run).not.toHaveBeenCalled()
    await click('创建备份')
    expect(run).toHaveBeenLastCalledWith('BACKUP', '', '手动备份')
    await selectBackupRow('PREBACKUP-002')
    await click('恢复所选备份')
    expect(run).toHaveBeenLastCalledWith('RESTORE', 'PREBACKUP-002', undefined)
    store.restoreResult = { prebackupId: 'PREBACKUP-002', integrityValid: false, result: 'FAILURE', progress: 0, rolledBack: false, generated: false }
    await flushPromises()
    expect(wrapper.get('[data-testid="restore-result"]').text()).toContain('失败，恢复未开始')
    store.restoreResult = { ...store.restoreResult, integrityValid: true, progress: 100, rolledBack: true }
    await flushPromises()
    expect(wrapper.get('[data-testid="restore-result"]').text()).toContain('已回滚')
    store.restoreResult = { ...store.restoreResult, result: 'SUCCESS', rolledBack: false }
    expect(wrapper.find('[data-testid="full-config-export"]').exists()).toBe(false)
    await click('刷新记录')
    expect(store.loadMaintenance).toHaveBeenCalledWith('backup')
  })

  it('完整配置导出流程演示明确不导出当前场景，保留确认、分级、水印和时间', async () => {
    const store = useAdminStore()
    useAuthStore().role = 'ADMIN'
    const context = { confirmationId: 'CONF-EXPORT', actor: 'admin', role: 'ADMIN', createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z' }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-EXPORT', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: 1 },
    }) }) as Response
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ ...context, state: 'AWAITING_CONFIRMATION' }))
      .mockResolvedValueOnce(response({ ...context, state: 'CONFIRMED' }))
      .mockResolvedValueOnce(response({ objectId: 'FULL-CONFIG', generated: false, classification: 'INTERNAL', watermark: '内部使用', verifiedAt: fixtures.epoch }))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    wrapper = mount(ScenarioConfigExport, { global: { plugins: [ElementPlus] } })
    expect(wrapper.text()).toContain('不校验或导出当前场景内容')
    await click('确认并验证导出')
    expect(fetchMock).not.toHaveBeenCalled()
    await click('确认并验证导出')
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('不校验或导出当前场景内容'), '完整配置导出流程演示', expect.any(Object))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ action: 'FULL_CONFIG_EXPORT', objectId: 'FULL-CONFIG' })
    expect(fetchMock.mock.calls[2]![0]).toContain('/api/v1/admin/config/export')
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual({ format: 'JSON', confirmationId: 'CONF-EXPORT' })
    expect(store.fullConfigExport?.generated).toBe(false)
    expect(wrapper.text()).toContain('完整配置导出流程验证通过；未校验或导出当前场景内容，未生成实际文件。')
    for (const text of ['内部使用', '2026-08-06 16:00:00']) expect(wrapper.get('[data-testid="full-config-result"]').text()).toContain(text)
    expect(store.fullConfigExport?.verifiedAt).toBe(fixtures.epoch)
    for (const [classification, label] of [['INTERNAL', '内部使用'], ['LEVEL_II', '二级'], ['LEVEL_III', '三级']] as const) {
      store.fullConfigExport = { ...store.fullConfigExport!, classification }
      await flushPromises()
      expect(wrapper.get('[data-testid="full-config-result"] .el-descriptions__content').text()).toBe(label)
    }
  })

  it('场景配置导出对操作员隐藏，离页后迟到的确认不触发请求', async () => {
    const auth = useAuthStore()
    auth.role = 'OPERATOR'
    const run = vi.spyOn(useAdminStore(), 'runMaintenanceAction').mockResolvedValue(true)
    wrapper = mount(ScenarioConfigExport, { global: { plugins: [ElementPlus] } })
    expect(wrapper.find('[data-testid="full-config-export"]').exists()).toBe(false)
    auth.role = 'ADMIN'
    await flushPromises()
    let confirm!: () => void
    vi.spyOn(ElMessageBox, 'confirm').mockImplementation(() => new Promise(resolve => { confirm = () => resolve('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>) }))
    await click('确认并验证导出')
    wrapper.unmount()
    wrapper = undefined
    confirm()
    await flushPromises()
    expect(run).not.toHaveBeenCalled()
  })

  it('Mock 恢复成功后切换来源清除旧结果，来源提示只弹出一次而不占据页面', async () => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    useAuthStore().$patch({ role: 'ADMIN' })
    const context = {
      confirmationId: 'CONF-P7', actor: 'admin', role: 'ADMIN',
      createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z',
    }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({
      ok: true, data, meta: { requestId: 'REQ-P7', generatedAt: fixtures.epoch, page: 1, pageSize: 10, total: 1 },
    }) }) as Response
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(fixtures.backups))
      .mockResolvedValueOnce(response({ ...context, state: 'AWAITING_CONFIRMATION' }))
      .mockResolvedValueOnce(response({ ...context, state: 'CONFIRMED' }))
      .mockResolvedValueOnce(response({ prebackupId: 'PREBACKUP-002', integrityValid: true, progress: 100, result: 'SUCCESS', rolledBack: false, generated: false }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const info = vi.spyOn(ElMessage, 'info').mockReturnValue({ close: vi.fn() })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/admin')
    wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    expect(info).not.toHaveBeenCalled()
    await selectBackupRow('PREBACKUP-002')
    expect(info).toHaveBeenCalledExactlyOnceWith('恢复来源已切换，请确认后执行恢复。')
    expect(wrapper.find('[data-testid="backup-feedback"]').exists()).toBe(false)
    await selectBackupRow('PREBACKUP-002')
    expect(info).toHaveBeenCalledTimes(1)
    await click('恢复所选备份')
    expect(store.restoreResult?.result).toBe('SUCCESS')
    expect(wrapper.get('[data-testid="restore-result"]').text()).toContain('成功')

    wrapper.getComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'BACKUP-CORRUPT-001')
    await flushPromises()
    expect(store.restoreResult).toBeNull()
    expect(wrapper.find('[data-testid="restore-result"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="backup-feedback"]').exists()).toBe(false)
    expect(info).toHaveBeenCalledTimes(2)
    expect(info).toHaveBeenLastCalledWith('恢复来源已切换，请确认后执行恢复。')
    expect(store.maintenance.backup.state).toBe('EMPTY')
    expect(store.maintenance.backup.message).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('SQLite 恢复通过正式 Store 流程执行确认，成功清空身份并提示重新登录', async () => {
    const store = useAdminStore()
    vi.mocked(store.loadMaintenance).mockRestore()
    const auth = useAuthStore()
    auth.$patch({ principal: { userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN', permissions: ['BACKUP_RESTORE'] }, role: 'ADMIN' })
    const backup = { backupId: 'BACKUP-SQLITE', status: 'VALID', checksum: 'A'.repeat(64), createdAt: fixtures.epoch }
    const context = { confirmationId: 'CONF-SQLITE', actor: 'admin', role: 'ADMIN', createdAt: fixtures.epoch, expiresAt: '2026-08-06T08:05:00Z' }
    const response = (data: unknown): Response => ({ ok: true, json: async () => ({ ok: true, data,
      meta: { requestId: 'REQ-SQLITE', generatedAt: fixtures.epoch, page: 1, pageSize: 1, total: 1 },
    }) }) as Response
    const fetchMock = vi.fn().mockResolvedValueOnce(response([backup]))
      .mockResolvedValueOnce(response({ ...context, state: 'AWAITING_CONFIRMATION' }))
      .mockResolvedValueOnce(response({ ...context, state: 'CONFIRMED' }))
      .mockResolvedValueOnce(response({ prebackupId: 'PREBACKUP-SQLITE', integrityValid: true, progress: 100, result: 'SUCCESS', rolledBack: false, generated: true }))
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const message = vi.spyOn(ElMessage, 'success').mockReturnValue({ close: vi.fn() })
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/admin')
    wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    expect(wrapper.get('[data-testid="backup-table"]').text()).toContain('旧主库备份')
    await click('选择恢复')
    await click('恢复所选备份')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await click('恢复所选备份')
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('审计与文件读取记录保留'), '恢复备份', expect.anything())
    expect(confirm.mock.calls.at(-1)?.[0]).toContain('账号及密码将恢复到备份时的状态，之后新增的账号可能消失')
    expect(confirm.mock.calls.at(-1)?.[0]).toContain('请确认掌握备份中的管理员账号和密码')
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ operation: 'RESTORE', backupId: 'BACKUP-SQLITE', confirmationId: 'CONF-SQLITE' })
    expect(auth.principal).toBeNull()
    expect(router.currentRoute.value.path).toBe('/login')
    expect(message).toHaveBeenCalledWith('SQLite 数据已恢复，审计记录保留，请重新登录。')
  })

  it('恢复来源显示名称、时间和类型且最新优先；正式 INVALID 禁用，Mock 失败演示仍可提交', async () => {
    const store = useAdminStore()
    useAuthStore().role = 'ADMIN'
    const formal = { status: 'VALID' as const, checksum: 'A'.repeat(64), format: 'SYSTEM_SQLITE_V1' as const }
    store.backups = [
      { ...formal, backupId: 'OLD', name: '旧系统快照', createdAt: '2026-09-20T00:00:00Z' },
      { ...formal, backupId: 'INVALID-SQLITE', name: '无效系统快照', createdAt: '2026-09-21T00:30:00Z', status: 'INVALID' },
      { ...formal, backupId: 'LATEST', name: '最新系统快照', createdAt: '2026-09-21T01:00:00Z' },
      { ...formal, backupId: 'MAIN', name: '旧主库快照', createdAt: '2026-09-20T02:00:00Z', format: 'MAIN_SQLITE_V1' },
      { backupId: 'MOCK-INVALID', status: 'INVALID_FIXTURE', checksum: 'MOCK-INVALID', createdAt: fixtures.epoch },
    ]
    const run = vi.spyOn(store, 'runMaintenanceAction').mockResolvedValue(false)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
    await router.push('/admin')
    wrapper = mount(BackupRestoreWizard, { global: { plugins: [ElementPlus, router] } })
    await flushPromises()
    const options = wrapper.findAllComponents({ name: 'ElOption' })
    expect(options.map(option => option.props('value'))).toEqual(['LATEST', 'INVALID-SQLITE', 'MAIN', 'OLD', 'MOCK-INVALID'])
    expect(options[0]!.props('label')).toBe('最新系统快照 · 2026-09-21 09:00:00 · 系统备份')
    expect(options[1]!.props('disabled')).toBe(true)
    expect(options[2]!.props('disabled')).toBe(true)
    expect(options[4]!.props('disabled')).toBe(false)
    const invalidRow = wrapper.findAll('tr').find(row => row.text().includes('INVALID-SQLITE'))!
    expect(invalidRow.find('button').attributes('disabled')).toBeDefined()
    const select = wrapper.getComponent({ name: 'ElSelect' })
    select.vm.$emit('update:modelValue', 'INVALID-SQLITE')
    await flushPromises()
    expect(wrapper.get('[data-testid="backup-restore"]').attributes('disabled')).toBeDefined()
    await click('恢复所选备份')
    expect(confirm).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    select.vm.$emit('update:modelValue', 'MOCK-INVALID')
    await flushPromises()
    await click('恢复所选备份')
    expect(run).toHaveBeenCalledExactlyOnceWith('RESTORE', 'MOCK-INVALID', undefined)
  })


})
