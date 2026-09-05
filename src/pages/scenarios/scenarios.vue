<script setup lang="ts">
import { computed, nextTick, onMounted, ref, toRaw, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessageBox } from 'element-plus'
import type { CapabilityState, InformationDemand, Jammer, JammerUiExtension, Link, LinkType, Platform, PlatformType, ScenarioConfig, ScenarioTemplate, SensorUiExtension, ValidationIssue } from '../../contracts/domain-models'
import {
  BUSINESS_INFORMATION_NODE_TYPES,
  JAMMER_TYPES,
  LINK_MHZ_MINIMUM_STEP,
  LINK_TYPES,
  SUPPORTING_ENTITY_TYPES,
  inspectScenarioConfig,
  inspectScenarioUiExtensions,
  isBusinessInformationNodeType,
} from '../../features/scenarios/scenario-validation'
import { JAMMER_TYPE_LABELS, LINK_TYPE_LABELS, PLATFORM_TYPE_LABELS } from '../../features/situation/situation-model'
import { useScenarioStore } from '../../stores/scenario'
import ScriptPreview from '../../components/scenarios/ScriptPreview.vue'
import TemplateLibrary from '../../components/scenarios/TemplateLibrary.vue'
import ValidationPanel from '../../components/scenarios/ValidationPanel.vue'
import PlatformEditorDialog from '../../components/scenarios/PlatformEditorDialog.vue'
import LinkEditorDialog from '../../components/scenarios/LinkEditorDialog.vue'
import JammerEditorDialog from '../../components/scenarios/JammerEditorDialog.vue'

const scenarioStore = useScenarioStore()
const {
  draft,
  dirty,
  panelState,
  resultCode,
  resultMessage,
  validation,
  templates,
  selectedTemplate,
  templateState,
  templateResultMessage,
  lastConfirmation,
  script,
  scriptState,
  scriptResultMessage,
  preflight,
} = storeToRefs(scenarioStore)
const activeTab = ref('scenario')
const platformDialogVisible = ref(false)
const editingPlatformIndex = ref<number | null>(null)
const platformEditor = ref<Platform | null>(null)
const platformEditorError = ref('')
const platformFeedback = ref('')
const linkDialogVisible = ref(false)
const editingLinkIndex = ref<number | null>(null)
const linkEditorLink = ref<Link | null>(null)
const linkEditorError = ref('')
const linkFeedback = ref('')
const linkFeedbackStatus = ref<'success' | 'error'>('success')
const linkFrequencyBelowMinimum = ref(false)
const linkBandwidthBelowMinimum = ref(false)
const jammerDialogVisible = ref(false)
const editingJammerIndex = ref<number | null>(null)
const jammerEditorJammer = ref<Jammer | null>(null)
const jammerEditorUiExtension = ref<JammerUiExtension | null>(null)
const jammerEditorError = ref('')
const jammerFeedback = ref('')
const jammerFeedbackStatus = ref<'success' | 'error'>('success')
const jammerFrequencyBelowMinimum = ref(false)
const jammerBandwidthBelowMinimum = ref(false)
const sceneOperationFeedback = ref('')

