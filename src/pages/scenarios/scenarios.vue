<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { BusinessInformationNodeType, CapabilityState, DeviceParameters, GeoPoint, InformationDemand, Jammer, JammerUiExtension, Link, LinkType, Platform, ScenarioConfig, ScenarioLinkSettings, SensorUiExtension, ValidationIssue } from '../../contracts/domain-models'
import { LINK_PARAMETER_DEFAULTS, readLinkEnabled, readLinkSettings } from '../../features/scenarios/link-settings'
import { formatScriptExecutionLog } from '../../features/scenarios/script-execution-status'
import { applyLinkEdit, synchronizePlatformLinkIds } from '../../features/scenarios/link-edit'
import { effectiveLinkFromPorts, isPlatformPortLinkField, overwriteLegacyLinkFromPorts, projectLinkPortParameters, resolveLinkPortFieldTarget } from '../../features/scenarios/link-port-parameters'
import { BUSINESS_DEFAULTS } from '../../features/scenarios/business-defaults'
import { createPlatformGrid } from '../../features/scenarios/platform-layout'
import { PLATFORM_POINT_DEFAULT_ALTITUDE, PLATFORM_POSITION_RULES, REAR_DEFAULT_ORIGIN, RELAY_DEFAULT_ORIGIN, RELAY_DEFAULT_ROUTE, SATELLITE_GEO_POSITION } from '../../features/scenarios/platform-position-rules'
import { saveScriptText } from '../../features/scenarios/script-file'
import type { ScriptGenerationReceipt as ScriptGenerationResult } from '../../features/scenarios/script-package-preflight'
import { isJammerPlatformType, JAMMER_CALC_DEFAULTS, JAMMER_DEFAULT_BANDS, JAMMER_DEFAULTS, METERS_PER_KILOMETER, readJammerBands, readJammerReleaseRange, wattsToDbm } from '../../features/scenarios/jammer-settings'
import { formatDataRate, linkTypeDefaults, RAIN_TIER_OPTIONS, RAIN_TIER_RATES, type RainTier } from '../../features/scenarios/link-calc-defaults'
import {
  BUSINESS_INFORMATION_NODE_TYPES,
  INFORMATION_NODE_LIMIT,
  INFORMATION_NODE_TYPE_LIMITS,
  JAMMER_TYPES,
  LINK_MHZ_MINIMUM_STEP,
  LINK_TYPES,
  SATELLITE_TYPES,
  PLATFORM_TYPE_DOMAINS,
  SUPPORTING_ENTITY_TYPES,
  inspectScenarioConfig,
  inspectScenarioUiExtensions,
  isBusinessInformationNodeType,
} from '../../features/scenarios/scenario-validation'
import { JAMMER_TYPE_LABELS, LINK_TYPE_LABELS, PLATFORM_TYPE_LABELS } from '../../features/situation/situation-model'
import { useScenarioStore } from '../../stores/scenario'
import { useAuthStore } from '../../stores/auth'
import ValidationPanel from '../../components/scenarios/ValidationPanel.vue'
import ScriptPreview from '../../components/scenarios/ScriptPreview.vue'
import ScriptPreviewDialog from '../../components/scenarios/ScriptPreviewDialog.vue'
import ScriptGenerationReceipt from '../../components/scenarios/ScriptGenerationReceipt.vue'
import PlatformEditorDialog from '../../components/scenarios/PlatformEditorDialog.vue'
import LinkEditorDialog from '../../components/scenarios/LinkEditorDialog.vue'
import LinkSettingsPanel from '../../components/scenarios/LinkSettingsPanel.vue'
import DeviceParametersPanel from '../../components/scenarios/DeviceParametersPanel.vue'
import SeaAreaMapPicker from '../../components/scenarios/SeaAreaMapPicker.vue'
import JammerEditorDialog from '../../components/scenarios/JammerEditorDialog.vue'
import NativeEsmEditor, { NATIVE_ESM_PROBE_DEFAULTS } from '../../components/scenarios/NativeEsmEditor.vue'
import { SCENARIO_BASIC_DEFAULTS, scenarioPlatformLabel } from '../../features/scenarios/scenario-basic'
import { readDeviceParameters, TEMPLATE_PLATFORM_TYPES, templatePortAntennaName } from '../../features/scenarios/template-defaults'
import { fieldValidationMessage } from '../../features/scenarios/validation-fields'
import { formatValidationFieldLabel, formatValidationIssueMessage } from '../../features/scenarios/validation-field-labels'

const scenarioStore = useScenarioStore()
const props = defineProps<{ managed?: boolean }>()
const emit = defineEmits<{ saved: []; back: [] }>()
const authStore = useAuthStore()
const {
  draft,
  dirty,
  panelState,
  resultCode,
  resultMessage,
  validation,
  templateState,
  script,
  scriptState,
  scriptResultMessage,
  preflight,
} = storeToRefs(scenarioStore)
const activeTab = ref('scenario')
const LINK_PAGE_SIZE = 30
const linkPage = ref(1)
const portParametersVisible = ref(false)
const portParametersError = ref('')
const portParametersWarning = ref('')
const deviceFocusPath = ref('')
const showIds = ref(false)
const draftReviewed = ref(false)
const scriptAction = ref<'save' | 'generate' | null>(null)
const previewingScript = ref(false)
const scriptPreviewVisible = ref(false)
const scriptPreviewReceipt = ref<ScriptGenerationResult | null>(null)
const scriptOutputPath = ref('')
const scriptGenerationLog = ref<string[]>([])
const scriptGenerationReceipt = ref<ScriptGenerationResult | null>(null)
const scriptGenerationReceiptVisible = ref(false)
const scriptGenerationDialog = ref<InstanceType<typeof ScriptGenerationReceipt> | null>(null)
/** 日志直接读取本次预览的 mapping.json，避免页面按配置重新推断“已写入”。 */
function executionLog(): string[] { return script.value === null ? [] : formatScriptExecutionLog(script.value.preview) }
const validationAttempted = ref(false)
const touchedFields = ref(new Set<string>())
watch(() => draft.value?.config.scenario.id, () => {
  validationAttempted.value = false
  touchedFields.value.clear()
  linkPage.value = 1
  portParametersVisible.value = false
  portParametersError.value = ''
  portParametersWarning.value = ''
}, { flush: 'sync' })
let active = true
const executionLifetime = new AbortController()
onBeforeUnmount(() => { active = false; executionLifetime.abort() })
const platformDialogVisible = ref(false)
const editingPlatformIndex = ref<number | null>(null)
const otherPlatformNodes = computed(() => draft.value?.config.platforms.filter((_, index) => index !== editingPlatformIndex.value))
const platformEditor = ref<Platform | null>(null)
const platformEditorError = ref('')
const detailPlatformId = ref<string | null>(null)
const detailPlatform = computed(() => draft.value?.config.platforms.find(platform => platform.id === detailPlatformId.value) ?? null)
// 重载或切换草稿时关闭详情，避免同编号节点串到另一场景。
watch(draft, () => {
  detailPlatformId.value = null
  scriptOutputPath.value = ''
  scriptGenerationLog.value = []
}, { flush: 'sync' })
const linkDialogVisible = ref(false)
const editingLinkIndex = ref<number | null>(null)
const linkSettingsVisible = ref(false)
const linkSettingsPanel = ref<InstanceType<typeof LinkSettingsPanel> | null>(null)
const seaAreaVisible = ref(false)
const linkEditorLink = ref<Link | null>(null)
const linkEditorError = ref('')
const linkFrequencyBelowMinimum = ref(false)
const linkBandwidthBelowMinimum = ref(false)
const linkBusiness = ref<InformationDemand | null>(null)
const linkFocusPath = ref('')
const jammerDialogVisible = ref(false)
const editingJammerIndex = ref<number | null>(null)
const jammerEditorJammer = ref<Jammer | null>(null)
const jammerEditorUiExtension = ref<JammerUiExtension | null>(null)
const jammerEditorError = ref('')
const jammerFocusPath = ref('')
const jammerFrequencyBelowMinimum = ref(false)
const jammerBandwidthBelowMinimum = ref(false)

/** 分钟只用于表单显示；保持接口中的 duration 为秒，避免两套时长失去同步。 */
const simulationDurationMinutes = computed<number | undefined>({
  get: () => {
    const seconds = draft.value?.config.scenario.duration
    return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds / 60 : undefined
  },
  /** 接收用户输入的分钟数；清空时保留无效值供整体校验提示，不静默恢复默认值。 */
  set: (minutes) => {
    if (!draft.value) return
    draft.value.config.scenario.duration = typeof minutes === 'number' ? minutes * 60 : Number.NaN
    markDirty()
  },
})

const deploymentDomainLabels = {
  ground: '地面',
  air: '空中',
  space: '天基',
} as const
const businessTypeOptions = BUSINESS_INFORMATION_NODE_TYPES.map((value) => ({ value, label: PLATFORM_TYPE_LABELS[value] }))
const supportingTypeOptions = SUPPORTING_ENTITY_TYPES.map((value) => ({ value, label: PLATFORM_TYPE_LABELS[value] }))
const satelliteTypeOptions = SATELLITE_TYPES.map((value) => ({ value, label: value === 'TIANTONG' ? '天通卫星' : '神通卫星' }))
const linkTypeOptions = LINK_TYPES.map((value) => ({ value, label: LINK_TYPE_LABELS[value] }))
const linkDirectionLabels = { FORWARD: '前向', REVERSE: '返向' } as const
const jammerTypeOptions = JAMMER_TYPES.map((value) => ({ value, label: JAMMER_TYPE_LABELS[value] }))
const hasJammerPlatform = computed(() => draft.value?.config.platforms.some(platform => isJammerPlatformType(platform.type)) ?? false)

const stateLabels: Record<CapabilityState, string> = {
  LOADING: '加载中',
  VALIDATING: '校验中',
  EXECUTING: '处理中',
  SUCCESS: '已就绪',
  EMPTY: '未加载',
  ERROR: '处理失败',
}

/**
 * 判断页面当前是否处于不可重复操作的处理阶段。
 * @returns 加载、校验或保存中返回 `true`。
 * @remarks 只读取 Store 状态，不发起请求或修改草稿。
 */
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(panelState.value))
const businessNodeCount = computed(() => draft.value?.config.platforms.filter((platform) => isBusinessInformationNodeType(platform.type)).length ?? 0)
const businessNodeTypeCounts = computed<Record<BusinessInformationNodeType, number>>(() => Object.fromEntries(
  BUSINESS_INFORMATION_NODE_TYPES.map((type) => [
    type,
    draft.value?.config.platforms.filter((platform) => platform.type === type).length ?? 0,
  ]),
) as Record<BusinessInformationNodeType, number>)
const businessNodeTypeCount = computed(() => BUSINESS_INFORMATION_NODE_TYPES.filter((type) => businessNodeTypeCounts.value[type] > 0).length)
const supportingEntityCount = computed(() => (draft.value?.config.platforms.length ?? 0) - businessNodeCount.value)
const linkTypeCount = computed(() => new Set(draft.value?.config.links.map((link) => link.type) ?? []).size)
const linkPageCount = computed(() => Math.max(1, Math.ceil((draft.value?.config.links.length ?? 0) / LINK_PAGE_SIZE)))
const linkPageOffset = computed(() => (linkPage.value - 1) * LINK_PAGE_SIZE)
const pagedLinks = computed(() => draft.value?.config.links.slice(linkPageOffset.value, linkPageOffset.value + LINK_PAGE_SIZE) ?? [])
watch(linkPageCount, count => { linkPage.value = Math.min(linkPage.value, count) })
const linkSettings = computed(() => readLinkSettings(draft.value?.config ?? { platforms: [] }))

/** 写入链路全局设置；settings 为面板提交的配置副本，更新后标记草稿待保存。 */
function updateLinkSettings(settings: ScenarioLinkSettings): void {
  if (!draft.value || pending.value || draft.value.locked) return
  draft.value.config.linkSettings = settings
  markDirty()
}
const jammerTypeCount = computed(() => new Set(draft.value?.config.jammers.map((jammer) => jammer.type) ?? []).size)
const liveValidation = computed(() => {
  if (!draft.value) return { valid: true, errors: [], warnings: [] }
  const config = draft.value.config
  const effectiveConfig = { ...config, links: config.links.map(link => effectiveLinkFromPorts(config, link)) }
  const result = inspectScenarioConfig(effectiveConfig, 'write').result
  const extensions = inspectScenarioUiExtensions(draft.value.uiExtensions, config.jammers.map(item => item.id), config.sensors.map(item => item.id)).result
  return { valid: result.valid && extensions.valid, errors: [...result.errors, ...extensions.errors], warnings: result.warnings }
})
const validationCompleted = computed(() => draftReviewed.value || resultCode.value.startsWith('VALIDATION_'))
const showValidationSummary = computed(() => validationAttempted.value || validationCompleted.value || (draft.value?.revision ?? 0) > 0)
const templatePending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(templateState.value))
const configurationTab = computed(() => ['scenario', 'platforms', 'links', 'jammers', 'data'].includes(activeTab.value))
const deviceParametersPanel = ref<InstanceType<typeof DeviceParametersPanel> | null>(null)
const scriptPending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(scriptState.value))
const scenarioActionsBusy = computed(() => scriptAction.value !== null || previewingScript.value || pending.value || scriptPending.value)
const alreadySaved = computed(() => draft.value !== null && draft.value.revision > 0
  && !dirty.value && !draft.value.locked && !pending.value && !scriptPending.value)
const currentScriptPreview = computed(() => {
  const current = draft.value
  const preview = script.value
  if (!current || !preview || current.locked || dirty.value) return null
  return preview.scenarioId === current.config.scenario.id
    && preview.configVersion === `${current.config.scenario.id}-v${current.revision}` ? preview : null
})
watch(currentScriptPreview, preview => {
  if (!preview) {
    scriptPreviewVisible.value = false
    scriptPreviewReceipt.value = null
  }
}, { flush: 'sync' })
watch(scriptPreviewVisible, open => { if (!open) scriptPreviewReceipt.value = null })
const canMaintainTemplates = computed(() => authStore.authorize('OFFICIAL_TEMPLATE_MAINTAIN').allowed)

// 校验资格只属于当前草稿；编辑、重载或替换草稿后失效，不把“已保存”等同于“已校验”。
watch([draft, dirty], () => {
  draftReviewed.value = false
  scriptGenerationReceiptVisible.value = false
  scriptGenerationReceipt.value = null
  scriptPreviewReceipt.value = null
}, { flush: 'sync' })

const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/** 将 RFC 3339 时间转换为北京时间的分钟精度日期时间；仅适用固定 UTC+8，不处理夏令时。 */
function toBeijingDateTime(value: string): string {
  if (value === '') return ''
  const match = RFC3339_DATE_TIME.exec(value)
  if (match === null) return value
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]!) return value
  const date = new Date(value.replace('t', 'T').replace(/z$/, 'Z'))
  if (Number.isNaN(date.getTime())) return value
  const beijing = new Date(date.getTime() + BEIJING_UTC_OFFSET_MS)
  const pad = (part: number) => String(part).padStart(2, '0')
  const beijingYear = beijing.getUTCFullYear()
  const formattedYear = beijingYear < 0
    ? `-${String(Math.abs(beijingYear)).padStart(4, '0')}`
    : String(beijingYear).padStart(4, '0')
  return `${formattedYear}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}T${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}`
}

/** 将北京时间转换为秒精度 UTC RFC 3339；固定按 UTC+8 且不处理夏令时，无效值原样保留供校验。 */
function beijingDateTimeToUtc(value: string): string {
  if (value === '') return ''
  const parts = /^(\d{4,5})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (parts === null) return value
  const [, year, month, day, hour, minute] = parts.map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year!, month! - 1, day!)
  date.setUTCHours(hour! - 8, minute!, 0, 0)
  const utcYear = date.getUTCFullYear()
  if (utcYear < 0 || utcYear > 9999 || toBeijingDateTime(date.toISOString()) !== value) return value
  return date.toISOString().replace('.000Z', 'Z')
}

/**
 * 在 UTC RFC 3339 时间和北京时间输入格式之间转换。
 * @returns 当前输入框使用的北京时间分钟精度文本。
 * @remarks 写入时将北京时间转换为 UTC，更新草稿开始时间并标记存在未保存修改。
 */
const startTimeBeijing = computed({
  get: () => toBeijingDateTime(draft.value?.config.scenario.startTime ?? ''),
  set: (value: string | null) => {
    if (draft.value === null) return
    draft.value.config.scenario.startTime = beijingDateTimeToUtc(value ?? '')
    scenarioStore.markDirty()
  },
})

const useStartTimeDatePicker = computed(() => {
  const value = startTimeBeijing.value
  if (value === '') return true
  const year = Number(value.slice(0, value.indexOf('-')))
  return year >= 1000 && year <= 9999 && beijingDateTimeToUtc(value) !== value
})

