<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue'
import type { CapabilityState, InformationDemand, LaserLinkParameters, Link, LinkParameterField, LinkType, Platform, ScenarioParameterCatalog, ValidationIssue } from '../../contracts/domain-models'
import { LINK_MODULATIONS, prepareLinkEquipment } from '../../features/scenarios/link-equipment-parameters'
import { EQUIPMENT_LINK_TYPES, equipmentTypeIssue } from '../../features/admin/equipment-link-rules'
import { prepareLinkMasterData } from '../../features/scenarios/link-master-parameters'
import { LINK_PARAMETER_DEFAULTS } from '../../features/scenarios/link-settings'
import {
  datalinkRateTiers, FIBER_DATA_RATE_MBPS, fixedLinkDataRate, formatDataRate, LASER_LINK_MODULATION, linkPowerMaxW, linkTypeDefaults,
} from '../../features/scenarios/link-calc-defaults'
import { changeBusinessDirection } from '../../features/scenarios/business-defaults'
import { fieldValidationMessage } from '../../features/scenarios/validation-fields'
import BusinessEditorDialog from './BusinessEditorDialog.vue'
import { scenarioPlatformLabel } from '../../features/scenarios/scenario-basic'

type LinkTypeOption = { value: LinkType, label: string }

const props = defineProps<{
  modelValue: boolean
  link: Link | null
  editing: boolean
  showIds?: boolean
  error: string
  pending: boolean
  locked: boolean
  platforms: readonly Platform[]
  linkTypeOptions: readonly LinkTypeOption[]
  linkDirectionLabels: Record<Link['direction'], string>
  minimumStep: number
  demand?: InformationDemand | null
  parameterCatalog?: ScenarioParameterCatalog | null
  parameterCatalogState?: CapabilityState
  parameterCatalogMessage?: string
  referenceDisabled?: boolean
  /** 由父级按当前场景上下文校验本弹框的临时副本。 */
  validate?: (link: Link, demand?: InformationDemand | null) => ValidationIssue[]
}>()

const emit = defineEmits<{
  'update:modelValue': [visible: boolean]
  apply: [link: Link, demand?: InformationDemand]
  opened: []
  'frequency-input': [value: number | undefined]
  'bandwidth-input': [value: number | undefined]
  'load-parameters': []
  'close-parameters': []
}>()

/**
 * 激光切换期间，通用频率、带宽、功率和速率可刻意留空，交由父页的写入校验提示用户补齐。
 * 不在输入阶段把空字符串转成 0，避免把未填写的光学参数伪装成有效配置。
 */
type EditableLink = Omit<Link, 'frequency' | 'bandwidth' | 'txPower' | 'dataRate' | 'rxFrequency' | 'rxBandwidth' | 'laser'>
  & Partial<Pick<Link, 'frequency' | 'bandwidth' | 'txPower' | 'dataRate' | 'rxFrequency' | 'rxBandwidth'>>
  & { laser?: Partial<LaserLinkParameters> }

