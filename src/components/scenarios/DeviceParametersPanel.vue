<script setup lang="ts">
import { computed, ref, toRaw } from 'vue'
import type {
  CapabilityState, DeviceParameters, EquipmentParameter, LinkParameterField, MasterData, PortParameters,
  ScenarioParameterCatalog, TemplateAntennaName, TemplatePlatformType,
} from '../../contracts/domain-models'
import { readDeviceParameters, TEMPLATE_ANTENNA_NAMES, TEMPLATE_PLATFORM_TYPES } from '../../features/scenarios/template-defaults'
import { datalinkRateTiers, formatDataRate } from '../../features/scenarios/link-calc-defaults'
import { preparePortEquipment, preparePortMasterData, PORT_SOURCE_FIELDS } from '../../features/scenarios/port-parameter-source'

const props = defineProps<{
  modelValue?: DeviceParameters
  disabled?: boolean
  /** 按字段路径读取校验消息，路径以 deviceParameters. 开头。 */
  fieldMessage: (fieldPath: string) => string
  parameterCatalog?: ScenarioParameterCatalog | null
  parameterCatalogState?: CapabilityState
  parameterCatalogMessage?: string
  /** 场景尚未保存时不能引用基础数据（服务端按场景修订登记引用）。 */
  referenceDisabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: DeviceParameters]
  'load-parameters': []
}>()

type PortKey = Exclude<keyof PortParameters, 'parameterSource'>
type RateUnit = 'bit/s' | 'kbits/sec' | 'mbits/sec'

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
  fiber_link: '光纤',
}
const ANTENNA_USAGE: Record<TemplateAntennaName, string> = {
  OMNI_ANTENNA: '全向天线（OMNI_ANTENNA）',
  MICRO_UAV_OMNI_ANTENNA: '任务无人机机载微波宽波束',
  MICRO_REAR_PLATFORM_DIR_ANTENNA: '后方通信车微波定向',
  OMNI_ANTENNA_HIGHGAIN: '干扰设备高增益全向',
  C_BAND_DIRECTIONAL_VEHICLE_ANTENNA: '集群指挥车 C 波段定向',
  C_BAND_DIRECTIONAL_UAV_ANTENNA: '任务无人机 C 波段',
  L_BAND_DIRECTIONAL_VEHICLE_ANTENNA: '集群指挥车 L 波段定向跟踪',
  L_BAND_DIRECTIONAL_UAV_ANTENNA: '任务无人机 L 波段全向',
  SAT_GROUND_MOBILE_ANTENNA: '后方通信车卫通动中通',
  SAT_SPACE_BEAM_ANTENNA: '卫星星载对地点波束',
  SAT_UAV_CLUSTER_WIDEBAND_ANTENNA: '任务无人机机载卫通宽波束',
  LASER_COMM_ANTENNA: '激光通信',
}
const NUMBER_COLUMNS: readonly { key: Exclude<PortKey, 'transferRate'>; label: string; min?: number }[] = [
  { key: 'txFrequency', label: '发射频率（MHz）', min: 0 },
  { key: 'txBandwidth', label: '发射带宽（MHz）', min: 0 },
  { key: 'txPower', label: '发射功率（W）', min: 0 },
  { key: 'rxFrequency', label: '接收频率（MHz）', min: 0 },
  { key: 'rxBandwidth', label: '接收带宽（MHz）', min: 0 },
  { key: 'noiseFigureDb', label: '噪声系数（dB）', min: 0 },
  { key: 'eirpDbw', label: 'EIRP（dBW）' },
  { key: 'gtDbk', label: 'G/T（dB/K）' },
]

const activeType = ref<TemplatePlatformType>('MISSION_UAV_PLATFORM')
/** 每个端口当前选择的基础数据项，键为 `${平台类型}/${端口}`。 */
const selections = ref<Record<string, string>>({})
const sourceErrors = ref<Record<string, string>>({})

const resolved = computed(() => readDeviceParameters({ deviceParameters: props.modelValue }))
const rows = (type: TemplatePlatformType) => Object.entries(resolved.value.ports[type]).map(([port, parameters]) => ({ port, parameters }))
const antennaRows = computed(() => TEMPLATE_ANTENNA_NAMES.map(name => ({ name, gain: resolved.value.antennaGains[name] ?? 0 })))
const parameterLoading = computed(() => ['LOADING', 'VALIDATING'].includes(props.parameterCatalogState ?? 'EMPTY'))