/**
 * 读取指定合同字段的首条中文错误。
 * @param fieldPath 场景配置中的字段路径。
 * @returns 对应错误消息；没有错误时返回空字符串。
 * @remarks 只读取当前校验结果，不修改表单或错误集合。
 */
function sensorExtensionIndex(sensorId: string): number {
  return draft.value?.uiExtensions.sensors.findIndex(sensor => sensor.sensorId === sensorId) ?? -1
}

function liveFieldMessage(fieldPath: string): string {
  return fieldValidationMessage([...liveValidation.value.errors, ...liveValidation.value.warnings], fieldPath)
}

function issueMessage(fieldPath: string): string {
  if (!showValidationSummary.value && !touchedFields.value.has(fieldPath)) return ''
  return fieldValidationMessage([...liveValidation.value.errors, ...liveValidation.value.warnings,
    ...validation.value.errors, ...validation.value.warnings], fieldPath)
}

function relativeEditorIssues(result: { errors: ValidationIssue[]; warnings: ValidationIssue[] }, path: string): ValidationIssue[] {
  const collection = path.slice(0, path.lastIndexOf('['))
  return [...result.errors, ...result.warnings].flatMap(issue => issue.fieldPath.startsWith(`${path}.`)
    ? [{ ...issue, fieldPath: issue.fieldPath.slice(path.length + 1) }]
    // 端口映射不符是端点组合问题，挂在源、目标节点下，不能显示成链路类型非法。
    : issue.fieldPath === path && (issue.code === 'TEMPLATE_PORT_MAPPING_INVALID' || issue.code === 'TEMPLATE_PORT_MAPPING_WARNING')
      ? (['sourcePlatformId', 'targetPlatformId'] as const).map(fieldPath => ({ ...issue, fieldPath }))
    : issue.fieldPath === path ? [{ ...issue, fieldPath: 'type' }]
      // 集合级错误（如数量上限、类型缺失）落到类型或 ID 字段；集合级警告是整场景提示，交由校验面板展示，不占用编辑弹框字段。
      : issue.fieldPath === collection
        ? (issue.severity === 'ERROR' ? [{ ...issue, fieldPath: issue.code.includes('_ID_') ? 'id' : 'type' }] : [])
        : [])
}

/** 只校验编辑副本；编辑中的无效数据不写入草稿，也不覆盖其他设备的参数。 */
function validatePlatformFields(platform: Platform): ValidationIssue[] {
  if (!draft.value) return []
  const config = structuredClone(toRaw(draft.value.config))
  const index = editingPlatformIndex.value ?? config.platforms.length
  config.platforms[index] = structuredClone(toRaw(platform))
  return relativeEditorIssues(inspectScenarioConfig(config, 'write').result, `platforms[${index}]`)
}

function withPortInheritance(config: Pick<ScenarioConfig, 'deviceParameters' | 'platforms'>, link: Link): Link {
  return overwriteLegacyLinkFromPorts(config, link)
}

function resolveEditorLinkPorts(link: Link) {
  if (!draft.value) return null
  const config = draft.value.config
  const previousId = editingLinkIndex.value === null ? undefined : config.links[editingLinkIndex.value]?.id
  return projectLinkPortParameters(config, link, previousId)
}

function validateLinkFields(link: Link, demand?: InformationDemand | null): ValidationIssue[] {
  if (!draft.value) return []
  const config = structuredClone(toRaw(draft.value.config))
  const index = editingLinkIndex.value ?? config.links.length
  config.links = config.links.map(item => effectiveLinkFromPorts(config, item))
  config.links[index] = effectiveLinkFromPorts(config, withPortInheritance(config, structuredClone(toRaw(link))))
  synchronizePlatformLinkIds(config, link.id)
  let demandIndex = -1
  if (demand) {
    demandIndex = config.informationDemand.findIndex(item => item.id === demand.id)
    if (demandIndex < 0) demandIndex = config.informationDemand.length
    config.informationDemand[demandIndex] = { ...structuredClone(toRaw(demand)), linkId: link.id,
      sourcePlatformId: link.sourcePlatformId, destinationPlatformIds: [link.targetPlatformId], direction: link.direction }
  }
  const result = inspectScenarioConfig(config, 'write').result
  const issues = relativeEditorIssues(result, `links[${index}]`)
  if (demandIndex >= 0) issues.push(...relativeEditorIssues(result, `informationDemand[${demandIndex}]`)
    .map(issue => ({ ...issue, fieldPath: `business.${issue.fieldPath}` })))
  // 新模板卫通端口为“后方车 ↔ 任务无人机或卫星”：后方车与无人机之间须经卫星中继。
  if (link.type === 'SAT' && !config.platforms.some(platform => platform.type === 'COMMUNICATION_SATELLITE'
    && [link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId].includes(platform.id))) {
    for (const fieldPath of ['sourcePlatformId', 'targetPlatformId']) issues.push({ severity: 'ERROR',
      code: 'SATELLITE_ENDPOINT_REQUIRED', fieldPath, message: '卫星链路的一端或中继须选择通信卫星。' })
  }
  if (linkFrequencyBelowMinimum.value) issues.unshift({ severity: 'ERROR', code: 'LINK_FREQUENCY_INVALID', fieldPath: 'frequency', message: '链路频率必须大于 0 MHz。' })
  if (linkBandwidthBelowMinimum.value) issues.unshift({ severity: 'ERROR', code: 'LINK_BANDWIDTH_INVALID', fieldPath: 'bandwidth', message: '链路带宽必须大于 0 MHz。' })
  return issues
}

function validateJammerFields(jammer: Jammer, extension: JammerUiExtension): ValidationIssue[] {
  if (!draft.value) return []
  const config = structuredClone(toRaw(draft.value.config))
  const extensions = structuredClone(toRaw(draft.value.uiExtensions))
  const index = editingJammerIndex.value ?? config.jammers.length
  config.jammers[index] = structuredClone(toRaw(jammer))
  const existing = extensions.jammers.findIndex(item => item.jammerId === jammer.id)
  const extensionIndex = existing < 0 ? extensions.jammers.length : existing
  extensions.jammers[extensionIndex] = { ...structuredClone(toRaw(extension)), jammerId: jammer.id }
  synchronizePlatformJammerIds(config, jammer.id)
  const issues = relativeEditorIssues(inspectScenarioConfig(config, 'write').result, `jammers[${index}]`)
  issues.push(...relativeEditorIssues(inspectScenarioUiExtensions(extensions, config.jammers.map(item => item.id), config.sensors.map(item => item.id)).result,
    `uiExtensions.jammers[${extensionIndex}]`))
  if (jammerFrequencyBelowMinimum.value) issues.unshift({ severity: 'ERROR', code: 'JAMMER_FREQUENCY_INVALID', fieldPath: 'frequency', message: '干扰频率必须大于 0 MHz。' })
  if (jammerBandwidthBelowMinimum.value) issues.unshift({ severity: 'ERROR', code: 'JAMMER_BANDWIDTH_INVALID', fieldPath: 'bandwidth', message: '干扰带宽必须大于 0 MHz。' })
  return issues
}

function touchField(event: Event): void {
  if (!(event.target instanceof Element)) return
  const path = event.target.closest<HTMLElement>('[data-field-path]')?.dataset.fieldPath
  if (path) touchedFields.value.add(path)
}

/**
 * 标记表单字段已经发生修改。
 * @returns 无返回值。
 * @sideEffects 调用场景 Store 清除旧字段错误并设置未保存标记。
 */
function markDirty(): void {
  scenarioStore.markDirty()
}

/**
 * 仿真倍速标准档位：`full` 不启用 realtime（clock_rate 32），`xN` 表示实时（realtime 缺省）且 clock_rate 为 N。
 * @remarks 档位只决定 realtime / simClockSpeed 两个既有字段的写法，不新增契约字段。
 */
const SIM_SPEED_OPTIONS = [
  { value: 'full', label: '全速' },
  { value: 'x1', label: 'x1' },
  { value: 'x2', label: 'x2' },
  { value: 'x4', label: 'x4' },
  { value: 'x8', label: 'x8' },
  { value: 'x16', label: 'x16' },
  { value: 'x32', label: 'x32' },
] as const
type SimSpeedOptionValue = typeof SIM_SPEED_OPTIONS[number]['value']
/** 旧场景的非标准 realtime / simClockSpeed 组合：只回显当前值，不可选择。 */
const LEGACY_SIM_SPEED = 'legacy'
type SimSpeedValue = SimSpeedOptionValue | typeof LEGACY_SIM_SPEED
/** 全速写入的 clock_rate；x32 同为 32，靠 realtime 缺省区分两者。 */
const FULL_SPEED_CLOCK = 32

/** 读取草稿已保存的仿真时钟倍速；缺省返回 undefined，显示默认值时不回写字段。 */
function savedSimClockSpeed(): number | undefined {
  const clock = draft.value?.config.scenario.environment.simClockSpeed
  return typeof clock === 'number' && Number.isFinite(clock) ? clock : undefined
}

/**
 * 仿真倍速下拉的读写映射。
 * @returns 七个标准档位之一或 `legacy`；实时且倍速缺省时按文档默认值回显 x2。
 * @remarks 读取只推断显示值，不改写 realtime / simClockSpeed；写入时按档位归一化这两个字段。
 */
const simSpeed = computed<SimSpeedValue>({
  get: () => {
    if (!draft.value) return 'x2'
    const clock = savedSimClockSpeed()
    if (draft.value.config.scenario.realtime === false) return clock === FULL_SPEED_CLOCK ? 'full' : LEGACY_SIM_SPEED
    if (clock === undefined) return 'x2'
    // 实时且 clock_rate 32 回显 x32，与全速（realtime=false + 32）区分。
    return SIM_SPEED_OPTIONS.find(option => option.value !== 'full' && Number(option.value.slice(1)) === clock)?.value
      ?? LEGACY_SIM_SPEED
  },
  set: (value) => {
    if (!draft.value || value === LEGACY_SIM_SPEED) return
    const scenario = draft.value.config.scenario
    if (value === 'full') {
      scenario.realtime = false
      scenario.environment.simClockSpeed = FULL_SPEED_CLOCK
    } else {
      // 实时模式不落 realtime 字段，保持旧场景“缺省即实时”的存储形态。
      delete scenario.realtime
      scenario.environment.simClockSpeed = Number(value.slice(1))
    }
    markDirty()
  },
})

/** 旧场景倍速回显文案；缺省倍速按文档默认值展示，但不写入字段。 */
const legacySimSpeedLabel = computed(() => {
  const clock = savedSimClockSpeed() ?? SCENARIO_BASIC_DEFAULTS.simClockSpeed
  return draft.value?.config.scenario.realtime === false
    ? `当前：非实时 / ${clock}×（旧场景）`
    : `当前：${clock}×（旧场景）`
})

function formatPortParametersError(errors: readonly ValidationIssue[], config: Pick<ScenarioConfig, 'platforms' | 'links' | 'jammers' | 'sensors'>): string {
  const firstError = errors[0]
  if (!firstError) return ''
  const label = formatValidationFieldLabel(firstError.fieldPath, config)
  return errors.length > 1
    ? `共有 ${errors.length} 项端口参数校验未通过，请先修正：${label}（${firstError.message}）`
    : `${label}：${firstError.message}`
}

function updatePortParameters(value: DeviceParameters): void {
  if (!draft.value) return
  const config = draft.value.config
  config.deviceParameters = value
  config.links = toRaw(config.links).map(link => overwriteLegacyLinkFromPorts(config, link))
  portParametersWarning.value = ''
  if (portParametersError.value) {
    const remaining = liveValidation.value.errors.filter(issue => issue.fieldPath.startsWith('deviceParameters'))
    portParametersError.value = formatPortParametersError(remaining, config)
  }
  markDirty()
}

async function closePortParameters(): Promise<void> {
  if (draft.value && !pending.value && !draft.value.locked) {
    const config = draft.value.config
    const deviceErrors = liveValidation.value.errors.filter(issue => issue.fieldPath.startsWith('deviceParameters'))
    if (deviceErrors.length > 0) {
      const firstError = deviceErrors[0]!
      portParametersError.value = formatPortParametersError(deviceErrors, config)
      portParametersWarning.value = ''
      deviceParametersPanel.value?.revealField(firstError.fieldPath)
      await nextTick()
      // 等待切换标签页后 el-table 列完成异步挂载再聚焦。
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      await nextTick()
      focusValidationField(firstError.fieldPath)
      return
    }
    let changed = false
    const updatedLinks = toRaw(config.links).map((link) => {
      const next = overwriteLegacyLinkFromPorts(config, link)
      if (next !== link && JSON.stringify(next) !== JSON.stringify(link)) changed = true
      return next
    })
    if (changed) {
      config.links = updatedLinks
      markDirty()
    }
  }
  portParametersError.value = ''
  portParametersWarning.value = ''
  portParametersVisible.value = false
}

type NaturalNumberKey = 'rainAltitudeLimitM' | 'rainAttenuationDb' | 'simplifiedAttenuationDbPerKm' | 'polarizationMismatchDb'
  | 'pointingErrorDb' | 'seaLowAltitudeThresholdM' | 'seaPathOverSeaThresholdKm' | 'seaWaterTempC' | 'seaSurfaceRoughnessM'
type NaturalGroup = 'rain' | 'atmosphere' | 'misc' | 'sea'
/**
 * link_calc natural_environment 数值字段，按文档“环境参数（全局）”的小标题分组；范围与校验一致。
 * hidden：2026-11-25 实测插件不使用该值，界面不展示但仍按默认值写入脚本；fineOnly：仅多径模型（fine）下插件生效。
 */
const NATURAL_NUMBER_FIELDS: readonly { key: NaturalNumberKey; group: NaturalGroup; label: string; min: number; max?: number; step: number; hint?: string; hidden?: boolean; fineOnly?: boolean }[] = [
  { key: 'rainAltitudeLimitM', group: 'rain', label: '雨区顶部高度（m）', min: 0, max: 30000, step: 100, hint: '典型 1000～5000 m' },
  { key: 'rainAttenuationDb', group: 'rain', label: '固定雨衰兜底值（dB）', min: 0, step: 0.1, hidden: true },
  { key: 'simplifiedAttenuationDbPerKm', group: 'atmosphere', label: '简化衰减率（dB/km）', min: 0, step: 0.01, hint: '简化/自动模式生效；自动模式下为 0 时按 ITU 计算' },
  { key: 'polarizationMismatchDb', group: 'misc', label: '极化失配损耗（dB）', min: 0, step: 0.1, hint: '通常 0～3 dB' },
  { key: 'pointingErrorDb', group: 'misc', label: '指向误差损耗（dB）', min: 0, step: 0.1 },
  { key: 'seaLowAltitudeThresholdM', group: 'sea', label: '贴海飞行高度阈值（m）', min: 0, step: 10 },
  { key: 'seaPathOverSeaThresholdKm', group: 'sea', label: '跨海距离阈值（km）', min: 0, step: 1 },
  { key: 'seaWaterTempC', group: 'sea', label: '海水温度（℃）', min: -2, max: 30, step: 1, fineOnly: true },
  { key: 'seaSurfaceRoughnessM', group: 'sea', label: '海面高度标准差（m）', min: 0, max: 5, step: 0.1, hint: '0 表示按海况等级推导', fineOnly: true },
]
const naturalFields = (group: NaturalGroup) => NATURAL_NUMBER_FIELDS.filter(field => field.group === group && !field.hidden)
/** 当前是否为经验模型（coarse）；此时多径模型专属参数不参与插件计算。 */
function seaFineInactive(): boolean {
  return draft.value?.config.scenario.environment.seaModel !== 'fine'
}
/** 返回数值字段下方提示；多径模型专属参数在经验模型下提示其不生效。 */
function naturalFieldHint(field: { hint?: string; fineOnly?: boolean }): string | undefined {
  return field.fineOnly && seaFineInactive() ? '仅多径模型（fine）生效' : field.hint
}
const NATURAL_ENVIRONMENT_FIELD_KEYS = new Set<string>([...NATURAL_NUMBER_FIELDS.map(field => field.key),
  'rainEnabled', 'cloudEnabled', 'atmosphereModel', 'seaModel', 'seaPolarization'])

/** 选择雨强档位时同步降雨强度；档位为界面主入口，降雨强度仍可单独微调。 */
function changeRainTier(tier: RainTier): void {
  if (!draft.value) return
  draft.value.config.scenario.environment.rainCloudAttenuation = tier
  draft.value.config.scenario.environment.rainRateMmPerHour = RAIN_TIER_RATES[tier]
  markDirty()
}

/** 选择 ITU 模型时清零简化衰减率，避免其大于 0 时覆盖 ITU 计算。 */
function changeAtmosphereModel(model: 'itu' | 'simplified' | 'auto'): void {
  if (!draft.value) return
  const environment = draft.value.config.scenario.environment
  environment.atmosphereModel = model
  if (model === 'itu') environment.simplifiedAttenuationDbPerKm = 0
  markDirty()
}

