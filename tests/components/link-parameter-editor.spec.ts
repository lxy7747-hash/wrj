import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it } from 'vitest'
import type { EquipmentParameter, Link, LinkType, MasterData, ScenarioParameterCatalog } from '../../src/contracts/domain-models'
import LinkEditorDialog from '../../src/components/scenarios/LinkEditorDialog.vue'

enableAutoUnmount(afterEach)
afterEach(() => { document.body.innerHTML = '' })
const equipment: EquipmentParameter = { equipmentId: 'EQ-LINK', type: '数传通信设备', frequencyMinMHz: 100, frequencyMaxMHz: 200,
  bandwidthMHz: 5, txPowerW: 20, dataRateMbps: 2, modulation: 'QPSK', berThreshold: 0.001, active: true, readOnly: false, version: 1 }
const dictionary: MasterData = { dataId: 'DICT-LINK', kind: 'PARAMETER_DICTIONARY', version: 2, referenceCount: 0, active: true,
  content: { name: '数传参数', description: '', entries: [
    { key: 'noiseFigureDb', valueType: 'NUMBER', value: 6, unit: 'dB' },
    { key: 'rxAntennaGainDbi', valueType: 'NUMBER', value: 25, unit: 'dBi' },
    { key: 'bandwidthMHz', valueType: 'NUMBER', value: 99 },
    { key: 'frequency', valueType: 'NUMBER', value: 3, unit: 'GHz' },
    { key: 'unmapped', valueType: 'NUMBER', value: 99 },
  ] } }
const enums: MasterData = { ...dictionary, dataId: 'ENUM-LINK', kind: 'ENUMERATION', content: { name: '调制选项', description: '', entries: [
  { key: 'modulation.BPSK', valueType: 'TEXT', value: 'BPSK' }, { key: 'modulation.QPSK', valueType: 'TEXT', value: 'QPSK' },
] } }
const catalog: ScenarioParameterCatalog = { equipment: [equipment], masterData: [dictionary, enums] }
function link(): Link { return { id: 'L-MW-01', type: 'DATALINK', band: 'C', direction: 'FORWARD', sourcePlatformId: 'A', targetPlatformId: 'B',
  frequency: 150, bandwidth: 10, txPower: 10, antennaGain: { tx: 1, rx: 2 }, modulation: 'BPSK', berThreshold: 0.01, dataRate: 2 } }
async function dialog(current = link(), currentCatalog = catalog, linkTypeOptions: readonly { value: LinkType, label: string }[] = [{ value: 'DATALINK', label: '数传' }]) {
  const wrapper = mount(LinkEditorDialog, { attachTo: document.body, props: {
    modelValue: true, link: current, editing: true, error: '', pending: false, locked: false, platforms: [],
    linkTypeOptions, linkDirectionLabels: { FORWARD: '前向', REVERSE: '返向' }, minimumStep: 0.001,
    parameterCatalog: structuredClone(currentCatalog), parameterCatalogState: 'SUCCESS',
  }, global: { plugins: [ElementPlus] } })
  await flushPromises()
  const select = async (id: string, value: string) => {
    const component = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === id)!
    component.vm.$emit('update:modelValue', value)
    component.vm.$emit('change', value)
    await flushPromises()
  }
  const click = async (id: string) => { document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(); await flushPromises() }
  return { wrapper, select, click }
}

