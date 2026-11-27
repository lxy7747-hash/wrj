import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import type { DeviceParameters } from '../../src/contracts/domain-models'
import DeviceParametersPanel from '../../src/components/scenarios/DeviceParametersPanel.vue'
import { readDeviceParameters } from '../../src/features/scenarios/template-defaults'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ScenarioConfig } from '../../src/contracts/domain-models'

async function mountPanel(props: { modelValue?: DeviceParameters, fieldMessage?: (path: string) => string, disabled?: boolean } = {}) {
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
  it('缺省时按模板默认值展示五类平台端口与 2 个仍在用的非端口天线增益，光纤只读', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual(['任务无人机（含中继）', '集群指挥车', '后方通信车', '天通卫星', '神通卫星'])
    expect(numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-sat_link-txFrequency').props('modelValue')).toBe(20000)
    // C/L 波段速率按模板 bit/s 档位显示。
    expect(select(wrapper, 'port-MISSION_UAV_PLATFORM-c_band_uplink-transferRate').props('modelValue')).toBe(2)
    expect(wrapper.text()).toContain('2 Mbps')
    expect(wrapper.findAllComponents({ name: 'ElInputNumber' }).filter(item => item.attributes('data-testid')?.startsWith('antenna-gain-'))).toHaveLength(1)
    expect(numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-c_band_uplink-peakGainDb').props('modelValue')).toBe(5)
    expect(numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-lazer_link-peakGainDb').props('modelValue')).toBe(45)
    expect(wrapper.text()).toContain('激光通信')
    expect(wrapper.text()).not.toContain('激光链路不写入脚本')
    expect(wrapper.text()).not.toMatch(/sat_link|microwave_link|peak_gain/)

    await wrapper.findAll('[role="tab"]')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="port-COMMAND_VEHICLE_PLATFORM-fiber_link-transferRate"]').text()).toBe('1000 Mbps（固定）')
    expect(wrapper.find('[data-testid="port-COMMAND_VEHICLE_PLATFORM-fiber_link-txFrequency"]').exists()).toBe(false)

    await wrapper.findAll('[role="tab"]')[3]!.trigger('click')
    await flushPromises()
    // 天通速率按 kbps 显示（16000 kbps = 16 Mbps），领域值仍为 Mbps。
    expect(numberInput(wrapper, 'port-TIAN_TONG_SAT-sat_link-transferRate').props('modelValue')).toBe(16000)
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

    numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-lazer_link-peakGainDb').vm.$emit('update:modelValue', 38)
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
})


it('在端口参数设置中直接展示 EIRP、G/T 与峰值增益并支持编辑，同时保留折叠的天线模型表', async () => {
  const unconfigured = await mountPanel({ modelValue: undefined })
  expect(numberInput(unconfigured, 'port-MISSION_UAV_PLATFORM-microwave_link-peakGainDb')?.props('modelValue')).toBe(25)
  unconfigured.unmount()

  const modelValue = readDeviceParameters({})
  Object.assign(modelValue.ports.MISSION_UAV_PLATFORM!.microwave_link!, { eirpDbw: -5, gtDbk: -10 })
  const before = structuredClone(modelValue)
  const wrapper = await mountPanel({ modelValue })
  expect(numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-microwave_link-eirpDbw')?.props('modelValue')).toBe(-5)
  expect(numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-microwave_link-gtDbk')?.props('modelValue')).toBe(-10)
  expect(numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-microwave_link-peakGainDb')?.props('modelValue')).toBe(30)
  expect(wrapper.get('[data-testid="antenna-advanced"]').attributes('open')).toBeUndefined()
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-microwave_link-txPower').vm.$emit('update:modelValue', 25)
  expect(lastValue(wrapper).ports!.MISSION_UAV_PLATFORM!.microwave_link!).toMatchObject({ eirpDbw: -5, gtDbk: -10, txPower: 25 })
  numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-microwave_link-eirpDbw').vm.$emit('update:modelValue', 12)
  expect(lastValue(wrapper).ports!.MISSION_UAV_PLATFORM!.microwave_link!).toMatchObject({ eirpDbw: 12 })
  numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-microwave_link-peakGainDb').vm.$emit('update:modelValue', 9)
  expect(lastValue(wrapper).antennaGains?.OMNI_ANTENNA).toBe(9)
  expect(modelValue).toEqual(before)
  expect(numberInput(wrapper, 'antenna-gain-OMNI_ANTENNA_HIGHGAIN')).toBeDefined()
  expect(numberInput(wrapper, 'port-MISSION_UAV_PLATFORM-lazer_link-peakGainDb')).toBeDefined()
  for (const name of ['OMNI_ANTENNA', 'C_BAND_DIRECTIONAL_UAV_ANTENNA', 'SAT_UAV_CLUSTER_WIDEBAND_ANTENNA', 'MICRO_UAV_OMNI_ANTENNA', 'MICRO_REAR_PLATFORM_DIR_ANTENNA', 'LASER_COMM_ANTENNA']) {
    expect(numberInput(wrapper, `antenna-gain-${name}`)).toBeUndefined()
  }
  wrapper.unmount()
})

it('端口与天线字段校验异常时可定位并展开对应区域', async () => {
  const modelValue = readDeviceParameters({})
  modelValue.ports.TIAN_TONG_SAT!.sat_link!.eirpDbw = Number.NaN
  const wrapper = await mountPanel({ modelValue, fieldMessage: path => path === 'deviceParameters.ports.TIAN_TONG_SAT.sat_link.eirpDbw' ? '必须为有限数值' : '' })
  wrapper.vm.revealField('deviceParameters.ports.TIAN_TONG_SAT.sat_link.eirpDbw')
  await flushPromises()
  numberInput(wrapper, 'port-TIAN_TONG_SAT-sat_link-eirpDbw').vm.$emit('update:modelValue', -5)
  expect(lastValue(wrapper).ports!.TIAN_TONG_SAT!.sat_link!.eirpDbw).toBe(-5)
  wrapper.vm.revealField('deviceParameters.antennaGains.OMNI_ANTENNA_HIGHGAIN')
  await flushPromises()
  expect(wrapper.get('[data-testid="antenna-advanced"]').attributes('open')).toBeDefined()
  wrapper.unmount()
})