/** 保存地图框选的海面区域；polygon 为确认后的顶点副本。 */
function applySeaArea(polygon: GeoPoint[]): void {
  if (!draft.value || draft.value.locked) return
  draft.value.config.scenario.environment.seaPolygon = polygon
  markDirty()
}

/**
 * 生成当前场景内未占用的平台 ID。
 * @param prefix 业务节点或支撑实体使用的 ID 前缀。
 * @returns 首个未被使用的三位序号 ID。
 * @remarks 只读取当前草稿，不修改平台集合。
 */
function nextPlatformId(prefix: 'PLAT-' | 'SUP-', reservedIds?: Set<string>): string {
  const ids = reservedIds ?? new Set(draft.value?.config.platforms.map((platform) => platform.id) ?? [])
  let index = 1
  while (ids.has(`${prefix}${String(index).padStart(3, '0')}`)) index += 1
  return `${prefix}${String(index).padStart(3, '0')}`
}

/**
 * 根据类型建议生成未占用的节点 ID。
 * @param type 节点类型。
 * @returns 首个未被使用的三位序号 ID。
 */
function suggestPlatformId(type: PlatformType): string {
  const isBusiness = isBusinessInformationNodeType(type)
  return nextPlatformId(isBusiness ? 'PLAT-' : 'SUP-')
}

/**
 * 打开新增节点对话框。
 * @param preferredType 可选预设类型或分类。
 * @returns 无返回值。
 * @sideEffects 创建独立编辑副本并打开对话框；若信息节点已达上限，默认切换为支撑实体并提示。
 */
function openNewPlatform(preferredType?: PlatformType | 'business' | 'supporting'): void {
  if (draft.value === null) return
  if (preferredType === 'business' && businessNodeCount.value >= INFORMATION_NODE_LIMIT) {
    ElMessage.error(`信息节点已达 ${INFORMATION_NODE_LIMIT} 个，不能继续新增。`)
    return
  }

  const configuredSatelliteTypes = new Set(draft.value.config.platforms
    .filter((platform) => platform.type === 'COMMUNICATION_SATELLITE')
    .map((platform) => platform.satelliteType))
  const defaultSatelliteType = configuredSatelliteTypes.has('TIANTONG') ? 'SHENTONG' : 'TIANTONG'

  let targetType: PlatformType
  if (preferredType && preferredType !== 'business' && preferredType !== 'supporting') {
    targetType = preferredType
  } else if (preferredType === 'supporting' || businessNodeCount.value >= INFORMATION_NODE_LIMIT) {
    targetType = 'COMMUNICATION_SATELLITE'
    if (preferredType !== 'supporting' && businessNodeCount.value >= INFORMATION_NODE_LIMIT) {
      ElMessage.info(`信息节点已达 ${INFORMATION_NODE_LIMIT} 个上限，当前可新增支撑实体。`)
    }
  } else {
    targetType = 'AIRBORNE_MISSION_CLUSTER'
  }

  const isBusiness = isBusinessInformationNodeType(targetType)
  const id = suggestPlatformId(targetType)
  editingPlatformIndex.value = null

  let defaultName: string
  if (targetType === 'COMMUNICATION_SATELLITE') {
    defaultName = `${defaultSatelliteType === 'TIANTONG' ? '天通' : '神通'}卫星`
  } else {
    defaultName = PLATFORM_TYPE_LABELS[targetType] || '新增节点'
  }

  platformEditor.value = {
    id,
    name: defaultName,
    type: targetType,
    ...(targetType === 'COMMUNICATION_SATELLITE' ? { satelliteType: defaultSatelliteType } : {}),
    category: PLATFORM_TYPE_DOMAINS[targetType] ?? (isBusiness ? 'air' : 'space'),
    initialPosition: targetType === 'COMMUNICATION_SATELLITE' ? { ...SATELLITE_GEO_POSITION }
      : targetType === 'FORWARD_RELAY_NODE' ? { ...RELAY_DEFAULT_ORIGIN }
      : targetType === 'REAR_COMMAND_NODE' ? { ...REAR_DEFAULT_ORIGIN } : {
      longitude: PLATFORM_POSITION_RULES[targetType]?.minLongitude ?? 0,
      latitude: PLATFORM_POSITION_RULES[targetType]?.minLatitude ?? 0,
      altitude: targetType === 'AIRBORNE_MISSION_CLUSTER' ? PLATFORM_POINT_DEFAULT_ALTITUDE : 0,
    },
    waypoints: targetType === 'FORWARD_RELAY_NODE' ? RELAY_DEFAULT_ROUTE.waypoints.map(point => ({ ...point })) : [],
    ...(targetType === 'FORWARD_RELAY_NODE' ? { loiterWaypoints: RELAY_DEFAULT_ROUTE.loiterWaypoints.map(point => ({ ...point })) } : {}),
    linkIds: [],
    sensorIds: [],
    jammerIds: [],
  }
  platformEditorError.value = ''
  platformDialogVisible.value = true
}

/**
 * 打开现有节点编辑对话框。
 * @param platform 需要编辑的平台数据。
 * @param index 平台在当前草稿集合中的位置。
 * @returns 无返回值。
 * @sideEffects 记录待编辑平台；对话框负责创建独立编辑副本。
 */
function openPlatformEditor(platform: Platform, index: number): void {
  editingPlatformIndex.value = index
  platformEditor.value = platform
  platformEditorError.value = ''
  platformDialogVisible.value = true
}

/** 确认失败用非阻塞消息展示原因，不自动应用草稿。 */
function showEditorValidationMessage(message: string): false {
  ElMessage.warning({ message, showClose: true })
  return false
}

/**
 * 将平台编辑副本写入当前场景草稿。
 * @param editor 由平台编辑弹窗提交的独立编辑副本。
 * @param quantity 新增空中无人作业集群的数量；编辑或其他类型固定为 1。
 * @param spacingKm 仅有编队原点时的批量平铺间隔，单位为千米。
 * @returns 校验并写入成功时返回 `true`，否则返回 `false`。
 * @sideEffects 成功时新增或替换一个平台、标记草稿未保存并关闭对话框。
 */
function applyPlatformEditor(editor: Platform, quantity = 1, spacingKm = 1): boolean {
  if (draft.value === null) return false
  platformEditorError.value = ''
  editor.id = editor.id.trim()
  editor.name = editor.name.trim()
  if (editor.id === '' || editor.name === '') {
    return showEditorValidationMessage('节点 ID 和名称均为必填项。')
  }
  if (editor.type === 'COMMUNICATION_SATELLITE') {
    if (editor.satelliteType !== 'TIANTONG' && editor.satelliteType !== 'SHENTONG') {
      return showEditorValidationMessage('请选择天通卫星或神通卫星。')
    }
  } else {
    delete editor.satelliteType
  }
  const addingAirborneBatch = editingPlatformIndex.value === null && editor.type === 'AIRBORNE_MISSION_CLUSTER'
  const batchQuantity = addingAirborneBatch ? quantity : 1
  const available = INFORMATION_NODE_TYPE_LIMITS.AIRBORNE_MISSION_CLUSTER - businessNodeTypeCounts.value.AIRBORNE_MISSION_CLUSTER
  if (addingAirborneBatch && (!Number.isSafeInteger(batchQuantity) || batchQuantity < 1 || batchQuantity > available)) {
    return showEditorValidationMessage(`空中无人作业集群当前还可新增 ${Math.max(0, available)} 个。`)
  }
  const candidate = structuredClone(toRaw(draft.value.config))
  const editedPlatform = structuredClone(toRaw(editor))
  let gridPositions: Platform['initialPosition'][] | undefined
  if (addingAirborneBatch && batchQuantity > 1 && editedPlatform.waypoints.length === 0) {
    try {
      gridPositions = createPlatformGrid(editedPlatform.initialPosition, batchQuantity, spacingKm)
    } catch (error) {
      return showEditorValidationMessage((error as Error).message)
    }
  }
  if (editingPlatformIndex.value === null) {
    const reservedIds = new Set(candidate.platforms.map((platform) => platform.id))
    const initialAirborneCount = businessNodeTypeCounts.value.AIRBORNE_MISSION_CLUSTER
    for (let index = 0; index < batchQuantity; index += 1) {
      const platform = structuredClone(editedPlatform)
      if (gridPositions) platform.initialPosition = gridPositions[index]!
      if (index > 0) platform.id = nextPlatformId('PLAT-', reservedIds)
      reservedIds.add(platform.id)
      if (batchQuantity > 1) platform.name = `${editedPlatform.name} U${String(initialAirborneCount + index + 1).padStart(2, '0')}`
      candidate.platforms.push(platform)
    }
  } else candidate.platforms[editingPlatformIndex.value] = editedPlatform
  const issue = inspectScenarioConfig(candidate, 'write').result.errors.find((item) => (
    item.fieldPath.startsWith('platforms') || item.code === 'PLATFORM_REFERENCE_NOT_FOUND'
    || item.fieldPath.endsWith('.relayPlatformId') || item.fieldPath.startsWith('linkSettings.enabledSatellites')
  ))
  if (issue !== undefined) {
    return showEditorValidationMessage(issue.message)
  }

  draft.value.config.platforms = candidate.platforms
  markDirty()
  platformDialogVisible.value = false
  const message = editingPlatformIndex.value === null
    ? `${batchQuantity > 1 ? `已批量新增 ${batchQuantity} 个空中无人作业集群` : '节点已新增'}，保存草稿后生效。`
    : '节点已更新，保存草稿后生效。'
  ElMessage.success(message)
  return true
}

/**
 * 删除未被其他配置引用的节点。
 * @param platform 需要删除的平台。
 * @param index 平台在当前草稿集合中的位置。
 * @returns 删除成功时返回 `true`，被容量或引用规则阻止时返回 `false`。
 * @sideEffects 成功时从草稿移除平台并设置未保存标记；失败时草稿保持不变。
 */
function removePlatform(platform: Platform, index: number): boolean {
  if (draft.value === null) return false
  if (isBusinessInformationNodeType(platform.type) && businessNodeCount.value <= 1) {
    ElMessage.error('场景至少需要保留一个信息节点。')
    return false
  }
  const config = draft.value.config
  const referenced = config.links.some((link) => [link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId].includes(platform.id))
    || config.jammers.some((jammer) => jammer.platformId === platform.id)
    || config.sensors.some((sensor) => sensor.platformId === platform.id)
    || config.informationDemand.some((demand) => demand.sourcePlatformId === platform.id || demand.destinationPlatformIds.includes(platform.id))
  if (referenced) {
    ElMessage.error('该节点仍被链路、设备或信息需求引用，不能删除。')
    return false
  }
  config.platforms.splice(index, 1)
  if (platform.satelliteType && config.linkSettings
    && !config.platforms.some(item => item.type === 'COMMUNICATION_SATELLITE' && item.satelliteType === platform.satelliteType)) {
    config.linkSettings.enabledSatellites[platform.satelliteType] = false
  }
  markDirty()
  ElMessage.success('节点已删除，保存草稿后生效。')
  return true
}

/**
 * 读取平台类型的中文业务名称。
 * @param type 节点类型枚举值。
 * @returns 对应的文档中文名称。
 * @remarks 只读取既有类型映射。
 */
function platformTypeLabel(platform: Platform): string {
  if (platform.type !== 'COMMUNICATION_SATELLITE') return PLATFORM_TYPE_LABELS[platform.type]
  if (platform.satelliteType === 'TIANTONG') return '天通卫星'
  if (platform.satelliteType === 'SHENTONG') return '神通卫星'
  return PLATFORM_TYPE_LABELS[platform.type]
}

/**
 * 生成当前场景内未占用的链路 ID。
 * @returns 首个未使用的三位序号配置链路 ID。
 * @remarks 只读取当前草稿，不修改链路集合。
 */
function nextLinkId(): string {
  const ids = new Set(draft.value?.config.links.map((link) => link.id) ?? [])
  let index = 1
  while (ids.has(`L-CFG-${String(index).padStart(3, '0')}`)) index += 1
  return `L-CFG-${String(index).padStart(3, '0')}`
}

function resetLinkMinimumAttempts(): void {
  linkFrequencyBelowMinimum.value = false
  linkBandwidthBelowMinimum.value = false
}

// Element Plus normalizes the model to min; retain the user's raw attempt until valid input replaces it.
function trackLinkFrequencyInput(value: number | undefined): void {
  if (typeof value === 'number') linkFrequencyBelowMinimum.value = value <= 0
}

function trackLinkBandwidthInput(value: number | undefined): void {
  if (typeof value === 'number') linkBandwidthBelowMinimum.value = value <= 0
}

/**
 * 打开新增链路对话框并填入可校验的默认参数。
 * @returns 无返回值。
 * @sideEffects 节点不足两个时显示中文提示；否则创建独立编辑副本并打开对话框。
 */
function openNewLink(): void {
  if (draft.value === null) return
  if (draft.value.config.platforms.length < 2) {
    ElMessage.error('至少需要两个节点才能新增链路。')
    return
  }
  linkEditorLink.value = {
    ...LINK_PARAMETER_DEFAULTS,
    id: nextLinkId(),
    type: 'MICROWAVE',
    sourcePlatformId: draft.value.config.platforms[0]!.id,
    targetPlatformId: draft.value.config.platforms[1]!.id,
    ...linkTypeDefaults('MICROWAVE'),
    modulation: 'BPSK',
    berThreshold: 0.00001,
    direction: 'FORWARD',
  }
  editingLinkIndex.value = null
  linkBusiness.value = createLinkBusiness(linkEditorLink.value)
  linkFocusPath.value = ''
  linkEditorError.value = ''
  resetLinkMinimumAttempts()
  linkDialogVisible.value = true
}

/**
 * 打开现有链路编辑对话框。
 * @param link 需要编辑的链路数据。
 * @param index 链路在当前草稿集合中的位置。
 * @returns 无返回值。
 * @sideEffects 记录编辑目标并打开对话框；对话框内部创建副本，取消时不会污染草稿。
 */
function openLinkEditor(link: Link, index: number): void {
  linkPage.value = Math.floor(index / LINK_PAGE_SIZE) + 1
  // 补默认值前先取原始对象，避免嵌套响应式代理导致弹框的深拷贝失败。
  linkEditorLink.value = { ...toRaw(link), enabled: readLinkEnabled(link, draft.value?.config.linkSettings) }
  editingLinkIndex.value = index
  linkBusiness.value = draft.value?.config.informationDemand.find(item => item.linkId === link.id) ?? createLinkBusiness(link)
  linkFocusPath.value = ''
  linkEditorError.value = ''
  resetLinkMinimumAttempts()
  linkDialogVisible.value = true
}

/**
 * 引用相关修改即时保存；未引用基础数据的链路保持原草稿编辑流程。
 * @param linkEditor 新增或编辑的链路副本。
 * @returns 校验并写入成功时返回 `true`，否则返回 `false`。
 * @sideEffects 成功时同步保存修订及端点关联，并关闭对话框；不生成脚本或运行仿真。
 */
async function applyLinkEditor(linkEditor: Link, demand?: InformationDemand): Promise<boolean> {
  if (draft.value === null || pending.value || draft.value.locked) return false
  linkEditorError.value = ''
  if (linkFrequencyBelowMinimum.value) {
    return showEditorValidationMessage('链路频率必须大于 0 MHz。')
  }
  if (linkBandwidthBelowMinimum.value) {
    return showEditorValidationMessage('链路带宽必须大于 0 MHz。')
  }
  linkEditor.id = linkEditor.id.trim()
  if (linkEditor.id === '') {
    return showEditorValidationMessage('链路 ID 为必填项。')
  }
  if (linkEditor.type === 'SAT' && !draft.value.config.platforms.some(platform => (
    platform.type === 'COMMUNICATION_SATELLITE'
    && (platform.id === linkEditor.sourcePlatformId || platform.id === linkEditor.targetPlatformId || platform.id === linkEditor.relayPlatformId)
  ))) {
    return showEditorValidationMessage('卫星链路的一端或中继须选择通信卫星。')
  }
  const editedLink = withPortInheritance(draft.value.config, structuredClone(toRaw(linkEditor)))
  if (editedLink.inheritPortParameters && editedLink.parameterSource?.fields.some(field => isPlatformPortLinkField(editedLink.type, field))) {
    return showEditorValidationMessage('请先取消链路上的端口参数引用，再改用平台端口参数。')
  }
  if (!demand) {
    return showEditorValidationMessage('请填写该链路的业务参数。')
  }
  const previous = draft.value.config.informationDemand.find(item => item.id === demand.id)
  if (previous?.linkId && previous.linkId !== editedLink.id) {
    return showEditorValidationMessage('该业务已关联其他链路。')
  }
  const editedDemand = { ...structuredClone(toRaw(demand)), linkId: editedLink.id,
    sourcePlatformId: editedLink.sourcePlatformId, destinationPlatformIds: [editedLink.targetPlatformId], direction: editedLink.direction }
  const issue = validateLinkFields(editedLink, editedDemand).find(item => item.severity === 'ERROR')
  if (issue !== undefined) {
    return showEditorValidationMessage(issue.message)
  }

  const previousLinkId = editingLinkIndex.value === null ? undefined : draft.value.config.links[editingLinkIndex.value]?.id
  const previousSource = draft.value.config.links.find(link => link.id === previousLinkId)?.parameterSource
  if (!editedLink.parameterSource && !previousSource) {
    const candidate = structuredClone(toRaw(draft.value.config))
    applyLinkEdit(candidate, editedLink, editedDemand, previousLinkId)
    draft.value.config = candidate
    markDirty()
    if (editingLinkIndex.value === null) linkPage.value = linkPageCount.value
    linkDialogVisible.value = false
    ElMessage.success(editingLinkIndex.value === null ? '链路已新增，保存草稿后生效。' : '链路已更新，保存草稿后生效。')
    return true
  }
  const epoch = scenarioStore.requestEpoch
  const saved = await scenarioStore.saveLink(editedLink, editedDemand, previousLinkId, executionLifetime.signal)
  if (!active || epoch !== scenarioStore.requestEpoch) return false
  if (!saved) return showEditorValidationMessage(scenarioStore.resultMessage)
  if (editingLinkIndex.value === null) linkPage.value = linkPageCount.value
  linkDialogVisible.value = false
  ElMessage.success('链路、关联业务及参数引用已保存。')
  return true
}

