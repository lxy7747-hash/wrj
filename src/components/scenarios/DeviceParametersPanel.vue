<script setup lang="ts">
import { computed, ref, toRaw } from 'vue'
import type { DeviceParameters, PortParameters, TemplateAntennaName, TemplatePlatformType } from '../../contracts/domain-models'
import { readDeviceParameters, TEMPLATE_ANTENNA_NAMES, TEMPLATE_PLATFORM_TYPES, TEMPLATE_PORT_PARAMS, templatePortAntennaName } from '../../features/scenarios/template-defaults'
import { datalinkRateTiers, formatDataRate } from '../../features/scenarios/link-calc-defaults'

const props = defineProps<{
  modelValue?: DeviceParameters
  section?: 'all' | 'ports' | 'antennas'
  disabled?: boolean
  /** 按字段路径读取校验消息，路径以 deviceParameters. 开头。 */
  fieldMessage: (fieldPath: string) => string
}>()

const sectionMode = computed(() => props.section ?? 'all')

const emit = defineEmits<{
  'update:modelValue': [value: DeviceParameters]
}>()

type PortKey = Exclude<keyof PortParameters, 'parameterSource'>

const PLATFORM_LABELS: Record<TemplatePlatformType, string> = {
  MISSION_UAV_PLATFORM: '任务无人机（含中继）',
  COMMAND_VEHICLE_PLATFORM: '集群指挥车',
  REAR_COMM_PLATFORM: '后方通信车',
  TIAN_TONG_SAT: '天通卫星',
  SHEN_TONG_SAT: '神通卫星',
}
const PORT_LABELS: Record<string, string> = {
  sat_link: '卫通', sat_link_a: '卫通 A（前向）', sat_link_b: '卫通 B（返向）', microwave_link: '微波',
  c_band_uplink: 'C 波段上行', c_band_downlink: 'C 波段下行', l_band_uplink: 'L 波段上行', l_band_downlink: 'L 波段下行',
  lazer_link: '激光通信',
  fiber_link: '光纤',
}
const ANTENNA_USAGE: Record<TemplateAntennaName, string> = {
  OMNI_ANTENNA: '通用全向天线',
  MICRO_UAV_OMNI_ANTENNA: '任务无人机微波宽波束天线',
  MICRO_REAR_PLATFORM_DIR_ANTENNA: '后方通信车微波定向天线',
  OMNI_ANTENNA_HIGHGAIN: '干扰设备高增益全向天线',
  C_BAND_DIRECTIONAL_VEHICLE_ANTENNA: '集群指挥车 C 波段定向天线',
  C_BAND_DIRECTIONAL_UAV_ANTENNA: '任务无人机 C 波段天线',
  L_BAND_DIRECTIONAL_VEHICLE_ANTENNA: '集群指挥车 L 波段定向天线',
  L_BAND_DIRECTIONAL_UAV_ANTENNA: '任务无人机 L 波段全向天线',
  SAT_GROUND_MOBILE_ANTENNA: '后方通信车卫通动中通天线',
  SAT_SPACE_BEAM_ANTENNA: '卫星星载点波束天线',
  SAT_UAV_CLUSTER_WIDEBAND_ANTENNA: '任务无人机卫通宽波束天线',
  LASER_COMM_ANTENNA: '任务无人机激光通信天线',
}
const COLUMN_GROUPS: readonly {
  label: string
  theme: 'tx' | 'rx'
  columns: readonly { key: Exclude<PortKey, 'transferRate'>; label: string; min?: number }[]
}[] = [
  {
    label: '发射端',
    theme: 'tx',
    columns: [
      { key: 'txFrequency', label: '发射频率（MHz）', min: 0 },
      { key: 'txBandwidth', label: '发射带宽（MHz）', min: 0 },
      { key: 'txPower', label: '发射功率（W）', min: 0 },
      { key: 'eirpDbw', label: 'EIRP（dBW）' },
    ],
  },
  {
    label: '接收端',
    theme: 'rx',
    columns: [
      { key: 'rxFrequency', label: '接收频率（MHz）', min: 0 },
      { key: 'rxBandwidth', label: '接收带宽（MHz）', min: 0 },
      { key: 'noiseFigureDb', label: '噪声系数（dB）', min: 0 },
      { key: 'gtDbk', label: 'G/T（dB/K）' },
    ],
  },
]

