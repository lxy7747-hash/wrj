<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue'
import { APP_CONFIG } from '../../config/app.config'
import type { CapabilityState, InformationDemand, LaserLinkParameters, Link, LinkParameterField, LinkType, Platform, ScenarioParameterCatalog, ValidationIssue } from '../../contracts/domain-models'
import { LINK_MODULATIONS, prepareLinkEquipment } from '../../features/scenarios/link-equipment-parameters'
import { EQUIPMENT_LINK_TYPES, equipmentTypeIssue } from '../../features/admin/equipment-link-rules'
import { prepareLinkMasterData } from '../../features/scenarios/link-master-parameters'
import { isPlatformPortLinkField, type LinkPortEditorProjection } from '../../features/scenarios/link-port-parameters'
import { LINK_PARAMETER_DEFAULTS } from '../../features/scenarios/link-settings'
import {
  datalinkRateTiers, directionalDataRateBounds, FIBER_DATA_RATE_MBPS, fixedLinkDataRate, formatDataRate, linkPowerMaxW, linkTypeDefaults,
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
  resolvePortParameters?: (link: Link) => LinkPortEditorProjection | null
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
const laserSwitchFields = [...Object.keys(linkTypeDefaults('LASER')), 'txPolarization', 'rxPolarization', 'inheritPortParameters'] as (keyof EditableLink)[]
let beforeLaser: EditableLink | null = null
/** 用于区分“打开弹框回显方向”和“用户实际切换方向”，避免回显时误改业务信息类型。 */
let lastDirection: Link['direction'] | undefined
const validationTick = ref(0)
const usePlatformPorts = computed(() => props.resolvePortParameters !== undefined && editor.value?.type !== 'LASER')
const portParameters = computed(() => {
  void validationTick.value
  return editor.value && usePlatformPorts.value ? props.resolvePortParameters?.(editor.value as Link) ?? null : null
})
function includesPortField(fields: readonly LinkParameterField[]): boolean {
  const type = editor.value?.type
  return usePlatformPorts.value && type !== undefined && fields.some(field => isPlatformPortLinkField(type, field))
}

const selectedParameter = ref('')
const selectedEntry = ref('')
const sourceValues = ref('')
const sourceFields: Record<LinkParameterField, string> = {
  frequency: '发射频率', bandwidth: '发射带宽', txPower: '发射功率', dataRate: '数据速率', modulation: '调制方式', berThreshold: '误码率阈值',
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
const showMasterData = computed(() => APP_CONFIG.systemManagement.showMasterData)
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
  if (includesPortField(preview.fields)) return '所选基础数据包含共享端口参数，请在「端口参数设置」中引用。'
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
  if (!props.modelValue || props.referenceDisabled || !editor.value || !preview?.ok || preview.fields.length === 0 || includesPortField(preview.fields)
    || !source || props.pending || props.locked) return
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
  if (usePlatformPorts.value && portParameters.value) Object.assign(link, portParameters.value.values)
  return link
}

const validationIssues = computed(() => {
  // 深度 watch 将嵌套输入同步到此计算属性。
  void validationTick.value
  const link = validationLink()
  return link && props.validate ? props.validate(link, validationDemand(link)) : []
})
/** 新增链路的默认端点只是占位。用户改过类型或端点之后，才显示端口组合错误。 */
const revealEndpointConstraint = ref(false)
const shownIssues = computed(() => revealEndpointConstraint.value
  ? validationIssues.value
  : validationIssues.value.filter(issue => issue.code !== 'TEMPLATE_PORT_MAPPING_INVALID' && issue.code !== 'TEMPLATE_PORT_MAPPING_WARNING'))
const fieldError = (fieldPath: string): string => fieldValidationMessage(shownIssues.value, fieldPath)
const PORT_MANAGED_LINK_FIELDS = ['dataRate', 'frequency', 'bandwidth', 'txPower', 'rxFrequency', 'rxBandwidth', 'noiseFigureDb'] as const
const portValidationMessages = computed(() => {
  if (!usePlatformPorts.value) return []
  return Array.from(new Set(PORT_MANAGED_LINK_FIELDS.map(field => fieldError(field)).filter(Boolean)))
})
const receiveDetails = ref<HTMLDetailsElement | null>(null)

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
  revealEndpointConstraint.value = true
  if (!editor.value) return
  if (editor.value.relayPlatformId && !relayCandidates(type).some(platform => platform.id === editor.value!.relayPlatformId)) editor.value.relayPlatformId = null
  if (type === 'DATALINK') editor.value.band ??= 'C'
  else delete editor.value.band
  if (type === 'LASER') {
    if (props.resolvePortParameters) beforeLaser = structuredClone(toRaw(editor.value))
    // 采用 1112 lazer_link 缺省参数集（含 EIRP 20 / G-T 15 / 噪声 5）；光学口径、脉宽与 OOK 为可选扩展，切入时不强制填写。
    delete editor.value.laser
    delete editor.value.txPolarization
    delete editor.value.rxPolarization
    delete editor.value.inheritPortParameters
    Object.assign(editor.value, linkTypeDefaults('LASER'))
    return
  }
  if (beforeLaser) {
    const restored = structuredClone(toRaw(editor.value))
    for (const key of laserSwitchFields) {
      if (Object.hasOwn(beforeLaser, key)) Object.assign(restored, { [key]: beforeLaser[key] })
      else Reflect.deleteProperty(restored, key)
    }
    editor.value = restored
    beforeLaser = null
  }
  delete editor.value.laser
  applyTypeDefaults()
}