/**
 * 删除指定链路并清理平台反向关联。
 * @param link 需要删除的链路。
 * @returns 删除成功时返回 `true`。
 * @sideEffects 从草稿移除链路及所有对应平台关联，并设置未保存标记。
 */
function removeLink(link: Link): boolean {
  if (draft.value === null || pending.value || draft.value.locked) return false
  const index = draft.value.config.links.indexOf(link)
  if (index < 0) return false
  if (link.parameterSource) {
    ElMessage.error('该链路仍引用基础数据，请先编辑链路，取消引用并保存后再删除。')
    return false
  }
  const candidate = structuredClone(toRaw(draft.value.config))
  candidate.informationDemand = candidate.informationDemand.filter(item => item.linkId !== link.id)
  if (candidate.informationDemand.length === 0) {
    ElMessage.error('场景至少需要一项业务，不能删除最后一条带业务的链路。')
    return false
  }
  candidate.links.splice(index, 1)
  synchronizePlatformLinkIds(candidate, link.id)
  draft.value.config.links = candidate.links
  draft.value.config.informationDemand = candidate.informationDemand
  draft.value.config.platforms = candidate.platforms
  markDirty()
  ElMessage.success('链路已删除，保存草稿后生效。')
  return true
}

/** 读取链路类型的中文名称。 */
function linkTypeLabel(type: LinkType): string {
  return LINK_TYPE_LABELS[type]
}

/**
 * 在链路列表行内切换当前链路启停。
 * @param link 需要切换的链路（草稿内对象）。
 * @param enabled 新的启用状态。
 * @returns 无返回值。
 * @sideEffects 写入链路 enabled 并标记草稿未保存。
 */
function setLinkEnabled(link: Link, enabled: boolean): void {
  if (draft.value === null || pending.value || draft.value.locked) return
  link.enabled = enabled
  markDirty()
}

/**
 * 生成当前场景内未占用的干扰设备 ID。
 * @returns 首个未使用的三位序号配置干扰设备 ID。
 * @remarks 只读取当前草稿，不修改干扰设备集合。
 */
function nextJammerId(): string {
  const ids = new Set(draft.value?.config.jammers.map((jammer) => jammer.id) ?? [])
  let index = 1
  while (ids.has(`JAM-CFG-${String(index).padStart(3, '0')}`)) index += 1
  return `JAM-CFG-${String(index).padStart(3, '0')}`
}

/**
 * 清除干扰频率和带宽的非法输入记录。
 * @returns 无返回值。
 * @sideEffects 将两个最低值输入标记恢复为未触发状态。
 */
function resetJammerMinimumAttempts(): void {
  jammerFrequencyBelowMinimum.value = false
  jammerBandwidthBelowMinimum.value = false
}

/**
 * 记录干扰频率输入是否低于合同最小值。
 * @param value Element Plus 数字输入组件发出的原始值。
 * @returns 无返回值。
 * @sideEffects 更新当前干扰频率的非法输入标记。
 */
function trackJammerFrequencyInput(value: number | undefined): void {
  if (typeof value === 'number') jammerFrequencyBelowMinimum.value = value <= 0
}

/**
 * 记录干扰带宽输入是否低于合同最小值。
 * @param value Element Plus 数字输入组件发出的原始值。
 * @returns 无返回值。
 * @sideEffects 更新当前干扰带宽的非法输入标记。
 */
function trackJammerBandwidthInput(value: number | undefined): void {
  if (typeof value === 'number') jammerBandwidthBelowMinimum.value = value <= 0
}

/** 修改场景干扰总开关；enabled 为开关值，保留每台设备的独立参数与启停。 */
function setJammingEnabled(enabled: boolean | string | number): void {
  if (!draft.value || pending.value || draft.value.locked || typeof enabled !== 'boolean') return
  draft.value.config.jammingEnabled = enabled
  markDirty()
}

/**
 * 打开新增干扰设备对话框并填入可校验的默认参数。
 * @returns 无返回值。
 * @sideEffects 没有干扰节点时显示中文提示；否则创建未选择所属节点的独立编辑副本。
 */
function openNewJammer(): void {
  if (pending.value || draft.value?.locked) return
  if (!hasJammerPlatform.value) {
    ElMessage.error('请先在节点配置中新增干扰节点。')
    return
  }
  jammerEditorJammer.value = {
    id: nextJammerId(),
    platformId: '',
    type: 'BARRAGE',
    ...JAMMER_DEFAULTS,
    eirpDbw: JAMMER_CALC_DEFAULTS.eirpDbw,
    antennaGainDbi: JAMMER_CALC_DEFAULTS.antennaGainDbi,
    weaponBands: JAMMER_DEFAULT_BANDS.map(band => ({ ...band })),
  }
  jammerEditorUiExtension.value = { jammerId: jammerEditorJammer.value.id, direction: 0, enabled: true }
  editingJammerIndex.value = null
  jammerEditorError.value = ''
  jammerFocusPath.value = ''
  resetJammerMinimumAttempts()
  jammerDialogVisible.value = true
}

/**
 * 打开现有干扰设备编辑对话框。
 * @param jammer 需要编辑的干扰设备数据。
 * @param index 干扰设备在当前草稿集合中的位置。
 * @returns 无返回值。
 * @sideEffects 记录编辑目标并打开对话框；对话框内部创建副本，取消时不会污染草稿。
 */
function openJammerEditor(jammer: Jammer, index: number): void {
  jammerEditorJammer.value = jammer
  jammerEditorUiExtension.value = (
    draft.value?.uiExtensions.jammers.find((extension) => extension.jammerId === jammer.id)
      ?? { jammerId: jammer.id, direction: 0, enabled: true }
  )
  editingJammerIndex.value = index
  jammerEditorError.value = ''
  jammerFocusPath.value = ''
  resetJammerMinimumAttempts()
  jammerDialogVisible.value = true
}

/**
 * 根据干扰设备归属同步平台反向关联。
 * @param config 待同步的完整场景配置副本。
 * @param jammerId 新增、更新或删除的干扰设备 ID。
 * @returns 无返回值。
 * @sideEffects 先从所有平台移除该 ID，再为当前归属平台补回关联。
 */
function synchronizePlatformJammerIds(config: ScenarioConfig, jammerId: string): void {
  config.platforms.forEach((platform) => {
    platform.jammerIds = platform.jammerIds.filter((id) => id !== jammerId)
  })
  const jammer = config.jammers.find((item) => item.id === jammerId)
  const platform = config.platforms.find((item) => item.id === jammer?.platformId)
  if (platform !== undefined) platform.jammerIds.push(jammerId)
}

/**
 * 将干扰设备编辑副本写入当前场景草稿。
 * @returns 校验并写入成功时返回 `true`，否则返回 `false`。
 * @sideEffects 成功时同步归属平台关联、标记未保存并关闭对话框。
 */
function applyJammerEditor(jammerEditor: Jammer, jammerUiEditor: JammerUiExtension): boolean {
  if (draft.value === null) return false
  jammerEditorError.value = ''
  if (jammerFrequencyBelowMinimum.value) {
    return showEditorValidationMessage('干扰频率必须大于 0 MHz。')
  }
  if (jammerBandwidthBelowMinimum.value) {
    return showEditorValidationMessage('干扰带宽必须大于 0 MHz。')
  }
  jammerEditor.id = jammerEditor.id.trim()
  if (jammerEditor.id === '') {
    return showEditorValidationMessage('干扰设备 ID 为必填项。')
  }
  const candidate = structuredClone(toRaw(draft.value.config))
  const candidateExtensions = structuredClone(toRaw(draft.value.uiExtensions))
  const editedJammer = structuredClone(toRaw(jammerEditor))
  const editedExtension = { ...structuredClone(toRaw(jammerUiEditor)), jammerId: editedJammer.id }
  if (editingJammerIndex.value === null) {
    candidate.jammers.push(editedJammer)
    candidateExtensions.jammers.push(editedExtension)
  } else {
    candidate.jammers[editingJammerIndex.value] = editedJammer
    const extensionIndex = candidateExtensions.jammers.findIndex((extension) => extension.jammerId === editedJammer.id)
    if (extensionIndex === -1) candidateExtensions.jammers.push(editedExtension)
    else candidateExtensions.jammers[extensionIndex] = editedExtension
  }
  synchronizePlatformJammerIds(candidate, editedJammer.id)
  const editedJammerPath = `jammers[${editingJammerIndex.value ?? candidate.jammers.length - 1}].`
  const issue = [
    ...inspectScenarioConfig(candidate, 'write').result.errors,
    ...inspectScenarioUiExtensions(candidateExtensions, candidate.jammers.map((jammer) => jammer.id)).result.errors,
  ].find(item => {
    // 旧归属或超界参数可逐台修正；全部设备仍由整体校验和 PUT 阻断。
    if (['JAMMER_RANGE_INVALID', 'JAMMER_TRIGGER_TIME_INVALID', 'JAMMER_PLATFORM_TYPE_INVALID'].includes(item.code) && !item.fieldPath.startsWith(editedJammerPath)) return false
    return item.fieldPath.startsWith('jammers') || item.fieldPath.endsWith('.jammerIds') || item.fieldPath.startsWith('uiExtensions.jammers')
  })
  if (issue !== undefined) {
    return showEditorValidationMessage(issue.message)
  }

  draft.value.config.jammers = candidate.jammers
  draft.value.config.platforms = candidate.platforms
  draft.value.uiExtensions.jammers = candidateExtensions.jammers
  markDirty()
  jammerDialogVisible.value = false
  ElMessage.success(editingJammerIndex.value === null ? '干扰设备已新增，保存草稿后生效。' : '干扰设备已更新，保存草稿后生效。')
  return true
}

/**
 * 删除指定干扰设备并清理平台反向关联。
 * @param jammer 需要删除的干扰设备。
 * @param index 干扰设备在当前草稿集合中的位置。
 * @returns 删除成功时返回 `true`。
 * @sideEffects 从草稿移除干扰设备及平台关联，并设置未保存标记。
 */
function removeJammer(jammer: Jammer, index: number): boolean {
  if (draft.value === null) return false
  const candidate = structuredClone(toRaw(draft.value.config))
  candidate.jammers.splice(index, 1)
  const candidateExtensions = structuredClone(toRaw(draft.value.uiExtensions))
  candidateExtensions.jammers = candidateExtensions.jammers.filter((extension) => extension.jammerId !== jammer.id)
  synchronizePlatformJammerIds(candidate, jammer.id)
  draft.value.config.jammers = candidate.jammers
  draft.value.config.platforms = candidate.platforms
  draft.value.uiExtensions.jammers = candidateExtensions.jammers
  markDirty()
  ElMessage.success('干扰设备已删除，保存草稿后生效。')
  return true
}

/**
 * 读取干扰设备类型的中文名称。
 * @param type 干扰设备类型枚举值。
 * @returns 对应中文名称。
 */
function jammerTypeLabel(type: Jammer['type']): string {
  return JAMMER_TYPE_LABELS[type]
}

function jammerTypeTagType(type: Jammer['type']): 'danger' | 'warning' | 'info' {
  return type === 'BARRAGE' ? 'danger' : type === 'SPOT' ? 'warning' : 'info'
}

function formatJammerPowerPrimary(jammer: Jammer): string {
  if (!Number.isFinite(jammer.defaultPower) || jammer.defaultPower <= 0) return `${jammer.defaultPower} W`
  const dbm = Number(wattsToDbm(jammer.defaultPower).toFixed(1))
  const sign = dbm > 0 ? '+' : ''
  return `${sign}${dbm} dBm`
}

function formatJammerPowerDetail(jammer: Jammer): string {
  const watts = Number.isFinite(jammer.defaultPower) ? `${Number(jammer.defaultPower.toPrecision(6))} W` : `${jammer.defaultPower} W`
  return jammer.eirpDbw === undefined ? watts : `${watts} · EIRP ${jammer.eirpDbw} dBW`
}

function formatKmCell(meters: number): number {
  return Number((meters / METERS_PER_KILOMETER).toFixed(2))
}

function jammerExtension(jammerId: string): JammerUiExtension | undefined {
  return draft.value?.uiExtensions.jammers.find((extension) => extension.jammerId === jammerId)
}

function setJammerEnabled(jammerId: string, enabled: boolean): void {
  const extension = jammerExtension(jammerId)
  if (extension === undefined) return
  extension.enabled = enabled
  markDirty()
}

/** 按 ID 读取传感器界面扩展，避免依赖两个数组的排列顺序。 */
function sensorExtension(sensorId: string): SensorUiExtension | undefined {
  return draft.value?.uiExtensions.sensors.find((extension) => extension.sensorId === sensorId)
}

/** 更新一个传感器界面扩展字段并标记草稿未保存。 */
function setSensorExtensionValue<K extends keyof SensorUiExtension>(sensorId: string, field: K, value: SensorUiExtension[K]): void {
  const extension = sensorExtension(sensorId)
  if (extension === undefined || field === 'sensorId' || field === 'type') return
  extension[field] = value
  markDirty()
}

function setNativeEsm(sensorId: string, esm: SensorUiExtension['esm']): void {
  const extension = sensorExtension(sensorId)
  if (extension === undefined) return
  // `esm: undefined` is not a legacy record: the closed validator correctly rejects an explicitly malformed setting.
  if (esm === undefined) delete extension.esm
  else extension.esm = esm
  markDirty()
}

/** 读取传感器方向的编辑模式。 */
function sensorDirectionMode(sensorId: string): 'OMNI' | 'DIRECTIONAL' {
  return typeof sensorExtension(sensorId)?.direction === 'number' ? 'DIRECTIONAL' : 'OMNI'
}

/** 切换全向或定向模式；首次切换到定向时使用 0 度。 */
function setSensorDirectionMode(sensorId: string, mode: 'OMNI' | 'DIRECTIONAL'): void {
  const direction = sensorExtension(sensorId)?.direction
  setSensorExtensionValue(sensorId, 'direction', mode === 'OMNI' ? 'OMNI' : typeof direction === 'number' ? direction : 0)
}

/** 更新定向模式的角度。 */
function setSensorDirection(sensorId: string, direction: number | undefined): void {
  if (direction !== undefined) setSensorExtensionValue(sensorId, 'direction', direction)
}

/** 生成当前场景内未占用的传感器 ID。 */
function nextSensorId(): string {
  const ids = new Set(draft.value?.config.sensors.map((sensor) => sensor.id) ?? [])
  let index = 1
  while (ids.has(`ESM-${String(index).padStart(2, '0')}`)) index += 1
  return `ESM-${String(index).padStart(2, '0')}`
}

/** 按传感器归属重建平台反向关联。 */
function synchronizeAllSensorIds(): void {
  if (draft.value === null) return
  draft.value.config.platforms.forEach((platform) => { platform.sensorIds = [] })
  draft.value.config.sensors.forEach((sensor) => {
    const platform = draft.value?.config.platforms.find((item) => item.id === sensor.platformId)
    if (platform !== undefined) platform.sensorIds.push(sensor.id)
  })
  markDirty()
}

/** 新增一组可立即校验的传感器及界面扩展参数。 */
function addSensor(): void {
  const platform = draft.value?.config.platforms[0]
  if (draft.value === null || platform === undefined) return
  const sensorId = nextSensorId()
  draft.value.config.sensors.push({ id: sensorId, platformId: platform.id, frequencyRange: { min: 1000, max: 6000 }, detectionRange: 100000 })
  draft.value.uiExtensions.sensors.push({ sensorId, type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true,
    // 本机 AFSIM 2.9 被动侦测探针的已接受参数；用户仍可在表格中调节。
    esm: { ...NATIVE_ESM_PROBE_DEFAULTS } })
  synchronizeAllSensorIds()
}