const editor = ref<EditableLink | null>(null)
const business = ref<InformationDemand | null>(null)
const validationTick = ref(0)
const selectedParameter = ref('')
const selectedEntry = ref('')
const sourceValues = ref('')
const sourceFields: Record<LinkParameterField, string> = {
  frequency: '发射频率', bandwidth: '发射带宽', txPower: '发射功率', dataRate: '数据速率', modulation: '调制方式', berThreshold: 'BER 阈值', coding: '信道编码',
  rxFrequency: '接收频率', rxBandwidth: '接收带宽', 'antennaGain.tx': '发射天线增益', 'antennaGain.rx': '接收天线增益',
  antennaGainCorrectionDb: '增益修正', noiseFigureDb: '噪声系数', txPolarization: '发射极化', rxPolarization: '接收极化',
}
function sourceValue(link: EditableLink, field: LinkParameterField): unknown {
  if (field === 'antennaGain.tx') return link.antennaGain.tx
  if (field === 'antennaGain.rx') return link.antennaGain.rx
  return link[field]
}
function appliedValues(link: EditableLink): string {
  return JSON.stringify(link.parameterSource?.fields.map(field => sourceValue(link, field)) ?? [])
}
const parameterLoading = computed(() => ['LOADING', 'VALIDATING'].includes(props.parameterCatalogState ?? 'EMPTY'))
const sourceOptions = computed(() => [
  ...(props.parameterCatalog?.equipment ?? []).filter(row => row.active !== false && !row.readOnly).map(row => ({
    key: `EQUIPMENT:${row.equipmentId}`,
    label: `${row.type} · ${row.equipmentId}${editor.value && equipmentTypeIssue(row.type, editor.value.type) ? `（${Object.hasOwn(EQUIPMENT_LINK_TYPES, row.type) ? '类型不匹配' : '类型未明确'}）` : ''}`,
    disabledReason: editor.value ? equipmentTypeIssue(row.type, editor.value.type) ?? '' : '', equipment: row, master: undefined,
  })),
  ...(props.parameterCatalog?.masterData ?? []).filter(row => row.active && row.content && ['COMMUNICATION_SYSTEM', 'PARAMETER_DICTIONARY', 'ENUMERATION'].includes(row.kind)).map(row => ({
    key: `MASTER_DATA:${row.dataId}`, label: `${row.content!.name} · ${row.dataId}`, disabledReason: '', master: row, equipment: undefined,
  })),
])
const savedParameter = computed(() => {
  const source = editor.value?.parameterSource
  if (!source) return null
  const name = source.kind === 'EQUIPMENT'
    ? props.parameterCatalog?.equipment.find(row => row.equipmentId === source.sourceId && row.version === source.sourceVersion)?.type
    : props.parameterCatalog?.masterData.find(row => row.dataId === source.sourceId && row.version === source.sourceVersion)?.content?.name
  return {
    key: `SAVED:${source.kind}:${source.sourceId}:${source.sourceVersion}`,
    label: `${name || (source.kind === 'EQUIPMENT' ? '设备' : '通用数据')} · ${source.sourceId}`,
  }
})
const selectedSource = computed(() => sourceOptions.value.find(row => row.key === selectedParameter.value))
const enumEntries = computed(() => selectedSource.value?.master?.kind === 'ENUMERATION' ? selectedSource.value.master.content?.entries ?? [] : [])
const parameterPreview = computed(() => {
  void validationTick.value
  if (!editor.value || !selectedSource.value) return null
  const link = structuredClone(toRaw(editor.value)) as Link
  const source = selectedSource.value
  if (source.equipment) return prepareLinkEquipment(link, source.equipment, props.platforms)
  if (source.master) return prepareLinkMasterData(link, source.master, props.platforms, selectedEntry.value || undefined)
  return null
})
const parameterSelectionError = computed(() => {
  if (!selectedParameter.value || selectedParameter.value === savedParameter.value?.key) return ''
  const preview = parameterPreview.value
  if (!preview) return '所选基础数据暂不可用，请重新选择或清空选择。'
  if (!preview.ok) return `${preview.fieldPath}：${preview.message}`
  return preview.fields.length ? '' : '所选基础数据没有可填入的链路参数，请重新选择或清空选择。'
})
const parameterMismatch = computed(() => {
  void validationTick.value
  const link = editor.value
  if (!link?.parameterSource) return ''
  if (appliedValues(link) !== sourceValues.value) return '已修改引用字段，请清空后重新选择基础数据，或取消引用后使用自定义参数。'
  const source = props.parameterCatalog?.equipment.find(row => link.parameterSource!.kind === 'EQUIPMENT' && row.equipmentId === link.parameterSource!.sourceId && row.version === link.parameterSource!.sourceVersion)
  if (source) {
    const prepared = prepareLinkEquipment(structuredClone(toRaw(link)) as Link, source, props.platforms, true)
    if (!prepared.ok) return prepared.message
  }
  return ''
})
function applyParameters(): void {
  const preview = parameterPreview.value
  const source = selectedSource.value
  if (!props.modelValue || props.referenceDisabled || !editor.value || !preview?.ok || preview.fields.length === 0 || !source || props.pending || props.locked) return
  editor.value = { ...preview.link, parameterSource: {
    kind: source.equipment ? 'EQUIPMENT' : 'MASTER_DATA', sourceId: source.equipment?.equipmentId ?? source.master!.dataId,
    sourceVersion: source.equipment?.version ?? source.master!.version, fields: preview.fields as LinkParameterField[],
    ...(source.master?.kind === 'ENUMERATION' ? { entryKey: selectedEntry.value } : {}),
  } }
  sourceValues.value = appliedValues(editor.value)
}
function clearParameterSource(): void {
  if (editor.value) delete editor.value.parameterSource
  selectedParameter.value = ''
  selectedEntry.value = ''
  sourceValues.value = ''
}
function changeParameterSource(): void {
  selectedEntry.value = ''
  if (!selectedParameter.value) { clearParameterSource(); return }
  applyParameters()
}
onBeforeUnmount(() => emit('close-parameters'))

/** 深度变更也要立即触发校验，不能等到点击确认后才显示字段提示。 */
watch([editor, business], () => { validationTick.value += 1 }, { deep: true, flush: 'sync' })

function validationDemand(link: Link): InformationDemand | null {
  if (!business.value) return null
  return {
    ...structuredClone(toRaw(business.value)),
    linkId: link.id.trim(),
    sourcePlatformId: link.sourcePlatformId,
    destinationPlatformIds: [link.targetPlatformId],
    direction: link.direction,
  }
}

/** 校验始终拿克隆后的编辑副本，校验函数不能触及父场景草稿。 */
function validationLink(): Link | null {
  if (!editor.value) return null
  const link = structuredClone(toRaw(editor.value)) as Link
  if (link.forwardDataRate === undefined) delete link.forwardDataRate
  if (link.reverseDataRate === undefined) delete link.reverseDataRate
  if (fixedDataRate.value !== null) link.dataRate = fixedDataRate.value
  return link
}