const activeType = ref<TemplatePlatformType>('MISSION_UAV_PLATFORM')

const resolved = computed(() => readDeviceParameters({ deviceParameters: props.modelValue }))
const rows = (type: TemplatePlatformType) => Object.entries(resolved.value.ports[type]).map(([port, parameters]) => ({ port, parameters }))
const portUsedAntennas = computed(() => {
  const used = new Set<TemplateAntennaName>()
  for (const type of TEMPLATE_PLATFORM_TYPES) {
    for (const port of Object.keys(resolved.value.ports[type])) {
      if (port !== 'fiber_link') used.add(templatePortAntennaName(type, port))
    }
  }
  return used
})
const UNUSED_TEMPLATE_ANTENNAS: ReadonlySet<TemplateAntennaName> = new Set([
  'MICRO_UAV_OMNI_ANTENNA',
  'MICRO_REAR_PLATFORM_DIR_ANTENNA',
])
const antennaRows = computed(() => TEMPLATE_ANTENNA_NAMES
  .filter(name => sectionMode.value !== 'all' || (!portUsedAntennas.value.has(name) && (!UNUSED_TEMPLATE_ANTENNAS.has(name) || Boolean(props.fieldMessage(`deviceParameters.antennaGains.${name}`)))))
  .map(name => ({ name, gain: resolved.value.antennaGains[name] ?? 0 })))

function rateTiers(port: string): readonly number[] {
  const match = /^([cl])_band_(uplink|downlink)$/u.exec(port)
  return match ? datalinkRateTiers(match[1]!.toUpperCase() as 'C' | 'L', match[2] === 'uplink' ? 'FORWARD' : 'REVERSE') : []
}
const tierLabel = (mbps: number) => formatDataRate(mbps)
const path = (type: TemplatePlatformType, port: string, key?: string) => `deviceParameters.ports.${type}.${port}${key ? `.${key}` : ''}`
const antennaAdvancedOpen = ref(false)
function handleAntennaToggle(event: Event): void {
  antennaAdvancedOpen.value = (event.target as HTMLDetailsElement | null)?.open ?? false
}
const portAntennaName = templatePortAntennaName
function templatePortPeakGain(type: TemplatePlatformType, port: string): number | undefined {
  return TEMPLATE_PORT_PARAMS.find(entry => entry.platform_type === type)
    ?.comm_params.find(item => item.comm_name === port)?.transmitter.peak_gain_dB
}
function effectivePortPeakGain(type: TemplatePlatformType, port: string): number | undefined {
  const antenna = portAntennaName(type, port)
  const explicit = props.modelValue?.antennaGains
  if (explicit && Object.hasOwn(explicit, antenna)) return explicit[antenna]
  return templatePortPeakGain(type, port) ?? resolved.value.antennaGains[antenna]
}
function revealField(fieldPath: string): void {
  if (fieldPath.startsWith('deviceParameters.antennaGains.')) {
    const antennaName = fieldPath.split('.').at(-1) as TemplateAntennaName
    if (sectionMode.value === 'all' && portUsedAntennas.value.has(antennaName)) {
      const matchType = TEMPLATE_PLATFORM_TYPES.find(type =>
        Object.keys(resolved.value.ports[type]).some(port => port !== 'fiber_link' && portAntennaName(type, port) === antennaName))
      if (matchType) activeType.value = matchType
      return
    }
    antennaAdvancedOpen.value = true
    return
  }
  if (fieldPath.startsWith('deviceParameters.antennaGains')) {
    antennaAdvancedOpen.value = true
    return
  }
  const type = /^deviceParameters\.ports\.([^.]+)/.exec(fieldPath)?.[1]
  if (TEMPLATE_PLATFORM_TYPES.includes(type as TemplatePlatformType)) activeType.value = type as TemplatePlatformType
}
defineExpose({ revealField })

/**
 * 写回完整端口参数。存储层要求端口对象包含全部 7 个字段，所以以补齐默认值后的副本为基础；
 * 未编辑过的端口和天线保持缺省，由读取函数补默认值。
 */