/** 删除传感器及对应界面扩展和平台关联。 */
function removeSensor(index: number): void {
  if (draft.value === null) return
  const [removed] = draft.value.config.sensors.splice(index, 1)
  if (removed === undefined) return
  draft.value.uiExtensions.sensors = draft.value.uiExtensions.sensors.filter((extension) => extension.sensorId !== removed.id)
  synchronizeAllSensorIds()
}

/** 生成当前场景内未占用的信息需求 ID。 */
function nextInformationDemandId(): string {
  const ids = new Set(draft.value?.config.informationDemand.map((demand) => demand.id) ?? [])
  let index = 1
  while (ids.has(`INFO-${String(index).padStart(3, '0')}`)) index += 1
  return `INFO-${String(index).padStart(3, '0')}`
}

/** 新业务属于当前链路，复用其方向和单一端点，不猜配历史业务。 */
function createLinkBusiness(link: Link): InformationDemand {
  return {
    id: nextInformationDemandId(),
    sourcePlatformId: link.sourcePlatformId,
    destinationPlatformIds: [link.targetPlatformId],
    direction: link.direction,
    enabled: true,
    ...BUSINESS_DEFAULTS[link.direction],
    priority: 'NORMAL',
    maxLatencyMs: 1000,
  }
}


/**
 * 读取规范字段路径对应的页面输入标识。
 * @param fieldPath 校验结果中的规范字段路径。
 * @returns 可聚焦输入的测试标识；集合级问题没有单一输入时返回 `undefined`。
 * @remarks 只完成当前已开放编辑字段的直接映射。
 */
function validationTargetId(fieldPath: string): string | undefined {
  const portField = /^deviceParameters\.ports\.([^.]+)\.([^.]+)\.([^.]+)$/.exec(fieldPath)
  if (portField) return `port-${portField[1]}-${portField[2]}-${portField[3]}`
  if (fieldPath.startsWith('deviceParameters.antennaGains.')) {
    const antennaName = fieldPath.split('.').at(-1)
    const ports = readDeviceParameters(draft.value?.config ?? {}).ports
    for (const type of TEMPLATE_PLATFORM_TYPES) {
      const port = Object.keys(ports[type]).find(name => name !== 'fiber_link' && templatePortAntennaName(type, name) === antennaName)
      if (port) return `port-${type}-${port}-peakGainDb`
    }
    return `antenna-gain-${antennaName}`
  }
  const sensorField = /^uiExtensions\.sensors\[(\d+)\]\.(.+)$/.exec(fieldPath)
  if (sensorField) {
    const extension = draft.value?.uiExtensions.sensors[Number(sensorField[1])]
    const index = draft.value?.config.sensors.findIndex(sensor => sensor.id === extension?.sensorId)
    if (sensorField[2] === 'probability') return `sensor-probability-${index}`
  }
  if (fieldPath === 'jammingEnabled') return 'jamming-enabled'
  const waypointMotionField = /^platforms\[\d+\]\.waypoints\[(\d+)\]\.(heading|acceleration)$/.exec(fieldPath)
  if (waypointMotionField) return `waypoint-${waypointMotionField[2]}-${waypointMotionField[1]}`
  if (/^platforms\[\d+\]\.faction$/.test(fieldPath)) return 'platform-faction'
  const jammerEnabledMatch = /^uiExtensions\.jammers\[(\d+)\]\.enabled$/.exec(fieldPath)
  if (jammerEnabledMatch) {
    const jammerId = draft.value?.uiExtensions.jammers[Number(jammerEnabledMatch[1])]?.jammerId
    if (jammerId) return `toggle-jammer-${jammerId}`
  }
  const jammerBandField = /^jammers\[\d+\]\.weaponBands\[(\d+)\]\.(frequency|bandwidth|mode|spotBandwidthMHz|sweepDutyCycle)$/.exec(fieldPath)
  if (jammerBandField) {
    const bandIndex = Number(jammerBandField[1])
    const field = jammerBandField[2]
    if (field === 'mode') return bandIndex === 0 ? 'jammer-type' : `jammer-band-mode-${bandIndex}`
    if (field === 'spotBandwidthMHz') return `jammer-band-spot-bandwidth-${bandIndex}`
    if (field === 'sweepDutyCycle') return `jammer-band-sweep-duty-${bandIndex}`
    return bandIndex === 0 ? `jammer-${field}` : `jammer-band-${field}-${bandIndex}`
  }
  const jammerField = /^(?:jammers|uiExtensions\.jammers)\[\d+\]\.(\w+)/.exec(fieldPath)?.[1]
  if (jammerField) return ({ id: 'jammer-id', platformId: 'jammer-platform', type: 'jammer-type', defaultPower: 'jammer-power',
    direction: 'jammer-direction', elevation: 'jammer-elevation', frequency: 'jammer-frequency', bandwidth: 'jammer-bandwidth', weaponBands: 'jammer-add-band', detectionRange: 'jammer-range', jammingRange: 'jammer-jamming-range', releaseRange: 'jammer-release-range', triggerTimeS: 'jammer-trigger-time', detectionDelayS: 'jammer-detection-delay', jammingDurationS: 'jammer-jamming-duration' } as Record<string, string>)[jammerField] ?? `jammer-${jammerField}`
  const demandField = /^informationDemand\[\d+\]\.(\w+)/.exec(fieldPath)?.[1]
  if (demandField && linkDialogVisible.value) {
    const sharedTarget = ({ direction: 'link-direction', sourcePlatformId: 'link-source', destinationPlatformIds: 'link-target', linkId: 'link-id' } as Record<string, string>)[demandField]
    if (sharedTarget) return sharedTarget
  }
  if (demandField) return ({ direction: 'demand-direction', informationType: 'demand-type',
    sourcePlatformId: 'demand-source', destinationPlatformIds: 'demand-destinations', volumeMb: 'demand-volume', frequencyHz: 'demand-frequency',
    maxLatencyMs: 'demand-latency', minDataRateMbps: 'demand-rate' } as Record<string, string>)[demandField]
  const linkField = /^links\[\d+\]\.(.+)$/.exec(fieldPath)?.[1]
  if (linkField) return ({
    enabled: 'link-enabled',
    antennaGainCorrectionDb: 'link-gain-correction',
    antiJammingGainDb: 'link-anti-jamming-gain', spatialIsolationDb: 'link-spatial-isolation',
    modulation: 'link-modulation', 'laser.modulation': 'laser-modulation', berThreshold: 'link-ber-threshold', band: 'link-band',
    forwardDataRate: 'link-forward-data-rate', reverseDataRate: 'link-reverse-data-rate',
    rxFrequency: 'link-rx-frequency', rxBandwidth: 'link-rx-bandwidth', txPolarization: 'link-tx-polarization',
    rxPolarization: 'link-rx-polarization', noiseFigureDb: 'link-noise-figure',
  } as Record<string, string>)[linkField]
  if (fieldPath.startsWith('linkSettings.enabledSatellites')) return 'link-relay-satellite'
  const linkCalcField = /^linkSettings\.linkCalc\.(\w+)/.exec(fieldPath)?.[1]
  if (linkCalcField) return `link-calc-${linkCalcField}`
  const hotLinkField = /^linkSettings\.hotLinks\.(forward|reverse)\[(\d+)\]/.exec(fieldPath)
  if (hotLinkField) return `hot-link-${hotLinkField[1]}-${hotLinkField[2]}`
  if (fieldPath.startsWith('linkSettings.hotLinks')) return 'hot-link-settings'
  const naturalField = /^scenario\.environment\.(\w+)/.exec(fieldPath)?.[1]
  if (naturalField && NATURAL_ENVIRONMENT_FIELD_KEYS.has(naturalField)) return `scenario-env-${naturalField}`
  const directTargets: Record<string, string> = {
    'linkSettings.switchCooldownS': 'link-switch-cooldown',
    'linkSettings.switchStableChecks': 'link-switch-stable-checks',
    'scenario.id': 'scenario-id',
    'scenario.name': 'scenario-name',
    'scenario.description': 'scenario-description',
    'scenario.startTime': 'scenario-start-time',
    'scenario.duration': 'scenario-duration',
    'scenario.timeStep': 'scenario-time-step',
    'scenario.environment.seaState': 'scenario-sea-state',
    'scenario.environment.rainRateMmPerHour': 'scenario-rain-rate',
    'scenario.environment.multipathEnabled': 'scenario-multipath',
    'scenario.environment.cloudAltitudeMinM': 'scenario-cloud-min',
    'scenario.environment.cloudAltitudeMaxM': 'scenario-cloud-max',
    'scenario.environment.cloudWaterDensityGM3': 'scenario-cloud-water',
    'scenario.environment.seaPolygon': 'open-sea-area',

    'scenario.environment.simClockSpeed': 'scenario-sim-speed',
    'scenario.environment.rainCloudAttenuation': 'scenario-rain-cloud-atten',
  }
  return directTargets[fieldPath]
}

/**
 * 将焦点移动到错误对应的当前输入组件。
 * @param fieldPath 校验结果中的规范字段路径。
 * @returns 无返回值。
 * @sideEffects 找到可编辑输入时调用其 `focus()`，集合级问题只定位页签。
 */
function focusValidationField(fieldPath: string): void {
  const testId = validationTargetId(fieldPath)
  if (testId === undefined) return
  const owner = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  let details = owner?.closest('details')
  while (details) {
    details.open = true
    details = details.parentElement?.closest('details') ?? null
  }
  const target = owner?.matches('input, textarea, button') === true
    ? owner
    : owner?.querySelector<HTMLElement>('input, textarea, button')
  target?.focus()
}

/**
 * 定位整体校验问题所属页签、集合项和具体输入。
 * @param issue 用户选择的字段校验问题。
 * @returns 定位和聚焦完成后无返回值。
 * @sideEffects 切换页签；集合项问题会打开对应编辑弹框并显示中文原因。
 */
async function locateValidationIssue(issue: ValidationIssue): Promise<void> {
  let targetPath = issue.fieldPath
  const linkFieldMatch = /^links\[(\d+)\]\.([^.]+)$/.exec(issue.fieldPath)
  if (linkFieldMatch && draft.value) {
    const portTarget = resolveLinkPortFieldTarget(draft.value.config, Number(linkFieldMatch[1]), linkFieldMatch[2]!)
    if (portTarget && (issue.severity === 'WARNING' || !portTarget.legacyLinkOverrideInvalid)) {
      targetPath = portTarget.fieldPath
    }
  }

  // 编号异常定位时展开隐藏字段，不影响正常配置的精简展示。
  if (targetPath === 'scenario.id' || /(?:\.id|Ids|\.linkId)$/.test(targetPath) || issue.code.endsWith('_ID_DUPLICATED')) showIds.value = true
  const platformIndex = Number(/^platforms\[(\d+)\]/.exec(targetPath)?.[1])
  const linkIndex = Number(/^links\[(\d+)\]/.exec(targetPath)?.[1])
  const jammerIndex = Number(/^(?:jammers|uiExtensions\.jammers)\[(\d+)\]/.exec(targetPath)?.[1])

  if (targetPath.startsWith('platforms')) activeTab.value = 'platforms'
  else if (targetPath.startsWith('links') || targetPath.startsWith('linkSettings') || targetPath.startsWith('informationDemand')) activeTab.value = 'links'
  else if (targetPath.startsWith('deviceParameters')) {
    activeTab.value = 'links'
    deviceFocusPath.value = targetPath
    const banner = `${formatValidationFieldLabel(targetPath, draft.value?.config)}：${formatValidationIssueMessage(issue, draft.value?.config)}`
    if (issue.severity === 'WARNING') {
      portParametersWarning.value = banner
      portParametersError.value = ''
    } else {
      portParametersError.value = banner
      portParametersWarning.value = ''
    }
    portParametersVisible.value = true
  }
  else if (targetPath.startsWith('jammers') || targetPath.startsWith('uiExtensions.jammers') || targetPath === 'jammingEnabled') activeTab.value = 'jammers'
  else if (targetPath.startsWith('sensors') || targetPath.startsWith('uiExtensions.sensors')
    || targetPath.startsWith('output')) activeTab.value = 'data'
  else activeTab.value = 'scenario'
  await nextTick()

  if (targetPath.startsWith('deviceParameters')) {
    deviceParametersPanel.value?.revealField(targetPath)
    await nextTick()
  }
  if (targetPath.startsWith('linkSettings')) {
    linkSettingsVisible.value = true
    linkSettingsPanel.value?.revealField(targetPath.slice('linkSettings.'.length))
  }
  const demandIndex = Number(/^informationDemand\[(\d+)\]/.exec(targetPath)?.[1])
  if (Number.isInteger(demandIndex) && draft.value?.config.informationDemand[demandIndex]) {
    const demand = draft.value.config.informationDemand[demandIndex]!
    const associatedIndex = draft.value.config.links.findIndex(link => link.id === demand.linkId)
    if (associatedIndex >= 0) {
      openLinkEditor(draft.value.config.links[associatedIndex]!, associatedIndex)
      linkEditorError.value = issue.message
      linkFocusPath.value = targetPath
      return
    }
  }
  if (Number.isInteger(platformIndex) && draft.value?.config.platforms[platformIndex] !== undefined) {
    openPlatformEditor(draft.value.config.platforms[platformIndex], platformIndex)
    platformEditorError.value = issue.message
  } else if (Number.isInteger(linkIndex) && draft.value?.config.links[linkIndex] !== undefined) {
    openLinkEditor(draft.value.config.links[linkIndex], linkIndex)
    linkEditorError.value = issue.message
    linkFocusPath.value = targetPath
  } else if (Number.isInteger(jammerIndex) && draft.value?.config.jammers[jammerIndex] !== undefined) {
    openJammerEditor(draft.value.config.jammers[jammerIndex], jammerIndex)
    jammerEditorError.value = issue.message
    jammerFocusPath.value = targetPath
  }
  await nextTick()
  // 等待表格列完成异步挂载后再聚焦。
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  focusValidationField(targetPath)
}

/**
 * 重新加载确定性场景草稿。
 * @returns 加载流程结束后兑现且不返回值的 Promise。
 * @sideEffects 调用场景 Store，并以服务端草稿替换当前页面数据。
 */
async function loadScenario(): Promise<void> {
  await scenarioStore.loadScenario()
}

function createScenario(): void {
  if (scenarioStore.createScenario()) activeTab.value = 'scenario'
}

/** 模板保存当前已落盘配置的独立副本；确认期间草稿变化或会话失效则取消。 */
async function saveAsTemplate(): Promise<void> {
  if (!canMaintainTemplates.value || !alreadySaved.value || templatePending.value) return
  const epoch = scenarioStore.requestEpoch
  const scriptEpoch = scenarioStore.scriptEpoch
  const currentDraft = draft.value
  try {
    const { value } = await ElMessageBox.prompt('将当前已保存场景及扩展参数复制为模板，不改变原场景。', '另存为模板', {
      inputValue: `${currentDraft!.config.scenario.name} 模板`,
      inputValidator: name => name.trim() !== '' || '请输入模板名称。',
      confirmButtonText: '保存模板', cancelButtonText: '取消',
    })
    if (epoch !== scenarioStore.requestEpoch || scriptEpoch !== scenarioStore.scriptEpoch
      || currentDraft !== draft.value || !alreadySaved.value || !canMaintainTemplates.value || templatePending.value) return
    if (await scenarioStore.createTemplate(value)) ElMessage.success(scenarioStore.templateResultMessage)
    else if (epoch === scenarioStore.requestEpoch) ElMessage.error(scenarioStore.templateResultMessage)
  } catch {
    // 取消不创建模板、不修改草稿。
  }
}

function validateEditorDraft(): boolean {
  validationAttempted.value = true
  if (liveValidation.value.valid) return true
  scenarioStore.validation = liveValidation.value
  scenarioStore.panelState = 'ERROR'
  scenarioStore.resultCode = 'VALIDATION_FAILED'
  scenarioStore.resultMessage = `请先修正 ${liveValidation.value.errors.length} 项配置错误。`
  activeTab.value = 'validation'
  return false
}

function persistEditorDraft(): Promise<boolean> {
  const config = draft.value?.config
  if (config) config.links = toRaw(config.links).map(link => overwriteLegacyLinkFromPorts(config, link))
  return scenarioStore.saveScenario()
}