/** 套用当前类型、波段与方向对应的文档端口默认值；不改动端点、调制和业务参数。 */
function applyTypeDefaults(): void {
  if (!editor.value) return
  if (editor.value.type === 'LASER') return
  const defaults = linkTypeDefaults(editor.value.type, editor.value.band ?? 'C', editor.value.direction)
  if (usePlatformPorts.value) {
    editor.value.txPolarization ??= defaults.txPolarization
    editor.value.rxPolarization ??= defaults.rxPolarization
  } else Object.assign(editor.value, defaults)
}

const fiber = computed(() => editor.value?.type === 'FIBER')
const laser = computed(() => editor.value?.type === 'LASER')
/** 卫星、微波速率固定只读；天通卫星为 16 kbit/s。 */
const fixedDataRate = computed(() => editor.value && !usePlatformPorts.value ? fixedLinkDataRate(editor.value, props.platforms) : null)
const rateTiers = computed(() => editor.value?.type === 'DATALINK' ? datalinkRateTiers(editor.value.band ?? 'C', editor.value.direction) : [])
const laserWavelengthNm = computed(() => {
  const frequencyMHz = editor.value?.frequency
  return typeof frequencyMHz === 'number' && Number.isFinite(frequencyMHz) && frequencyMHz > 0
    ? 299_792_458_000 / frequencyMHz
    : null
})

function setReceiveCarrierNumber(key: 'rxFrequency' | 'rxBandwidth', value: number | null | undefined): void {
  if (!editor.value) return
  if (typeof value === 'number' && Number.isFinite(value)) editor.value[key] = value
  else delete editor.value[key]
}

/** 清空噪声系数时恢复设备缺省（3 dB）。 */
function setNoiseFigure(value: number | null | undefined): void {
  if (!editor.value) return
  if (typeof value === 'number') editor.value.noiseFigureDb = value
  else delete editor.value.noiseFigureDb
}

/** 激光链路可选数值字段（EIRP/G-T/噪声）：清空即删除属性，留待校验。 */
function setLaserNumberField(key: 'eirpDbw' | 'gtDbk' | 'noiseFigureDb', value: number | null | undefined): void {
  if (!editor.value) return
  if (typeof value === 'number' && Number.isFinite(value)) editor.value[key] = value
  else delete editor.value[key]
}

