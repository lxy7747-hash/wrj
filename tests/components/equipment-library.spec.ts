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

function errorResponse(message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code: 'CONFLICT', message, retryable: false, correlationId: 'CORR-EQ' },
    meta: { requestId: 'REQ-EQ', generatedAt: '2026-08-06T08:00:00Z' } }), { status: 409 })
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

  it('被场景引用而删除失败时只显示一次错误浮层，不占据整行；再次操作可再次提示', async () => {
    const message = '装备仍有场景引用，请先在链路中取消引用并保存场景后再删除。'
    const context = { confirmationId: 'CONF-DELETE', actor: 'admin', role: 'ADMIN', createdAt: '2026-08-06T08:00:00Z', expiresAt: '2026-08-06T08:05:00Z' }
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      if (init?.method === 'DELETE') return errorResponse(message)
      if (init?.method === 'POST') return response({ ...context, state: String(url).endsWith('/confirmations') ? 'AWAITING_CONFIRMATION' : 'CONFIRMED' })
      return response([EQUIPMENT])
    }))
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const error = vi.spyOn(ElMessage, 'error')
    const success = vi.spyOn(ElMessage, 'success')
    const wrapper = setup()
    await flushPromises()
    for (let attempt = 1; attempt <= 2; attempt++) {
      await wrapper.findAll('button').find(button => button.text() === '删除')!.trigger('click')
      await flushPromises()
      expect(error).toHaveBeenCalledTimes(attempt)
      expect(error).toHaveBeenLastCalledWith(message)
      expect(wrapper.find('[data-testid="equipment-feedback"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="equipment-table"]').text()).toContain(EQUIPMENT.equipmentId)
    }
    expect(success).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('停用失败使用错误浮层，保留设备状态且不出现常驻提示条', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => init?.method ? errorResponse('装备已变化，请刷新后重试。') : response([EQUIPMENT])))
    const error = vi.spyOn(ElMessage, 'error')
    const success = vi.spyOn(ElMessage, 'success')
    const wrapper = setup()
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '停用')!.trigger('click')
    await flushPromises()
    expect(error).toHaveBeenCalledExactlyOnceWith('装备已变化，请刷新后重试。')
    expect(success).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="equipment-feedback"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="equipment-table"]').text()).toContain('已启用')
    wrapper.unmount()
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
    const error = vi.spyOn(ElMessage, 'error')
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
    const type = () => wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'equipment-type')!
    expect(type().props()).toMatchObject({ modelValue: '', clearable: true, allowCreate: false })
    expect(type().findAllComponents({ name: 'ElOption' }).map(option => option.props('value')))
      .toEqual(['卫星通信设备', '微波通信设备', '数传通信设备', '激光通信设备', '光纤通信设备'])
    const modulation = () => wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'equipment-modulation')!
    expect(modulation().props()).toMatchObject({ clearable: true, allowCreate: false })
    expect(modulation().findAllComponents({ name: 'ElOption' }).map(option => option.props('value'))).toEqual(['BPSK', 'QPSK'])
    expect(wrapper.findAll('.equipment-editor .el-form-item__label').map(label => label.text()))
      .toEqual(['编号', '类型', '频率下限（MHz）', '频率上限（MHz）', '调制方式', '发射带宽（MHz）', '发射功率（W）', '数据速率（Mbps）', 'BER 阈值'])
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'equipment-threshold')!.props())
      .toMatchObject({ step: 0.000001 })
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('编号须为')
    expect(error).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await wrapper.get('input[data-testid="equipment-id"]').setValue(EQUIPMENT.equipmentId)
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('请填写 1–100 字的装备类型')
    expect(fetcher).toHaveBeenCalledTimes(1)
    type().vm.$emit('update:modelValue', '微波通信设备')
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(records[0]).toMatchObject({ equipmentId: EQUIPMENT.equipmentId, type: '微波通信设备', frequencyMinMHz: null, modulation: null, version: 1 })
    expect(success).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenLastCalledWith('装备参数已保存。')
    expect(wrapper.find('[data-testid="equipment-feedback"]').exists()).toBe(false)
    const button = (label: string) => wrapper.findAll('button').find(item => item.text() === label)!
    await button('查看').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('暂无数据')
    await button('关闭').trigger('click')
    await button('编辑').trigger('click')
    expect(wrapper.get('input[data-testid="equipment-id"]').attributes('disabled')).toBeDefined()
    type().vm.$emit('update:modelValue', '卫星通信设备')
    modulation().vm.$emit('update:modelValue', 'QPSK')
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(success).toHaveBeenCalledTimes(2)
    expect(success).toHaveBeenLastCalledWith('装备参数已保存。')
    wrapper.unmount()
    const reloaded = setup()
    await flushPromises()
    expect(reloaded.get('[data-testid="equipment-table"]').text()).toContain('卫星通信设备')
    expect(records[0]).toMatchObject({ type: '卫星通信设备', modulation: 'QPSK', version: 2 })
    expect(reloaded.text()).toContain('QPSK')
    await reloaded.findAll('button').find(item => item.text() === '编辑')!.trigger('click')
    const reloadedModulation = reloaded.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'equipment-modulation')!
    expect(reloadedModulation.props('modelValue')).toBe('QPSK')
    reloadedModulation.vm.$emit('update:modelValue', undefined)
    await reloaded.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(records[0]).toMatchObject({ modulation: null, version: 3 })
    reloaded.unmount()
  })

  it('原有自定义装备类型回显并原样保存，不默认替换；清空仍须重新选择', async () => {
    let record = { ...EQUIPMENT, type: '自定义设备w2' }
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method) record = { ...JSON.parse(String(init.body)), version: record.version + 1 }
      return response(init?.method ? record : [record])
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = setup()
    await flushPromises()
    await wrapper.findAll('button').find(item => item.text() === '编辑')!.trigger('click')
    const type = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'equipment-type')!
    expect(type.props('modelValue')).toBe('自定义设备w2')
    expect(type.findAllComponents({ name: 'ElOption' })[0]!.props()).toMatchObject({ value: '自定义设备w2', label: '自定义设备w2（原有类型）', disabled: true })
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(record).toMatchObject({ type: '自定义设备w2', version: 2 })
    await wrapper.findAll('button').find(item => item.text() === '编辑')!.trigger('click')
    const reopened = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'equipment-type')!
    reopened.vm.$emit('update:modelValue', undefined)
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(record.type).toBe('自定义设备w2')
    reopened.vm.$emit('update:modelValue', '数传通信设备')
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(record).toMatchObject({ type: '数传通信设备', version: 3 })
    wrapper.unmount()
  })

  it.each([
    { type: '微波通信设备', values: [80] },
    { type: '卫星通信设备', values: [0.016, 16] },
    { type: '数传通信设备', values: [0.0064, 0.0128, 0.0256, 0.0512, 2, 4, 8, 16] },
  ])('$type 数据速率使用受控下拉，选择后保存并按单位回显，清空仍保存为 null', async ({ type, values }) => {
    let record: EquipmentParameter = { ...EQUIPMENT, type, dataRateMbps: null, ...(type === '激光通信设备' ? { modulation: 'OOK' } : {}) }
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method) record = { ...JSON.parse(String(init.body)), version: record.version + 1 }
      return response(init?.method ? record : [record])
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = setup()
    await flushPromises()
    const edit = async () => { await wrapper.findAll('button').find(item => item.text() === '编辑')!.trigger('click') }
    await edit()
    const rate = () => wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'equipment-data-rate')!
    expect(rate().props()).toMatchObject({ modelValue: null, clearable: true, allowCreate: false })
    expect(rate().findAllComponents({ name: 'ElOption' }).map(option => option.props('value'))).toEqual(values)
    rate().vm.$emit('update:modelValue', values[0])
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(record).toMatchObject({ dataRateMbps: values[0], version: 2 })
    if (type === '卫星通信设备') expect(wrapper.get('[data-testid="equipment-table"]').text()).toContain('16 kbps')
    await edit()
    expect(rate().props('modelValue')).toBe(values[0])
    rate().vm.$emit('update:modelValue', undefined)
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(record).toMatchObject({ dataRateMbps: null, version: 3 })
    wrapper.unmount()
  })

  it('原有微波速率 1 不自动改成 80；重选合法值前禁止发送保存请求', async () => {
    let record = { ...EQUIPMENT, type: '微波通信设备', dataRateMbps: 1 }
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method) record = { ...JSON.parse(String(init.body)), version: record.version + 1 }
      return response(init?.method ? record : [record])
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = setup()
    await flushPromises()
    await wrapper.findAll('button').find(item => item.text() === '编辑')!.trigger('click')
    const rate = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'equipment-data-rate')!
    expect(rate.props('modelValue')).toBe(1)
    expect(rate.findAllComponents({ name: 'ElOption' })[0]!.props()).toMatchObject({ value: 1, disabled: true })
    expect(wrapper.findAllComponents({ name: 'ElFormItem' }).find(item => item.props('label') === '数据速率')!.props('error')).toContain('数据速率与设备类型不一致')
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(record.dataRateMbps).toBe(1)
    rate.vm.$emit('update:modelValue', 80)
    await flushPromises()
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(record).toMatchObject({ dataRateMbps: 80, version: 2 })
    wrapper.unmount()
  })

  it.each([
    { type: '光纤通信设备', invalid: 9, valid: 10 },
    { type: '光纤通信设备', invalid: 1001, valid: 1000 },
    { type: '激光通信设备', invalid: 0, valid: 0.5 },
  ])('$type 数值速率按场景范围校验，越界不夹值、不写入', async ({ type, invalid, valid }) => {
    let record: EquipmentParameter = { ...EQUIPMENT, type, dataRateMbps: null, ...(type === '激光通信设备' ? { modulation: 'OOK' } : {}) }
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method) record = { ...JSON.parse(String(init.body)), version: record.version + 1 }
      return response(init?.method ? record : [record])
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = setup()
    await flushPromises()
    await wrapper.findAll('button').find(item => item.text() === '编辑')!.trigger('click')
    const rate = wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'equipment-data-rate')!
    rate.vm.$emit('update:modelValue', invalid)
    await flushPromises()
    expect(rate.props('modelValue')).toBe(invalid)
    expect(wrapper.get('[data-testid="equipment-save"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(record.dataRateMbps).toBeNull()
    rate.vm.$emit('update:modelValue', valid)
    await flushPromises()
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(record).toMatchObject({ dataRateMbps: valid, version: 2 })
    wrapper.unmount()
  })

  it('旧数据的非受控调制仍可查看，编辑时须明确重选或清空，不自动改写', async () => {
    let record = { ...EQUIPMENT, modulation: '1' }
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method) record = { ...JSON.parse(String(init.body)), version: record.version + 1 }
      return response(init?.method ? record : [record])
    })
    vi.stubGlobal('fetch', fetcher)
    const wrapper = setup()
    await flushPromises()
    await wrapper.findAll('button').find(item => item.text() === '编辑')!.trigger('click')
    const modulation = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'equipment-modulation')!
    expect(modulation.props('modelValue')).toBe('1')
    expect(modulation.findAllComponents({ name: 'ElOption' })[0]!.props()).toMatchObject({ value: '1', disabled: true })
    expect(wrapper.findAllComponents({ name: 'ElFormItem' }).find(item => item.props('label') === '调制方式')!.props('error')).toContain('请选择 BPSK 或 QPSK')
    expect(wrapper.get('[data-testid="equipment-save"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(record.modulation).toBe('1')
    modulation.vm.$emit('update:modelValue', 'BPSK')
    await flushPromises()
    await wrapper.get('[data-testid="equipment-save"]').trigger('click')
    await flushPromises()
    expect(record).toMatchObject({ modulation: 'BPSK', version: 2 })
    wrapper.unmount()
  })

  it('七项通信参数在表单内逐项显示错误、保留原输入并阻止保存', async () => {
    const record: EquipmentParameter = { ...EQUIPMENT, type: '数传通信设备', frequencyMinMHz: 100, frequencyMaxMHz: 200,
      bandwidthMHz: 10, txPowerW: 20, dataRateMbps: 2, modulation: 'QPSK', berThreshold: 0.1 }
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => response(init?.method ? record : [record]))
    vi.stubGlobal('fetch', fetcher)
    const wrapper = setup()
    await flushPromises()
    await wrapper.findAll('button').find(item => item.text() === '编辑')!.trigger('click')
    const number = (id: string) => wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === id)!
    const select = (id: string) => wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === id)!
    const error = (label: string) => wrapper.findAllComponents({ name: 'ElFormItem' }).find(item => item.props('label') === label)!.props('error') as string
    const save = () => wrapper.get('[data-testid="equipment-save"]')
    const cases: Array<[string, () => void, () => unknown, string, () => void]> = [
      ['频率下限（MHz）', () => number('equipment-frequency-min').vm.$emit('update:modelValue', 0), () => number('equipment-frequency-min').props('modelValue'), '频率必须为有限正数', () => number('equipment-frequency-min').vm.$emit('update:modelValue', 100)],
      ['频率上限（MHz）', () => number('equipment-frequency-max').vm.$emit('update:modelValue', 99), () => number('equipment-frequency-max').props('modelValue'), '频率上限不得小于下限', () => number('equipment-frequency-max').vm.$emit('update:modelValue', 200)],
      ['调制方式', () => select('equipment-modulation').vm.$emit('update:modelValue', 'OOK'), () => select('equipment-modulation').props('modelValue'), '请选择 BPSK 或 QPSK', () => select('equipment-modulation').vm.$emit('update:modelValue', 'QPSK')],
      ['发射带宽（MHz）', () => number('equipment-bandwidth').vm.$emit('update:modelValue', 0), () => number('equipment-bandwidth').props('modelValue'), '发射带宽必须为有限正数', () => number('equipment-bandwidth').vm.$emit('update:modelValue', 10)],
      ['发射功率（W）', () => number('equipment-power').vm.$emit('update:modelValue', -1), () => number('equipment-power').props('modelValue'), '发射功率须为非负有限数值', () => number('equipment-power').vm.$emit('update:modelValue', 20)],
      ['数据速率', () => select('equipment-data-rate').vm.$emit('update:modelValue', 1), () => select('equipment-data-rate').props('modelValue'), '数据速率与设备类型不一致', () => select('equipment-data-rate').vm.$emit('update:modelValue', 2)],
      ['BER 阈值', () => number('equipment-threshold').vm.$emit('update:modelValue', 1.1), () => number('equipment-threshold').props('modelValue'), 'BER 阈值必须在 0～1', () => number('equipment-threshold').vm.$emit('update:modelValue', 0.1)],
    ]
    for (const [label, setInvalid, value, message, reset] of cases) {
      setInvalid()
      await flushPromises()
      expect(value()).toEqual(label === '调制方式' ? 'OOK' : label === 'BER 阈值' ? 1.1 : label === '发射带宽（MHz）' || label === '频率下限（MHz）' ? 0 : label === '发射功率（W）' ? -1 : label === '频率上限（MHz）' ? 99 : 1)
      expect(error(label)).toContain(message)
      expect(save().attributes('disabled')).toBeDefined()
      reset()
      await flushPromises()
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('管理员可停用并恢复装备，状态和请求版本同步更新', async () => {
    let records: EquipmentParameter[] = [EQUIPMENT]
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init?.method) return response(records)
      const input = JSON.parse(String(init.body)) as EquipmentParameter
      const saved = { ...input, version: input.version + 1 }
      records = [saved]
      return response(saved)
    })
    vi.stubGlobal('fetch', fetcher)
    const success = vi.spyOn(ElMessage, 'success')
    const wrapper = setup()
    await flushPromises()
    const button = (label: string) => wrapper.findAll('button').find(item => item.text() === label)!
    expect(wrapper.text()).toContain('已启用')
    await button('停用').trigger('click')
    await flushPromises()
    expect(records).toEqual([{ ...EQUIPMENT, active: false, version: 2 }])
    expect(wrapper.text()).toContain('已停用')
    expect(success).toHaveBeenCalledWith('装备参数已停用。')
    await button('恢复').trigger('click')
    await flushPromises()
    expect(records).toEqual([{ ...EQUIPMENT, active: true, version: 3 }])
    expect(success).toHaveBeenCalledWith('装备参数已恢复启用。')
    wrapper.unmount()
  })

  it('加载失败明确显示错误，重试恢复；只读装备不可编辑', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response([{ ...EQUIPMENT, readOnly: true }])))
    const success = vi.spyOn(ElMessage, 'success')
    const error = vi.spyOn(ElMessage, 'error')
    const wrapper = setup()
    await flushPromises()
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]![0]).toContain('暂时不可用')
    expect(wrapper.find('[data-testid="equipment-feedback"]').exists()).toBe(false)
    await wrapper.findAll('button').find(item => item.text() === '刷新')!.trigger('click')
    await flushPromises()
    expect(wrapper.findAll('button').find(item => item.text() === '编辑')!.attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('button').find(item => item.text() === '删除')!.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('100～200 MHz')
    expect(success).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