async function openScriptPreview(): Promise<void> {
  const initialDraft = draft.value
  if (!initialDraft || initialDraft.locked || scenarioActionsBusy.value || !validateEditorDraft()) return
  const epoch = scenarioStore.requestEpoch
  const userId = authStore.principal?.userId
  const editorCurrent = () => active && epoch === scenarioStore.requestEpoch && userId === authStore.principal?.userId && !draft.value?.locked
  previewingScript.value = true
  try {
    if (!alreadySaved.value) {
      const editEpoch = scenarioStore.scriptEpoch
      try {
        await ElMessageBox.confirm('脚本预览使用已保存的场景修订。是否保存当前草稿并继续预览？', '保存并预览', {
          confirmButtonText: '保存并预览', cancelButtonText: '取消', type: 'info',
        })
      } catch { return }
      if (!editorCurrent() || draft.value !== initialDraft || scenarioStore.scriptEpoch !== editEpoch) return
      const saved = await persistEditorDraft()
      if (!editorCurrent()) return
      if (!saved) { activeTab.value = 'validation'; return }
    }
    const savedDraft = draft.value
    scenarioStore.clearScriptPreview()
    const generated = await generateScriptPreview()
    if (!editorCurrent() || draft.value !== savedDraft || dirty.value) return
    if (!generated) {
      if (panelState.value === 'ERROR') activeTab.value = 'validation'
      else if (scenarioStore.scriptResultCode !== 'CONFIRMATION_REQUIRED') ElMessage.error(scriptResultMessage.value)
      return
    }
    if (!currentScriptPreview.value) { ElMessage.error('脚本版本与当前场景不一致，请重新生成预览。'); return }
    scriptPreviewReceipt.value = null
    scriptPreviewVisible.value = true
  } finally { previewingScript.value = false }
}

/** 校验并保存场景，生成 TXT；失败时停止后续阶段。 */
async function saveScenario(action: 'save' | 'generate' = 'save'): Promise<void> {
  const initialDraft = draft.value
  if (!initialDraft || initialDraft.locked || scenarioActionsBusy.value || !validateEditorDraft()) return
  const saved = alreadySaved.value
  const epoch = scenarioStore.requestEpoch
  const userId = authStore.principal?.userId
  const editorCurrent = () => active && epoch === scenarioStore.requestEpoch && userId === authStore.principal?.userId && !draft.value?.locked
  const retry = action === 'generate' ? '请重试生成。' : '请重试保存。'
  scriptAction.value = action
  try {
    if (action === 'generate' && !saved) {
      const editEpoch = scenarioStore.scriptEpoch
      try {
        await ElMessageBox.confirm('生成脚本使用已保存的场景修订。是否保存当前草稿并生成 TXT？', '保存并生成', {
          confirmButtonText: '保存并生成', cancelButtonText: '取消', type: 'info',
        })
      } catch { return }
      if (!editorCurrent() || draft.value !== initialDraft || scenarioStore.scriptEpoch !== editEpoch) return
    }
    draftReviewed.value = false
    // 未修改的已保存草稿仍须校验和生成脚本，但不重复 PUT 或增加修订号。
    if (await (saved ? scenarioStore.validateScenario() : persistEditorDraft())) {
      if (!editorCurrent() || !draft.value) return
      const savedDraft = draft.value
      const current = () => editorCurrent() && draft.value === savedDraft && !dirty.value
      draftReviewed.value = true
      activeTab.value = validation.value.warnings.length > 0 ? 'validation' : 'scenario'
      const generated = await generateScriptPreview()
      if (!current()) return
      const preview = currentScriptPreview.value
      if (!generated || !preview) {
        if (action === 'generate' && panelState.value === 'ERROR') activeTab.value = 'validation'
        ElMessage.warning(`场景配置已保存，但 TXT 未生成。${!generated ? scriptResultMessage.value : '脚本版本与当前场景不一致。'} ${retry}`)
        return
      }
      const scriptEpoch = scenarioStore.scriptEpoch
      const currentScript = () => current() && scriptEpoch === scenarioStore.scriptEpoch
      try {
        const path = await saveScriptText(preview)
        if (!currentScript()) return
        scriptOutputPath.value = path
        const log = executionLog()
        scriptGenerationLog.value = [`已生成脚本入口：${path}`, `场景修订：${preview.configVersion}`, ...log]
        scriptGenerationReceipt.value = { path, version: preview.configVersion, log }
        if (action === 'generate') {
          scriptPreviewReceipt.value = scriptGenerationReceipt.value
          scriptPreviewVisible.value = true
        }
      } catch (error) {
        if (currentScript()) ElMessage.error(`场景配置已保存，但 TXT 写入未完成。${error instanceof Error ? error.message : retry}`)
        return
      }
      if (action === 'save') {
        ElMessage.success('场景已保存，TXT 已生成。')
        if (!saved && props.managed) emit('saved')
      }
    } else {
      if (editorCurrent()) activeTab.value = 'validation'
    }
  } finally { scriptAction.value = null }
}


/** 生成脚本预览；遇到 WARNING 时只在本次确认后继续。 */
async function generateScriptPreview(): Promise<boolean> {
  const currentDraft = draft.value
  const epoch = scenarioStore.requestEpoch
  const userId = authStore.principal?.userId
  const current = () => active && epoch === scenarioStore.requestEpoch && userId === authStore.principal?.userId
    && draft.value === currentDraft && !dirty.value && !draft.value?.locked
  const generated = await scenarioStore.generateScriptPreview()
  if (!current()) return false
  if (generated) {
    scriptGenerationLog.value = ['预览映射状态（尚未写入本机执行包）：', ...executionLog()]
    return true
  }
  if (scenarioStore.scriptResultCode !== 'CONFIRMATION_REQUIRED') return false
  const scriptEpoch = scenarioStore.scriptEpoch
  try {
    await ElMessageBox.confirm(`${scenarioStore.scriptResultMessage} 是否继续生成？`, '脚本预览警告', {
      confirmButtonText: '本次继续', cancelButtonText: '取消', type: 'warning',
    })
    if (!current() || scriptEpoch !== scenarioStore.scriptEpoch) return false
    const confirmed = await scenarioStore.generateScriptPreview(true) && current()
    if (confirmed) scriptGenerationLog.value = ['预览映射状态（尚未写入本机执行包）：', ...executionLog()]
    return confirmed
  } catch {
    // 用户取消后不创建一次性确认上下文。
    return false
  }
}

onMounted(() => {
  if (draft.value === null) void loadScenario()
})
</script>

<template>
  <section class="page scenario-page" aria-label="场景配置">
    <header class="scenario-header" aria-label="场景操作">
      <el-button v-if="managed" data-testid="back-scene-list" @click="emit('back')">返回场景列表</el-button>
      <div class="scenario-header__actions" aria-label="场景辅助工具">
        <el-checkbox v-if="draft" v-model="showIds" data-testid="show-scenario-ids">显示编号</el-checkbox>
        <el-tooltip v-if="canMaintainTemplates" content="请先保存场景；运行中或处理中不可另存模板。" :disabled="alreadySaved && !templatePending">
          <span><el-button :disabled="!alreadySaved || templatePending" :loading="templatePending" data-testid="save-as-template" @click="saveAsTemplate">另存为模板</el-button></span>
        </el-tooltip>
      </div>
    </header>

    <div class="scenario-workflow-bar">
      <p v-if="draft" class="scenario-required-hint">* 为必填项。航点可不配置，新增后须完整填写。</p>
      <div class="scenario-header__actions">
        <el-tag :type="panelState === 'ERROR' ? 'danger' : dirty ? 'warning' : 'success'">
          {{ dirty ? '未保存' : stateLabels[panelState] }}
        </el-tag>
        <span v-if="draft" class="console-chip">{{ draft.revision === 0 ? '尚未保存' : `修订 ${draft.revision}` }}</span>
        <el-button v-if="(panelState === 'ERROR' || panelState === 'EMPTY') && !dirty" :loading="pending" @click="loadScenario">
          重新加载
        </el-button>
        <el-button
          type="primary"
          :disabled="draft === null || draft?.locked || scenarioActionsBusy"
          :loading="scriptAction === 'save' || (scriptAction === null && pending)"
          data-testid="save-scenario"
          title="校验并保存场景，生成 TXT。"
          @click="saveScenario()"
        >
          保存
        </el-button>
        <el-button
          :disabled="draft === null || draft?.locked || scenarioActionsBusy"
          :loading="previewingScript"
          data-testid="generate-script"
          @click="openScriptPreview"
        >生成脚本预览</el-button>
        <el-button
          :disabled="draft === null || draft?.locked || scenarioActionsBusy"
          :loading="scriptAction === 'generate'"
          data-testid="generate-script-file"
          @click="saveScenario('generate')"
        >生成脚本</el-button>
        <el-button
          :disabled="scenarioActionsBusy || scriptGenerationDialog?.checking"
          :loading="scriptGenerationDialog?.checking"
          title="选择已生成的脚本包根目录"
          data-testid="preflight-script-folder"
          @click="scriptGenerationDialog?.openFolderPicker()"
        >执行预检</el-button>
      </div>
    </div>

    <el-alert
      v-if="panelState === 'ERROR' && (activeTab !== 'validation' || draft === null)"
      class="scenario-feedback"
      type="error"
      :closable="false"
      :title="resultMessage"
      show-icon
    />

    <div v-if="pending && draft === null" class="console-placeholder" aria-live="polite">
      正在加载场景草稿…
    </div>

    <el-form
      v-else-if="draft"
      class="scenario-form"
      :model="draft.config.scenario"
      label-position="top"
      :disabled="pending || draft.locked"
      data-testid="scenario-editor"
      @input.capture="touchField"
      @change.capture="touchField"
      @focusout="touchField"
    >
      <div v-if="showValidationSummary && liveValidation.errors.length > 0" class="scenario-validation-notices">
        <el-alert type="error" :closable="false" show-icon data-testid="scenario-live-validation">
          <template #title>当前有 {{ liveValidation.errors.length }} 项配置错误，不能保存。</template>
          {{ liveValidation.errors[0]?.fieldPath }}：{{ liveValidation.errors[0]?.message }}
          <el-button link type="primary" @click="locateValidationIssue(liveValidation.errors[0]!)">定位首个问题</el-button>
        </el-alert>
      </div>
      <!-- 平台、链路、干扰表格在可见时挂载，避免零宽布局。 -->
      <!-- 基础、传感器数字输入保留实例，避免重挂载按最小值改写待修正参数。 -->
      <el-tabs v-model="activeTab" class="scenario-tabs" :class="{ 'scenario-tabs--navigation-only': !configurationTab }" aria-label="参数分类">
        <el-tab-pane label="场景基础" name="scenario">
      <section class="console-panel scenario-section" aria-label="场景基础">
        <div class="form-grid form-grid--scenario">
          <el-form-item data-field-path="scenario.id" v-show="showIds" label="场景编号" :error="issueMessage('scenario.id')">
            <el-input v-model="draft.config.scenario.id" disabled data-testid="scenario-id" />
          </el-form-item>
          <el-form-item data-field-path="scenario.name" required label="场景名称" :error="issueMessage('scenario.name')">
            <el-input
              v-model="draft.config.scenario.name"
              maxlength="128"
              data-testid="scenario-name"
              @update:model-value="markDirty"
            />
          </el-form-item>
          <el-form-item data-field-path="scenario.startTime" required label="开始时间" :error="issueMessage('scenario.startTime')">
            <div class="scenario-start-time" data-testid="scenario-start-time">
              <el-date-picker
                  v-if="useStartTimeDatePicker"
                  v-model="startTimeBeijing"
                  type="datetime"
                  format="YYYY-MM-DD HH:mm"
                  value-format="YYYY-MM-DDTHH:mm"
                  placeholder="请选择开始时间"
                  style="width: 100%"
              />
              <el-input v-else v-model="startTimeBeijing" />
            </div>
          </el-form-item>
          <el-form-item data-field-path="scenario.timeStep" required label="时间步长（秒）" :error="issueMessage('scenario.timeStep')">
            <el-input-number
                v-model="draft.config.scenario.timeStep"
                controls-position="right"
                data-testid="scenario-time-step"
                @update:model-value="markDirty"
            />
          </el-form-item>
          <el-form-item data-field-path="scenario.duration" required label="仿真总时长（min）" :error="issueMessage('scenario.duration')">
            <el-input-number
                v-model="simulationDurationMinutes"
                controls-position="right"
                data-testid="scenario-duration"
            />
          </el-form-item>

          <el-form-item data-field-path="scenario.environment.simClockSpeed" label="仿真倍速" :error="issueMessage('scenario.environment.simClockSpeed')">
            <el-select v-model="simSpeed" :disabled="draft.locked" data-testid="scenario-sim-speed">
              <!-- 旧场景的非标准组合只回显当前值，不可选择；选定标准档位后按标准映射归一化。 -->
              <el-option v-if="simSpeed === 'legacy'" :label="legacySimSpeedLabel" value="legacy" disabled />
              <el-option v-for="option in SIM_SPEED_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>

          <el-form-item data-field-path="scenario.description" label="场景描述" :error="issueMessage('scenario.description')">
            <el-input
              v-model="draft.config.scenario.description"
              type="textarea"
              :rows="3"
              maxlength="512"
              show-word-limit
              data-testid="scenario-description"
              @update:model-value="markDirty"
            />
          </el-form-item>
        </div>
      </section>
      <!-- 分组与标题按《与前端字段确认说明》“环境参数（全局）”：降雨、云雾、大气、极化失配、海况。 -->
      <section class="console-panel scenario-section environment-section" aria-labelledby="scenario-environment-title" data-testid="scenario-environment">
        <h3 id="scenario-environment-title" class="environment-section__title">环境参数（全局）</h3>
        <h4 class="environment-group__title">降雨参数</h4>
        <div class="form-grid form-grid--scenario" data-testid="environment-rain">
          <el-form-item data-field-path="scenario.environment.rainEnabled" label="是否开启" :error="issueMessage('scenario.environment.rainEnabled')">
            <el-switch v-model="draft.config.scenario.environment.rainEnabled" inline-prompt active-text="开" inactive-text="关"
              data-testid="scenario-env-rainEnabled" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item data-field-path="scenario.environment.rainCloudAttenuation" label="雨强档位" :error="issueMessage('scenario.environment.rainCloudAttenuation')">
            <el-select :model-value="draft.config.scenario.environment.rainCloudAttenuation" data-testid="scenario-rain-cloud-atten" @update:model-value="changeRainTier">
              <el-option v-for="option in RAIN_TIER_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
          <el-form-item data-field-path="scenario.environment.rainRateMmPerHour" required label="降雨强度（mm/h）" :error="issueMessage('scenario.environment.rainRateMmPerHour')">
            <el-input-number v-model="draft.config.scenario.environment.rainRateMmPerHour" controls-position="right" data-testid="scenario-rain-rate" @update:model-value="markDirty" />
            <small :class="{ 'field-hint--hidden': !!issueMessage('scenario.environment.rainRateMmPerHour') }" class="field-hint">0～100 mm/h，超过 100 按 100 封顶</small>
          </el-form-item>
          <el-form-item v-for="field in naturalFields('rain')" :key="field.key" :data-field-path="`scenario.environment.${field.key}`" :label="field.label" :error="issueMessage(`scenario.environment.${field.key}`)">
            <el-input-number v-model="draft.config.scenario.environment[field.key]" :step="field.step"
              controls-position="right" :data-testid="`scenario-env-${field.key}`" @update:model-value="markDirty" />
            <small v-if="field.hint" :class="{ 'field-hint--hidden': !!issueMessage(`scenario.environment.${field.key}`) }" class="field-hint">{{ field.hint }}</small>
          </el-form-item>
        </div>
        <h4 class="environment-group__title">云雾参数</h4>
        <div class="form-grid form-grid--scenario" data-testid="environment-cloud">
          <el-form-item data-field-path="scenario.environment.cloudEnabled" label="是否开启" :error="issueMessage('scenario.environment.cloudEnabled')">
            <el-switch v-model="draft.config.scenario.environment.cloudEnabled" inline-prompt active-text="开" inactive-text="关"
              data-testid="scenario-env-cloudEnabled" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item data-field-path="scenario.environment.cloudAltitudeMinM" label="云层底边高度（m）" :error="issueMessage('scenario.environment.cloudAltitudeMinM')">
            <el-input-number v-model="draft.config.scenario.environment.cloudAltitudeMinM" :max="30000" controls-position="right" data-testid="scenario-cloud-min" @update:model-value="markDirty" />
            <small :class="{ 'field-hint--hidden': !!issueMessage('scenario.environment.cloudAltitudeMinM') }" class="field-hint">范围 0～30000 m；顶边高度须高于底边高度。</small>
          </el-form-item>
          <el-form-item data-field-path="scenario.environment.cloudAltitudeMaxM" label="云层顶边高度（m）" :error="issueMessage('scenario.environment.cloudAltitudeMaxM')">
            <el-input-number v-model="draft.config.scenario.environment.cloudAltitudeMaxM" :max="30000" controls-position="right" data-testid="scenario-cloud-max" @update:model-value="markDirty" />
            <small :class="{ 'field-hint--hidden': !!issueMessage('scenario.environment.cloudAltitudeMaxM') }" class="field-hint">范围 0～30000 m；须高于云层底边高度。</small>
          </el-form-item>
          <el-form-item data-field-path="scenario.environment.cloudWaterDensityGM3" label="云中含水量（g/m³）" :error="issueMessage('scenario.environment.cloudWaterDensityGM3')">
            <el-input-number v-model="draft.config.scenario.environment.cloudWaterDensityGM3" :step="0.1" controls-position="right" data-testid="scenario-cloud-water" @update:model-value="markDirty" />
            <small :class="{ 'field-hint--hidden': !!issueMessage('scenario.environment.cloudWaterDensityGM3') }" class="field-hint">典型 0.05～2.0 g/m³</small>
          </el-form-item>
        </div>
        <h4 class="environment-group__title">大气参数</h4>
        <div class="form-grid form-grid--scenario" data-testid="environment-atmosphere">
          <el-form-item data-field-path="scenario.environment.atmosphereModel" label="衰减模型" :error="issueMessage('scenario.environment.atmosphereModel')">
            <el-select :model-value="draft.config.scenario.environment.atmosphereModel" data-testid="scenario-env-atmosphereModel" @update:model-value="changeAtmosphereModel">
              <el-option label="itu（标准）" value="itu" /><el-option label="simplified（简化）" value="simplified" /><el-option label="auto（自动）" value="auto" />
            </el-select>
          </el-form-item>
          <el-form-item v-for="field in naturalFields('atmosphere')" :key="field.key" :data-field-path="`scenario.environment.${field.key}`" :label="field.label" :error="issueMessage(`scenario.environment.${field.key}`)">
            <el-input-number v-model="draft.config.scenario.environment[field.key]" :step="field.step"
              :disabled="draft.config.scenario.environment.atmosphereModel === 'itu'"
              controls-position="right" :data-testid="`scenario-env-${field.key}`" @update:model-value="markDirty" />
            <small v-if="field.hint" :class="{ 'field-hint--hidden': !!issueMessage(`scenario.environment.${field.key}`) }" class="field-hint">{{ field.hint }}</small>
          </el-form-item>
        </div>
        <h4 class="environment-group__title">极化失配</h4>
        <div class="form-grid form-grid--scenario" data-testid="environment-misc">
          <el-form-item v-for="field in naturalFields('misc')" :key="field.key" :data-field-path="`scenario.environment.${field.key}`" :label="field.label" :error="issueMessage(`scenario.environment.${field.key}`)">
            <el-input-number v-model="draft.config.scenario.environment[field.key]" :step="field.step"
              controls-position="right" :data-testid="`scenario-env-${field.key}`" @update:model-value="markDirty" />
            <small v-if="field.hint" :class="{ 'field-hint--hidden': !!issueMessage(`scenario.environment.${field.key}`) }" class="field-hint">{{ field.hint }}</small>
          </el-form-item>
        </div>
        <h4 class="environment-group__title">海况参数</h4>
        <div class="form-grid form-grid--scenario" data-testid="environment-sea">
          <el-form-item data-field-path="scenario.environment.seaState" required label="海况等级" :error="issueMessage('scenario.environment.seaState')">
            <el-input-number v-model="draft.config.scenario.environment.seaState" :step="1" step-strictly controls-position="right" data-testid="scenario-sea-state" @update:model-value="markDirty" />
            <small :class="{ 'field-hint--hidden': !!issueMessage('scenario.environment.seaState') }" class="field-hint">1～9 级，0 表示不启用海况损耗</small>
          </el-form-item>
          <el-form-item data-field-path="scenario.environment.multipathEnabled" class="multipath-field" label="海面多径衰落" :error="issueMessage('scenario.environment.multipathEnabled')">
            <el-switch v-model="draft.config.scenario.environment.multipathEnabled" inline-prompt active-text="启用" inactive-text="禁用"
              data-testid="scenario-multipath" @update:model-value="markDirty" />
            <template v-if="draft.config.scenario.environment.multipathEnabled">
              <el-button size="small" class="sea-area-button" :disabled="pending || draft.locked" data-testid="open-sea-area" @click="seaAreaVisible = true">
                框选海面区域
              </el-button>
              <span class="sea-area-summary" data-testid="sea-area-summary">
                {{ draft.config.scenario.environment.seaPolygon?.length
                  ? `已框选 ${draft.config.scenario.environment.seaPolygon.length} 个顶点`
                  : '未框选海面区域' }}
              </span>
            </template>
            <SeaAreaMapPicker v-model="seaAreaVisible" :polygon="draft.config.scenario.environment.seaPolygon" @confirm="applySeaArea" />
          </el-form-item>
          <el-form-item data-field-path="scenario.environment.seaModel" label="损耗计算模式" :error="issueMessage('scenario.environment.seaModel')">
            <el-select v-model="draft.config.scenario.environment.seaModel" data-testid="scenario-env-seaModel" @update:model-value="markDirty">
              <el-option label="经验模型（coarse）" value="coarse" /><el-option label="多径模型（fine）" value="fine" />
            </el-select>
          </el-form-item>
          <el-form-item data-field-path="scenario.environment.seaPolarization" label="反射系数极化" :error="issueMessage('scenario.environment.seaPolarization')">
            <el-select v-model="draft.config.scenario.environment.seaPolarization" :disabled="seaFineInactive()" data-testid="scenario-env-seaPolarization" @update:model-value="markDirty">
              <el-option label="垂直极化" value="vertical" /><el-option label="水平极化" value="horizontal" />
            </el-select>
            <small v-if="seaFineInactive()" :class="{ 'field-hint--hidden': !!issueMessage('scenario.environment.seaPolarization') }" class="field-hint" data-testid="sea-polarization-hint">仅多径模型（fine）生效</small>
          </el-form-item>
          <el-form-item v-for="field in naturalFields('sea')" :key="field.key" :data-field-path="`scenario.environment.${field.key}`" :label="field.label" :error="issueMessage(`scenario.environment.${field.key}`)">
            <el-input-number v-model="draft.config.scenario.environment[field.key]" :step="field.step"
              :disabled="!!field.fineOnly && seaFineInactive()"
              controls-position="right" :data-testid="`scenario-env-${field.key}`" @update:model-value="markDirty" />
            <small v-if="naturalFieldHint(field)" :class="{ 'field-hint--hidden': !!issueMessage(`scenario.environment.${field.key}`) }" class="field-hint">{{ naturalFieldHint(field) }}</small>
          </el-form-item>
        </div>
      </section>
        </el-tab-pane>

        <el-tab-pane label="节点配置" name="platforms">
          <section class="console-panel scenario-section" aria-label="节点配置">
            <div class="section-heading">