/** 确认当前链路及其启停副本；取消或校验失败时不写入原场景。 */
function apply(): void {
  if (editor.value === null || props.pending || props.locked || parameterMismatch.value || parameterSelectionError.value) return
  if (selectedSource.value) applyParameters()
  if (fixedDataRate.value !== null) editor.value.dataRate = fixedDataRate.value
  const receiveFields = laser.value ? ['rxFrequency', 'rxBandwidth'] : ['rxFrequency', 'rxBandwidth', 'txPolarization', 'rxPolarization', 'noiseFigureDb']
  if (receiveDetails.value && receiveFields.some(fieldError)) receiveDetails.value.open = true
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
  revealEndpointConstraint.value = props.editing
  if (receiveDetails.value) receiveDetails.value.open = false
  beforeLaser = null
  editor.value = props.link === null ? null : { ...LINK_PARAMETER_DEFAULTS, ...structuredClone(toRaw(props.link)) }
  // 旧数传链路缺省波段时按 C 波段展示，与生成器的缺省口径一致。
  if (editor.value?.type === 'DATALINK') editor.value.band ??= 'C'
  lastDirection = editor.value?.direction
  // 旧链路没有单独的接收参数与极化时，按生成器缺省口径展示（接收同发射，微波水平、其余垂直）。
  if (editor.value && editor.value.type !== 'LASER') {
    const defaults = linkTypeDefaults(editor.value.type)
    if (!usePlatformPorts.value) {
      editor.value.rxFrequency ??= editor.value.frequency
      editor.value.rxBandwidth ??= editor.value.bandwidth
    }
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
  if (!direction) return
  // 打开弹框时的回显不算用户切换（lastDirection 已在赋值时同步为新方向）。
  if (lastDirection === undefined || lastDirection === direction) { lastDirection = direction; return }
  lastDirection = direction
  if (business.value) changeBusinessDirection(business.value, direction, Boolean(props.demand?.linkId))
})

/** 数传上下行的频率、功率与速率档位不同，用户切换方向时套用对应默认值。 */
function changeDirection(): void {
  if (editor.value?.type === 'DATALINK') applyTypeDefaults()
}

/** 前向/返向速率上下界，随链路类型与数传波段动态更新。 */
const forwardRateBounds = computed(() => editor.value
  ? directionalDataRateBounds(editor.value.type, 'FORWARD', editor.value.band ?? 'C')
  : { min: 0.001, max: Infinity })
const reverseRateBounds = computed(() => editor.value
  ? directionalDataRateBounds(editor.value.type, 'REVERSE', editor.value.band ?? 'C')
  : { min: 0.001, max: Infinity })

/** 未填写单链方向速率时的占位提示，展示当前沿用的端口/默认速率。 */
const directionalRatePlaceholder = computed(() => {
  const fallback = portParameters.value?.values.dataRate ?? fixedDataRate.value ?? editor.value?.dataRate
  return typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0
    ? `默认 ${formatDataRate(fallback)}`
    : '留空沿用端口/默认速率'
})