const validationIssues = computed(() => {
  // 深度 watch 将嵌套输入同步到此计算属性。
  void validationTick.value
  const link = validationLink()
  return link && props.validate ? props.validate(link, validationDemand(link)) : []
})
const fieldError = (fieldPath: string): string => fieldValidationMessage(validationIssues.value, fieldPath)

/** 嵌入业务组件使用业务相对路径；父级链路校验结果中的业务路径统一以 business. 开头。 */
function validateBusiness(demand: InformationDemand): ValidationIssue[] {
  const link = validationLink()
  if (!link || !props.validate) return []
  return props.validate(link, structuredClone(toRaw(demand)))
    .filter(issue => issue.fieldPath === 'business' || issue.fieldPath.startsWith('business.'))
    .map(issue => ({ ...issue, fieldPath: issue.fieldPath === 'business' ? '' : issue.fieldPath.slice('business.'.length) }))
}

/** 可选中继：卫星链路经通信卫星，微波 / 数传经高空中继节点；光纤、激光不支持中继。 */
function relayCandidates(type: LinkType | undefined): Platform[] {
  if (type === 'SAT') return props.platforms.filter(platform => platform.type === 'COMMUNICATION_SATELLITE')
  if (type === 'MICROWAVE' || type === 'DATALINK') return props.platforms.filter(platform => platform.type === 'FORWARD_RELAY_NODE')
  return []
}
const relayOptions = computed(() => relayCandidates(editor.value?.type))
function setRelay(value: string | undefined): void {
  if (!editor.value) return
  // 清空时与旧数据一致：原有中继写 null 表示移除，新链路不写该字段。
  if (value) editor.value.relayPlatformId = value
  else if (editor.value.relayPlatformId !== undefined) editor.value.relayPlatformId = null
}

/** 改类型后清除不再适用的中继引用；数传默认 C 波段，其他类型不保留波段。按新类型套用文档端口默认值。 */
function changeType(type: LinkType): void {
  if (!editor.value) return
  if (editor.value.relayPlatformId && !relayCandidates(type).some(platform => platform.id === editor.value!.relayPlatformId)) editor.value.relayPlatformId = null
  if (type === 'DATALINK') editor.value.band ??= 'C'
  else delete editor.value.band
  if (type === 'LASER') {
    // 切入激光时不沿用射频默认值；频率、带宽、光功率和速率均由用户显式填写。
    delete editor.value.frequency
    delete editor.value.bandwidth
    delete editor.value.txPower
    delete editor.value.dataRate
    delete editor.value.rxFrequency
    delete editor.value.rxBandwidth
    delete editor.value.txPolarization
    delete editor.value.rxPolarization
    delete editor.value.noiseFigureDb
    delete editor.value.laser
    return
  }
  delete editor.value.laser
  applyTypeDefaults()
}

/** 套用当前类型、波段与方向对应的文档端口默认值；不改动端点、调制和业务参数。 */
function applyTypeDefaults(): void {
  if (!editor.value) return
  if (editor.value.type !== 'LASER') Object.assign(editor.value, linkTypeDefaults(editor.value.type, editor.value.band ?? 'C', editor.value.direction))
}

const fiber = computed(() => editor.value?.type === 'FIBER')
const laser = computed(() => editor.value?.type === 'LASER')
/** 卫星、微波速率固定只读；天通卫星为 16 kbit/s。 */
const fixedDataRate = computed(() => editor.value ? fixedLinkDataRate(editor.value, props.platforms) : null)
const rateTiers = computed(() => editor.value?.type === 'DATALINK' ? datalinkRateTiers(editor.value.band ?? 'C', editor.value.direction) : [])
const laserWavelengthNm = computed(() => {
  const frequencyMHz = editor.value?.frequency
  return typeof frequencyMHz === 'number' && Number.isFinite(frequencyMHz) && frequencyMHz > 0
    ? 299_792_458_000 / frequencyMHz
    : null
})

function setLaserNumber(key: 'txApertureDiameterM' | 'rxApertureDiameterM' | 'pulseWidthS', value: number | null | undefined): void {
  if (!editor.value) return
  if (typeof value === 'number' && Number.isFinite(value)) {
    editor.value.laser = { ...editor.value.laser, [key]: value }
  } else if (editor.value.laser) {
    delete editor.value.laser[key]
    clearEmptyLaser()
  }
}

function setLaserPulseWidthNs(value: number | null | undefined): void {
  // 界面采用 ns，合同中稳定存储为 s。
  setLaserNumber('pulseWidthS', typeof value === 'number' && Number.isFinite(value) ? value * 1e-9 : value)
}

function setLaserModulation(value: string | null | undefined): void {
  if (!editor.value) return
  if (value === 'OOK') editor.value.laser = { ...editor.value.laser, modulation: 'OOK' }
  else if (editor.value.laser) {
    delete editor.value.laser.modulation
    clearEmptyLaser()
  }
}

