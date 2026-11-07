import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import type { DeviceParameters, EquipmentParameter, ScenarioParameterCatalog } from '../../src/contracts/domain-models'
import DeviceParametersPanel from '../../src/components/scenarios/DeviceParametersPanel.vue'
import { readDeviceParameters } from '../../src/features/scenarios/template-defaults'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ScenarioConfig } from '../../src/contracts/domain-models'

async function mountPanel(props: { modelValue?: DeviceParameters, fieldMessage?: (path: string) => string, parameterCatalog?: ScenarioParameterCatalog | null, referenceDisabled?: boolean, disabled?: boolean } = {}) {
  const wrapper = mount(DeviceParametersPanel, {
    props: { fieldMessage: () => '', ...props },
    global: { plugins: [ElementPlus] },
  })
  // el-table 在下一轮渲染单元格。
  await flushPromises()
  // 组件为 <script setup>，测试只按公开 props 调用 setProps。
  return wrapper as unknown as VueWrapper<any>
}
type PanelWrapper = Awaited<ReturnType<typeof mountPanel>>
const numberInput = (wrapper: PanelWrapper, testId: string) => wrapper.findAllComponents({ name: 'ElInputNumber' }).find(item => item.attributes('data-testid') === testId)!
const select = (wrapper: PanelWrapper, testId: string) => wrapper.findAllComponents({ name: 'ElSelect' }).find(item => item.attributes('data-testid') === testId)!
const lastValue = (wrapper: PanelWrapper) => wrapper.emitted('update:modelValue')!.at(-1)![0] as DeviceParameters