/** 速率写法与生成器一致：C/L 波段与光纤为 bit/s，天通 kbits/sec，其余 mbits/sec。 */
function rateUnit(type: TemplatePlatformType, port: string): RateUnit {
  if (port === 'fiber_link' || /^[cl]_band_/u.test(port)) return 'bit/s'
  return type === 'TIAN_TONG_SAT' ? 'kbits/sec' : 'mbits/sec'
}
function displayRate(type: TemplatePlatformType, port: string, mbps: number): number {
  const unit = rateUnit(type, port)
  return unit === 'bit/s' ? mbps * 1_000_000 : unit === 'kbits/sec' ? mbps * 1_000 : mbps
}
function fromDisplayRate(type: TemplatePlatformType, port: string, value: number): number {
  const unit = rateUnit(type, port)
  return unit === 'bit/s' ? value / 1_000_000 : unit === 'kbits/sec' ? value / 1_000 : value
}
function rateTiers(port: string): readonly number[] {
  const match = /^([cl])_band_(uplink|downlink)$/u.exec(port)
  return match ? datalinkRateTiers(match[1]!.toUpperCase() as 'C' | 'L', match[2] === 'uplink' ? 'FORWARD' : 'REVERSE') : []
}
const tierLabel = (mbps: number) => `${Number((mbps * 1_000_000).toPrecision(12))} bit/s（${formatDataRate(mbps)}）`
const path = (type: TemplatePlatformType, port: string, key?: string) => `deviceParameters.ports.${type}.${port}${key ? `.${key}` : ''}`
const sourceKey = (type: TemplatePlatformType, port: string) => `${type}/${port}`

/** 已引用基础数据的字段只读；修改前须先取消引用，避免保存时与来源快照不一致。 */
function sourceLocked(parameters: PortParameters, key: PortKey): boolean {
  return Boolean(parameters.parameterSource?.fields.some(field => PORT_SOURCE_FIELDS[field as keyof typeof PORT_SOURCE_FIELDS] === key))
}

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
  // 清空输入时写 NaN 交给校验原位提示，不悄悄回填默认值。
  parameters[key] = value === null || value === undefined ? Number.NaN : key === 'transferRate' ? fromDisplayRate(type, port, value) : value
  writePort(type, port, parameters)
}
function updateGain(name: TemplateAntennaName, value: number | null | undefined): void {
  const next = current()
  next.antennaGains = { ...next.antennaGains, [name]: value === null || value === undefined ? Number.NaN : value }
  emit('update:modelValue', next)
}

type SourceOption = { key: string; label: string; equipment?: EquipmentParameter; master?: MasterData }
const sourceOptions = computed<SourceOption[]>(() => [
  ...(props.parameterCatalog?.equipment ?? []).filter(row => row.active !== false && !row.readOnly)
    .map(row => ({ key: `EQUIPMENT:${row.equipmentId}`, label: `${row.type} · ${row.equipmentId}`, equipment: row })),
  ...(props.parameterCatalog?.masterData ?? []).filter(row => row.active && row.content && ['COMMUNICATION_SYSTEM', 'PARAMETER_DICTIONARY'].includes(row.kind))
    .map(row => ({ key: `MASTER_DATA:${row.dataId}`, label: `${row.content!.name} · ${row.dataId}`, master: row })),
])
function applySource(type: TemplatePlatformType, port: string, key: string): void {
  const id = sourceKey(type, port)
  selections.value = { ...selections.value, [id]: key }
  sourceErrors.value = { ...sourceErrors.value, [id]: '' }
  const option = sourceOptions.value.find(item => item.key === key)
  if (!option || props.disabled || props.referenceDisabled) return
  const current = structuredClone(resolved.value.ports[type][port]!)
  delete current.parameterSource
  const target = { id: `@port:${type}/${port}`, path: path(type, port), type, port, parameters: current }
  const prepared = option.equipment ? preparePortEquipment(target, option.equipment) : preparePortMasterData(target, option.master!)
  if (!prepared.ok) {
    sourceErrors.value = { ...sourceErrors.value, [id]: prepared.message }
    return
  }
  writePort(type, port, { ...prepared.parameters, parameterSource: {
    kind: option.equipment ? 'EQUIPMENT' : 'MASTER_DATA',
    sourceId: option.equipment?.equipmentId ?? option.master!.dataId,
    sourceVersion: option.equipment?.version ?? option.master!.version,
    fields: prepared.fields as LinkParameterField[],
  } })
}
function clearSource(type: TemplatePlatformType, port: string): void {
  const current = structuredClone(resolved.value.ports[type][port]!)
  delete current.parameterSource
  selections.value = { ...selections.value, [sourceKey(type, port)]: '' }
  writePort(type, port, current)
}
</script>