/** 可选方向速率清空后必须删除属性，才能回退到端口/默认速率而不是留下 undefined。 */
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
    width="min(860px, calc(100vw - 2rem))"
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
        <div class="link-editor-grid link-editor-grid--auto">
          <el-form-item required label="链路类型" :error="fieldError('type')">
            <el-select v-model="editor.type" style="width: 100%" data-testid="link-type" @change="changeType">
              <el-option v-for="option in linkTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
          <!-- 链路启停改在“链路配置”列表行内操作；此处保留隐藏节点，兼容旧场景回显与校验定位。 -->
          <el-form-item v-show="false" label="当前链路" :error="fieldError('enabled')">
            <el-switch v-model="editor.enabled" active-text="启用" inactive-text="停用" data-testid="link-enabled" />
          </el-form-item>
          <el-form-item required label="通信方向" :error="fieldError('direction')">
            <el-select v-model="editor.direction" style="width: 100%" data-testid="link-direction" @change="changeDirection">
              <el-option v-for="(label, value) in linkDirectionLabels" :key="value" :label="label" :value="value" />
            </el-select>
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
        <div class="link-editor-grid link-editor-grid--auto">
          <el-form-item required label="发送端" :error="fieldError('sourcePlatformId')">
            <el-select v-model="editor.sourcePlatformId" filterable style="width: 100%" data-testid="link-source" @change="revealEndpointConstraint = true">
              <el-option v-for="platform in platforms" :key="platform.id" :label="scenarioPlatformLabel(platforms, platform.id, showIds)" :value="platform.id" />
            </el-select>
          </el-form-item>
          <el-form-item required label="接收端" :error="fieldError('targetPlatformId')">
            <el-select v-model="editor.targetPlatformId" filterable style="width: 100%" data-testid="link-target" @change="revealEndpointConstraint = true">
              <el-option v-for="platform in platforms" :key="platform.id" :label="scenarioPlatformLabel(platforms, platform.id, showIds)" :value="platform.id" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="editor.type === 'SAT' || editor.type === 'MICROWAVE' || editor.type === 'DATALINK'" label="中继节点（可选）" :error="fieldError('relayPlatformId')">
            <el-select :model-value="editor.relayPlatformId ?? ''" clearable placeholder="不经中继" style="width: 100%" data-testid="link-relay" @update:model-value="setRelay">
              <el-option v-for="platform in relayOptions" :key="platform.id" :label="scenarioPlatformLabel(platforms, platform.id, showIds)" :value="platform.id" />
            </el-select>
            <small v-if="editor.type === 'SAT'" class="link-editor-hint">公共服务平台后方节点与任务无人机之间的卫通须经通信卫星中继。</small>
          </el-form-item>
        </div>
      </section>

      <section class="link-editor-section" aria-labelledby="link-communication-title">
        <h4 id="link-communication-title" class="link-editor-section__title">通信参数</h4>
        <div v-if="usePlatformPorts || showMasterData || editor.parameterSource" class="link-parameter-source" data-testid="link-parameter-source">
          <template v-if="usePlatformPorts">
            <p>端口参数统一在「端口参数设置」中配置。</p>
            <div v-if="portParameters" data-testid="link-port-parameters">
              <p>发送端端口：{{ scenarioPlatformLabel(platforms, editor.sourcePlatformId, showIds) }} · {{ portParameters.source.portName }}</p>
              <p>接收端端口：{{ scenarioPlatformLabel(platforms, editor.targetPlatformId, showIds) }} · {{ portParameters.target.portName }}</p>
            </div>
            <p v-else>请选择可匹配端口的节点和链路类型。</p>
            <p v-for="message in portValidationMessages" :key="message" class="link-port-conflict" role="alert" data-testid="link-port-validation">{{ message }}</p>
          </template>
          <template v-if="showMasterData">
            <div class="link-parameter-source__controls">
              <el-select v-model="selectedParameter" placeholder="选择设备参数或通用基础数据" aria-label="链路基础数据" filterable clearable :loading="parameterLoading" :disabled="referenceDisabled"
                data-testid="link-parameter-select" @change="changeParameterSource" @visible-change="visible => { if (visible && !parameterCatalog && !parameterLoading) emit('load-parameters') }">
                <el-option v-if="savedParameter && selectedParameter === savedParameter.key" :value="savedParameter.key" :label="savedParameter.label" disabled />
                <el-option-group v-if="!usePlatformPorts" label="设备参数">
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
          </template>
          <div v-if="editor.parameterSource" data-testid="link-parameter-applied">
            已引用 {{ editor.parameterSource.sourceId }} · v{{ editor.parameterSource.sourceVersion }}
            <el-button link data-testid="link-parameter-clear" @click="clearParameterSource">取消引用，保留参数</el-button>
          </div>
          <p v-if="parameterMismatch" role="alert" data-testid="link-parameter-mismatch">{{ parameterMismatch }}</p>
        </div>
        <div class="link-editor-grid">
          <el-form-item v-if="editor.direction === 'FORWARD' || Boolean(fieldError('forwardDataRate'))" label="前向速率（Mbit/s）" :error="fieldError('forwardDataRate')">
            <el-input-number :model-value="editor.forwardDataRate" :min="validate ? undefined : forwardRateBounds.min"
              :max="validate ? undefined : forwardRateBounds.max" :step="0.001" :placeholder="directionalRatePlaceholder"
              controls-position="right" data-testid="link-forward-data-rate" @update:model-value="setDirectionalRate('forwardDataRate', $event)" />
            <small :class="{ 'link-editor-hint--hidden': !!fieldError('forwardDataRate') }" class="link-editor-hint">
              {{ `${forwardRateBounds.min}～${forwardRateBounds.max} Mbit/s；留空沿用端口/默认速率。` }}
            </small>
          </el-form-item>
          <el-form-item v-if="editor.direction === 'REVERSE' || Boolean(fieldError('reverseDataRate'))" label="返向速率（Mbit/s）" :error="fieldError('reverseDataRate')">
            <el-input-number :model-value="editor.reverseDataRate" :min="validate ? undefined : reverseRateBounds.min"
              :max="validate ? undefined : reverseRateBounds.max" :step="0.001" :placeholder="directionalRatePlaceholder"
              controls-position="right" data-testid="link-reverse-data-rate" @update:model-value="setDirectionalRate('reverseDataRate', $event)" />
            <small :class="{ 'link-editor-hint--hidden': !!fieldError('reverseDataRate') }" class="link-editor-hint">
              {{ `${reverseRateBounds.min}～${reverseRateBounds.max} Mbit/s；留空沿用端口/默认速率。` }}
            </small>
          </el-form-item>
          <el-form-item v-if="!usePlatformPorts" required :label="laser ? '介质传输速率（Mbit/s）' : '数据速率'" :error="fieldError('dataRate')">
            <el-input v-if="fixedDataRate !== null" :model-value="formatDataRate(fixedDataRate)" disabled data-testid="link-data-rate" />
            <el-select v-else-if="editor.type === 'DATALINK'" v-model="editor.dataRate" style="width: 100%" data-testid="link-data-rate">
              <el-option v-for="tier in rateTiers" :key="tier" :label="formatDataRate(tier)" :value="tier" />
              <el-option v-if="editor.dataRate !== undefined && !rateTiers.includes(editor.dataRate)" :label="`${formatDataRate(editor.dataRate)}（不在档位内）`" :value="editor.dataRate" />
            </el-select>
            <el-input-number v-else v-model="editor.dataRate" :min="validate ? undefined : fiber ? FIBER_DATA_RATE_MBPS.min : 0" :max="validate ? undefined : fiber ? FIBER_DATA_RATE_MBPS.max : Infinity"
              controls-position="right" data-testid="link-data-rate" />
            <small v-if="fixedDataRate === null && !laser" :class="{ 'link-editor-hint--hidden': !!fieldError('dataRate') }" class="link-editor-hint">{{ editor.type === 'DATALINK' ? '按波段与方向分档' : fiber ? '10～1000 Mbit/s' : '单位 Mbit/s' }}</small>
          </el-form-item>
          <el-form-item v-if="!usePlatformPorts" required :label="fiber ? '发送频率（MHz）' : laser ? '激光频率（MHz）' : '发射频率（MHz）'" :error="fieldError('frequency')">
            <el-input-number v-model="editor.frequency" :min="validate ? undefined : Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="link-frequency" @input="emit('frequency-input', $event)" />
            <small v-if="laser" :class="{ 'link-editor-hint--hidden': !!fieldError('frequency') }" class="link-editor-hint" data-testid="laser-wavelength">
              {{ laserWavelengthNm === null ? '填写激光频率后显示波长' : `波长约 ${Number(laserWavelengthNm.toPrecision(8))} nm（只读）` }}
            </small>
          </el-form-item>
          <template v-if="!fiber && !usePlatformPorts">
            <el-form-item required :label="laser ? '激光带宽（MHz）' : '发射带宽（MHz）'" :error="fieldError('bandwidth')">
              <el-input-number v-model="editor.bandwidth" :min="validate ? undefined : Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="link-bandwidth" @input="emit('bandwidth-input', $event)" />
            </el-form-item>
            <el-form-item required :label="laser ? '激光光功率（W）' : '发射功率（W）'" :error="fieldError('txPower')">
              <el-input-number v-model="editor.txPower" :min="validate ? undefined : 0" :max="validate ? undefined : linkPowerMaxW(editor.type)" controls-position="right" data-testid="link-power" />
            </el-form-item>
          </template>
          <template v-if="!fiber && !laser">
            <el-form-item v-if="Boolean(fieldError('antennaGain.tx'))" required label="发射天线增益（dBi）" :error="fieldError('antennaGain.tx')"><el-input-number v-model="editor.antennaGain.tx" controls-position="right" data-testid="link-tx-gain" /></el-form-item>
            <el-form-item v-if="Boolean(fieldError('antennaGain.rx'))" required label="接收天线增益（dBi）" :error="fieldError('antennaGain.rx')"><el-input-number v-model="editor.antennaGain.rx" controls-position="right" data-testid="link-rx-gain" /></el-form-item>
          </template>
        </div>
        <section v-if="!laser" class="link-editor-subsection" aria-labelledby="link-quality-title" data-testid="link-quality-advanced">
          <h5 id="link-quality-title" class="link-editor-subsection__title">质量参数</h5>
          <div class="link-editor-grid">
            <el-form-item required label="调制方式" :error="fieldError('modulation')">
              <el-select v-model="editor.modulation" clearable value-on-clear="" style="width: 100%" data-testid="link-modulation">
                <el-option v-for="value in LINK_MODULATIONS" :key="value" :label="value" :value="value" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="Boolean(fieldError('berThreshold'))" required label="误码率阈值" :error="fieldError('berThreshold')">
              <div class="link-editor-threshold">
                <el-input-number v-model="editor.berThreshold" :min="validate ? undefined : 0" :max="validate ? undefined : 1" :step="0.000001" controls-position="right" data-testid="link-ber-threshold" />
                <span :class="{ 'link-editor-hint--hidden': !!fieldError('berThreshold') }">取值范围 0–1</span>
              </div>
            </el-form-item>
          </div>
        </section>
        <details v-if="!fiber && !usePlatformPorts" ref="receiveDetails" class="scenario-advanced" data-testid="link-receive-advanced">
          <summary>{{ laser ? '接收参数' : '接收与极化' }}</summary>
          <div class="link-editor-grid">
            <el-form-item v-if="!usePlatformPorts" :required="!laser" :label="laser ? '接收激光频率（MHz）' : '接收频率（MHz）'" :error="fieldError('rxFrequency')">
              <el-input-number :model-value="editor.rxFrequency" :placeholder="laser ? '留空时与发射相同' : undefined" :min="validate ? undefined : Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="link-rx-frequency" @update:model-value="setReceiveCarrierNumber('rxFrequency', $event)" />
            </el-form-item>
            <el-form-item v-if="!usePlatformPorts" :required="!laser" :label="laser ? '接收激光带宽（MHz）' : '接收带宽（MHz）'" :error="fieldError('rxBandwidth')">
              <el-input-number :model-value="editor.rxBandwidth" :placeholder="laser ? '留空时与发射相同' : undefined" :min="validate ? undefined : Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="link-rx-bandwidth" @update:model-value="setReceiveCarrierNumber('rxBandwidth', $event)" />
            </el-form-item>
            <template v-if="!laser">
              <el-form-item v-if="!usePlatformPorts" required label="发射极化" :error="fieldError('txPolarization')">
                <el-select v-model="editor.txPolarization" style="width: 100%" data-testid="link-tx-polarization">
                  <el-option label="垂直极化" value="vertical" /><el-option label="水平极化" value="horizontal" />
                </el-select>
              </el-form-item>
              <el-form-item v-if="!usePlatformPorts" required label="接收极化" :error="fieldError('rxPolarization')">
                <el-select v-model="editor.rxPolarization" style="width: 100%" data-testid="link-rx-polarization">
                  <el-option label="垂直极化" value="vertical" /><el-option label="水平极化" value="horizontal" />
                </el-select>
              </el-form-item>
              <el-form-item v-if="!usePlatformPorts" label="接收机噪声系数（dB）" :error="fieldError('noiseFigureDb')">
                <el-input-number :model-value="editor.noiseFigureDb" :min="validate ? undefined : 0" :max="validate ? undefined : 100" placeholder="缺省 3（天通 2）" controls-position="right"
                  data-testid="link-noise-figure" @update:model-value="setNoiseFigure" />
              </el-form-item>
            </template>
          </div>
        </details>
        <details v-if="!laser" class="scenario-advanced" data-testid="link-gain-advanced" :open="['antennaGainCorrectionDb', 'antiJammingGainDb', 'spatialIsolationDb'].some(key => fieldError(key))">
          <summary>增益修正与抗干扰参数</summary>
          <div class="link-editor-grid link-editor-grid--three">
          <el-form-item v-if="!usePlatformPorts" label="天线增益修正值（dB）" :error="fieldError('antennaGainCorrectionDb')"><el-input-number v-model="editor.antennaGainCorrectionDb" controls-position="right" data-testid="link-gain-correction" /></el-form-item>
          <el-form-item label="波形抗干扰增益（dB）" :error="fieldError('antiJammingGainDb')"><el-input-number v-model="editor.antiJammingGainDb" :min="validate ? undefined : 0" controls-position="right" data-testid="link-anti-jamming-gain" /></el-form-item>
          <el-form-item label="空域隔离量（dB）" :error="fieldError('spatialIsolationDb')"><el-input-number v-model="editor.spatialIsolationDb" :min="validate ? undefined : 0" controls-position="right" data-testid="link-spatial-isolation" /></el-form-item>
          </div>
        </details>
      </section>

      <details v-if="laser" class="scenario-advanced" data-testid="link-laser-advanced"
        :open="validationIssues.some(issue => ['eirpDbw', 'gtDbk', 'noiseFigureDb'].includes(issue.fieldPath))">
        <summary>激光增益与噪声参数</summary>
        <div class="link-editor-grid link-editor-grid--three">
          <el-form-item label="EIRP（dBW）" :error="fieldError('eirpDbw')">
            <el-input-number :model-value="editor.eirpDbw" :step="0.1" controls-position="right" data-testid="laser-eirp" @update:model-value="setLaserNumberField('eirpDbw', $event)" />
          </el-form-item>
          <el-form-item label="G/T（dB/K）" :error="fieldError('gtDbk')">
            <el-input-number :model-value="editor.gtDbk" :step="0.1" controls-position="right" data-testid="laser-gt" @update:model-value="setLaserNumberField('gtDbk', $event)" />
          </el-form-item>
          <el-form-item label="噪声系数（dB）" :error="fieldError('noiseFigureDb')">
            <el-input-number :model-value="editor.noiseFigureDb" :min="validate ? undefined : 0" :step="0.1" controls-position="right" data-testid="laser-noise" @update:model-value="setLaserNumberField('noiseFigureDb', $event)" />
          </el-form-item>
        </div>
      </details>

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
  margin-bottom: 0.85rem;
}