const deploymentDomainLabels = {
  ground: '地面',
  air: '空中',
  space: '天基',
} as const
const businessTypeOptions = BUSINESS_INFORMATION_NODE_TYPES.map((value) => ({ value, label: PLATFORM_TYPE_LABELS[value] }))
const supportingTypeOptions = SUPPORTING_ENTITY_TYPES.map((value) => ({ value, label: PLATFORM_TYPE_LABELS[value] }))
const linkTypeOptions = LINK_TYPES.map((value) => ({ value, label: LINK_TYPE_LABELS[value] }))
const linkDirectionLabels = { FORWARD: '正向', REVERSE: '反向' } as const
const jammerTypeOptions = JAMMER_TYPES.map((value) => ({ value, label: JAMMER_TYPE_LABELS[value] }))

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
const supportingEntityCount = computed(() => (draft.value?.config.platforms.length ?? 0) - businessNodeCount.value)
const linkTypeCount = computed(() => new Set(draft.value?.config.links.map((link) => link.type) ?? []).size)
const jammerTypeCount = computed(() => new Set(draft.value?.config.jammers.map((jammer) => jammer.type) ?? []).size)
const validationCompleted = computed(() => resultCode.value.startsWith('VALIDATION_'))
const templatePending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(templateState.value))

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
function issueMessage(fieldPath: string): string {
  return validation.value.errors.find((issue) => issue.fieldPath === fieldPath)?.message ?? ''
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
 * 生成当前场景内未占用的平台 ID。
 * @param prefix 业务节点或支撑实体使用的 ID 前缀。
 * @returns 首个未被使用的三位序号 ID。
 * @remarks 只读取当前草稿，不修改平台集合。
 */
function nextPlatformId(prefix: 'PLAT-' | 'SUP-'): string {
  const ids = new Set(draft.value?.config.platforms.map((platform) => platform.id) ?? [])
  let index = 1
  while (ids.has(`${prefix}${String(index).padStart(3, '0')}`)) index += 1
  return `${prefix}${String(index).padStart(3, '0')}`
}

/**
 * 打开新增场景实体对话框。
 * @param classification 新实体属于业务信息节点还是支撑实体。
 * @returns 无返回值。
 * @sideEffects 达到容量上限时只显示中文提示；否则创建独立编辑副本并打开对话框。
 */
function openNewPlatform(classification: 'business' | 'supporting'): void {
  if (draft.value === null) return
  if (classification === 'business' && businessNodeCount.value >= 50) {
    platformFeedback.value = '业务信息节点已达 50 个，不能继续新增。'
    return
  }
  const business = classification === 'business'
  const id = nextPlatformId(business ? 'PLAT-' : 'SUP-')
  editingPlatformIndex.value = null
  platformEditor.value = {
    id,
    name: business ? `新增业务信息节点 ${id}` : `新增支撑实体 ${id}`,
    type: business ? 'REAR_COMMAND_NODE' : 'COMMUNICATION_SATELLITE',
    category: business ? 'ground' : 'space',
    initialPosition: { longitude: 0, latitude: 0, altitude: business ? 0 : 550000 },
    waypoints: [],
    linkIds: [],
    sensorIds: [],
    jammerIds: [],
  }
  platformEditorError.value = ''
  platformFeedback.value = ''
  platformDialogVisible.value = true
}

/**
 * 打开现有场景实体编辑对话框。
 * @param platform 需要编辑的平台数据。
 * @param index 平台在当前草稿集合中的位置。
 * @returns 无返回值。
 * @sideEffects 记录待编辑平台；对话框负责创建独立编辑副本。
 */
function openPlatformEditor(platform: Platform, index: number): void {
  editingPlatformIndex.value = index
  platformEditor.value = platform
  platformEditorError.value = ''
  platformFeedback.value = ''
  platformDialogVisible.value = true
}

/**
 * 将平台编辑副本写入当前场景草稿。
 * @param editor 由平台编辑弹窗提交的独立编辑副本。
 * @returns 校验并写入成功时返回 `true`，否则返回 `false`。
 * @sideEffects 成功时新增或替换一个平台、标记草稿未保存并关闭对话框。
 */
function applyPlatformEditor(editor: Platform): boolean {
  if (draft.value === null) return false
  editor.id = editor.id.trim()
  editor.name = editor.name.trim()
  if (editor.id === '' || editor.name === '') {
    platformEditorError.value = '场景实体 ID 和名称均为必填项。'
    return false
  }
  const candidate = structuredClone(toRaw(draft.value.config))
  const editedPlatform = structuredClone(toRaw(editor))
  if (editingPlatformIndex.value === null) candidate.platforms.push(editedPlatform)
  else candidate.platforms[editingPlatformIndex.value] = editedPlatform
  const issue = inspectScenarioConfig(candidate).result.errors.find((item) => (
    item.fieldPath.startsWith('platforms') || item.code === 'PLATFORM_REFERENCE_NOT_FOUND'
  ))
  if (issue !== undefined) {
    platformEditorError.value = issue.message
    return false
  }

  draft.value.config.platforms = candidate.platforms
  markDirty()
  platformDialogVisible.value = false
  platformFeedback.value = editingPlatformIndex.value === null ? '场景实体已新增，保存草稿后生效。' : '场景实体已更新，保存草稿后生效。'
  return true
}

/**
 * 删除未被其他配置引用的场景实体。
 * @param platform 需要删除的平台。
 * @param index 平台在当前草稿集合中的位置。
 * @returns 删除成功时返回 `true`，被容量或引用规则阻止时返回 `false`。
 * @sideEffects 成功时从草稿移除平台并设置未保存标记；失败时草稿保持不变。
 */
function removePlatform(platform: Platform, index: number): boolean {
  if (draft.value === null) return false
  if (isBusinessInformationNodeType(platform.type) && businessNodeCount.value <= 1) {
    platformFeedback.value = '场景至少需要保留一个业务信息节点。'
    return false
  }
  const config = draft.value.config
  const referenced = config.links.some((link) => link.sourcePlatformId === platform.id || link.targetPlatformId === platform.id)
    || config.jammers.some((jammer) => jammer.platformId === platform.id)
    || config.sensors.some((sensor) => sensor.platformId === platform.id)
    || config.informationDemand.some((demand) => demand.sourcePlatformId === platform.id || demand.destinationPlatformIds.includes(platform.id))
  if (referenced) {
    platformFeedback.value = '该场景实体仍被链路、设备或信息需求引用，不能删除。'
    return false
  }
  config.platforms.splice(index, 1)
  markDirty()
  platformFeedback.value = '场景实体已删除，保存草稿后生效。'
  return true
}

/**
 * 读取平台类型的中文业务名称。
 * @param type 场景实体类型枚举值。
 * @returns 对应的文档中文名称。
 * @remarks 只读取既有类型映射。
 */
function platformTypeLabel(type: PlatformType): string {
  return PLATFORM_TYPE_LABELS[type]
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
 * @sideEffects 场景实体不足两个时显示中文提示；否则创建独立编辑副本并打开对话框。
 */
function openNewLink(): void {
  if (draft.value === null) return
  if (draft.value.config.platforms.length < 2) {
    linkFeedback.value = '至少需要两个场景实体才能新增链路。'
    linkFeedbackStatus.value = 'error'
    return
  }
  linkEditorLink.value = {
    id: nextLinkId(),
    type: 'MICROWAVE',
    sourcePlatformId: draft.value.config.platforms[0]!.id,
    targetPlatformId: draft.value.config.platforms[1]!.id,
    frequency: 4500,
    bandwidth: 20,
    txPower: 50,
    antennaGain: { tx: 10, rx: 10 },
    modulation: 'QPSK',
    berThreshold: 0.00001,
    dataRate: 10,
    direction: 'FORWARD',
  }
  editingLinkIndex.value = null
  linkEditorError.value = ''
  linkFeedback.value = ''
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
  linkEditorLink.value = link
  editingLinkIndex.value = index
  linkEditorError.value = ''
  linkFeedback.value = ''
  resetLinkMinimumAttempts()
  linkDialogVisible.value = true
}

/**
 * 根据链路端点同步平台反向关联。
 * @param config 待同步的完整场景配置副本。
 * @param linkId 新增、更新或删除的链路 ID。
 * @returns 无返回值。
 * @sideEffects 先从所有平台移除该 ID，再为当前链路的源端和目标端补回关联。
 */
function synchronizePlatformLinkIds(config: ScenarioConfig, linkId: string): void {
  config.platforms.forEach((platform) => {
    platform.linkIds = platform.linkIds.filter((id) => id !== linkId)
  })
  const link = config.links.find((item) => item.id === linkId)
  if (link === undefined) return
  new Set([link.sourcePlatformId, link.targetPlatformId]).forEach((platformId) => {
    const platform = config.platforms.find((item) => item.id === platformId)
    if (platform !== undefined) platform.linkIds.push(linkId)
  })
}

/**
 * 将链路编辑副本写入当前场景草稿。
 * @returns 校验并写入成功时返回 `true`，否则返回 `false`。
 * @sideEffects 成功时同步端点平台关联、标记未保存并关闭对话框。
 */
function applyLinkEditor(linkEditor: Link): boolean {
  if (draft.value === null) return false
  if (linkFrequencyBelowMinimum.value) {
    linkEditorError.value = '链路频率必须大于 0 MHz。'
    return false
  }
  if (linkBandwidthBelowMinimum.value) {
    linkEditorError.value = '链路带宽必须大于 0 MHz。'
    return false
  }
  linkEditor.id = linkEditor.id.trim()
  if (linkEditor.id === '') {
    linkEditorError.value = '链路 ID 为必填项。'
    return false
  }
  const candidate = structuredClone(toRaw(draft.value.config))
  const editedLink = structuredClone(toRaw(linkEditor))
  if (editingLinkIndex.value === null) candidate.links.push(editedLink)
  else candidate.links[editingLinkIndex.value] = editedLink
  synchronizePlatformLinkIds(candidate, editedLink.id)
  const issue = inspectScenarioConfig(candidate).result.errors.find((item) => (
    item.fieldPath.startsWith('links') || item.fieldPath.endsWith('.linkIds')
  ))
  if (issue !== undefined) {
    linkEditorError.value = issue.message
    return false
  }

  draft.value.config.links = candidate.links
  draft.value.config.platforms = candidate.platforms
  markDirty()
  linkDialogVisible.value = false
  linkFeedback.value = editingLinkIndex.value === null ? '链路已新增，保存草稿后生效。' : '链路已更新，保存草稿后生效。'
  linkFeedbackStatus.value = 'success'
  return true
}

/**
 * 删除指定链路并清理平台反向关联。
 * @param link 需要删除的链路。
 * @param index 链路在当前草稿集合中的位置。
 * @returns 删除成功时返回 `true`。
 * @sideEffects 从草稿移除链路及所有对应平台关联，并设置未保存标记。
 */
function removeLink(link: Link, index: number): boolean {
  if (draft.value === null) return false
  const candidate = structuredClone(toRaw(draft.value.config))
  candidate.links.splice(index, 1)
  synchronizePlatformLinkIds(candidate, link.id)
  draft.value.config.links = candidate.links
  draft.value.config.platforms = candidate.platforms
  markDirty()
  linkFeedback.value = '链路已删除，保存草稿后生效。'
  linkFeedbackStatus.value = 'success'
  return true
}

/** 读取链路类型的中文名称。 */
function linkTypeLabel(type: LinkType): string {
  return LINK_TYPE_LABELS[type]
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

/**
 * 打开新增干扰设备对话框并填入可校验的默认参数。
 * @returns 无返回值。
 * @sideEffects 没有场景实体时显示中文提示；否则创建独立编辑副本并打开对话框。
 */
function openNewJammer(): void {
  const platform = draft.value?.config.platforms[0]
  if (platform === undefined) {
    jammerFeedback.value = '至少需要一个场景实体才能新增干扰设备。'
    jammerFeedbackStatus.value = 'error'
    return
  }
  jammerEditorJammer.value = {
    id: nextJammerId(),
    platformId: platform.id,
    type: 'BARRAGE',
    defaultPower: 50,
    frequency: 2200,
    bandwidth: 20,
    autoDetect: false,
    detectionRange: 100000,
  }
  jammerEditorUiExtension.value = { jammerId: jammerEditorJammer.value.id, direction: 0, duration: 60, enabled: true }
  editingJammerIndex.value = null
  jammerEditorError.value = ''
  jammerFeedback.value = ''
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
      ?? { jammerId: jammer.id, direction: 0, duration: 60, enabled: true }
  )
  editingJammerIndex.value = index
  jammerEditorError.value = ''
  jammerFeedback.value = ''
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
  if (jammerFrequencyBelowMinimum.value) {
    jammerEditorError.value = '干扰频率必须大于 0 MHz。'
    return false
  }
  if (jammerBandwidthBelowMinimum.value) {
    jammerEditorError.value = '干扰带宽必须大于 0 MHz。'
    return false
  }
  jammerEditor.id = jammerEditor.id.trim()
  if (jammerEditor.id === '') {
    jammerEditorError.value = '干扰设备 ID 为必填项。'
    return false
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
  const issue = [
    ...inspectScenarioConfig(candidate).result.errors,
    ...inspectScenarioUiExtensions(candidateExtensions, candidate.jammers.map((jammer) => jammer.id)).result.errors,
  ].find((item) => (
    item.fieldPath.startsWith('jammers') || item.fieldPath.endsWith('.jammerIds')
      || item.fieldPath.startsWith('uiExtensions.jammers')
  ))
  if (issue !== undefined) {
    jammerEditorError.value = issue.message
    return false
  }

  draft.value.config.jammers = candidate.jammers
  draft.value.config.platforms = candidate.platforms
  draft.value.uiExtensions.jammers = candidateExtensions.jammers
  markDirty()
  jammerDialogVisible.value = false
  jammerFeedback.value = editingJammerIndex.value === null ? '干扰设备已新增，保存草稿后生效。' : '干扰设备已更新，保存草稿后生效。'
  jammerFeedbackStatus.value = 'success'
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
  jammerFeedback.value = '干扰设备已删除，保存草稿后生效。'
  jammerFeedbackStatus.value = 'success'
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
  draft.value.uiExtensions.sensors.push({ sensorId, type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true })
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

/** 新增一条完整的信息需求默认记录。 */
function addInformationDemand(): void {
  if (draft.value === null || draft.value.config.platforms.length < 2) return
  const platforms = draft.value.config.platforms
  const demand: InformationDemand = {
    id: nextInformationDemandId(),
    sourcePlatformId: platforms[0]!.id,
    destinationPlatformIds: [platforms[1]!.id],
    informationType: '态势信息',
    volumeMb: 1,
    frequencyHz: 1,
    priority: 'NORMAL',
    maxLatencyMs: 1000,
    minDataRateMbps: 1,
  }
  draft.value.config.informationDemand.push(demand)
  markDirty()
}

/** 删除指定信息需求。 */
function removeInformationDemand(index: number): void {
  draft.value?.config.informationDemand.splice(index, 1)
  markDirty()
}

/**
 * 读取规范字段路径对应的页面输入标识。
 * @param fieldPath 校验结果中的规范字段路径。
 * @returns 可聚焦输入的测试标识；集合级问题没有单一输入时返回 `undefined`。
 * @remarks 只完成当前已开放编辑字段的直接映射。
 */
function validationTargetId(fieldPath: string): string | undefined {
  const directTargets: Record<string, string> = {
    'scenario.id': 'scenario-id',
    'scenario.name': 'scenario-name',
    'scenario.description': 'scenario-description',
    'scenario.startTime': 'scenario-start-time',
    'scenario.duration': 'scenario-duration',
    'scenario.timeStep': 'scenario-time-step',
    'scenario.environment.seaState': 'scenario-sea-state',
    'scenario.environment.temperatureC': 'scenario-temperature',
    'scenario.environment.humidityPercent': 'scenario-humidity',
    'scenario.environment.rainRateMmPerHour': 'scenario-rain-rate',
    'scenario.environment.rainLossDbPerKm': 'scenario-rain-loss',
    'scenario.environment.multipathEnabled': 'scenario-multipath',
    'output.directory': 'output-directory',
    'output.writeInterval': 'output-write-interval',
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
  const platformIndex = Number(/^platforms\[(\d+)\]/.exec(issue.fieldPath)?.[1])
  const linkIndex = Number(/^links\[(\d+)\]/.exec(issue.fieldPath)?.[1])
  const jammerIndex = Number(/^(?:jammers|uiExtensions\.jammers)\[(\d+)\]/.exec(issue.fieldPath)?.[1])

  if (issue.fieldPath.startsWith('platforms')) activeTab.value = 'platforms'
  else if (issue.fieldPath.startsWith('links')) activeTab.value = 'links'
  else if (issue.fieldPath.startsWith('jammers') || issue.fieldPath.startsWith('uiExtensions.jammers')) activeTab.value = 'jammers'
  else if (issue.fieldPath.startsWith('sensors') || issue.fieldPath.startsWith('uiExtensions.sensors')
    || issue.fieldPath.startsWith('output') || issue.fieldPath.startsWith('informationDemand')) activeTab.value = 'data'
  else activeTab.value = 'scenario'
  await nextTick()

  if (Number.isInteger(platformIndex) && draft.value?.config.platforms[platformIndex] !== undefined) {
    openPlatformEditor(draft.value.config.platforms[platformIndex], platformIndex)
    platformEditorError.value = issue.message
  } else if (Number.isInteger(linkIndex) && draft.value?.config.links[linkIndex] !== undefined) {
    openLinkEditor(draft.value.config.links[linkIndex], linkIndex)
    linkEditorError.value = issue.message
  } else if (Number.isInteger(jammerIndex) && draft.value?.config.jammers[jammerIndex] !== undefined) {
    openJammerEditor(draft.value.config.jammers[jammerIndex], jammerIndex)
    jammerEditorError.value = issue.message
  }
  await nextTick()
  focusValidationField(issue.fieldPath)
}

/**
 * 执行当前草稿的整体校验并展示结果页签。
 * @returns 校验请求结束后无返回值。
 * @sideEffects 切换到整体校验页签并调用场景 Store；不修改草稿内容。
 */
async function validateScenario(): Promise<void> {
  activeTab.value = 'validation'
  await scenarioStore.validateScenario()
}

/**
 * 重新加载确定性场景草稿。
 * @returns 加载流程结束后兑现且不返回值的 Promise。
 * @sideEffects 调用场景 Store，并以服务端草稿替换当前页面数据。
 */
async function loadScenario(): Promise<void> {
  await scenarioStore.loadScenario()
}

/**
 * 保存当前场景草稿并同步平台区域反馈。
 * @returns 保存流程结束后兑现且不返回值的 Promise。
 * @sideEffects 调用场景 Store；成功时把平台区域提示更新为已保存状态。
 */
async function saveScenario(): Promise<void> {
  if (await scenarioStore.saveScenario()) {
    platformFeedback.value = '场景草稿已保存。'
    linkFeedback.value = '场景草稿已保存。'
    linkFeedbackStatus.value = 'success'
    jammerFeedback.value = '场景草稿已保存。'
    jammerFeedbackStatus.value = 'success'
  }
}

/** 粘贴并导入完整场景快照；不访问模板库或全局 Mock 重置。 */
async function importScenarioSnapshot(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('粘贴一个完整 ScenarioConfig 规范快照。UI 扩展将按规则重建。', '导入场景规范快照', {
      confirmButtonText: '导入场景',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '{ "schemaVersion": "1.0", ... }',
      inputValidator: (text) => text.trim() !== '' || '请输入场景快照 JSON。',
    })
    if (await scenarioStore.importScenarioSnapshot(value)) sceneOperationFeedback.value = scenarioStore.resultMessage
  } catch {
    // 用户取消时保持当前场景不变。
  }
}

/** 二次确认后撤销最近一次已持久化场景操作。 */
async function undoScenario(): Promise<void> {
  try {
    await ElMessageBox.confirm('撤销最近一次场景保存、导入或重置操作？', '撤销场景操作', {
      confirmButtonText: '撤销', cancelButtonText: '取消', type: 'warning',
    })
    if (await scenarioStore.undoScenario()) sceneOperationFeedback.value = scenarioStore.resultMessage
  } catch {
    // 用户取消时保持当前场景不变。
  }
}

/** 二次确认后将当前场景恢复为初始快照。 */
async function resetScenario(): Promise<void> {
  try {
    await ElMessageBox.confirm('重置当前场景的全部参数？该操作完成后仍可撤销。', '重置场景', {
      confirmButtonText: '重置场景', cancelButtonText: '取消', type: 'warning',
    })
    if (await scenarioStore.resetScenario()) sceneOperationFeedback.value = scenarioStore.resultMessage
  } catch {
    // 用户取消时保持当前场景不变。
  }
}

/** 生成脚本预览；遇到 WARNING 时只在本次确认后继续。 */
async function generateScriptPreview(): Promise<void> {
  if (await scenarioStore.generateScriptPreview()) return
  if (scenarioStore.scriptResultCode !== 'CONFIRMATION_REQUIRED') return
  try {
    await ElMessageBox.confirm(`${scenarioStore.scriptResultMessage} 是否继续生成？`, '脚本预览警告', {
      confirmButtonText: '本次继续', cancelButtonText: '取消', type: 'warning',
    })
    await scenarioStore.generateScriptPreview(true)
  } catch {
    // 用户取消后不创建一次性确认上下文。
  }
}

/**
 * 将模板应用为当前临时工作场景。
 * @param template 待应用模板。
 * @returns 操作结束后无返回值。
 * @sideEffects 确认名称后替换当前临时场景草稿。
 */
async function applyTemplate(template: ScenarioTemplate): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('应用后将替换当前临时工作场景。', '应用场景模板', {
      confirmButtonText: '应用',
      cancelButtonText: '取消',
      inputValue: `${template.name} 场景`,
      inputValidator: (name) => name.trim() !== '' || '请输入临时场景名称。',
    })
    await scenarioStore.copyTemplate(template.templateId, value)
  } catch {
    // 用户取消应用时保持工作草稿不变。
  }
}

onMounted(() => {
  if (draft.value === null) void loadScenario()
})

watch(activeTab, (tab) => {
  if (tab === 'templates' && templateState.value === 'EMPTY' && templates.value.length === 0) {
    void scenarioStore.loadTemplates()
  }
})
</script>

<template>
  <section class="page scenario-page" aria-label="场景配置">
    <header class="scenario-header" aria-label="场景操作">
      <div class="scenario-header__actions">
        <el-tag :type="panelState === 'ERROR' ? 'danger' : dirty ? 'warning' : 'success'">
          {{ dirty ? '未保存' : stateLabels[panelState] }}
        </el-tag>
        <span v-if="draft" class="console-chip">修订 {{ draft.revision }}</span>
        <el-button v-if="panelState === 'ERROR' && !dirty" :loading="pending" @click="loadScenario">
          重新加载
        </el-button>
        <el-button
          :disabled="draft === null"
          :loading="pending && activeTab === 'validation'"
          data-testid="validate-scenario"
          @click="validateScenario"
        >
          整体校验
        </el-button>
        <el-button
          type="primary"
          :disabled="draft === null || draft?.locked || !dirty"
          :loading="pending"
          data-testid="save-scenario"
          @click="saveScenario"
        >
          保存草稿
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="panelState === 'ERROR' && activeTab !== 'validation'"
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
    >
      <el-tabs v-model="activeTab" class="scenario-tabs">
        <el-tab-pane label="场景基础" name="scenario">
      <section class="console-panel scenario-section" aria-labelledby="scenario-basic-title">
       <div class="section-heading">
         <div>
           <p class="section-kicker">基础信息</p>
           <h3 id="scenario-basic-title">场景标识</h3>
         </div>
       </div>
        <div class="form-grid form-grid--basic form-grid--scenario-identity">
          <el-form-item label="场景编号" :error="issueMessage('scenario.id')">
            <el-input v-model="draft.config.scenario.id" disabled data-testid="scenario-id" />
          </el-form-item>
          <el-form-item label="场景名称" :error="issueMessage('scenario.name')">
            <el-input
              v-model="draft.config.scenario.name"
              maxlength="128"
              data-testid="scenario-name"
              @update:model-value="markDirty"
            />
          </el-form-item>
          <el-form-item class="form-grid__wide" label="场景描述" :error="issueMessage('scenario.description')">
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
        <div class="section-heading">
          <div>
            <p class="section-kicker">时序参数</p>
            <h3 id="scenario-timing-title">仿真时间</h3>
          </div>
        </div>
        <div class="form-grid form-grid--timing">
          <el-form-item label="开始时间" :error="issueMessage('scenario.startTime')">
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
          <el-form-item label="仿真时长（秒）" :error="issueMessage('scenario.duration')">
            <el-input-number
                v-model="draft.config.scenario.duration"
                controls-position="right"
                data-testid="scenario-duration"
                @update:model-value="markDirty"
            />
          </el-form-item>
          <el-form-item label="时间步长（秒）" :error="issueMessage('scenario.timeStep')">
            <el-input-number
                v-model="draft.config.scenario.timeStep"
                controls-position="right"
                data-testid="scenario-time-step"
                @update:model-value="markDirty"
            />
          </el-form-item>
        </div>
        <div class="section-heading">
          <div>
            <p class="section-kicker">环境参数</p>
            <h3 id="scenario-environment-title">传播环境</h3>
          </div>
        </div>
        <div class="form-grid form-grid--environment">
          <el-form-item label="海况等级" :error="issueMessage('scenario.environment.seaState')">
            <el-input-number v-model="draft.config.scenario.environment.seaState" controls-position="right" data-testid="scenario-sea-state" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item label="温度（℃）" :error="issueMessage('scenario.environment.temperatureC')">
            <el-input-number v-model="draft.config.scenario.environment.temperatureC" controls-position="right" data-testid="scenario-temperature" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item label="相对湿度（%）" :error="issueMessage('scenario.environment.humidityPercent')">
            <el-input-number v-model="draft.config.scenario.environment.humidityPercent" controls-position="right" data-testid="scenario-humidity" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item label="降雨率（mm/h）" :error="issueMessage('scenario.environment.rainRateMmPerHour')">
            <el-input-number v-model="draft.config.scenario.environment.rainRateMmPerHour" controls-position="right" data-testid="scenario-rain-rate" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item label="雨衰（dB/km）" :error="issueMessage('scenario.environment.rainLossDbPerKm')">
            <el-input-number v-model="draft.config.scenario.environment.rainLossDbPerKm" controls-position="right" data-testid="scenario-rain-loss" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item class="multipath-field" label="多径效应">
            <el-switch
                v-model="draft.config.scenario.environment.multipathEnabled"
                inline-prompt
                active-text="启用"
                inactive-text="关闭"
                data-testid="scenario-multipath"
                @update:model-value="markDirty"
            />
          </el-form-item>
        </div>
      </section>
        </el-tab-pane>

        <el-tab-pane label="平台与航点" name="platforms">
          <section class="console-panel scenario-section" aria-labelledby="scenario-platform-title">
            <div class="section-heading">
<!--              <div>-->
<!--                <p class="section-kicker">平台与航点</p>-->
<!--                <h3 id="scenario-platform-title">场景实体配置</h3>-->
<!--              </div>-->
              <div class="platform-counts" aria-label="场景实体数量">
                <el-tag type="primary">业务信息节点 {{ businessNodeCount }} / 50</el-tag>
                <el-tag>支撑实体 {{ supportingEntityCount }}</el-tag>
              </div>
            </div>

            <el-alert
              v-if="platformFeedback"
              class="platform-feedback"
              :type="platformFeedback.includes('不能') || platformFeedback.includes('至少') ? 'error' : 'success'"
              :closable="false"
              :title="platformFeedback"
              show-icon
            />

            <el-table :data="draft.config.platforms" stripe data-testid="platform-table">
              <el-table-column prop="id" label="场景实体 ID" min-width="130" />
              <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip />
              <el-table-column label="分类" width="120">
                <template #default="{ row }">
                  {{ isBusinessInformationNodeType(row.type) ? '业务信息节点' : '支撑实体' }}
                </template>
              </el-table-column>
              <el-table-column label="场景实体类型" min-width="180">
                <template #default="{ row }">{{ platformTypeLabel(row.type) }}</template>
              </el-table-column>
              <el-table-column label="部署域" width="90">
                <template #default="{ row }">{{ deploymentDomainLabels[row.category] }}</template>
              </el-table-column>
              <el-table-column label="航点" width="70" align="center">
                <template #default="{ row }">{{ row.waypoints.length }}</template>
              </el-table-column>
              <el-table-column label="操作" fixed="right" width="140">
                <template #default="{ row, $index }">
                  <el-button link type="primary" :disabled="pending || draft.locked" :data-testid="`edit-platform-${$index}`" @click="openPlatformEditor(row, $index)">编辑</el-button>
                  <el-popconfirm title="确认删除该场景实体？" confirm-button-text="删除" cancel-button-text="取消" @confirm="removePlatform(row, $index)">
                    <template #reference><el-button link type="danger" :disabled="pending || draft.locked" :data-testid="`delete-platform-${$index}`">删除</el-button></template>
                  </el-popconfirm>
                </template>
              </el-table-column>
            </el-table>

            <div class="platform-actions">
              <el-button type="primary" :disabled="pending || draft.locked" data-testid="add-business-platform" @click="openNewPlatform('business')">新增业务信息节点</el-button>
              <el-button :disabled="pending || draft.locked" data-testid="add-supporting-platform" @click="openNewPlatform('supporting')">新增支撑实体</el-button>
            </div>
          </section>
        </el-tab-pane>

        <el-tab-pane label="链路配置" name="links">
          <section class="console-panel scenario-section" aria-labelledby="scenario-link-title">
            <div class="section-heading">
<!--              <div>-->
<!--                <p class="section-kicker">信息链路</p>-->
<!--                <h3 id="scenario-link-title">链路参数配置</h3>-->
<!--              </div>-->
              <div class="platform-counts" aria-label="链路类型覆盖">
                <el-tag type="primary">链路 {{ draft.config.links.length }}</el-tag>
                <el-tag :type="linkTypeCount === 4 ? 'success' : 'warning'">已配置 {{ linkTypeCount }} / 4 类</el-tag>
              </div>
            </div>

            <el-alert
              v-if="linkFeedback"
              class="platform-feedback"
              :type="linkFeedbackStatus"
              :closable="false"
              :title="linkFeedback"
              show-icon
            />

            <el-table :data="draft.config.links" stripe data-testid="link-table">
              <el-table-column prop="id" label="链路 ID" min-width="120" />
              <el-table-column label="类型" min-width="130"><template #default="{ row }">{{ linkTypeLabel(row.type) }}</template></el-table-column>
              <el-table-column prop="sourcePlatformId" label="源平台" min-width="120" />
              <el-table-column prop="targetPlatformId" label="目标平台" min-width="120" />
              <el-table-column prop="frequency" label="频率（MHz）" min-width="110" />
              <el-table-column prop="bandwidth" label="带宽（MHz）" min-width="110" />
              <el-table-column label="方向" width="80"><template #default="{ row }">{{ linkDirectionLabels[row.direction] }}</template></el-table-column>
              <el-table-column label="操作" fixed="right" width="140">
                <template #default="{ row, $index }">
                  <el-button link type="primary" :disabled="pending || draft.locked" :data-testid="`edit-link-${$index}`" @click="openLinkEditor(row, $index)">编辑</el-button>
                  <el-popconfirm title="确认删除该链路？" confirm-button-text="删除" cancel-button-text="取消" @confirm="removeLink(row, $index)">
                    <template #reference><el-button link type="danger" :disabled="pending || draft.locked" :data-testid="`delete-link-${$index}`">删除</el-button></template>
                  </el-popconfirm>
                </template>
              </el-table-column>
            </el-table>

            <div class="platform-actions">
              <el-button type="primary" :disabled="pending || draft.locked" data-testid="add-link" @click="openNewLink">新增链路</el-button>
            </div>
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
                <el-tag :type="jammerTypeCount === 2 ? 'success' : 'warning'">已配置 {{ jammerTypeCount }} / 2 类</el-tag>
              </div>
            </div>

            <el-alert
              v-if="jammerFeedback"
              class="platform-feedback"
              :type="jammerFeedbackStatus"
              :closable="false"
              :title="jammerFeedback"
              show-icon
            />

            <el-table :data="draft.config.jammers" stripe data-testid="jammer-table">
              <el-table-column prop="id" label="设备 ID" min-width="130" />
              <el-table-column label="类型" ><template #default="{ row }">{{ jammerTypeLabel(row.type) }}</template></el-table-column>
              <el-table-column prop="platformId" label="归属平台"/>
              <el-table-column prop="frequency" label="频率（MHz）" />
              <el-table-column prop="bandwidth" label="带宽（MHz）" />
              <el-table-column prop="defaultPower" label="默认功率（W）"  />
              <el-table-column label="自动检测"><template #default="{ row }">{{ row.autoDetect ? '开启' : '关闭' }}</template></el-table-column>
              <el-table-column prop="detectionRange" label="检测范围（m）"/>
              <el-table-column label="方向（°）" ><template #default="{ row }">{{ jammerExtension(row.id)?.direction }}</template></el-table-column>
              <el-table-column label="持续时间（s）" ><template #default="{ row }">{{ jammerExtension(row.id)?.duration }}</template></el-table-column>
              <el-table-column label="启用">
                <template #default="{ row }">
                  <el-switch :model-value="jammerExtension(row.id)?.enabled" :disabled="pending || draft.locked" :data-testid="`toggle-jammer-${row.id}`" @update:model-value="setJammerEnabled(row.id, $event)" />
                </template>
              </el-table-column>
              <el-table-column label="操作" fixed="right" width="140">
                <template #default="{ row, $index }">
                  <el-button link type="primary" :disabled="pending || draft.locked" :data-testid="`edit-jammer-${$index}`" @click="openJammerEditor(row, $index)">编辑</el-button>
                  <el-popconfirm title="确认删除该干扰设备？" confirm-button-text="删除" cancel-button-text="取消" @confirm="removeJammer(row, $index)">
                    <template #reference><el-button link type="danger" :disabled="pending || draft.locked" :data-testid="`delete-jammer-${$index}`">删除</el-button></template>
                  </el-popconfirm>
                </template>
              </el-table-column>
            </el-table>

            <div class="platform-actions">
              <el-button type="primary" :disabled="pending || draft.locked" data-testid="add-jammer" @click="openNewJammer">新增干扰设备</el-button>
            </div>
          </section>
        </el-tab-pane>

        <el-tab-pane label="传感器与输出" name="data">
          <section class="console-panel scenario-section" aria-labelledby="scenario-sensor-title">
            <div class="section-heading">
<!--              <div>-->
<!--                <p class="section-kicker">探测配置</p>-->
<!--                <h3 id="scenario-sensor-title">传感器</h3>-->
<!--              </div>-->
              <el-tag type="primary">{{ draft.config.sensors.length }} 个</el-tag>
            </div>
            <el-table :data="draft.config.sensors" stripe data-testid="sensor-table">
              <el-table-column prop="id" label="传感器 ID"/>
              <el-table-column label="类型"><template #default>ESM</template></el-table-column>
              <el-table-column label="归属平台" min-width="160">
                <template #default="{ row, $index }"><el-select v-model="row.platformId" :data-testid="`sensor-platform-${$index}`" @change="synchronizeAllSensorIds"><el-option v-for="platform in draft.config.platforms" :key="platform.id" :label="platform.name" :value="platform.id" /></el-select></template>
              </el-table-column>
              <el-table-column label="最低频率（MHz）" min-width="90"><template #default="{ row, $index }"><el-input-number v-model="row.frequencyRange.min" :min="0.001" controls-position="right" :data-testid="`sensor-frequency-min-${$index}`" @update:model-value="markDirty" /></template></el-table-column>
              <el-table-column label="最高频率（MHz）" min-width="90"><template #default="{ row, $index }"><el-input-number v-model="row.frequencyRange.max" :min="0.001" controls-position="right" :data-testid="`sensor-frequency-max-${$index}`" @update:model-value="markDirty" /></template></el-table-column>
              <el-table-column label="探测范围（m）" min-width="90"><template #default="{ row, $index }"><el-input-number v-model="row.detectionRange" :min="0" controls-position="right" :data-testid="`sensor-range-${$index}`" @update:model-value="markDirty" /></template></el-table-column>
              <el-table-column label="方向" min-width="220">
                <template #default="{ row, $index }">
                  <div class="sensor-direction-editor">
                    <el-select :model-value="sensorDirectionMode(row.id)" :data-testid="`sensor-direction-mode-${$index}`" @change="setSensorDirectionMode(row.id, $event)">
                      <el-option label="全向" value="OMNI" />
                      <el-option label="定向" value="DIRECTIONAL" />
                    </el-select>
                    <el-input-number v-if="sensorDirectionMode(row.id) === 'DIRECTIONAL'" :model-value="sensorExtension(row.id)?.direction" :min="0" :max="360" controls-position="right" :data-testid="`sensor-direction-${$index}`" @update:model-value="setSensorDirection(row.id, $event)" />
                  </div>
                </template>
              </el-table-column>
              <el-table-column label="探测概率" min-width="90"><template #default="{ row, $index }"><el-input-number :model-value="sensorExtension(row.id)?.probability" :min="0" :max="1" :step="0.01" controls-position="right" :data-testid="`sensor-probability-${$index}`" @update:model-value="setSensorExtensionValue(row.id, 'probability', $event ?? 0)" /></template></el-table-column>
              <el-table-column label="启用"><template #default="{ row, $index }"><el-switch :model-value="sensorExtension(row.id)?.enabled" :data-testid="`sensor-enabled-${$index}`" @change="setSensorExtensionValue(row.id, 'enabled', $event)" /></template></el-table-column>
              <el-table-column label="操作" fixed="right"><template #default="{ $index }"><el-button link type="danger" :data-testid="`delete-sensor-${$index}`" @click="removeSensor($index)">删除</el-button></template></el-table-column>
            </el-table>
            <div class="platform-actions"><el-button type="primary" data-testid="add-sensor" @click="addSensor">新增传感器</el-button></div>
          </section>

          <section class="console-panel scenario-section" aria-labelledby="scenario-output-title">
            <div class="section-heading"><div><p class="section-kicker">结果配置</p><h3 id="scenario-output-title">输出参数</h3></div></div>
            <div class="form-grid form-grid--basic">
              <el-form-item class="form-grid__wide" label="输出目录" :error="issueMessage('output.directory')"><el-input v-model="draft.config.output.directory" data-testid="output-directory" @update:model-value="markDirty" /></el-form-item>
              <el-form-item label="写入间隔（秒）" :error="issueMessage('output.writeInterval')"><el-input-number v-model="draft.config.output.writeInterval" :min="draft.config.scenario.timeStep" :step="0.001" controls-position="right" data-testid="output-write-interval" @update:model-value="markDirty" /></el-form-item>
              <el-form-item label="链路质量"><el-switch v-model="draft.config.output.linkQualityEnabled" active-text="输出" inactive-text="关闭" data-testid="output-link-quality" @change="markDirty" /></el-form-item>
              <el-form-item label="事件"><el-switch v-model="draft.config.output.eventsEnabled" active-text="输出" inactive-text="关闭" data-testid="output-events" @change="markDirty" /></el-form-item>
              <el-form-item label="链路切换"><el-switch v-model="draft.config.output.linkSwitchEnabled" active-text="输出" inactive-text="关闭" data-testid="output-link-switch" @change="markDirty" /></el-form-item>
            </div>
          </section>

          <section class="console-panel scenario-section" aria-labelledby="scenario-demand-title">
            <div class="section-heading"><div><p class="section-kicker">任务流量</p><h3 id="scenario-demand-title">信息需求</h3></div><el-tag>{{ draft.config.informationDemand.length }} 条</el-tag></div>
            <el-table :data="draft.config.informationDemand" stripe data-testid="information-demand-table">
              <el-table-column prop="id" label="需求 ID" />
              <el-table-column label="源平台"  min-width="160"><template #default="{ row, $index }"><el-select v-model="row.sourcePlatformId" :data-testid="`demand-source-${$index}`" @change="markDirty"><el-option v-for="platform in draft.config.platforms" :key="platform.id" :label="platform.name" :value="platform.id" /></el-select></template></el-table-column>
              <el-table-column label="目标平台"  min-width="160"><template #default="{ row, $index }"><el-select v-model="row.destinationPlatformIds" multiple collapse-tags :data-testid="`demand-destinations-${$index}`" @change="markDirty"><el-option v-for="platform in draft.config.platforms" :key="platform.id" :label="platform.name" :value="platform.id" /></el-select></template></el-table-column>
              <el-table-column label="信息类型" min-width="100"><template #default="{ row, $index }"><el-input v-model="row.informationType" :data-testid="`demand-type-${$index}`" @update:model-value="markDirty" /></template></el-table-column>
              <el-table-column label="数据量（MB）"><template #default="{ row, $index }"><el-input-number v-model="row.volumeMb" :min="0" controls-position="right" :data-testid="`demand-volume-${$index}`" @update:model-value="markDirty" /></template></el-table-column>
              <el-table-column label="频率（Hz）" ><template #default="{ row, $index }"><el-input-number v-model="row.frequencyHz" :min="0" controls-position="right" :data-testid="`demand-frequency-${$index}`" @update:model-value="markDirty" /></template></el-table-column>
              <el-table-column label="优先级" ><template #default="{ row, $index }"><el-select v-model="row.priority" :data-testid="`demand-priority-${$index}`" @change="markDirty"><el-option label="高" value="HIGH" /><el-option label="普通" value="NORMAL" /></el-select></template></el-table-column>
              <el-table-column label="最大时延（ms）"  min-width="100"><template #default="{ row, $index }"><el-input-number v-model="row.maxLatencyMs" :min="0" controls-position="right" :data-testid="`demand-latency-${$index}`" @update:model-value="markDirty" /></template></el-table-column>
              <el-table-column label="最低速率（Mbps）"><template #default="{ row, $index }"><el-input-number v-model="row.minDataRateMbps" :min="0" controls-position="right" :data-testid="`demand-rate-${$index}`" @update:model-value="markDirty" /></template></el-table-column>
              <el-table-column label="操作" fixed="right"><template #default="{ $index }"><el-button link type="danger" :disabled="draft.config.informationDemand.length <= 1" :data-testid="`delete-information-demand-${$index}`" @click="removeInformationDemand($index)">删除</el-button></template></el-table-column>
            </el-table>
            <div class="platform-actions"><el-button type="primary" :disabled="draft.config.platforms.length < 2" data-testid="add-information-demand" @click="addInformationDemand">新增信息需求</el-button></div>
          </section>
        </el-tab-pane>

        <el-tab-pane label="场景操作" name="operations">
          <section class="console-panel scenario-section" aria-labelledby="scenario-operation-title">
<!--            <div class="section-heading">-->
<!--              <div>-->
<!--                <p class="section-kicker">完整快照</p>-->
<!--                <h3 id="scenario-operation-title">导入、撤销与重置</h3>-->
<!--              </div>-->
<!--            </div>-->
            <el-alert title="导入 ScenarioConfig 规范快照，UI 扩展按规则重建。以下操作不导入模板，也不会重置全局 Mock 数据。" type="info" :closable="false" show-icon />
            <el-alert v-if="sceneOperationFeedback" class="platform-feedback" :title="sceneOperationFeedback" type="success" :closable="false" show-icon />
            <div class="platform-actions">
              <el-button type="primary" :disabled="pending || draft.locked" data-testid="import-scenario-snapshot" @click="importScenarioSnapshot">导入完整快照</el-button>
              <el-button :disabled="pending || draft.locked || dirty" data-testid="undo-scenario" @click="undoScenario">撤销场景操作</el-button>
              <el-button type="danger" plain :disabled="pending || draft.locked || dirty" data-testid="reset-scenario" @click="resetScenario">重置当前场景</el-button>
            </div>
            <pre class="scenario-json-preview" data-testid="scenario-json-preview">{{ JSON.stringify(draft.config, null, 2) }}</pre>
          </section>
        </el-tab-pane>

        <el-tab-pane label="脚本预览" name="script">
          <ScriptPreview
            :state="scriptState"
            :result-message="scriptResultMessage"
            :script="script"
            :preflight="preflight"
            :output-directory="draft.config.output.directory"
            :locked="draft.locked"
            :dirty="dirty"
            @generate="generateScriptPreview"
            @preflight="scenarioStore.preflightScript"
          />
        </el-tab-pane>

        <el-tab-pane label="整体校验" name="validation">
          <ValidationPanel
            :pending="pending"
            :panel-state="panelState"
            :result-message="resultMessage"
            :validation="validation"
            :completed="validationCompleted"
            @locate="locateValidationIssue"
          />
        </el-tab-pane>

        <el-tab-pane label="场景模板" name="templates">
          <TemplateLibrary
            :can-maintain="false"
            :allow-apply="true"
            :pending="templatePending"
            :draft-available="draft !== null"
            :draft-locked="draft?.locked ?? false"
            :templates="templates"
            :state="templateState"
            :result-message="templateResultMessage"
            :selected-template="selectedTemplate"
            :last-confirmation="lastConfirmation"
            @load="scenarioStore.loadTemplate"
            @copy="applyTemplate"
          />
        </el-tab-pane>
      </el-tabs>
    </el-form>

    <PlatformEditorDialog
      v-model="platformDialogVisible"
      :platform="platformEditor"
      :editing="editingPlatformIndex !== null"
      :error="platformEditorError"
      :pending="pending"
      :locked="draft?.locked ?? false"
      :business-type-options="businessTypeOptions"
      :supporting-type-options="supportingTypeOptions"
      :deployment-domain-labels="deploymentDomainLabels"
      @apply="applyPlatformEditor"
    />

    <LinkEditorDialog
      v-model="linkDialogVisible"
      :link="linkEditorLink"
      :editing="editingLinkIndex !== null"
      :error="linkEditorError"
      :pending="pending"
      :locked="draft?.locked ?? false"
      :platforms="draft?.config.platforms ?? []"
      :link-type-options="linkTypeOptions"
      :link-direction-labels="linkDirectionLabels"
      :minimum-step="LINK_MHZ_MINIMUM_STEP"
      @apply="applyLinkEditor"
      @frequency-input="trackLinkFrequencyInput"
      @bandwidth-input="trackLinkBandwidthInput"
    />

    <JammerEditorDialog
      v-model="jammerDialogVisible"
      :jammer="jammerEditorJammer"
      :ui-extension="jammerEditorUiExtension"
      :editing="editingJammerIndex !== null"
      :error="jammerEditorError"
      :pending="pending"
      :locked="draft?.locked ?? false"
      :platforms="draft?.config.platforms ?? []"
      :jammer-type-options="jammerTypeOptions"
      :minimum-step="LINK_MHZ_MINIMUM_STEP"
      @apply="applyJammerEditor"
      @frequency-input="trackJammerFrequencyInput"
      @bandwidth-input="trackJammerBandwidthInput"
    />
  </section>
</template>

<style scoped>
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
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.scenario-header {
  justify-content: flex-end
}


.scenario-header__actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.scenario-feedback {
  margin-bottom: 1rem;
}

.scenario-form {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-rows: minmax(0, 1fr);
  gap: 1rem;
}

.scenario-tabs {
  display: flex;
  min-height: 0;
  flex-direction: column
}

.scenario-tabs :deep(.el-tabs__header) {
  flex: none;
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
  padding: 1.1rem;
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
  gap: 0 1rem;
}

.form-grid--basic {
  grid-template-columns: minmax(12rem, 1fr) minmax(18rem, 2fr);
}

.form-grid--scenario-identity {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.form-grid--timing {
  grid-template-columns: repeat(3, minmax(11rem, 1fr));
}

.form-grid--environment {
  grid-template-columns: repeat(3, minmax(11rem, 1fr));
}

.form-grid__wide {
  grid-column: 1 / -1;
}

.form-grid--scenario-identity :deep(.el-form-item),
.form-grid--timing :deep(.el-form-item),
.form-grid--environment :deep(.el-form-item) {
  display: grid;
  width: 100%;
  max-width: 30rem;
  align-items: start;
  grid-template-columns: 7.5rem minmax(0, 1fr);
}

.form-grid--scenario-identity :deep(.el-form-item__label),
.form-grid--timing :deep(.el-form-item__label),
.form-grid--environment :deep(.el-form-item__label) {
  display: flex;
  width: 100%;
  height: 2rem;
  align-items: center;
  justify-content: flex-end;
  margin: 0;
  padding-right: 0.5rem;
  line-height: 2rem;
  text-align: right;
  white-space: nowrap;
}

.form-grid--scenario-identity :deep(.el-form-item__content),
.form-grid--timing :deep(.el-form-item__content),
.form-grid--environment :deep(.el-form-item__content) {
  min-width: 0;
}

.form-grid--scenario-identity :deep(.form-grid__wide) {
  grid-column: auto;
  max-width: 36rem;
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

.platform-feedback {
  margin-bottom: 1rem;
}

.scenario-page :deep(.el-table .el-input-number) {
  width: 100%;
}

.scenario-json-preview {
  max-height: 32rem;
  margin: 1rem 0 0;
  padding: 1rem;
  overflow: auto;
  border: 1px solid var(--console-border);
  border-radius: 4px;
  background: var(--console-bg-elevated);
  color: var(--console-text);
  font: 12px/1.6 Consolas, monospace;
  white-space: pre;
}

.sensor-direction-editor {
  display: grid;
  grid-template-columns: 5rem minmax(0, 1fr);
  gap: 0.5rem;
}

.multipath-field :deep(.el-form-item__content) {
  min-height: 32px;
  align-items: center;
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
  .form-grid--timing,
  .form-grid--environment {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .form-grid--basic,
  .form-grid--timing,
  .form-grid--environment,
  .validation-issue {
    grid-template-columns: 1fr;
  }

  .form-grid__wide {
    grid-column: auto;
  }

  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }

}
</style>