function current(): DeviceParameters {
  return props.modelValue ? structuredClone(toRaw(props.modelValue)) : {}
}
function writePort(type: TemplatePlatformType, port: string, parameters: PortParameters): void {
  const next = current()
  next.ports = { ...next.ports, [type]: { ...next.ports?.[type], [port]: parameters } }
  emit('update:modelValue', next)
}
function updatePort(type: TemplatePlatformType, port: string, key: PortKey, value: number | null | undefined): void {
  const parameters = structuredClone(toRaw(resolved.value.ports[type][port]!))
  // 界面已不再提供端口装备引用；手工修改端口数值时清除历史来源，避免保存时与旧来源快照不一致。
  delete parameters.parameterSource
  // 清空输入时写 NaN 交给校验原位提示，不悄悄回填默认值。
  parameters[key] = value === null || value === undefined ? Number.NaN : value
  writePort(type, port, parameters)
}
function updateGain(name: TemplateAntennaName, value: number | null | undefined): void {
  const next = current()
  next.antennaGains = { ...next.antennaGains, [name]: value === null || value === undefined ? Number.NaN : value }
  emit('update:modelValue', next)
}

</script>

<template>
  <div class="device-parameters" data-testid="device-parameters-panel">
    <template v-if="sectionMode !== 'antennas'">
    <div class="device-parameters__card">
    <el-tabs v-model="activeType" class="device-parameters__tabs" aria-label="通信平台类型">
      <el-tab-pane v-for="type in TEMPLATE_PLATFORM_TYPES" :key="type" :label="PLATFORM_LABELS[type]" :name="type">
        <el-table v-if="activeType === type" :data="rows(type)" row-key="port" border class="device-parameters__ports-table" :data-testid="`device-ports-${type}`">
          <el-table-column label="端口" min-width="116" fixed="left">
            <template #default="{ row }">
              <div class="device-parameters__port-name">{{ PORT_LABELS[row.port] ?? row.port }}</div>
            </template>
          </el-table-column>
          <el-table-column v-for="group in COLUMN_GROUPS" :key="group.label" :label="group.label" align="center"
            :label-class-name="`device-group-header device-group-header--${group.theme} device-group-start device-group-start--${group.theme}`">
            <el-table-column v-for="(column, columnIndex) in group.columns" :key="column.key" :label="column.label" min-width="108"
              :class-name="columnIndex === 0 ? `device-group-start device-group-start--${group.theme}` : undefined">
              <template #default="{ row }">
                <span v-if="row.port === 'fiber_link'" class="device-parameters__fixed">—</span>
                <el-form-item v-else class="device-parameters__field" :error="fieldMessage(path(type, row.port, column.key))">
                  <el-input-number :model-value="Number.isNaN(row.parameters[column.key]) ? undefined : row.parameters[column.key]" :min="column.min" :step="column.key === 'noiseFigureDb' ? 0.1 : 1"
                    :disabled="disabled" controls-position="right" :aria-label="`${PORT_LABELS[row.port]}${column.label}`"
                    :data-testid="`port-${type}-${row.port}-${column.key}`" @update:model-value="value => updatePort(type, row.port, column.key, value)" />
                </el-form-item>
              </template>
            </el-table-column>
          </el-table-column>
          <el-table-column label="收发共用" align="center" label-class-name="device-group-header device-group-header--shared device-group-start device-group-start--shared">
            <el-table-column label="天线峰值增益（dB）" min-width="124" class-name="device-group-start device-group-start--shared">
              <template #default="{ row }">
                <span v-if="row.port === 'fiber_link'" class="device-parameters__fixed">—</span>
                <el-form-item v-else class="device-parameters__field" :error="fieldMessage(`deviceParameters.antennaGains.${portAntennaName(type, row.port)}`)">
                  <el-input-number :model-value="effectivePortPeakGain(type, row.port) !== undefined && Number.isNaN(effectivePortPeakGain(type, row.port)) ? undefined : effectivePortPeakGain(type, row.port)"
                    :step="0.5" :disabled="disabled" controls-position="right" :title="`对应天线模型：${portAntennaName(type, row.port)}`"
                    :aria-label="`${PORT_LABELS[row.port]}天线峰值增益（dB）`" :data-testid="`port-${type}-${row.port}-peakGainDb`"
                    @update:model-value="value => updateGain(portAntennaName(type, row.port), value)" />
                </el-form-item>
              </template>
            </el-table-column>
            <el-table-column label="传输速率" min-width="172">
              <template #default="{ row }">
                <span v-if="row.port === 'fiber_link'" class="device-parameters__fixed" :data-testid="`port-${type}-fiber_link-transferRate`">1000 Mbit/s（固定）</span>
                <el-form-item v-else class="device-parameters__field" :error="fieldMessage(path(type, row.port, 'transferRate'))">
                  <div class="device-parameters__rate">
                    <el-select v-if="rateTiers(row.port).length" :model-value="row.parameters.transferRate" :disabled="disabled"
                      :aria-label="`${PORT_LABELS[row.port]}传输速率`" :data-testid="`port-${type}-${row.port}-transferRate`"
                      @update:model-value="(value: number) => updatePort(type, row.port, 'transferRate', value)">
                      <el-option v-for="tier in rateTiers(row.port)" :key="tier" :label="tierLabel(tier)" :value="tier" />
                      <el-option v-if="!rateTiers(row.port).includes(row.parameters.transferRate)" :label="`${tierLabel(row.parameters.transferRate)}（不在档位内）`" :value="row.parameters.transferRate" />
                    </el-select>
                    <el-input-number v-else :model-value="Number.isNaN(row.parameters.transferRate) ? undefined : row.parameters.transferRate" :min="0"
                      :disabled="disabled" controls-position="right" :aria-label="`${PORT_LABELS[row.port]}传输速率`"
                      :data-testid="`port-${type}-${row.port}-transferRate`" @update:model-value="value => updatePort(type, row.port, 'transferRate', value)" />
                    <small v-if="!rateTiers(row.port).length" class="device-parameters__unit">Mbit/s</small>
                  </div>
                </el-form-item>
              </template>
            </el-table-column>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
    </div>
    </template>

    <details v-if="sectionMode === 'all'" class="scenario-advanced" data-testid="antenna-advanced" :open="antennaAdvancedOpen || antennaRows.some(row => fieldMessage(`deviceParameters.antennaGains.${row.name}`))" @toggle="handleAntennaToggle">
      <summary>其他天线模型与增益</summary>
      <div class="device-parameters__antenna-list" data-testid="antenna-gain-table">
        <div class="device-parameters__antenna-row device-parameters__antenna-row--head"><span>名称</span><span>天线峰值增益（dB）</span></div>
        <div v-for="row in antennaRows" :key="row.name" class="device-parameters__antenna-row">
          <span class="device-parameters__antenna-name">{{ ANTENNA_USAGE[row.name as TemplateAntennaName] }}</span>
          <el-form-item class="device-parameters__field" :error="fieldMessage(`deviceParameters.antennaGains.${row.name}`)">
            <el-input-number :model-value="Number.isNaN(row.gain) ? undefined : row.gain" :step="0.5" :disabled="disabled" controls-position="right"
              :aria-label="`${ANTENNA_USAGE[row.name as TemplateAntennaName]}天线峰值增益`" :data-testid="`antenna-gain-${row.name}`" @update:model-value="value => updateGain(row.name, value)" />
          </el-form-item>
        </div>
      </div>
    </details>
    <div v-else-if="sectionMode === 'antennas'" class="device-parameters__antenna-list" data-testid="antenna-gain-table">
      <div class="device-parameters__antenna-row device-parameters__antenna-row--head"><span>名称</span><span>天线峰值增益（dB）</span></div>
      <div v-for="row in antennaRows" :key="row.name" class="device-parameters__antenna-row">
        <span class="device-parameters__antenna-name">{{ ANTENNA_USAGE[row.name as TemplateAntennaName] }}</span>
        <el-form-item class="device-parameters__field" :error="fieldMessage(`deviceParameters.antennaGains.${row.name}`)">
          <el-input-number :model-value="Number.isNaN(row.gain) ? undefined : row.gain" :step="0.5" :disabled="disabled" controls-position="right"
            :aria-label="`${ANTENNA_USAGE[row.name as TemplateAntennaName]}天线峰值增益`" :data-testid="`antenna-gain-${row.name}`" @update:model-value="value => updateGain(row.name, value)" />
        </el-form-item>
      </div>
    </div>
  </div>