<!--              <div>-->
<!--                <p class="section-kicker">节点配置</p>-->
<!--                <h3 id="scenario-platform-title">节点配置</h3>-->
<!--              </div>-->
              <div class="platform-counts" aria-label="节点数量">
                <el-tag type="primary">信息节点 {{ businessNodeCount }} / {{ INFORMATION_NODE_LIMIT }}</el-tag>
                <el-tag :type="businessNodeTypeCount === 4 ? 'success' : 'warning'">信息节点类型 {{ businessNodeTypeCount }} / 4</el-tag>
                <el-tag>支撑实体 {{ supportingEntityCount }}</el-tag>
              </div>
              <div class="platform-actions">
                <el-button type="primary" :disabled="pending || draft.locked" data-testid="add-platform" @click="openNewPlatform()">新增节点</el-button>
              </div>
            </div>
            <el-table v-if="activeTab === 'platforms'" :data="draft.config.platforms" stripe data-testid="platform-table">
              <el-table-column v-if="showIds" prop="id" label="节点 ID" min-width="130" />
              <el-table-column label="名称" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ scenarioPlatformLabel(draft.config.platforms, row.id) }}</template></el-table-column>
              <el-table-column label="分类" width="120">
                <template #default="{ row }">
                  {{ isBusinessInformationNodeType(row.type) ? '信息节点' : '支撑实体' }}
                </template>
              </el-table-column>
              <el-table-column label="节点类型" min-width="180">
                <template #default="{ row }">{{ platformTypeLabel(row) }}</template>
              </el-table-column>
              <el-table-column label="部署域" width="90">
                <template #default="{ row }">{{ deploymentDomainLabels[row.category] }}</template>
              </el-table-column>
              <el-table-column label="航点" width="70" align="center">
                <template #default="{ row }">{{ row.waypoints.length }}</template>
              </el-table-column>
              <el-table-column label="操作" fixed="right" width="190">
                <template #default="{ row, $index }">
                  <el-button link type="primary" :disabled="false" :data-testid="`detail-platform-${$index}`" @click="detailPlatformId = row.id">详情</el-button>
                  <el-button link type="primary" :disabled="pending || draft.locked" :data-testid="`edit-platform-${$index}`" @click="openPlatformEditor(row, $index)">编辑</el-button>
                  <el-popconfirm title="确认删除该节点？" confirm-button-text="删除" cancel-button-text="取消" @confirm="removePlatform(row, $index)">
                    <template #reference><el-button link type="danger" :disabled="pending || draft.locked" :data-testid="`delete-platform-${$index}`">删除</el-button></template>
                  </el-popconfirm>
                </template>
              </el-table-column>
            </el-table>

          </section>
        </el-tab-pane>

        <el-tab-pane label="链路配置" name="links">
          <section class="console-panel scenario-section" aria-label="链路配置">
            <div class="section-heading">
<!--              <div>-->
<!--                <p class="section-kicker">信息链路</p>-->
<!--                <h3 id="scenario-link-title">链路参数配置</h3>-->
<!--              </div>-->
              <div class="platform-counts" aria-label="链路类型覆盖">
                <el-tag type="primary">链路 {{ draft.config.links.length }}</el-tag>
                <el-tag :type="linkTypeCount === 5 ? 'success' : 'warning'">已配置 {{ linkTypeCount }} / 5 类</el-tag>
                <el-tag type="info" data-testid="scenario-selected-satellite">选用卫星：{{ linkSettings.enabledSatellites.TIANTONG ? '天通卫星' : linkSettings.enabledSatellites.SHENTONG ? '神通卫星' : '未选择' }}</el-tag>
              </div>
              <div class="platform-actions">
                <el-button data-testid="open-port-parameters" @click="portParametersVisible = true">端口参数设置</el-button>
                <LinkSettingsPanel ref="linkSettingsPanel" :field-message="path => liveFieldMessage(`linkSettings.${path}`)" v-model:dialog-visible="linkSettingsVisible" :model-value="draft.config.linkSettings" :platforms="draft.config.platforms"
                  :links="draft.config.links"
                  :disabled="pending || draft.locked" :type-options="linkTypeOptions" @update:model-value="updateLinkSettings" />
                <el-button type="primary" :disabled="pending || draft.locked" data-testid="add-link" @click="openNewLink">新增链路</el-button>
              </div>
            </div>
            <el-table v-if="activeTab === 'links'" :key="'link-page-' + linkPage" :data="pagedLinks" stripe data-testid="link-table">
              <el-table-column v-if="showIds" prop="id" label="链路 ID" min-width="120" />
              <el-table-column v-else type="index" :index="linkPageOffset + 1" label="序号" width="65" />
              <el-table-column label="类型" min-width="130"><template #default="{ row }">{{ linkTypeLabel(row.type) }}</template></el-table-column>
              <el-table-column label="链路状态" width="100"><template #default="{ row }">
                <el-tag :type="readLinkEnabled(row, linkSettings) ? 'success' : 'info'">
                  {{ readLinkEnabled(row, linkSettings) ? '启用' : '停用' }}
                </el-tag>
              </template></el-table-column>
              <el-table-column label="启停" width="90"><template #default="{ row, $index }">
                <el-switch :model-value="readLinkEnabled(row, linkSettings) === true" :disabled="pending || draft.locked"
                  size="small" inline-prompt active-text="启用" inactive-text="停用"
                  :data-testid="`link-enabled-toggle-${linkPageOffset + $index}`"
                  @update:model-value="setLinkEnabled(row, $event)" />
              </template></el-table-column>
              <el-table-column label="发送端" min-width="150"><template #default="{ row }">{{ scenarioPlatformLabel(draft.config.platforms, row.sourcePlatformId, showIds) }}</template></el-table-column>
              <el-table-column label="中继节点" min-width="140"><template #default="{ row }">{{ row.relayPlatformId ? scenarioPlatformLabel(draft.config.platforms, row.relayPlatformId, showIds) : '不经中继' }}</template></el-table-column>
              <el-table-column label="接收端" min-width="150"><template #default="{ row }">{{ scenarioPlatformLabel(draft.config.platforms, row.targetPlatformId, showIds) }}</template></el-table-column>
              <el-table-column label="频率（MHz）" min-width="110"><template #default="{ row }">{{ effectiveLinkFromPorts(draft.config, row).frequency }}</template></el-table-column>
              <el-table-column label="带宽（MHz）" min-width="110"><template #default="{ row }">{{ effectiveLinkFromPorts(draft.config, row).bandwidth }}</template></el-table-column>
              <el-table-column label="方向" width="80"><template #default="{ row }">{{ linkDirectionLabels[row.direction] }}</template></el-table-column>
              <el-table-column label="方向速率" min-width="115"><template #default="{ row }">{{ formatDataRate((row.direction === 'REVERSE' ? row.reverseDataRate : row.forwardDataRate) ?? effectiveLinkFromPorts(draft.config, row).dataRate) }}</template></el-table-column>
              <el-table-column label="操作" fixed="right" width="140">
                <template #default="{ row, $index }">
                  <el-button link type="primary" :disabled="pending || draft.locked" :data-testid="`edit-link-${linkPageOffset + $index}`" @click="openLinkEditor(row, linkPageOffset + $index)">编辑</el-button>
                  <el-popconfirm title="确认删除该链路及其业务配置？" confirm-button-text="删除" cancel-button-text="取消" @confirm="removeLink(row)">
                    <template #reference><el-button link type="danger" :disabled="pending || draft.locked" :data-testid="`delete-link-${linkPageOffset + $index}`">删除</el-button></template>
                  </el-popconfirm>
                </template>
              </el-table-column>
            </el-table>

            <el-pagination v-if="activeTab === 'links' && linkPageCount > 1" v-model:current-page="linkPage" :page-size="LINK_PAGE_SIZE"
              :total="draft.config.links.length" layout="total, prev, pager, next"
              class="scenario-link-pagination" aria-label="链路列表分页" data-testid="link-pagination" />
          </section>
        </el-tab-pane>

        <el-tab-pane label="干扰设备" name="jammers">
          <section class="console-panel scenario-section" aria-labelledby="scenario-jammer-title">
            <div class="section-heading">