describe('通信设备参数面板', () => {
  it('缺省时按模板默认值展示五类平台端口与 12 个天线增益，光纤只读', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['任务无人机（含中继）', '集群指挥车', '后方通信车', '天通卫星', '神通卫星'])
    expect(numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-sat_link-txFrequency').props('modelValue')).toBe(14200)
    // C/L 波段速率按模板 bit/s 档位显示。
    expect(select(wrapper, 'port-MISSION_UAV_PLATFORM-c_band_uplink-transferRate').props('modelValue')).toBe(2)
    expect(wrapper.text()).toContain('2000000 bit/s（2 Mbps）')
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' }).filter(item => item.attributes('data-testid')?.startsWith('antenna-gain-'))).toHaveLength(12)
    expect(numberInput(wrapper, 'antenna-gain-C_BAND_DIRECTIONAL_UAV_ANTENNA').props('modelValue')).toBe(25)
    expect(wrapper.text()).toContain('激光通信')
    expect(wrapper.text()).not.toContain('激光链路不写入脚本')

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="port-COMMAND_VEHICLE_PLATFORM-fiber_link-transferRate"]').text()).toContain('模板固定')
    expect(wrapper.find('[data-testid="port-COMMAND_VEHICLE_PLATFORM-fiber_link-txFrequency"]').exists()).toBe(false)

    await wrapper.findAll('[role="tab"]')[3]!.trigger('click')
    await flushPromises()
    // 天通速率按 kbps 显示，领域值仍为 Mbps。
    expect(numberInput(wrapper, 'port-TIAN_TONG_SAT-sat_link-transferRate').props('modelValue')).toBe(16)
  })

  it('编辑端口写回完整端口参数，未编辑的端口与天线保持缺省；速率按端口单位换算', async () => {
    const wrapper = await mountPanel()
    numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-microwave_link-txPower').vm.$emit('update:modelValue', 25)
    const value = lastValue(wrapper)
    expect(Object.keys(value.ports!)).toEqual(['MISSION_UAV_PLATFORM'])
    expect(value.ports!.MISSION_UAV_PLATFORM).toEqual({ microwave_link: { ...readDeviceParameters({}).ports.MISSION_UAV_PLATFORM!.microwave_link!, txPower: 25 } })
    expect(value).not.toHaveProperty('antennaGains')

    await wrapper.setProps({ modelValue: value })
    select(wrapper, 'port-MISSION_UAV_PLATFORM-c_band_downlink-transferRate').vm.$emit('update:modelValue', 16)
    expect(lastValue(wrapper).ports!.MISSION_UAV_PLATFORM!.c_band_downlink!.transferRate).toBe(16)
    expect(lastValue(wrapper).ports!.MISSION_UAV_PLATFORM!.microwave_link!.txPower).toBe(25)

    numberInput(wrapper, 'antenna-gain-LASER_COMM_ANTENNA').vm.$emit('update:modelValue', 38)
    expect(lastValue(wrapper).antennaGains).toEqual({ LASER_COMM_ANTENNA: 38 })
  })

  it('清空输入不回填默认值，写入后由场景校验在原位提示', async () => {
    const wrapper = await mountPanel()
    numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-sat_link-txBandwidth').vm.$emit('update:modelValue', null)
    const value = lastValue(wrapper)
    expect(Number.isNaN(value.ports!.MISSION_UAV_PLATFORM!.sat_link!.txBandwidth)).toBe(true)
    const config = { ...structuredClone(fixtureSource.scenario) as ScenarioConfig, deviceParameters: value }
    const issues = inspectScenarioConfig(config, 'write').result.errors
    const path = 'deviceParameters.ports.MISSION_UAV_PLATFORM.sat_link.txBandwidth'
    expect(issues.map(issue => issue.fieldPath)).toContain(path)

    const message = issues.find(issue => issue.fieldPath === path)!.message
    const shown = await mountPanel({ modelValue: value, fieldMessage: (fieldPath: string) => fieldPath === path ? message : '' })
    expect(numberInput(shown, 'port-MISSION_UAV_PLATFORM-sat_link-txBandwidth').props('modelValue')).toBeUndefined()
    expect(shown.find('.el-form-item__error').text()).toBe(message)
  })

  it('应用设备参数写入来源快照并锁定引用字段，取消引用后可编辑；未保存场景不能引用', async () => {
    const equipment = {
      equipmentId: 'EQ-SAT-01', type: '卫星通信设备', version: 3, active: true, readOnly: false, modulation: 'QPSK', berThreshold: 0.001,
      frequencyMinMHz: 14000, frequencyMaxMHz: 14500, bandwidthMHz: 30, txPowerW: 40, dataRateMbps: 12,
    } as EquipmentParameter
    const catalog = { equipment: [equipment], masterData: [] } as ScenarioParameterCatalog
    const locked = await mountPanel({ parameterCatalog: catalog, referenceDisabled: true })
    expect(select(locked, 'port-source-select-MISSION_UAV_PLATFORM-sat_link').props('disabled')).toBe(true)
    expect(locked.text()).toContain('请先保存场景，再引用基础数据。')

    const wrapper = await mountPanel({ parameterCatalog: catalog })
    select(wrapper, 'port-source-select-MISSION_UAV_PLATFORM-sat_link').vm.$emit('change', 'EQUIPMENT:EQ-SAT-01')
    await flushPromises()
    const error = wrapper.find('[data-testid="port-source-error-MISSION_UAV_PLATFORM-sat_link"]')
    if (error.exists()) throw new Error(`设备参数未应用：${error.text()}`)
    const value = lastValue(wrapper)
    expect(value.ports!.MISSION_UAV_PLATFORM!.sat_link).toMatchObject({
      txBandwidth: 30, txPower: 40, transferRate: 12,
      parameterSource: { kind: 'EQUIPMENT', sourceId: 'EQ-SAT-01', sourceVersion: 3 },
    })
    await wrapper.setProps({ modelValue: value })
    expect(wrapper.get('[data-testid="port-source-MISSION_UAV_PLATFORM-sat_link"]').text()).toContain('EQ-SAT-01 · v3')
    expect(numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-sat_link-txPower').props('disabled')).toBe(true)
    // 未引用的字段（接收频率）仍可编辑。
    expect(numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-sat_link-rxFrequency').props('disabled')).toBe(false)

    await wrapper.get('[data-testid="port-source-clear-MISSION_UAV_PLATFORM-sat_link"]').trigger('click')
    const cleared = lastValue(wrapper).ports!.MISSION_UAV_PLATFORM!.sat_link!
    expect(cleared).not.toHaveProperty('parameterSource')
    expect(cleared.txPower).toBe(40)
  })

  it('装备类型与端口不符时原位提示，不写入参数', async () => {
    const equipment = { equipmentId: 'EQ-MW-01', type: '微波通信设备', version: 1, active: true, readOnly: false, modulation: 'QPSK', berThreshold: 0.001,
      frequencyMinMHz: 8000, frequencyMaxMHz: 8500, bandwidthMHz: 40, txPowerW: 10, dataRateMbps: 50 } as EquipmentParameter
    const wrapper = await mountPanel({ parameterCatalog: { equipment: [equipment], masterData: [] } as ScenarioParameterCatalog })
    select(wrapper, 'port-source-select-MISSION_UAV_PLATFORM-sat_link').vm.$emit('change', 'EQUIPMENT:EQ-MW-01')
    await flushPromises()
    expect(wrapper.get('[data-testid="port-source-error-MISSION_UAV_PLATFORM-sat_link"]').text()).toContain('装备类型与通信端口不符')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})


it('EIRP 与 G/T 可编辑有符号值，新增全向天线且保留三项旧天线', async () => {
  const wrapper = await mountPanel()
  for (const [field, value] of [['eirpDbw', -5], ['gtDbk', -10]] as const) {
    const input = numberInput(wrapper, `port-MISSION_UAV_PLATFORM-microwave_link-${field}`)
    expect(input.props('min')).toBeLessThan(-10)
    input.vm.$emit('update:modelValue', value)
    expect(lastValue(wrapper).ports!.MISSION_UAV_PLATFORM!.microwave_link![field]).toBe(value)
    await wrapper.setProps({ modelValue: lastValue(wrapper) })
  }
  for (const name of ['OMNI_ANTENNA', 'MICRO_UAV_OMNI_ANTENNA', 'MICRO_REAR_PLATFORM_DIR_ANTENNA', 'OMNI_ANTENNA_HIGHGAIN']) expect(numberInput(wrapper, `antenna-gain-${name}`)).toBeDefined()
  wrapper.unmount()
})