<template>
  <div class="device-parameters" data-testid="device-parameters-panel">
    <p class="device-parameters__hint">按平台类型配置模板端口；同一平台类型的所有实例共用一组参数。未修改的端口按模板默认值生成。</p>
    <el-tabs v-model="activeType" class="device-parameters__tabs" aria-label="通信平台类型">
      <el-tab-pane v-for="type in TEMPLATE_PLATFORM_TYPES" :key="type" :label="PLATFORM_LABELS[type]" :name="type">
        <el-table v-if="activeType === type" :data="rows(type)" row-key="port" :data-testid="`device-ports-${type}`">
          <el-table-column label="端口" min-width="150" fixed="left">
            <template #default="{ row }">
              <div>{{ PORT_LABELS[row.port] ?? row.port }}</div>
              <small class="device-parameters__port">{{ row.port }}</small>
            </template>
          </el-table-column>
          <el-table-column v-for="column in NUMBER_COLUMNS" :key="column.key" :label="column.label" min-width="130">
            <template #default="{ row }">
              <span v-if="row.port === 'fiber_link'" class="device-parameters__fixed">—</span>
              <el-form-item v-else class="device-parameters__field" :error="fieldMessage(path(type, row.port, column.key))">
                <el-input-number :model-value="Number.isNaN(row.parameters[column.key]) ? undefined : row.parameters[column.key]" :min="column.min" :step="column.key === 'noiseFigureDb' ? 0.1 : 1"
                  :disabled="disabled || sourceLocked(row.parameters, column.key)" controls-position="right" :aria-label="`${PORT_LABELS[row.port]}${column.label}`"
                  :data-testid="`port-${type}-${row.port}-${column.key}`" @update:model-value="value => updatePort(type, row.port, column.key, value)" />
              </el-form-item>
            </template>
          </el-table-column>
          <el-table-column label="传输速率" min-width="200">
            <template #default="{ row }">
              <span v-if="row.port === 'fiber_link'" class="device-parameters__fixed" :data-testid="`port-${type}-fiber_link-transferRate`">1000 mbits/sec（模板固定）</span>
              <el-form-item v-else class="device-parameters__field" :error="fieldMessage(path(type, row.port, 'transferRate'))">
                <el-select v-if="rateTiers(row.port).length" :model-value="row.parameters.transferRate" :disabled="disabled || sourceLocked(row.parameters, 'transferRate')"
                  :aria-label="`${PORT_LABELS[row.port]}传输速率`" :data-testid="`port-${type}-${row.port}-transferRate`"
                  @update:model-value="(value: number) => updatePort(type, row.port, 'transferRate', value * 1_000_000)">
                  <el-option v-for="tier in rateTiers(row.port)" :key="tier" :label="tierLabel(tier)" :value="tier" />
                  <el-option v-if="!rateTiers(row.port).includes(row.parameters.transferRate)" :label="`${tierLabel(row.parameters.transferRate)}（不在档位内）`" :value="row.parameters.transferRate" />
                </el-select>
                <el-input-number v-else :model-value="Number.isNaN(row.parameters.transferRate) ? undefined : displayRate(type, row.port, row.parameters.transferRate)" :min="0"
                  :disabled="disabled || sourceLocked(row.parameters, 'transferRate')" controls-position="right" :aria-label="`${PORT_LABELS[row.port]}传输速率`"
                  :data-testid="`port-${type}-${row.port}-transferRate`" @update:model-value="value => updatePort(type, row.port, 'transferRate', value)" />
                <small class="device-parameters__unit">{{ rateUnit(type, row.port) === 'kbits/sec' ? 'kbps' : 'Mbps' }}</small>
              </el-form-item>
            </template>
          </el-table-column>
          <el-table-column label="应用设备参数" min-width="260">
            <template #default="{ row }">
              <span v-if="row.port === 'fiber_link'" class="device-parameters__fixed">模板固定，只读</span>
              <div v-else class="device-parameters__source">
                <div v-if="row.parameters.parameterSource" :data-testid="`port-source-${type}-${row.port}`">
                  已引用 {{ row.parameters.parameterSource.sourceId }} · v{{ row.parameters.parameterSource.sourceVersion }}
                  <el-button link type="primary" :disabled="disabled" :data-testid="`port-source-clear-${type}-${row.port}`" @click="clearSource(type, row.port)">取消引用</el-button>
                </div>
                <el-select v-else :model-value="selections[sourceKey(type, row.port)] ?? ''" placeholder="选择设备参数或通用基础数据" filterable clearable
                  :loading="parameterLoading" :disabled="disabled || referenceDisabled" :aria-label="`${PORT_LABELS[row.port]}基础数据`"
                  :data-testid="`port-source-select-${type}-${row.port}`" @change="(key: string) => applySource(type, row.port, key)"
                  @visible-change="(visible: boolean) => { if (visible && !parameterCatalog && !parameterLoading) emit('load-parameters') }">
                  <el-option-group label="设备参数">
                    <el-option v-for="option in sourceOptions.filter(item => item.equipment)" :key="option.key" :value="option.key" :label="option.label" />
                  </el-option-group>
                  <el-option-group label="通用基础数据">
                    <el-option v-for="option in sourceOptions.filter(item => item.master)" :key="option.key" :value="option.key" :label="option.label" />
                  </el-option-group>
                </el-select>
                <small v-if="sourceErrors[sourceKey(type, row.port)]" role="alert" class="device-parameters__error" :data-testid="`port-source-error-${type}-${row.port}`">{{ sourceErrors[sourceKey(type, row.port)] }}</small>
                <small v-else-if="fieldMessage(path(type, row.port, 'parameterSource'))" role="alert" class="device-parameters__error">{{ fieldMessage(path(type, row.port, 'parameterSource')) }}</small>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>
    <p v-if="referenceDisabled" class="device-parameters__hint">请先保存场景，再引用基础数据。</p>
    <p v-if="parameterCatalogState === 'ERROR'" role="alert" class="device-parameters__error">{{ parameterCatalogMessage }}</p>

    <h4 class="device-parameters__title">天线增益</h4>
    <el-table :data="antennaRows" row-key="name" data-testid="antenna-gain-table">
      <el-table-column label="天线图名" prop="name" min-width="260" />
      <el-table-column label="用途说明" min-width="220"><template #default="{ row }">{{ ANTENNA_USAGE[row.name as TemplateAntennaName] }}</template></el-table-column>
      <el-table-column label="peak_gain（dB）" min-width="160">
        <template #default="{ row }">
          <el-form-item class="device-parameters__field" :error="fieldMessage(`deviceParameters.antennaGains.${row.name}`)">
            <el-input-number :model-value="Number.isNaN(row.gain) ? undefined : row.gain" :step="0.5" :disabled="disabled" controls-position="right"
              :aria-label="`${row.name} 峰值增益`" :data-testid="`antenna-gain-${row.name}`" @update:model-value="value => updateGain(row.name, value)" />
          </el-form-item>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.device-parameters { display: grid; gap: 12px; }
.device-parameters__hint { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; }
.device-parameters__title { margin: 8px 0 0; font-size: 14px; font-weight: 600; }
.device-parameters__port, .device-parameters__unit { color: var(--el-text-color-secondary); font-size: 12px; }
.device-parameters__fixed { color: var(--el-text-color-secondary); }
.device-parameters__field { margin-bottom: 0; }
.device-parameters__field :deep(.el-input-number), .device-parameters__field :deep(.el-select) { width: 100%; }
.device-parameters__source { display: grid; gap: 4px; }
.device-parameters__error { color: var(--el-color-danger); font-size: 12px; }
</style>