function setReceiveCarrierNumber(key: 'rxFrequency' | 'rxBandwidth', value: number | null | undefined): void {
  if (!editor.value) return
  if (typeof value === 'number' && Number.isFinite(value)) editor.value[key] = value
  else delete editor.value[key]
}

function clearEmptyLaser(): void {
  if (!editor.value?.laser) return
  const { txApertureDiameterM, rxApertureDiameterM, pulseWidthS, modulation } = editor.value.laser
  if (txApertureDiameterM === undefined && rxApertureDiameterM === undefined && pulseWidthS === undefined && modulation === undefined) delete editor.value.laser
}

/** 清空噪声系数时恢复设备缺省（3 dB）。 */
function setNoiseFigure(value: number | null | undefined): void {
  if (!editor.value) return
  if (typeof value === 'number') editor.value.noiseFigureDb = value
  else delete editor.value.noiseFigureDb
}

/** 保存编码选择；空字符串转为“未指定”，value 为选项或用户录入的后端编码标识。 */
function changeCoding(value: string | null | undefined): void {
  if (editor.value) editor.value.coding = (value ?? '').trim() || null
}

/** 确认当前链路及其启停副本；取消或校验失败时不写入原场景。 */
function apply(): void {
  if (editor.value === null || props.pending || props.locked || parameterMismatch.value || parameterSelectionError.value) return
  if (selectedSource.value) applyParameters()
  if (fixedDataRate.value !== null) editor.value.dataRate = fixedDataRate.value
  const demand = business.value ? {
    ...structuredClone(toRaw(business.value)),
    linkId: editor.value.id.trim(),
    sourcePlatformId: editor.value.sourcePlatformId,
    destinationPlatformIds: [editor.value.targetPlatformId],
    direction: editor.value.direction,
  } : undefined
  emit('apply', editor.value as Link, demand)
}

watch(() => props.modelValue, (visible) => {
  if (!visible) { emit('close-parameters'); return }
  editor.value = props.link === null ? null : { ...LINK_PARAMETER_DEFAULTS, ...structuredClone(toRaw(props.link)) }
  // 旧数传链路缺省波段时按 C 波段展示，与生成器的缺省口径一致。
  if (editor.value?.type === 'DATALINK') editor.value.band ??= 'C'
  // 旧链路没有单独的接收参数与极化时，按生成器缺省口径展示（接收同发射，微波水平、其余垂直）。
  if (editor.value && editor.value.type !== 'LASER') {
    const defaults = linkTypeDefaults(editor.value.type)
    editor.value.rxFrequency ??= editor.value.frequency
    editor.value.rxBandwidth ??= editor.value.bandwidth
    editor.value.txPolarization ??= defaults.txPolarization
    editor.value.rxPolarization ??= defaults.rxPolarization
  }
  business.value = props.demand ? { enabled: true, ...structuredClone(toRaw(props.demand)) } : null
  // 回显使用独立的只读选项，只有用户选择目录条目时才重新填参。
  selectedParameter.value = savedParameter.value?.key ?? ''
  selectedEntry.value = editor.value?.parameterSource?.entryKey ?? ''
  sourceValues.value = editor.value ? appliedValues(editor.value) : ''
  if (editor.value?.parameterSource && !props.parameterCatalog && !parameterLoading.value) emit('load-parameters')
}, { immediate: true })

watch(() => editor.value?.direction, direction => {
  if (direction && business.value) changeBusinessDirection(business.value, direction, Boolean(props.demand?.linkId))
})

/** 数传上下行的频率、功率与速率档位不同，用户切换方向时套用对应默认值。 */
function changeDirection(): void {
  if (editor.value?.type === 'DATALINK') applyTypeDefaults()
}