describe('链路弹框引用基础数据', () => {
  it('下拉框按设备参数和通用基础数据分组，字典与枚举同属通用组', async () => {
    const { wrapper } = await dialog()
    document.querySelector<HTMLElement>('[data-testid="link-parameter-select"] .el-select__wrapper')!.click()
    await flushPromises()
    expect(Array.from(document.querySelectorAll('.el-select-group__title'), title => title.textContent)).toEqual(['设备参数', '通用基础数据'])
    const groups = wrapper.findAllComponents({ name: 'ElOptionGroup' })
    expect(groups[0]!.findAllComponents({ name: 'ElOption' }).map(option => option.props('value'))).toEqual(['EQUIPMENT:EQ-LINK'])
    expect(groups[0]!.findAllComponents({ name: 'ElOption' }).map(option => option.props('label'))).toEqual(['数传通信设备 · EQ-LINK'])
    expect(groups[1]!.findAllComponents({ name: 'ElOption' }).map(option => option.props('value'))).toEqual(['MASTER_DATA:DICT-LINK', 'MASTER_DATA:ENUM-LINK'])
    expect(groups[1]!.findAllComponents({ name: 'ElOption' }).map(option => option.props('label'))).toEqual(['数传参数 · DICT-LINK', '调制选项 · ENUM-LINK'])
  })

  it.each([
    { equipment: [], masterData: [] },
    { equipment: [], masterData: [dictionary] },
    { equipment: [equipment], masterData: [] },
  ] as ScenarioParameterCatalog[])('空分类仍显示分组和禁用的空态，不生成可引用数据：%j', async currentCatalog => {
    const { wrapper } = await dialog(link(), currentCatalog)
    document.querySelector<HTMLElement>('[data-testid="link-parameter-select"] .el-select__wrapper')!.click()
    await flushPromises()
    const groups = wrapper.findAllComponents({ name: 'ElOptionGroup' })
    expect(groups.map(group => group.props('label'))).toEqual(['设备参数', '通用基础数据'])
    for (const [index, empty, label] of [[0, !currentCatalog.equipment.length, '暂无可用设备参数'], [1, !currentCatalog.masterData.length, '暂无可用通用基础数据']] as const) {
      if (!empty) continue
      const option = groups[index]!.findComponent({ name: 'ElOption' })
      expect(option.props()).toMatchObject({ label, disabled: true })
      expect(groups[index]!.isVisible()).toBe(true)
    }
    const select = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'link-parameter-select')!
    expect(select.props()).toMatchObject({ placeholder: '选择设备参数或通用基础数据', modelValue: '' })
    expect(document.querySelector('[data-testid="apply-link"]')?.textContent).toContain('确认')
    expect(document.querySelector('[data-testid="link-parameter-apply"]')).toBeNull()
    expect(wrapper.emitted('apply')).toBeUndefined()
  })

  it('选择设备后自动填入，确认携带来源版本；取消不修改原链路', async () => {
    const original = link()
    const { wrapper, select, click } = await dialog(original)
    await select('link-parameter-select', 'EQUIPMENT:EQ-LINK')
    expect(document.querySelector('[data-testid="link-parameter-preview"]')?.textContent).toContain('发射带宽：5')
    expect(original.bandwidth).toBe(10)
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'link-bandwidth')!.props('modelValue')).toBe(5)
    expect(document.querySelector('[data-testid="link-parameter-applied"]')?.textContent).toContain('EQ-LINK · v1')
    expect(document.querySelector('[data-testid="apply-link"]')?.textContent).toContain('保存')
    expect(document.querySelector('[data-testid="link-parameter-apply"]')).toBeNull()
    expect(wrapper.emitted('apply')).toBeUndefined()
    await click('cancel-link')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
    expect(original).toEqual(link())
    await wrapper.setProps({ modelValue: false } as never)
    await wrapper.setProps({ modelValue: true } as never)
    expect(document.querySelector('[data-testid="link-parameter-applied"]')).toBeNull()
    await select('link-parameter-select', 'EQUIPMENT:EQ-LINK')
    await click('apply-link')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ frequency: 150, bandwidth: 5, modulation: 'QPSK', parameterSource: {
      kind: 'EQUIPMENT', sourceId: 'EQ-LINK', sourceVersion: 1, fields: ['bandwidth', 'txPower', 'dataRate', 'modulation', 'berThreshold'],
    } })
    await wrapper.setProps({ modelValue: false } as never)
    expect(wrapper.emitted('close-parameters')).toBeTruthy()
    expect(original.parameterSource).toBeUndefined()
  })

  it('不兼容的设备选择不能确认成未引用链路；修正频率后才能填参并保存来源', async () => {
    const original = link()
    const { wrapper, select, click } = await dialog(original, {
      equipment: [{ ...equipment, frequencyMinMHz: 2, frequencyMaxMHz: 33 }], masterData: [],
    })
    await select('link-parameter-select', 'EQUIPMENT:EQ-LINK')
    expect(document.querySelector('[data-testid="link-parameter-selection-error"]')?.textContent).toContain('frequency：当前链路频率不在装备支持范围')
    expect(document.querySelector<HTMLButtonElement>('[data-testid="apply-link"]')!.disabled).toBe(true)
    await click('apply-link')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(original).toEqual(link())
    wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'link-frequency')!.vm.$emit('update:modelValue', 20)
    await flushPromises()
    expect(document.querySelector('[data-testid="link-parameter-selection-error"]')?.textContent).toBeUndefined()
    expect(document.querySelector('[data-testid="link-parameter-mismatch"]')?.textContent).toBeUndefined()
    expect(document.querySelector<HTMLButtonElement>('[data-testid="apply-link"]')!.disabled).toBe(false)
    await click('apply-link')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ frequency: 20, bandwidth: 5,
      parameterSource: { kind: 'EQUIPMENT', sourceId: 'EQ-LINK', sourceVersion: 1 } })
  })

  it('类型不匹配或未知的设备来源保持可见但置灰；手工触发也不能写入引用', async () => {
    const microwave = { ...equipment, equipmentId: 'EQ-MW', type: '微波通信设备', dataRateMbps: 80 }
    const unknown = { ...equipment, equipmentId: 'EQ-LEGACY', type: '旧通信设备' }
    const { wrapper, select, click } = await dialog(link(), { equipment: [equipment, microwave, unknown], masterData: [] })
    const options = wrapper.findAllComponents({ name: 'ElOptionGroup' })[0]!.findAllComponents({ name: 'ElOption' })
    expect(options.map(option => option.props('value'))).toEqual(['EQUIPMENT:EQ-LINK', 'EQUIPMENT:EQ-MW', 'EQUIPMENT:EQ-LEGACY'])
    expect(options[0]!.props('disabled')).toBe(false)
    expect(options[1]!.props()).toMatchObject({ disabled: true, label: expect.stringContaining('类型不匹配') })
    expect(options[2]!.props()).toMatchObject({ disabled: true, label: expect.stringContaining('类型未明确') })

    await select('link-parameter-select', 'EQUIPMENT:EQ-MW')
    expect(document.querySelector('[data-testid="link-parameter-selection-error"]')?.textContent).toContain('type：设备类型与当前链路类型不一致')
    await click('apply-link')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(document.querySelector('[data-testid="link-parameter-applied"]')).toBeNull()

    await select('link-parameter-select', 'EQUIPMENT:EQ-LEGACY')
    expect(document.querySelector('[data-testid="link-parameter-selection-error"]')?.textContent).toContain('type：设备类型尚未明确')
    await click('apply-link')
    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(document.querySelector('[data-testid="link-parameter-applied"]')).toBeNull()
  })

  it('切换链路类型后立即刷新设备来源的禁用状态', async () => {
    const microwave = { ...equipment, equipmentId: 'EQ-MW', type: '微波通信设备', dataRateMbps: 80 }
    const { wrapper, select } = await dialog(link(), { equipment: [equipment, microwave], masterData: [] }, [
      { value: 'DATALINK', label: '数传' }, { value: 'MICROWAVE', label: '微波' },
    ])
    const options = () => wrapper.findAllComponents({ name: 'ElOptionGroup' })[0]!.findAllComponents({ name: 'ElOption' })
    expect(options().map(option => option.props('disabled'))).toEqual([false, true])
    await select('link-type', 'MICROWAVE')
    expect(options().map(option => option.props('disabled'))).toEqual([true, false])
    expect(options()[0]!.props('label')).toContain('类型不匹配')
  })

  it('选择字典后自动填入映射字段，跳过未知和错误单位，取消引用保留已填参数', async () => {
    const { wrapper, select, click } = await dialog()
    await select('link-parameter-select', 'MASTER_DATA:DICT-LINK')
    const preview = document.querySelector('[data-testid="link-parameter-preview"]')!
    expect(preview.textContent).toContain('单位与链路字段不一致')
    expect(preview.textContent).toContain('不是受支持的链路参数字段')
    expect(preview.textContent).toContain('属于设备固有参数')
    expect(document.querySelector('[data-testid="link-parameter-applied"]')?.textContent).toContain('DICT-LINK · v2')
    await click('link-parameter-clear')
    await click('apply-link')
    const result = wrapper.emitted('apply')![0]![0] as Link
    expect(result).toMatchObject({ frequency: 150, bandwidth: 10, txPower: 10, noiseFigureDb: 6, antennaGain: { rx: 25 } })
    expect(result.parameterSource).toBeUndefined()
  })

  it('枚举不默认取第一个，选择具体值后自动填入，切换枚举重新选择', async () => {
    const { wrapper, select, click } = await dialog()
    await select('link-parameter-select', 'MASTER_DATA:ENUM-LINK')
    expect(document.querySelector('[data-testid="link-parameter-apply"]')).toBeNull()
    expect(document.querySelector('[data-testid="link-parameter-applied"]')).toBeNull()
    expect(wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'link-modulation')!.props('modelValue')).toBe('BPSK')
    expect(document.querySelector<HTMLButtonElement>('[data-testid="apply-link"]')!.disabled).toBe(true)
    await click('apply-link')
    expect(wrapper.emitted('apply')).toBeUndefined()
    await select('link-parameter-entry', 'modulation.QPSK')
    expect(wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'link-modulation')!.props('modelValue')).toBe('QPSK')
    await select('link-parameter-select', 'MASTER_DATA:DICT-LINK')
    await select('link-parameter-select', 'MASTER_DATA:ENUM-LINK')
    expect(wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'link-parameter-entry')!.props('modelValue')).toBe('')
    expect(document.querySelector('[data-testid="link-parameter-applied"]')?.textContent).toContain('DICT-LINK · v2')
    await select('link-parameter-entry', 'modulation.QPSK')
    await click('apply-link')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ modulation: 'QPSK', parameterSource: {
      kind: 'MASTER_DATA', sourceId: 'ENUM-LINK', sourceVersion: 2, entryKey: 'modulation.QPSK', fields: ['modulation'],
    } })
  })

  it('手工改写引用字段后禁止确认；解除引用后按自定义参数确认', async () => {
    const { wrapper, select, click } = await dialog()
    await select('link-parameter-select', 'EQUIPMENT:EQ-LINK')
    wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'link-bandwidth')!.vm.$emit('update:modelValue', 9)
    await flushPromises()
    expect(document.querySelector('[data-testid="link-parameter-mismatch"]')?.textContent).toContain('已修改引用字段')
    await click('apply-link')
    expect(wrapper.emitted('apply')).toBeUndefined()
    await click('link-parameter-clear')
    await click('apply-link')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ bandwidth: 9 })
  })

  it.each(['pending', 'locked', 'referenceDisabled'] as const)('%s 时选择数据不会自动填入或登记引用', async state => {
    const { wrapper, select } = await dialog()
    await wrapper.setProps({ [state]: true })
    await select('link-parameter-select', 'EQUIPMENT:EQ-LINK')
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'link-bandwidth')!.props('modelValue')).toBe(10)
    expect(document.querySelector('[data-testid="link-parameter-applied"]')).toBeNull()
    expect(wrapper.emitted('apply')).toBeUndefined()
    if (state === 'referenceDisabled') expect(document.body.textContent).toContain('请先保存场景，再引用基础数据。')
  })

  it('重开回显设备名称并隐藏版本文字，目录刷新保留保存版本，主动重选才应用新版', async () => {
    const { wrapper, select, click } = await dialog()
    await select('link-parameter-select', 'EQUIPMENT:EQ-LINK')
    await click('apply-link')
    const saved = wrapper.emitted('apply')![0]![0] as Link
    await wrapper.setProps({ modelValue: false } as never)
    await wrapper.setProps({ modelValue: true, link: saved } as never)
    const sourceSelect = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'link-parameter-select')!
    expect(sourceSelect.props('modelValue')).toBe('SAVED:EQUIPMENT:EQ-LINK:1')
    expect(sourceSelect.text()).toContain('数传通信设备 · EQ-LINK')
    expect(sourceSelect.text()).not.toMatch(/ · v\d+/)
    expect(document.querySelector('[data-testid="link-parameter-preview"]')).toBeNull()
    await wrapper.setProps({ parameterCatalog: { equipment: [{ ...equipment, version: 2, bandwidthMHz: 7 }], masterData: [] } } as never)
    expect(sourceSelect.props('modelValue')).toBe('SAVED:EQUIPMENT:EQ-LINK:1')
    expect(sourceSelect.text()).toContain('设备 · EQ-LINK')
    expect(sourceSelect.text()).not.toMatch(/ · v\d+/)
    await click('apply-link')
    expect(wrapper.emitted('apply')![1]![0]).toMatchObject({ bandwidth: 5, parameterSource: { sourceVersion: 1 } })
    expect(saved.parameterSource?.sourceVersion).toBe(1)
    await select('link-parameter-select', 'EQUIPMENT:EQ-LINK')
    await click('apply-link')
    expect(wrapper.emitted('apply')![2]![0]).toMatchObject({ bandwidth: 7, parameterSource: { sourceVersion: 2 } })
    await select('link-parameter-select', '')
    expect(sourceSelect.props('modelValue')).toBe('')
    expect(document.querySelector('[data-testid="link-parameter-applied"]')).toBeNull()
    await click('apply-link')
    expect(wrapper.emitted('apply')![3]![0]).toMatchObject({ bandwidth: 7 })
    expect((wrapper.emitted('apply')![3]![0] as Link).parameterSource).toBeUndefined()
  })

  it.each([dictionary, enums])('重开回显通用数据 $dataId 名称，隐藏版本文字但保留已选版本、枚举和参数', async source => {
    const { wrapper, select, click } = await dialog()
    await select('link-parameter-select', `MASTER_DATA:${source.dataId}`)
    if (source.kind === 'ENUMERATION') await select('link-parameter-entry', 'modulation.QPSK')
    await click('apply-link')
    const saved = wrapper.emitted('apply')![0]![0] as Link
    await wrapper.setProps({ modelValue: false } as never)
    await wrapper.setProps({ modelValue: true, link: saved } as never)
    const sourceSelect = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'link-parameter-select')!
    expect(sourceSelect.props('modelValue')).toBe(`SAVED:MASTER_DATA:${source.dataId}:2`)
    expect(sourceSelect.text()).toContain(`${source.content!.name} · ${source.dataId}`)
    expect(sourceSelect.text()).not.toMatch(/ · v\d+/)
    expect(document.querySelector('[data-testid="link-parameter-preview"]')).toBeNull()
    await click('apply-link')
    expect(wrapper.emitted('apply')![1]![0]).toMatchObject({ parameterSource: saved.parameterSource,
      ...(source.kind === 'ENUMERATION' ? { modulation: 'QPSK' } : { noiseFigureDb: 6, antennaGain: { rx: 25 } }) })
    await click('link-parameter-clear')
    expect(sourceSelect.props('modelValue')).toBe('')
    expect(document.querySelector('[data-testid="link-parameter-applied"]')).toBeNull()
  })

  it('目录未加载或来源不可用时保留原编号与版本，补齐目录名称不会触发填参', async () => {
    const current = link()
    current.parameterSource = { kind: 'MASTER_DATA', sourceId: dictionary.dataId, sourceVersion: dictionary.version, fields: ['noiseFigureDb'] }
    current.noiseFigureDb = 4
    const { wrapper, click } = await dialog(current, { equipment: [], masterData: [] })
    await wrapper.setProps({ modelValue: false, parameterCatalog: null, parameterCatalogState: 'EMPTY' } as never)
    await wrapper.setProps({ modelValue: true } as never)
    const sourceSelect = wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === 'link-parameter-select')!
    expect(sourceSelect.props('modelValue')).toBe('SAVED:MASTER_DATA:DICT-LINK:2')
    expect(sourceSelect.text()).toContain('通用数据 · DICT-LINK')
    expect(sourceSelect.text()).not.toMatch(/ · v\d+/)
    expect(wrapper.emitted('load-parameters')).toHaveLength(1)
    await wrapper.setProps({ parameterCatalog: { equipment: [], masterData: [{ ...dictionary, active: false }] }, parameterCatalogState: 'SUCCESS' } as never)
    expect(sourceSelect.text()).toContain('数传参数 · DICT-LINK')
    await click('apply-link')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ noiseFigureDb: 4, parameterSource: current.parameterSource })
    await wrapper.setProps({ parameterCatalog: null, parameterCatalogState: 'ERROR', parameterCatalogMessage: '加载失败，请重试。' } as never)
    expect(sourceSelect.text()).toContain('通用数据 · DICT-LINK')
    expect(document.body.textContent).toContain('加载失败，请重试。')
    await click('apply-link')
    expect(wrapper.emitted('apply')![1]![0]).toMatchObject({ noiseFigureDb: 4, parameterSource: current.parameterSource })
  })

  it('重开保留历史来源版本，不静默升级；越界装备与加载错误可定位且可重试', async () => {
    const current = link()
    current.parameterSource = { kind: 'EQUIPMENT', sourceId: 'EQ-LINK', sourceVersion: 1, fields: ['bandwidth'] }
    const { wrapper, select, click } = await dialog(current, { equipment: [{ ...equipment, version: 2, frequencyMinMHz: 300, frequencyMaxMHz: 400 }], masterData: [] })
    expect(document.querySelector('[data-testid="link-parameter-applied"]')?.textContent).toContain('v1')
    await click('apply-link')
    expect(wrapper.emitted('apply')![0]![0]).toMatchObject({ parameterSource: current.parameterSource, bandwidth: 10 })
    await select('link-parameter-select', 'EQUIPMENT:EQ-LINK')
    expect(document.querySelector('[data-testid="link-parameter-selection-error"]')?.textContent).toContain('frequency：当前链路频率不在装备支持范围')
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === 'link-bandwidth')!.props('modelValue')).toBe(10)
    expect(document.querySelector('[data-testid="link-parameter-applied"]')?.textContent).toContain('v1')
    await click('apply-link')
    expect(wrapper.emitted('apply')).toHaveLength(1)
    expect(document.querySelector<HTMLButtonElement>('[data-testid="apply-link"]')!.disabled).toBe(true)
    await wrapper.setProps({ parameterCatalog: null, parameterCatalogState: 'ERROR', parameterCatalogMessage: '加载失败，请重试。' } as never)
    expect(document.body.textContent).toContain('加载失败，请重试。')
    await click('link-parameter-refresh')
    expect(wrapper.emitted('load-parameters')).toHaveLength(1)
  })
})