</template>

<style scoped>
.device-parameters { display: grid; gap: 0.8rem; min-width: 0; }
.device-parameters__card {
  min-width: 0;
  padding: 0.55rem 0.85rem 0.85rem;
  border: 1px solid var(--console-border);
  border-radius: 8px;
  background: rgb(8 25 40 / 48%);
}
.device-parameters__tabs :deep(.el-tabs__header) { margin-bottom: 0.7rem; }
.device-parameters__tabs :deep(.el-tabs__nav-wrap::after) { background-color: var(--console-border); }
.device-parameters__tabs :deep(.el-tabs__item) { font-size: 13px; font-weight: 500; }
.device-parameters__port-name { color: var(--console-text); font-size: 12px; font-weight: 600; line-height: 1.4; }
.device-parameters__hint { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; }
.device-parameters__rate { display: flex; align-items: center; gap: 5px; width: 100%; flex-wrap: nowrap; }
.device-parameters__rate :deep(.el-input-number), .device-parameters__rate :deep(.el-select) { flex: 1 1 0; min-width: 0; }
.device-parameters__unit { flex-shrink: 0; white-space: nowrap; color: var(--el-text-color-secondary); font-size: 12px; }
.device-parameters__fixed { white-space: nowrap; color: var(--el-text-color-secondary); font-size: 12px; }
.device-parameters__field { margin-bottom: 0; }
.device-parameters__field :deep(.el-form-item__error) { position: static; margin-top: 2px; line-height: 1.3; }
.device-parameters__field :deep(.el-input-number), .device-parameters__field :deep(.el-select) { width: 100%; }
.device-parameters__ports-table :deep(.el-table__cell) { padding: 7px 0; }
.device-parameters__ports-table :deep(.cell) { padding-inline: 6px; }
.device-parameters__ports-table :deep(.el-input-number.is-controls-right .el-input__wrapper) { padding-inline: 6px 26px; }
.device-parameters__ports-table :deep(.el-input-number__increase),
.device-parameters__ports-table :deep(.el-input-number__decrease) { width: 22px; }
.device-parameters__source { display: grid; gap: 4px; }
.device-parameters__error { color: var(--el-color-danger); font-size: 12px; }
.device-parameters > .scenario-advanced { margin: 0; }
.device-parameters__antenna-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem 0.9rem;
  min-width: 0;
  max-width: 100%;
  overflow-x: hidden;
}
.device-parameters__antenna-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 170px;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--console-border);
  border-radius: 6px;
  background: rgb(6 20 34 / 58%);
}
.device-parameters__antenna-row--head {
  grid-column: 1 / -1;
  padding: 0 0.25rem 0.35rem;
  border: 0;
  border-bottom: 1px dashed var(--console-border);
  border-radius: 0;
  background: transparent;
  color: var(--console-text-muted);
  font-size: 12px;
  font-weight: 600;
}
.device-parameters__antenna-name { min-width: 0; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.device-parameters__ports-table :deep(th.device-group-header) {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
.device-parameters__ports-table :deep(th.device-group-header--tx) {
  color: var(--console-cyan);
  background-color: rgba(66, 216, 255, 0.14) !important;
  box-shadow: inset 0 -2px 0 rgba(66, 216, 255, 0.65);
}
.device-parameters__ports-table :deep(th.device-group-header--rx) {
  color: var(--console-teal);
  background-color: rgba(77, 224, 181, 0.14) !important;
  box-shadow: inset 0 -2px 0 rgba(77, 224, 181, 0.65);
}
.device-parameters__ports-table :deep(th.device-group-header--shared) {
  color: var(--console-amber);
  background-color: rgba(246, 184, 75, 0.14) !important;
  box-shadow: inset 0 -2px 0 rgba(246, 184, 75, 0.65);
}
.device-parameters__ports-table :deep(.device-group-start--tx) {
  border-left: 2px solid rgba(66, 216, 255, 0.45) !important;
}
.device-parameters__ports-table :deep(.device-group-start--rx) {
  border-left: 2px solid rgba(77, 224, 181, 0.45) !important;
}
.device-parameters__ports-table :deep(.device-group-start--shared) {
  border-left: 2px solid rgba(246, 184, 75, 0.45) !important;
}
@media (max-width: 820px) {
  .device-parameters__antenna-list { grid-template-columns: 1fr; }
}
</style>