/** 可选方向速率清空后必须删除属性，才能回退到历史 dataRate 而不是留下 undefined。 */
function setDirectionalRate(key: 'forwardDataRate' | 'reverseDataRate', value: number | null | undefined): void {
  if (!editor.value) return
  if (typeof value === 'number' && Number.isFinite(value)) editor.value[key] = value
  else delete editor.value[key]
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :close-on-click-modal="!pending"
    :close-on-press-escape="!pending"
    :show-close="!pending"
    class="link-editor-dialog scenario-dialog"
    :title="editing ? '编辑链路' : '新增链路'"
    width="min(760px, calc(100vw - 2rem))"
    top="5vh"
    destroy-on-close
    append-to-body
    data-testid="link-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @opened="emit('opened')"
  >
    <el-alert v-if="error" class="platform-feedback" type="error" :closable="false" :title="error" show-icon />
    <el-form v-if="editor" class="link-editor-form" :model="editor" label-position="top" :disabled="pending || locked">
      <section class="link-editor-section" aria-labelledby="link-basic-title">
        <h4 id="link-basic-title" class="link-editor-section__title">基本信息</h4>
        <div class="link-editor-grid">
          <el-form-item required label="链路类型" :error="fieldError('type')">
            <el-select v-model="editor.type" style="width: 100%" data-testid="link-type" @change="changeType">
              <el-option v-for="option in linkTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="当前链路" :error="fieldError('enabled')">
            <el-switch v-model="editor.enabled" active-text="启用" inactive-text="停用" data-testid="link-enabled" />
          </el-form-item>
          <el-form-item v-if="editor.type === 'DATALINK'" required label="数传波段" :error="fieldError('band')">
            <el-select v-model="editor.band" style="width: 100%" data-testid="link-band" @change="applyTypeDefaults">
              <el-option label="C 波段" value="C" /><el-option label="L 波段" value="L" />
            </el-select>
          </el-form-item>
          <el-form-item required v-show="showIds" label="链路 ID" :error="fieldError('id')"><el-input v-model="editor.id" :disabled="editing" data-testid="link-id" /></el-form-item>
        </div>
      </section>

      <section class="link-editor-section" aria-labelledby="link-endpoint-title">
        <h4 id="link-endpoint-title" class="link-editor-section__title">端点配置</h4>
        <div class="link-editor-grid">
          <el-form-item required label="源平台" :error="fieldError('sourcePlatformId')">
            <el-select v-model="editor.sourcePlatformId" filterable style="width: 100%" data-testid="link-source">
              <el-option v-for="platform in platforms" :key="platform.id" :label="scenarioPlatformLabel(platforms, platform.id, showIds)" :value="platform.id" />
            </el-select>
          </el-form-item>
          <el-form-item required label="目标平台" :error="fieldError('targetPlatformId')">
            <el-select v-model="editor.targetPlatformId" filterable style="width: 100%" data-testid="link-target">
              <el-option v-for="platform in platforms" :key="platform.id" :label="scenarioPlatformLabel(platforms, platform.id, showIds)" :value="platform.id" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="editor.type === 'SAT' || editor.type === 'MICROWAVE' || editor.type === 'DATALINK'" label="中继平台（可选）" :error="fieldError('relayPlatformId')">
            <el-select :model-value="editor.relayPlatformId ?? ''" clearable placeholder="不经中继" style="width: 100%" data-testid="link-relay" @update:model-value="setRelay">
              <el-option v-for="platform in relayOptions" :key="platform.id" :label="scenarioPlatformLabel(platforms, platform.id, showIds)" :value="platform.id" />
            </el-select>
            <small class="link-editor-hint">{{ editor.type === 'SAT' ? '后方指挥节点与任务无人机之间的卫通须经通信卫星中继。' : '经高空中继节点转发，中继收发使用同名端口。' }}</small>
          </el-form-item>
        </div>
      </section>

      <section class="link-editor-section" aria-labelledby="link-communication-title">
        <h4 id="link-communication-title" class="link-editor-section__title">通信参数</h4>
        <p v-if="!laser" class="link-editor-hint" data-testid="link-retained-hint">AFSIM 脚本的收发参数以“通信设备参数”为准，此处参数暂保留，不写入脚本。</p>
        <div class="link-parameter-source" data-testid="link-parameter-source">
          <div class="link-parameter-source__controls">
            <el-select v-model="selectedParameter" placeholder="选择设备参数或通用基础数据" aria-label="链路基础数据" filterable clearable :loading="parameterLoading" :disabled="referenceDisabled"
              data-testid="link-parameter-select" @change="changeParameterSource" @visible-change="visible => { if (visible && !parameterCatalog && !parameterLoading) emit('load-parameters') }">
              <el-option v-if="savedParameter && selectedParameter === savedParameter.key" :value="savedParameter.key" :label="savedParameter.label" disabled />
              <el-option-group label="设备参数">
                <el-option v-for="option in sourceOptions.filter(row => row.equipment)" :key="option.key" :value="option.key" :label="option.label" :disabled="Boolean(option.disabledReason)" :title="option.disabledReason" />
                <el-option v-if="parameterCatalog && !sourceOptions.some(row => row.equipment)" label="暂无可用设备参数" value="EMPTY:EQUIPMENT" disabled />
              </el-option-group>
              <el-option-group label="通用基础数据">
                <el-option v-for="option in sourceOptions.filter(row => row.master)" :key="option.key" :value="option.key" :label="option.label" />
                <el-option v-if="parameterCatalog && !sourceOptions.some(row => row.master)" label="暂无可用通用基础数据" value="EMPTY:MASTER_DATA" disabled />
              </el-option-group>
            </el-select>
            <el-button :disabled="referenceDisabled" :loading="parameterLoading" data-testid="link-parameter-refresh" @click="emit('load-parameters')">{{ parameterCatalogState === 'ERROR' ? '重试加载' : '刷新基础数据' }}</el-button>
          </div>
          <p v-if="referenceDisabled">请先保存场景，再引用基础数据。</p>
          <p v-if="parameterCatalogState === 'ERROR'" role="alert">{{ parameterCatalogMessage }}</p>
          <p v-else-if="parameterCatalog && sourceOptions.length === 0">暂无可用基础数据</p>
          <el-select v-if="enumEntries.length" v-model="selectedEntry" placeholder="请选择具体枚举值" aria-label="基础数据枚举值" data-testid="link-parameter-entry" @change="applyParameters">
            <el-option v-for="entry in enumEntries" :key="entry.key" :value="entry.key" :label="`${entry.key}：${entry.value}`" />
          </el-select>
          <div v-if="parameterPreview" data-testid="link-parameter-preview">
            <template v-if="parameterPreview.ok">
              <p v-for="field in parameterPreview.fields" :key="field">{{ sourceFields[field as LinkParameterField] }}：{{ field === 'dataRate' ? formatDataRate(parameterPreview.link.dataRate) : sourceValue(parameterPreview.link, field as LinkParameterField) }}</p>
            </template>
            <template v-if="'skipped' in parameterPreview">
              <p v-for="item in parameterPreview.skipped" :key="item.key">{{ item.key }}：{{ item.reason }}</p>
            </template>
          </div>
          <p v-if="parameterSelectionError" role="alert" data-testid="link-parameter-selection-error">{{ parameterSelectionError }}</p>
          <div v-if="editor.parameterSource" data-testid="link-parameter-applied">
            已引用 {{ editor.parameterSource.sourceId }} · v{{ editor.parameterSource.sourceVersion }}
            <el-button link data-testid="link-parameter-clear" @click="clearParameterSource">取消引用，保留参数</el-button>
          </div>
          <p v-if="parameterMismatch" role="alert" data-testid="link-parameter-mismatch">{{ parameterMismatch }}</p>
        </div>
        <div class="link-editor-grid">
          <el-form-item required :label="laser ? '介质传输速率（Mbps）' : '数据速率'" :error="fieldError('dataRate')">
            <el-input v-if="fixedDataRate !== null" :model-value="formatDataRate(fixedDataRate)" disabled data-testid="link-data-rate" />
            <el-select v-else-if="editor.type === 'DATALINK'" v-model="editor.dataRate" style="width: 100%" data-testid="link-data-rate">
              <el-option v-for="tier in rateTiers" :key="tier" :label="formatDataRate(tier)" :value="tier" />
              <el-option v-if="editor.dataRate !== undefined && !rateTiers.includes(editor.dataRate)" :label="`${formatDataRate(editor.dataRate)}（不在档位内）`" :value="editor.dataRate" />
            </el-select>
            <el-input-number v-else v-model="editor.dataRate" :min="validate ? undefined : fiber ? FIBER_DATA_RATE_MBPS.min : 0" :max="validate ? undefined : fiber ? FIBER_DATA_RATE_MBPS.max : Infinity"
              controls-position="right" data-testid="link-data-rate" />
            <small class="link-editor-hint">{{ fixedDataRate !== null ? '按对接文档固定显示；脚本速率以“通信设备参数”为准' : editor.type === 'DATALINK' ? '按波段与方向分档' : fiber ? '10～1000 Mbps' : laser ? '控制报文传输时间；光学脉宽单独配置，须显式填写' : '单位 Mbps' }}</small>
          </el-form-item>
          <template v-if="editor.type === 'SAT'">
            <el-form-item label="前向速率（Mbps）" :error="fieldError('forwardDataRate')">
              <el-input-number :model-value="editor.forwardDataRate" :min="0.128" :max="8" :step="0.001" placeholder="兼容旧速率" controls-position="right"
                data-testid="link-forward-data-rate" @update:model-value="setDirectionalRate('forwardDataRate', $event)" />
              <small class="link-editor-hint">0.128～8 Mbps；清空后兼容历史速率。</small>
            </el-form-item>
            <el-form-item label="返向速率（Mbps）" :error="fieldError('reverseDataRate')">
              <el-input-number :model-value="editor.reverseDataRate" :min="0.064" :max="2" :step="0.001" placeholder="兼容旧速率" controls-position="right"
                data-testid="link-reverse-data-rate" @update:model-value="setDirectionalRate('reverseDataRate', $event)" />
              <small class="link-editor-hint">0.064～2 Mbps；清空后兼容历史速率。</small>
            </el-form-item>
          </template>
          <el-form-item required :label="fiber ? '发送频率（MHz）' : laser ? '激光频率（MHz）' : '发射频率（MHz）'" :error="fieldError('frequency')">
            <el-input-number v-model="editor.frequency" :min="validate ? undefined : Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="link-frequency" @input="emit('frequency-input', $event)" />
            <small v-if="laser" class="link-editor-hint" data-testid="laser-wavelength">
              {{ laserWavelengthNm === null ? '填写激光频率后显示波长换算值' : `波长约 ${Number(laserWavelengthNm.toPrecision(8))} nm（由频率换算，只读）` }}
            </small>
          </el-form-item>
          <template v-if="!fiber">
            <el-form-item required :label="laser ? '激光带宽（MHz）' : '发射带宽（MHz）'" :error="fieldError('bandwidth')"><el-input-number v-model="editor.bandwidth" :min="validate ? undefined : Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="link-bandwidth" @input="emit('bandwidth-input', $event)" /></el-form-item>
            <el-form-item required :label="laser ? '激光光功率（W）' : '发射功率（W）'" :error="fieldError('txPower')"><el-input-number v-model="editor.txPower" :min="validate ? undefined : 0" :max="validate ? undefined : linkPowerMaxW(editor.type)" controls-position="right" data-testid="link-power" /></el-form-item>
            <el-form-item :required="!laser" :label="laser ? '接收激光频率（MHz）' : '接收频率（MHz）'" :error="fieldError('rxFrequency')"><el-input-number :model-value="editor.rxFrequency" :placeholder="laser ? '留空时与发射相同' : undefined" :min="validate ? undefined : Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="link-rx-frequency" @update:model-value="setReceiveCarrierNumber('rxFrequency', $event)" /></el-form-item>
            <el-form-item :required="!laser" :label="laser ? '接收激光带宽（MHz）' : '接收带宽（MHz）'" :error="fieldError('rxBandwidth')"><el-input-number :model-value="editor.rxBandwidth" :placeholder="laser ? '留空时与发射相同' : undefined" :min="validate ? undefined : Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="link-rx-bandwidth" @update:model-value="setReceiveCarrierNumber('rxBandwidth', $event)" /></el-form-item>
          </template>
          <template v-if="!fiber && !laser">
            <el-form-item required label="发射极化" :error="fieldError('txPolarization')">
              <el-select v-model="editor.txPolarization" style="width: 100%" data-testid="link-tx-polarization">
                <el-option label="垂直极化" value="vertical" /><el-option label="水平极化" value="horizontal" />
              </el-select>
            </el-form-item>
            <el-form-item required label="发射天线增益（dBi）" :error="fieldError('antennaGain.tx')"><el-input-number v-model="editor.antennaGain.tx" controls-position="right" data-testid="link-tx-gain" /></el-form-item>
            <el-form-item required label="接收极化" :error="fieldError('rxPolarization')">
              <el-select v-model="editor.rxPolarization" style="width: 100%" data-testid="link-rx-polarization">
                <el-option label="垂直极化" value="vertical" /><el-option label="水平极化" value="horizontal" />
              </el-select>
            </el-form-item>
            <el-form-item required label="接收天线增益（dBi）" :error="fieldError('antennaGain.rx')"><el-input-number v-model="editor.antennaGain.rx" controls-position="right" data-testid="link-rx-gain" /></el-form-item>
            <el-form-item label="接收机噪声系数（dB）" :error="fieldError('noiseFigureDb')">
              <el-input-number :model-value="editor.noiseFigureDb" :min="validate ? undefined : 0" :max="validate ? undefined : 100" placeholder="缺省 3（天通 2）" controls-position="right"
                data-testid="link-noise-figure" @update:model-value="setNoiseFigure" />
            </el-form-item>
          </template>
          <el-form-item label="天线增益修正值（dB）" :error="fieldError('antennaGainCorrectionDb')"><el-input-number v-model="editor.antennaGainCorrectionDb" controls-position="right" data-testid="link-gain-correction" /></el-form-item>
          <el-form-item label="波形抗干扰增益（dB）" :error="fieldError('antiJammingGainDb')"><el-input-number v-model="editor.antiJammingGainDb" :min="validate ? undefined : 0" controls-position="right" data-testid="link-anti-jamming-gain" /></el-form-item>
          <el-form-item label="空域隔离量（dB）" :error="fieldError('spatialIsolationDb')"><el-input-number v-model="editor.spatialIsolationDb" :min="validate ? undefined : 0" controls-position="right" data-testid="link-spatial-isolation" /></el-form-item>
        </div>
      </section>

      <section v-if="laser" class="link-editor-section" aria-labelledby="link-laser-title">
        <h4 id="link-laser-title" class="link-editor-section__title">光学配置</h4>
        <div class="link-editor-grid">
          <el-form-item required label="发射光学口径（m）" :error="fieldError('laser.txApertureDiameterM')">
            <el-input-number :model-value="editor.laser?.txApertureDiameterM" :min="validate ? undefined : Number.MIN_VALUE" controls-position="right"
              data-testid="laser-tx-aperture" @update:model-value="setLaserNumber('txApertureDiameterM', $event)" />
          </el-form-item>
          <el-form-item required label="接收光学口径（m）" :error="fieldError('laser.rxApertureDiameterM')">
            <el-input-number :model-value="editor.laser?.rxApertureDiameterM" :min="validate ? undefined : Number.MIN_VALUE" controls-position="right"
              data-testid="laser-rx-aperture" @update:model-value="setLaserNumber('rxApertureDiameterM', $event)" />
          </el-form-item>
          <el-form-item required label="激光脉宽（ns）" :error="fieldError('laser.pulseWidthS')">
            <el-input-number :model-value="editor.laser?.pulseWidthS === undefined ? undefined : editor.laser.pulseWidthS * 1e9" :min="validate ? undefined : Number.MIN_VALUE" controls-position="right"
              data-testid="laser-pulse-width" @update:model-value="setLaserPulseWidthNs" />
            <small class="link-editor-hint">界面按 ns 输入，保存为 s。</small>
          </el-form-item>
          <el-form-item required label="光调制方式" :error="fieldError('laser.modulation')">
            <el-select :model-value="editor.laser?.modulation" placeholder="请选择 OOK" style="width: 100%" data-testid="laser-modulation" @update:model-value="setLaserModulation">
              <el-option :label="LASER_LINK_MODULATION" :value="LASER_LINK_MODULATION" />
            </el-select>
          </el-form-item>
          <p class="link-editor-field--wide link-editor-hint">激光链路以光学口径生成收发模型；射频极化、噪声系数、调制和天线增益不适用于此配置。</p>
        </div>
      </section>

      <section class="link-editor-section" aria-labelledby="link-quality-title">
        <h4 id="link-quality-title" class="link-editor-section__title">质量与方向</h4>
        <p class="link-editor-hint">调制方式、信道编码类型、BER 阈值：新模板无对应参数，不写入脚本；通信方向决定数传上行 / 下行端口。</p>
        <div class="link-editor-grid">
          <el-form-item v-if="!laser" required label="调制方式" :error="fieldError('modulation')">
            <el-select v-model="editor.modulation" style="width: 100%" data-testid="link-modulation">
              <el-option v-for="value in LINK_MODULATIONS" :key="value" :label="value" :value="value" />
            </el-select>
          </el-form-item>
          <el-form-item required label="通信方向" :error="fieldError('direction')">
            <el-select v-model="editor.direction" style="width: 100%" data-testid="link-direction" @change="changeDirection">
              <el-option v-for="(label, value) in linkDirectionLabels" :key="value" :label="label" :value="value" />
            </el-select>
          </el-form-item>
          <el-form-item class="link-editor-field--wide" label="信道编码类型" :error="fieldError('coding')">
            <el-select :model-value="editor.coding ?? ''" filterable allow-create clearable default-first-option
              placeholder="选择无编码，或输入后端约定编码标识" data-testid="link-coding" @update:model-value="changeCoding">
              <el-option label="无编码" value="UNCODED" />
              <el-option v-if="editor.coding && editor.coding !== 'UNCODED'" :label="editor.coding" :value="editor.coding" />
            </el-select>
          </el-form-item>
          <el-form-item required class="link-editor-field--wide" label="BER 阈值" :error="fieldError('berThreshold')">
            <div class="link-editor-threshold">
              <el-input-number v-model="editor.berThreshold" :min="validate ? undefined : 0" :max="validate ? undefined : 1" :step="0.000001" controls-position="right" data-testid="link-ber-threshold" />
              <span>取值范围 0–1</span>
            </div>
          </el-form-item>
        </div>
      </section>
      <section v-if="business" class="link-editor-section" aria-labelledby="link-business-title">
        <h4 id="link-business-title" class="link-editor-section__title">业务参数</h4>
        <BusinessEditorDialog :key="business.id" embedded :model-value="true" :demand="business"
          :editing="Boolean(demand?.linkId)" :disabled="pending || locked" :platforms="platforms" error="" :validate="validateBusiness" />
      </section>
    </el-form>
    <template #footer>
      <el-button :disabled="pending" data-testid="cancel-link" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="pending" :disabled="pending || locked || Boolean(parameterMismatch) || Boolean(parameterSelectionError)" data-testid="apply-link" @click="apply">{{ selectedParameter || editor?.parameterSource || link?.parameterSource ? '保存' : '确认' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.platform-feedback {
  margin-bottom: 1rem;
}

.link-editor-form {
  display: grid;
  gap: 0.5rem;
}

.link-parameter-source {
  margin-bottom: 0.5rem;
  padding: 0.5rem;
  border: 1px solid var(--console-border);
  border-radius: 4px;
  font-size: 0.75rem;
}

.link-parameter-source__controls {
  display: flex;
  gap: 0.5rem;
}

.link-parameter-source__controls .el-select {
  flex: 1;
  min-width: 0;
}

.link-parameter-source p { margin: 0.25rem 0; }

.link-editor-section {
  min-width: 0;
}

.link-editor-section__title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0 0 0.375rem;
  color: var(--console-cyan);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
}

.link-editor-section__title::after {
  flex: 1;
  border-top: 1px solid var(--console-border);
  content: '';
}

.link-editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 1rem;
}

.link-editor-grid :deep(.el-form-item) {
  margin-bottom: 0.375rem;
}

.link-editor-grid :deep(.el-form-item__label) {
  margin-bottom: 0.25rem;
  line-height: 1.25rem;
}

.link-editor-grid :deep(.el-input-number) {
  width: 100%;
}

.link-editor-field--wide {
  grid-column: 1 / -1;
}

.link-editor-threshold {
  display: grid;
  align-items: center;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
  width: 100%;
}

.link-editor-hint {
  color: var(--console-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.link-editor-threshold span {
  color: var(--console-text-muted);
  font-size: 0.75rem;
}

@media (max-width: 600px) {
  .link-editor-grid,
  .link-editor-threshold {
    grid-template-columns: 1fr;
  }

  .link-editor-field--wide {
    grid-column: auto;
  }
}
</style>