.link-editor-form {
  display: grid;
  gap: 0.8rem;
}

.link-editor-form > .scenario-advanced {
  margin: 0;
}

.link-parameter-source {
  margin-bottom: 0.75rem;
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--console-border);
  border-left: 3px solid var(--console-cyan);
  border-radius: 6px;
  background: rgb(6 22 36 / 65%);
  font-size: 0.75rem;
  line-height: 1.5;
}

.link-parameter-source__controls {
  display: flex;
  gap: 0.5rem;
}

.link-parameter-source__controls .el-select {
  flex: 1;
  min-width: 0;
}

.link-parameter-source p { margin: 0.2rem 0; }

.link-parameter-source [data-testid="link-port-parameters"] {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.25rem 1rem;
  margin-top: 0.25rem;
}

.link-port-conflict {
  color: var(--el-color-warning);
}

.link-editor-section {
  min-width: 0;
  padding: 0.8rem 0.95rem 0.4rem;
  border: 1px solid var(--console-border);
  border-radius: 8px;
  background: rgb(8 25 40 / 48%);
}

.link-editor-section__title {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin: 0 0 0.6rem;
  color: var(--console-cyan);
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.link-editor-section__title::after {
  flex: 1;
  border-top: 1px solid rgb(52 104 134 / 55%);
  content: '';
}

.link-editor-subsection {
  min-width: 0;
  margin-top: 0.25rem;
  padding-top: 0.55rem;
  border-top: 1px dashed rgb(52 104 134 / 55%);
}

.link-editor-subsection__title {
  margin: 0 0 0.5rem;
  color: var(--console-text);
  font-size: 0.78rem;
  font-weight: 600;
}

.link-editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.15rem 0.9rem;
}