<!--              <div>-->
<!--                <p class="section-kicker">干扰设备</p>-->
<!--                <h3 id="scenario-jammer-title">干扰参数配置</h3>-->
<!--              </div>-->
              <div class="platform-counts" aria-label="干扰设备类型覆盖">
                <el-tag type="primary">设备 {{ draft.config.jammers.length }}</el-tag>
                <el-tag :type="jammerTypeCount === 3 ? 'success' : 'info'">已配置 {{ jammerTypeCount }} / 3 种手段</el-tag>
              </div>
              <div class="platform-actions">
                <el-switch :model-value="draft.config.jammingEnabled ?? false" :disabled="pending || draft.locked" active-text="干扰总开关"
                  aria-label="干扰总开关" data-testid="jamming-enabled" @update:model-value="setJammingEnabled" />
                <el-button type="primary" :disabled="pending || draft.locked || !hasJammerPlatform" data-testid="add-jammer" @click="openNewJammer">新增干扰设备</el-button>
                <small v-if="!hasJammerPlatform" data-testid="jammer-node-required">请先在节点配置中新增干扰节点。</small>
              </div>
            </div>
            <el-table v-if="activeTab === 'jammers'" :data="draft.config.jammers" stripe data-testid="jammer-table">
              <el-table-column v-if="showIds" prop="id" label="设备 ID" min-width="120" />
              <el-table-column v-else type="index" label="序号" width="60" />
              <el-table-column label="所属干扰节点" min-width="150"><template #default="{ row }">{{ scenarioPlatformLabel(draft.config.platforms, row.platformId, showIds) }}</template></el-table-column>
              <el-table-column label="干扰样式" width="100">
                <template #default="{ row }">
                  <el-tag size="small" effect="plain" :type="jammerTypeTagType(row.type)">{{ jammerTypeLabel(row.type) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="干扰频段" min-width="210">
                <template #default="{ row }">
                  <template v-if="readJammerBands(row).length <= 1">
                    <div class="jammer-table__value">{{ readJammerBands(row)[0]?.frequency ?? row.frequency }} MHz</div>
                    <div class="jammer-table__sub">
                      带宽 {{ readJammerBands(row)[0]?.bandwidth ?? row.bandwidth }} MHz<template v-if="readJammerBands(row)[0]?.mode === 'SPOT'"> · 瞄准 {{ readJammerBands(row)[0]?.spotBandwidthMHz }} MHz</template><template v-else-if="readJammerBands(row)[0]?.mode === 'SWEEP'"> · 占空比 {{ readJammerBands(row)[0]?.sweepDutyCycle }}</template>
                    </div>
                  </template>
                  <div v-else class="jammer-table__bands">
                    <div v-for="(band, bandIndex) in readJammerBands(row)" :key="bandIndex" class="jammer-table__band">
                      <span class="jammer-table__value">{{ band.frequency }} MHz</span>
                      <span class="jammer-table__sub">/ {{ band.bandwidth }} MHz · {{ jammerTypeLabel(band.mode) }}<template v-if="band.mode === 'SPOT'">（{{ band.spotBandwidthMHz }} MHz）</template><template v-else-if="band.mode === 'SWEEP'">（{{ band.sweepDutyCycle }}）</template></span>
                    </div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="干扰功率" min-width="150">
                <template #default="{ row }">
                  <div class="jammer-table__value">{{ formatJammerPowerPrimary(row) }}</div>
                  <div class="jammer-table__sub">{{ formatJammerPowerDetail(row) }}</div>
                </template>
              </el-table-column>
              <el-table-column label="探测范围" min-width="135">
                <template #default="{ row }">
                  <div class="jammer-table__value">{{ formatKmCell(row.detectionRange) }} km</div>
                  <div class="jammer-table__sub">最小 {{ formatKmCell(row.detectionMinimumRange ?? 1000) }} km</div>
                </template>
              </el-table-column>
              <el-table-column label="干扰 / 释放范围" min-width="155">
                <template #default="{ row }">
                  <div class="jammer-table__value">干扰 {{ formatKmCell(row.jammingRange) }} km</div>
                  <div class="jammer-table__sub">释放 {{ formatKmCell(readJammerReleaseRange(row)) }} km</div>
                </template>
              </el-table-column>
              <el-table-column label="启用" width="76">
                <template #default="{ row }">
                  <el-switch :model-value="jammerExtension(row.id)?.enabled" :disabled="pending || draft.locked" :data-testid="`toggle-jammer-${row.id}`" @update:model-value="setJammerEnabled(row.id, $event)" />
                </template>
              </el-table-column>
              <el-table-column label="操作" width="110" fixed="right" align="center">
                <template #default="{ row, $index }">
                  <el-button link type="primary" :disabled="pending || draft.locked" :data-testid="`edit-jammer-${$index}`" @click="openJammerEditor(row, $index)">编辑</el-button>
                  <el-popconfirm title="确认删除该干扰设备？" confirm-button-text="删除" cancel-button-text="取消" @confirm="removeJammer(row, $index)">
                    <template #reference><el-button link type="danger" :disabled="pending || draft.locked" :data-testid="`delete-jammer-${$index}`">删除</el-button></template>
                  </el-popconfirm>
                </template>
              </el-table-column>
            </el-table>

          </section>
        </el-tab-pane>

        <!-- 传感器页已并入“干扰设备”：侦测（ESM）参数在干扰设备编辑框中配置；config.sensors 仅为兼容旧场景保留，不再提供编辑入口。 -->

      </el-tabs>

      <div v-if="!configurationTab" class="scenario-stage-content">
          <ValidationPanel
            v-if="activeTab === 'validation'"
            :pending="pending"
            :panel-state="panelState"
            :result-message="resultMessage"
            :validation="validation"
            :completed="validationCompleted"
            :config="draft?.config"
            @locate="locateValidationIssue"
          />
          <ScriptPreview
            v-if="activeTab === 'validation' && script !== null"
            :state="scriptState"
            :result-message="scriptResultMessage"
            :script="script"
            :preflight="preflight"
            :locked="draft?.locked ?? false"
            :dirty="dirty"
            :preflight-passed="preflight.valid"
            :output-path="scriptOutputPath"
            :generation-log="scriptGenerationLog"
            @preflight="scenarioStore.preflightScript"
          />
      </div>
    </el-form>

    <div v-else class="scenario-stage-content">
      <el-empty v-if="panelState === 'EMPTY'" description="暂无场景，请新建场景。" data-testid="scenario-empty">
        <el-button type="primary" data-testid="create-scenario" @click="createScenario">新建场景</el-button>
      </el-empty>
    </div>

    <ScriptPreviewDialog
      v-model="scriptPreviewVisible"
      :script="currentScriptPreview"
      :draft="draft"
      :receipt="scriptPreviewReceipt"
    />
    <ScriptGenerationReceipt
      ref="scriptGenerationDialog"
      v-model="scriptGenerationReceiptVisible"
      :receipt="scriptGenerationReceipt"
      :current-scene="draft ? { scenarioId: draft.config.scenario.id, revision: draft.revision, dirty } : null"
    />

    <el-dialog
      :model-value="detailPlatform !== null"
      class="scenario-dialog"
      title="节点详情"
      width="min(620px, calc(100vw - 2rem))"
      append-to-body
      destroy-on-close
      @update:model-value="!$event && (detailPlatformId = null)"
    >
      <div v-if="detailPlatform" data-testid="platform-details">
        <el-descriptions :column="1" border>
          <el-descriptions-item label="名称">{{ detailPlatform.name }}</el-descriptions-item>
          <el-descriptions-item v-if="showIds" label="节点 ID">{{ detailPlatform.id }}</el-descriptions-item>
          <el-descriptions-item label="节点类型">{{ platformTypeLabel(detailPlatform) }}</el-descriptions-item>
          <el-descriptions-item label="部署域">{{ deploymentDomainLabels[detailPlatform.category] }}</el-descriptions-item>
        </el-descriptions>
        <h4>关联资源</h4>
        <el-descriptions :column="1" border>
          <el-descriptions-item label="链路"><span data-testid="platform-link-ids">{{ showIds ? detailPlatform.linkIds.join('、') || '暂无关联链路' : `${detailPlatform.linkIds.length} 条关联链路` }}</span></el-descriptions-item>
          <el-descriptions-item label="传感器"><span data-testid="platform-sensor-ids">{{ detailPlatform.sensorIds.join('、') || '暂无关联传感器' }}</span></el-descriptions-item>
          <el-descriptions-item label="干扰器"><span data-testid="platform-jammer-ids">{{ showIds ? detailPlatform.jammerIds.join('、') || '暂无关联干扰设备' : `${detailPlatform.jammerIds.length} 台干扰设备` }}</span></el-descriptions-item>
        </el-descriptions>
      </div>
      <template #footer><el-button data-testid="close-platform-details" @click="detailPlatformId = null">关闭</el-button></template>
    </el-dialog>

    <PlatformEditorDialog
      :validate="validatePlatformFields"
      :show-ids="showIds"
      v-model="platformDialogVisible"
      :platform="platformEditor"
      :existing-nodes="otherPlatformNodes"
      :editing="editingPlatformIndex !== null"
      :error="platformEditorError"
      :pending="pending"
      :locked="draft?.locked ?? false"
      :business-type-options="businessTypeOptions"
      :supporting-type-options="supportingTypeOptions"
      :satellite-type-options="satelliteTypeOptions"
      :business-type-counts="businessNodeTypeCounts"
      :business-type-limits="INFORMATION_NODE_TYPE_LIMITS"
      :business-node-count="businessNodeCount"
      :suggest-platform-id="suggestPlatformId"
      :deployment-domain-labels="deploymentDomainLabels"
      @apply="applyPlatformEditor"
      @invalid="showEditorValidationMessage"
    />

    <LinkEditorDialog
      :validate="validateLinkFields"
      :show-ids="showIds"
      v-model="linkDialogVisible"
      :link="linkEditorLink"
      :editing="editingLinkIndex !== null"
      :error="linkEditorError"
      :pending="pending"
      :locked="draft?.locked ?? false"
      :platforms="draft?.config.platforms ?? []"
      :resolve-port-parameters="resolveEditorLinkPorts"
      :link-type-options="linkTypeOptions"
      :link-direction-labels="linkDirectionLabels"
      :minimum-step="LINK_MHZ_MINIMUM_STEP"
      :demand="linkBusiness"
      :parameter-catalog="scenarioStore.parameterCatalog"
      :parameter-catalog-state="scenarioStore.parameterCatalogState"
      :parameter-catalog-message="scenarioStore.parameterCatalogMessage"
      :reference-disabled="!draft || draft.revision === 0"
      @load-parameters="scenarioStore.loadParameterCatalog()"
      @close-parameters="scenarioStore.clearParameterCatalog()"
      @opened="focusValidationField(linkFocusPath)"
      @apply="applyLinkEditor"
      @frequency-input="trackLinkFrequencyInput"
      @bandwidth-input="trackLinkBandwidthInput"
    />

    <el-dialog
      v-model="portParametersVisible"
      class="scenario-dialog"
      title="端口参数设置"
      width="min(1680px, calc(100vw - 2rem))"
      top="5vh"
      destroy-on-close
      append-to-body
      data-testid="port-parameters-dialog"
      @opened="deviceFocusPath && focusValidationField(deviceFocusPath)"
      @closed="deviceFocusPath = ''; portParametersError = ''; portParametersWarning = ''"
    >
      <p class="field-hint">采用平台端口参数的链路会随此处更新。同一平台类型的节点共用一组端口参数。</p>
      <el-alert
        v-if="portParametersError"
        type="error"
        :closable="false"
        :title="portParametersError"
        show-icon
        data-testid="port-parameters-error"
        style="margin-bottom: 0.75rem"
      />
      <el-alert
        v-else-if="portParametersWarning"
        type="warning"
        :closable="false"
        :title="portParametersWarning"
        show-icon
        data-testid="port-parameters-warning"
        style="margin-bottom: 0.75rem"
      />
      <DeviceParametersPanel
        v-if="draft"
        ref="deviceParametersPanel"
        section="all"
        :model-value="draft.config.deviceParameters"
        :disabled="pending || draft.locked"
        :field-message="liveFieldMessage"
        @update:model-value="updatePortParameters"
      />
      <template #footer>
        <el-button type="primary" data-testid="close-port-parameters" @click="closePortParameters">完成</el-button>
      </template>
    </el-dialog>

    <JammerEditorDialog
      :validate="validateJammerFields"
      :show-ids="showIds"
      v-model="jammerDialogVisible"
      :jammer="jammerEditorJammer"
      :ui-extension="jammerEditorUiExtension"
      :editing="editingJammerIndex !== null"
      :error="jammerEditorError"
      :pending="pending"
      :locked="draft?.locked ?? false"
      :platforms="draft?.config.platforms ?? []"
      :links="draft?.config.links ?? []"
      :jammer-type-options="jammerTypeOptions"
      :minimum-step="LINK_MHZ_MINIMUM_STEP"
      @apply="applyJammerEditor"
      @opened="focusValidationField(jammerFocusPath)"
      @frequency-input="trackJammerFrequencyInput"
      @bandwidth-input="trackJammerBandwidthInput"
    />
  </section>
</template>

<style scoped>
.scenario-table-field { margin-bottom: 0; }
.scenario-table-field :deep(.el-form-item__error) { position: static; }

.scenario-page {
  display: flex;
  height: 100%;
  flex-direction: column;
  padding-right: 0;
  padding-left: 0;
  padding-top: 5px;
  padding-bottom: 5px;
  overflow: hidden;
}

.scenario-header,
.scenario-header__actions,
.scenario-workflow-bar,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.scenario-header {
  flex-wrap: wrap;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--console-border);
}

.scenario-header__actions .el-button + .el-button {
  margin-left: 0;
}

.scenario-workflow-bar {
  flex-wrap: wrap;
  justify-content: flex-end;
  padding: 0.75rem;
}

.scenario-stage-content {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 0 0.75rem 0.75rem;
}

.scenario-header__actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.scenario-header > .scenario-header__actions {
  margin-left: auto;
}

.scenario-feedback {
  margin-bottom: 1rem;
}

.scenario-form {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 0.5rem;
  overflow: hidden;
}

.scenario-validation-notices {
  flex: none;
  padding: 0 0.75rem;
}

.scenario-required-hint {
  flex: 1 1 20rem;
  margin: 0;
  color: var(--console-text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.scenario-validation-notices .el-alert {
  color: var(--console-danger);
  background: color-mix(in srgb, var(--console-danger) 10%, var(--console-surface));
}

.scenario-tabs {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column
}

.scenario-tabs :deep(.el-tabs__header) {
  flex: none;
}

.scenario-tabs--navigation-only {
  flex: none;
}

.scenario-tabs--navigation-only :deep(.el-tabs__content) {
  display: none;
}

.scenario-tabs :deep(.el-tabs__content) {
  min-height: 0;
  flex: 1;
}

.scenario-tabs :deep(.el-tab-pane) {
  display: grid;
  height: 100%;
  gap: 1rem;
  overflow: auto;
  padding: 0 10px;
}

.scenario-tabs :deep(.el-tabs__item) {
  height: 40px;
  justify-content: center;
  padding: 0 1rem;
  border-radius: 6px 6px 0 0;
  font-weight: 600;
}

.scenario-tabs :deep(.el-tabs__nav .el-tabs__item:nth-child(2)),
.scenario-tabs :deep(.el-tabs__nav .el-tabs__item:last-child) {
  padding-right: 1rem;
  padding-left: 1rem;
}

.scenario-tabs :deep(.el-tabs__item.is-active) {
  background: color-mix(in srgb, var(--console-cyan) 10%, transparent);
}

.scenario-section {
  /* Grid 子项须允许收缩，表格的整数列宽不能反向撑大页签。 */
  min-width: 0;
  padding: 1.1rem;
}

.scenario-link-pagination {
  margin-top: 0.75rem;
}

.section-heading {
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--console-border);
}

.section-heading h3,
.section-kicker {
  margin: 0;
}

.section-kicker {
  margin-bottom: 0.25rem;
  color: var(--console-cyan);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}


.form-grid {
  display: grid;
  gap: 0 0.75rem;
}

.form-grid--basic {
  grid-template-columns: minmax(0, 2fr) repeat(4, minmax(0, 1fr));
}

.form-grid--scenario {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.form-grid--scenario :deep(.el-form-item) {
  display: grid;
  width: 100%;
  max-width: none;
  margin-bottom: 0.75rem;
  align-items: start;
  grid-template-columns: 7.5rem minmax(0, 1fr);
}

.form-grid--scenario :deep(.el-form-item__label) {
  display: flex;
  width: 100%;
  height: 2rem;
  align-items: center;
  justify-content: flex-end;
  margin: 0;
  padding-right: 0.375rem;
  line-height: 2rem;
  text-align: right;
  white-space: nowrap;
}

.form-grid--scenario :deep(.el-form-item__content) {
  min-width: 0;
}

.scenario-form :deep(.el-input-number) {
  width: 100%;
}

.scenario-start-time,
.scenario-start-time :deep(.el-date-editor) {
  width: 100%;
}

.platform-counts,
.platform-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.platform-counts,
.platform-actions {
  flex-wrap: wrap;
}

.platform-actions {
  margin-top: 1rem;
}

.section-heading .platform-actions {
  margin-top: 0;
}

.scenario-page :deep(.el-table .el-input-number) {
  width: 100%;
}


.sensor-direction-editor {
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr);
  gap: 0.5rem;
}

.multipath-field :deep(.el-form-item__content) {
  min-height: 32px;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.sea-area-button {
  margin-left: 0.25rem;
}

.sea-area-summary {
  color: var(--console-text-muted);
  font-size: 0.75rem;
}

.field-hint--hidden { visibility: hidden; }
.field-hint--single-line { white-space: nowrap; }
:deep(.el-form-item.is-error:has(.field-hint--hidden) .el-form-item__error) { transform: translateY(-1.5em); }
.field-hint {
  width: 100%;
  color: var(--console-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.environment-section {
  margin-top: 1rem;
}

.environment-section__title {
  margin: 0 0 0.75rem;
  font-size: 0.875rem;
}

.environment-group__title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0.75rem 0 0.5rem;
  color: var(--console-cyan);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
}

.environment-group__title::after {
  flex: 1;
  border-top: 1px solid var(--console-border);
  content: '';
}

.environment-section :deep(.el-select) {
  width: 100%;
}

/* 文档字段名较长，加宽标签列，避免不换行标签溢出。 */
.environment-section .form-grid--scenario :deep(.el-form-item) {
  grid-template-columns: 10.5rem minmax(0, 1fr);
}

.jammer-table__value {
  color: var(--console-text);
  font-size: 13px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}

.jammer-table__sub {
  margin-top: 2px;
  color: var(--console-text-muted);
  font-size: 12px;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
}

.jammer-table__bands {
  display: grid;
  gap: 2px;
}

.jammer-table__band {
  display: flex;
  align-items: baseline;
  gap: 4px;
  white-space: nowrap;
}

.jammer-table__band .jammer-table__sub {
  margin-top: 0;
}

@media (max-width: 960px) {
  .scenario-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .scenario-header__actions {
    justify-content: flex-start;
  }

  .form-grid--basic,
  .form-grid--scenario {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .form-grid--basic,
  .form-grid--scenario,
  .validation-issue {
    grid-template-columns: 1fr;
  }

  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }

}
</style>