.link-editor-grid--auto {
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.link-editor-grid--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.link-editor-grid :deep(.el-form-item) {
  margin-bottom: 0.95rem;
}

.link-editor-grid :deep(.el-form-item__label) {
  margin-bottom: 0.25rem;
  color: var(--console-text-muted);
  font-size: 12px;
  line-height: 1.25rem;
}

.link-editor-grid :deep(.el-input-number) {
  width: 100%;
}

.link-editor-threshold {
  display: grid;
  align-items: center;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.75rem;
  width: 100%;
}

.link-editor-hint--hidden { visibility: hidden; }
:deep(.el-form-item.is-error:has(.link-editor-hint--hidden) .el-form-item__error) { transform: translateY(-1.5em); }
.link-editor-hint {
  display: block;
  margin-top: 0.2rem;
  color: var(--console-text-muted);
  font-size: 0.75rem;
  line-height: 1.45;
}

.link-editor-threshold span {
  color: var(--console-text-muted);
  font-size: 0.75rem;
}

@media (max-width: 720px) {
  .link-editor-grid--three,
  .link-parameter-source [data-testid="link-port-parameters"] {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .link-editor-grid,
  .link-editor-grid--auto,
  .link-editor-grid--three,
  .link-editor-threshold,
  .link-parameter-source [data-testid="link-port-parameters"] {
    grid-template-columns: 1fr;
  }
}
</style>
