<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { HotLinkSettings, Link, LinkCalcSettings, LinkType, Platform, SatelliteType, ScenarioLinkSettings } from '../../contracts/domain-models'
import { isConfiguredLinkEnabled, LINK_DECISION_DEFAULTS, readLinkSettings } from '../../features/scenarios/link-settings'
import { hotLinkChainError, readHotLinks } from '../../features/scenarios/hot-links'
import { CHANNEL_ENCODING_OPTIONS, JAMMING_RANGE_KM, LINK_CALC_DEFAULTS, readLinkCalcSettings } from '../../features/scenarios/link-calc-defaults'
import { scenarioPlatformLabel } from '../../features/scenarios/scenario-basic'

const props = withDefaults(defineProps<{
  modelValue?: ScenarioLinkSettings
  dialogVisible?: boolean
  platforms: Platform[]
  links?: Link[]
  disabled: boolean
  typeOptions: readonly { value: LinkType; label: string }[]
  /** 父页将完整校验路径转换为本面板相对路径后传入，供字段下方即时展示。 */
  fieldMessage?: (relativeFieldPath: string) => string
}>(), { links: () => [] })
const emit = defineEmits<{
  'update:modelValue': [value: ScenarioLinkSettings]
  'update:dialogVisible': [visible: boolean]
}>()
const settings = computed(() => readLinkSettings({ platforms: props.platforms, linkSettings: props.modelValue }))
const satellites = [{ value: 'TIANTONG', label: '天通卫星' }, { value: 'SHENTONG', label: '神通卫星' }] as const

/** 单选本场景使用的卫星；type 为天通或神通，同步两个底层开关且不删除卫星实体。 */
function selectSatellite(type: SatelliteType): void {
  if (props.disabled || !props.platforms.some(p => p.type === 'COMMUNICATION_SATELLITE' && p.satelliteType === type)) return
  emit('update:modelValue', { ...settings.value, enabledSatellites: { TIANTONG: type === 'TIANTONG', SHENTONG: type === 'SHENTONG' } })
}

/** 保存冷却秒数；清空值保留为非法数值供整体校验阻断，避免静默改回默认值。 */
function setCooldown(value: number | undefined): void {
  if (!props.disabled) emit('update:modelValue', { ...settings.value, switchCooldownS: value ?? Number.NaN })
}

/** 保存连续稳定检查次数；清空值保留为非法数值供整体校验阻断。 */
function setStableChecks(value: number | undefined): void {
  if (!props.disabled) emit('update:modelValue', { ...settings.value, switchStableChecks: value ?? Number.NaN })
}

const decisionFields = [
  { key: 'switchCooldownFrames', label: '切换冷却帧数', min: 0, step: 1 },
  { key: 'minimumGxbDb', label: '可用性 GXB 下限（dB）', step: 1 },
  { key: 'maximumBer', label: '可用性误码率上限', min: 0, max: 1, step: 1e-6 },
  { key: 'minimumGxbImprovementDb', label: '切换 GXB 最少改善（dB）', min: 0, step: 1 },
  { key: 'minimumBerImprovementFactor', label: '切换误码率最少改善倍数', min: 1, step: 1 },
  { key: 'minimumSpatialIsolationDb', label: '候选空域隔离下限（dB）', min: 0, step: 1 },
] as const
const qualityThresholdFields = decisionFields.filter(field => field.key !== 'switchCooldownFrames')
const cooldownFramesField = decisionFields[0]

function setDecisionField(key: (typeof decisionFields)[number]['key'], value: number | undefined): void {
  if (!props.disabled) emit('update:modelValue', { ...settings.value, [key]: value ?? Number.NaN })
}

function setConsistency(value: string | number | boolean): void {
  if (!props.disabled) emit('update:modelValue', { ...settings.value, switchConsistencyCheck: value === true })
}

const linkCalc = computed(() => readLinkCalcSettings(settings.value.linkCalc))
const thresholdFields = [
  { key: 'emergencyThreshold', label: '紧急阈值', hint: '误码率达到或超过紧急阈值时，链路显示中断' },
  { key: 'warningThreshold', label: '告警阈值', hint: '误码率达到告警阈值且低于紧急阈值时，链路显示劣化' },
  { key: 'valueThresholdBer', label: '质量阈值', hint: '误码率不高于此值时满足优质链路门限' },
] as const
type ThresholdKey = (typeof thresholdFields)[number]['key']
const thresholdRows = computed(() => thresholdFields.map(field => ({
  ...field,
  error: props.fieldMessage?.(`linkCalc.${field.key}`) ?? '',
})))
const manualThresholds = ref<Partial<Record<ThresholdKey, boolean>>>({})

function isThresholdEnabled(key: ThresholdKey): boolean {
  if (manualThresholds.value[key] === true) return true
  const current = linkCalc.value[key]
  if (!Number.isFinite(current) || current !== LINK_CALC_DEFAULTS[key]) return true
  return Boolean(props.fieldMessage?.(`linkCalc.${key}`))
}

const enabledThresholdCount = computed(() => thresholdFields.filter(field => isThresholdEnabled(field.key)).length)

function toggleThreshold(key: ThresholdKey, enabled: string | number | boolean): void {
  if (props.disabled) return
  if (enabled === true) {
    manualThresholds.value = { ...manualThresholds.value, [key]: true }
  } else {
    const next = { ...manualThresholds.value }
    delete next[key]
    manualThresholds.value = next
    if (linkCalc.value[key] !== LINK_CALC_DEFAULTS[key] || !Number.isFinite(linkCalc.value[key])) {
      updateLinkCalc({ [key]: LINK_CALC_DEFAULTS[key] })
    }
  }
}

watch(() => props.dialogVisible, (visible) => {
  if (!visible) manualThresholds.value = {}
})

/** 写回 link_calc 全局设置；首次编辑时把文档默认值一并写入。 */
function updateLinkCalc(patch: Partial<LinkCalcSettings>): void {
  if (!props.disabled) emit('update:modelValue', { ...settings.value, linkCalc: { ...linkCalc.value, ...patch } })
}

/** 编辑结束后保存数值，空值或无法解析的输入交给整体校验。 */
function setThreshold(key: ThresholdKey, text: string): void {
  updateLinkCalc({ [key]: text.trim() === '' ? Number.NaN : Number(text) })
}

const thresholdDecimal = new Intl.NumberFormat('en-US', { useGrouping: false, maximumSignificantDigits: 21 })
function thresholdDisplay(value: number): string {
  return Number.isFinite(value) ? thresholdDecimal.format(value) : ''
}

const thresholdRangeText = computed<Record<ThresholdKey, string>>(() => {
  const { emergencyThreshold, warningThreshold, valueThresholdBer } = linkCalc.value
  const bound = (value: number, label: string) => value > 0 && value <= 1 ? thresholdDisplay(value) : label
  const emergency = bound(emergencyThreshold, '紧急阈值')
  const warning = bound(warningThreshold, '告警阈值')
  const quality = bound(valueThresholdBer, '质量阈值')
  const reversedBounds = emergencyThreshold > 0 && valueThresholdBer <= 1 && valueThresholdBer > emergencyThreshold
  return {
    emergencyThreshold: `可填 ${warning}～1（含两端）`,
    warningThreshold: reversedBounds
      ? '质量阈值高于紧急阈值，请先调整其中一项。'
      : `可填 ${quality}～${emergency}（含两端）`,
    valueThresholdBer: `可填大于 0 且不大于 ${warning} 的数值`,
  }
})

const hotDirections = [{ key: 'forward', direction: 'FORWARD', label: '前向热链' },
  { key: 'reverse', direction: 'REVERSE', label: '返向热链' }] as const
/** 链路类型的中文兜底名，保证没有传入类型选项时也不显示英文枚举。 */
const LINK_TYPE_TEXT: Record<LinkType, string> = { SAT: '卫星', MICROWAVE: '微波', DATALINK: '数传', LASER: '激光', FIBER: '光纤' }
function typeText(type: LinkType): string {
  return props.typeOptions.find(option => option.value === type)?.label ?? LINK_TYPE_TEXT[type]
}
/** 参与本次场景的链路（链路启用且卫星可用）；热链逐跳下拉和快捷生成只用这些。 */
const enabledHotLinks = computed(() => props.links.filter(link => isConfiguredLinkEnabled(link, settings.value, props.platforms)))
const hotLinks = computed(() => readHotLinks(settings.value.hotLinks))
const hotLinkCount = computed(() => [...hotLinks.value.forward, ...hotLinks.value.reverse].filter(chain => chain.length > 0).length)

/** 写回整份热链配置。 */
function emitHotLinks(next: HotLinkSettings): void {
  if (props.disabled) return
  emit('update:modelValue', { ...settings.value, hotLinks: next })
}
function linkById(id: string): Link | undefined {
  return props.links.find(link => link.id === id)
}
function writeChains(key: 'forward' | 'reverse', chains: string[][]): void {
  const next = readHotLinks(settings.value.hotLinks)
  next[key] = chains
  emitHotLinks(next)
}
/** 热链平台走向：首跳源平台，之后每跳的目标平台。 */
function chainPlatforms(chain: readonly string[]): string[] {
  const platforms: string[] = []
  chain.forEach((id, position) => {
    const link = linkById(id)
    if (link === undefined) return
    if (position === 0) platforms.push(link.sourcePlatformId)
    platforms.push(link.targetPlatformId)
  })
  return platforms
}
/** 首跳源平台名。 */
function chainStartName(chain: readonly string[]): string {
  const platforms = chainPlatforms(chain)
  return platforms.length > 0 ? scenarioPlatformLabel(props.platforms, platforms[0]!) : '未知平台'
}
/** 单跳链路类型名；引用失效时明确提示。 */
function hopTypeName(id: string): string {
  const link = linkById(id)
  return link === undefined ? '链路缺失' : typeText(link.type)
}
/** 单跳目标平台名。 */
function hopTargetName(id: string): string {
  const link = linkById(id)
  return link === undefined ? '' : scenarioPlatformLabel(props.platforms, link.targetPlatformId)
}
/** 下一跳可选链路：从当前终点平台出发、已启用、同方向、尚未使用，从源头杜绝断链。 */
function nextHopOptions(direction: Link['direction'], chain: readonly string[]): { value: string; label: string }[] {
  const last = chain.length > 0 ? linkById(chain[chain.length - 1]!) : undefined
  return enabledHotLinks.value
    .filter(link => link.direction === direction && !chain.includes(link.id)
      && (last === undefined || link.sourcePlatformId === last.targetPlatformId))
    .map(link => ({ value: link.id, label: linkPathLabel(link) }))
}
const pendingHop = ref<Record<string, string | undefined>>({})
/** 刚新增的空热链只是占位。点完成时若仍没选链路，才显示错误并留下弹框。 */
const emptyHotLinkNotice = ref<Record<string, boolean>>({})
function addChain(key: 'forward' | 'reverse'): void {
  if (props.disabled) return
  writeChains(key, [...hotLinks.value[key], []])
}
function appendHop(key: 'forward' | 'reverse', index: number, linkId: string | undefined): void {
  pendingHop.value[`${key}-${index}`] = undefined
  if (props.disabled || linkId === undefined) return
  const chains = hotLinks.value[key].map(chain => [...chain])
  chains[index]!.push(linkId)
  writeChains(key, chains)
}
/** 中间跳不能删；只从尾部删最后一跳，删到只剩一跳时整条移除。 */
function removeLastHop(key: 'forward' | 'reverse', index: number): void {
  if (props.disabled) return
  const chains = hotLinks.value[key].map(chain => [...chain])
  const chain = chains[index]!
  if (chain.length <= 1) chains.splice(index, 1)
  else chain.pop()
  writeChains(key, chains)
}
function removeChain(key: 'forward' | 'reverse', index: number): void {
  if (props.disabled) return
  const chains = hotLinks.value[key].map(chain => [...chain])
  chains.splice(index, 1)
  writeChains(key, chains)
}
/** 用平台名和链路名给出结构/启用错误；无误时返回空串。 */
function chainError(key: 'forward' | 'reverse', chain: readonly string[]): string {
  const direction = key === 'forward' ? 'FORWARD' : 'REVERSE'
  const reason = hotLinkChainError(chain, props.links, direction, {
    link: id => { const link = linkById(id); return link === undefined ? id : linkPathLabel(link) },
    platform: id => scenarioPlatformLabel(props.platforms, id),
  })
  if (reason !== null) return reason
  for (const id of chain) {
    const link = linkById(id)
    if (link !== undefined && !enabledHotLinks.value.some(item => item.id === id)) {
      return `链路 ${linkPathLabel(link)} 已停用或未参与本次场景。`
    }
  }
  return ''
}
function hotChainMessages(key: 'forward' | 'reverse', index: number, chain: readonly string[]): string[] {
  if (chain.length === 0 && !emptyHotLinkNotice.value[`${key}-${index}`]) return []
  const messages = [props.fieldMessage?.(`hotLinks.${key}[${index}]`) ?? '', chainError(key, chain)].filter(Boolean)
  return [...new Set(messages)]
}
function requestClose(): void {
  const notice: Record<string, boolean> = {}
  for (const group of hotDirections) {
    hotLinks.value[group.key].forEach((chain, index) => {
      if (chain.length === 0) notice[`${group.key}-${index}`] = true
    })
  }
  emptyHotLinkNotice.value = notice
  if (Object.keys(notice).length > 0) return
  emit('update:dialogVisible', false)
}
function onDialogVisible(open: boolean): void {
  if (open) emptyHotLinkNotice.value = {}
  if (open) emit('update:dialogVisible', true)
  else requestClose()
}
const quickStart = ref<Record<'forward' | 'reverse', string | undefined>>({ forward: undefined, reverse: undefined })
const quickEnd = ref<Record<'forward' | 'reverse', string | undefined>>({ forward: undefined, reverse: undefined })
const hotNotice = ref<Record<'forward' | 'reverse', string>>({ forward: '', reverse: '' })
function setQuickPlatform(which: 'start' | 'end', key: 'forward' | 'reverse', value: string | undefined): void {
  ;(which === 'start' ? quickStart : quickEnd).value[key] = value
}
/** 起点/终点候选：只列该方向有出链/入链的已启用平台。 */
function platformChoices(direction: Link['direction'], end: boolean): { value: string; label: string }[] {
  const ids = new Set(enabledHotLinks.value.filter(link => link.direction === direction).map(link => end ? link.targetPlatformId : link.sourcePlatformId))
  return [...ids].map(id => ({ value: id, label: scenarioPlatformLabel(props.platforms, id) }))
}
/** 按跳数查找连通路径，同层按链路编号遍历。 */
function findHotLinkPath(direction: Link['direction'], start: string, end: string): string[] | null {
  const links = enabledHotLinks.value.filter(link => link.direction === direction)
    .sort((left, right) => left.id.localeCompare(right.id))
  const queue = [start]
  const visited = new Set([start])
  const previous = new Map<string, { platform: string; linkId: string }>()
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const link of links) {
      if (link.sourcePlatformId !== current || visited.has(link.targetPlatformId)) continue
      visited.add(link.targetPlatformId)
      previous.set(link.targetPlatformId, { platform: current, linkId: link.id })
      if (link.targetPlatformId === end) {
        const path: string[] = []
        let node = end
        while (node !== start) {
          const step = previous.get(node)!
          path.unshift(step.linkId)
          node = step.platform
        }
        return path
      }
      queue.push(link.targetPlatformId)
    }
  }
  return null
}
function generateByEndpoints(key: 'forward' | 'reverse'): void {
  if (props.disabled) return
  const direction = key === 'forward' ? 'FORWARD' : 'REVERSE'
  const start = quickStart.value[key]
  const end = quickEnd.value[key]
  if (start === undefined || end === undefined) { hotNotice.value[key] = '请选择起点平台和终点平台。'; return }
  if (start === end) { hotNotice.value[key] = '起点和终点不能相同。'; return }
  const path = findHotLinkPath(direction, start, end)
  if (path === null) {
    hotNotice.value[key] = `未找到从 ${scenarioPlatformLabel(props.platforms, start)} 到 ${scenarioPlatformLabel(props.platforms, end)} 的可用路径。`
    return
  }
  if (hotLinks.value[key].some(chain => chain.join('\u0000') === path.join('\u0000'))) { hotNotice.value[key] = '该路径已存在。'; return }
  hotNotice.value[key] = ''
  writeChains(key, [...hotLinks.value[key], path])
}
/** 由一条前向热链生成反方向返向热链；任一跳缺少对应返向链路则提示。 */
function generateReverse(index: number): void {
  if (props.disabled) return
  const forward = hotLinks.value.forward[index]
  if (forward === undefined) return
  const reversed: string[] = []
  for (let position = forward.length - 1; position >= 0; position -= 1) {
    const link = linkById(forward[position]!)
    if (link === undefined) { hotNotice.value.forward = `第 ${position + 1} 跳链路不存在。`; return }
    const candidates = enabledHotLinks.value
      .filter(item => item.direction === 'REVERSE' && item.sourcePlatformId === link.targetPlatformId && item.targetPlatformId === link.sourcePlatformId)
      .sort((left, right) => (left.type === link.type ? 0 : 1) - (right.type === link.type ? 0 : 1)
        || left.id.localeCompare(right.id))
    if (candidates.length === 0) {
      hotNotice.value.forward = `第 ${position + 1} 跳没有对应的返向链路：${scenarioPlatformLabel(props.platforms, link.targetPlatformId)} → ${scenarioPlatformLabel(props.platforms, link.sourcePlatformId)}。`
      return
    }
    reversed.push(candidates[0]!.id)
  }
  if (hotLinks.value.reverse.some(chain => chain.join('\u0000') === reversed.join('\u0000'))) { hotNotice.value.forward = '对应的返向热链已存在。'; return }
  hotNotice.value.forward = ''
  writeChains('reverse', [...hotLinks.value.reverse, reversed])
}

/** 链路显示名：类型 + 源→目标平台中文名，避免向操作人员暴露英文链路编号。 */
function linkPathLabel(link: Link): string {
  return `${typeText(link.type)}（${scenarioPlatformLabel(props.platforms, link.sourcePlatformId)} → ${scenarioPlatformLabel(props.platforms, link.targetPlatformId)}）`
}

const advancedFields = {
  strategy: [
    'switchCooldownS', 'switchStableChecks', 'switchConsistencyCheck',
    ...decisionFields.map(field => field.key),
    ...thresholdFields.map(field => `linkCalc.${field.key}`),
  ],
  hotLinks: ['hotLinks'],
} as const
type AdvancedSection = keyof typeof advancedFields
const advancedSections = Object.keys(advancedFields) as AdvancedSection[]
const expanded = ref<Partial<Record<AdvancedSection, boolean>>>({})

watch(() => props.dialogVisible
  ? advancedSections.filter(section => advancedFields[section].some(field => props.fieldMessage?.(field))) : null,
(invalid, previous) => {
  if (!invalid) expanded.value = {}
  else for (const section of invalid) if (!previous?.includes(section)) expanded.value[section] = true
}, { immediate: true })

function toggleSection(section: AdvancedSection, event: Event): void {
  if (!props.dialogVisible) return
  const open = (event.currentTarget as HTMLDetailsElement).open
  expanded.value[section] = open
}

/** 服务端指出的问题需要先挂载输入控件，再由页面定位。 */
function revealField(path: string): void {
  const section = advancedSections.find(section => advancedFields[section].some(field => (
    path === field || path.startsWith(`${field}.`) || path.startsWith(`${field}[`)
  )))
  if (section) expanded.value[section] = true
}
defineExpose({ revealField })
</script>

<template>
  <div data-testid="link-settings">
    <el-button :disabled="disabled" data-testid="open-link-settings" @click="emit('update:dialogVisible', true)">链路设置</el-button>
  </div>
  <el-dialog :model-value="dialogVisible" class="link-settings-dialog scenario-dialog" title="链路设置" width="max(80vw, min(760px, calc(100vw - 2rem)))" top="5vh"
    destroy-on-close append-to-body data-testid="link-settings-dialog" @update:model-value="onDialogVisible">
    <el-form label-position="top" :disabled="disabled" class="link-settings__fields">
      <!-- 左列：选路策略与全局计算参数；右列：热链。 -->
      <div class="link-settings__column" data-testid="link-settings-left">
      <el-form-item label="本场景选用卫星" :error="fieldMessage?.('enabledSatellites') ?? ''">
        <el-select :model-value="settings.enabledSatellites.TIANTONG ? 'TIANTONG' : settings.enabledSatellites.SHENTONG ? 'SHENTONG' : undefined"
          placeholder="请先在节点配置中配置卫星" aria-label="本场景选用卫星" data-testid="link-relay-satellite" @change="selectSatellite">
          <el-option v-for="satellite in satellites" :key="satellite.value" :value="satellite.value" :label="satellite.label"
            :disabled="!platforms.some(p => p.type === 'COMMUNICATION_SATELLITE' && p.satelliteType === satellite.value)" />
        </el-select>
      </el-form-item>
      <details class="link-settings__disclosure scenario-advanced" data-testid="link-strategy-advanced" :open="expanded.strategy"
        @toggle="toggleSection('strategy', $event)">
        <summary>
          <span>选路稳定性与标定参数</span>
          <el-tag class="link-settings__summary-status" size="small" :type="enabledThresholdCount > 0 ? 'primary' : 'info'" effect="plain">
            {{ enabledThresholdCount > 0 ? `已启用 ${enabledThresholdCount} 项标定` : '默认参数' }}
          </el-tag>
        </summary>
        <div v-if="expanded.strategy" class="link-settings__disclosure-body link-settings__strategy-body">
          <section class="link-settings__subgroup" aria-label="设备失效标定门限">
            <div class="link-settings__subgroup-head">
              <span class="link-settings__subgroup-title">设备失效标定门限</span>
              <small class="link-settings__hint">按需启用自定义门限（关闭时使用默认误码率，满足 紧急 ≥ 告警 ≥ 质量）</small>
            </div>
            <div class="link-settings__failure-list">
              <el-form-item v-for="field in thresholdRows" :key="field.key" class="link-settings__failure-item"
                :class="{ 'is-enabled': isThresholdEnabled(field.key) }" :error="field.error" :show-message="false">
                <div class="link-settings__failure-row">
                  <div class="link-settings__failure-head">
                    <span class="link-settings__failure-label">{{ field.label }}</span>
                    <el-switch :model-value="isThresholdEnabled(field.key)" :disabled="disabled" :data-testid="`link-calc-enable-${field.key}`"
                      @update:model-value="toggleThreshold(field.key, $event)" />
                  </div>
                  <el-input v-if="isThresholdEnabled(field.key)" :model-value="thresholdDisplay(linkCalc[field.key])"
                    :model-modifiers="{ lazy: true }" inputmode="decimal"
                    :placeholder="`如 ${thresholdDisplay(LINK_CALC_DEFAULTS[field.key])}`" :disabled="disabled"
                    :aria-describedby="`link-calc-hint-${field.key}`"
                    :data-testid="`link-calc-${field.key}`" @update:model-value="setThreshold(field.key, $event)" />
                  <small :id="`link-calc-hint-${field.key}`" class="link-settings__hint"
                    :class="{ 'link-settings__hint--error': field.error }" aria-live="polite">
                    <template v-if="field.error">{{ field.error }}</template>
                    <template v-else>
                      <span :id="`link-calc-range-${field.key}`">{{ thresholdRangeText[field.key] }}</span>
                      <template v-if="!isThresholdEnabled(field.key)"> · 默认 {{ thresholdDisplay(LINK_CALC_DEFAULTS[field.key]) }}</template>
                      {{ ` · ${field.hint}` }}
                    </template>
                  </small>
                </div>
              </el-form-item>
            </div>
          </section>

          <section class="link-settings__subgroup" aria-label="防抖与稳定性">
            <div class="link-settings__subgroup-title">防抖与稳定性</div>
            <div class="link-settings__rule-grid">
              <el-form-item label="防乒乓滞回时间（秒）" :error="fieldMessage?.('switchCooldownS') ?? ''">
                <el-input-number :model-value="settings.switchCooldownS" :min="fieldMessage ? undefined : 0" :step="1" controls-position="right"
                  data-testid="link-switch-cooldown" @update:model-value="setCooldown" />
              </el-form-item>
              <el-form-item label="连续稳定检查次数" :error="fieldMessage?.('switchStableChecks') ?? ''">
                <el-input-number :model-value="settings.switchStableChecks ?? LINK_DECISION_DEFAULTS.switchStableChecks" :min="fieldMessage ? undefined : 1" :max="fieldMessage ? undefined : 100" :step="1" step-strictly controls-position="right"
                  :disabled="disabled" data-testid="link-switch-stable-checks" @update:model-value="setStableChecks" />
              </el-form-item>
              <el-form-item :label="cooldownFramesField.label" :error="fieldMessage?.(cooldownFramesField.key) ?? ''">
                <el-input-number :model-value="settings[cooldownFramesField.key] ?? LINK_DECISION_DEFAULTS[cooldownFramesField.key]"
                  :min="fieldMessage ? undefined : cooldownFramesField.min" :step="cooldownFramesField.step"
                  :disabled="disabled" controls-position="right" :data-testid="`link-decision-${cooldownFramesField.key}`"
                  @update:model-value="setDecisionField(cooldownFramesField.key, $event)" />
              </el-form-item>
              <el-form-item label="选路一致性校验" :error="fieldMessage?.('switchConsistencyCheck') ?? ''">
                <div class="link-settings__switch-box">
                  <el-switch :model-value="settings.switchConsistencyCheck ?? true" :disabled="disabled" data-testid="link-switch-consistency"
                    @update:model-value="setConsistency" />
                  <span class="link-settings__switch-text">{{ (settings.switchConsistencyCheck ?? true) ? '已启用' : '已关闭' }}</span>
                </div>
              </el-form-item>
            </div>
          </section>

          <section class="link-settings__subgroup" data-testid="quality-decision-settings" aria-label="质量选路与切换门限">
            <div class="link-settings__subgroup-title">质量选路与切换门限</div>
            <div class="link-settings__rule-grid">
              <el-form-item v-for="field in qualityThresholdFields" :key="field.key" :label="field.label" :error="fieldMessage?.(field.key) ?? ''">
                <el-input-number :model-value="settings[field.key] ?? LINK_DECISION_DEFAULTS[field.key]"
                  :min="fieldMessage ? undefined : 'min' in field ? field.min : undefined"
                  :max="fieldMessage ? undefined : 'max' in field ? field.max : undefined" :step="field.step"
                  :disabled="disabled" controls-position="right" :data-testid="`link-decision-${field.key}`"
                  @update:model-value="setDecisionField(field.key, $event)" />
              </el-form-item>
            </div>
          </section>
        </div>
      </details>
      <section class="link-settings__rules" data-testid="channel-encoding-settings" aria-labelledby="channel-encoding-title">
        <div class="link-settings__heading">
          <span id="channel-encoding-title">编码方案（全局）</span>
        </div>
        <el-form-item label="信道编码" :error="fieldMessage?.('linkCalc.channelEncodingScheme') ?? ''">
          <el-select :model-value="linkCalc.channelEncodingScheme" data-testid="link-calc-channelEncodingScheme"
            @update:model-value="updateLinkCalc({ channelEncodingScheme: $event })">
            <el-option v-for="option in CHANNEL_ENCODING_OPTIONS" :key="option.value" :value="option.value" :label="option.label" />
          </el-select>
        </el-form-item>
      </section>
      <section class="link-settings__rule-grid" data-testid="link-calc-settings" aria-label="链路计算周期">
        <el-form-item label="链路计算周期（秒）" :error="fieldMessage?.('linkCalc.updateIntervalS') ?? ''">
          <el-input-number :model-value="linkCalc.updateIntervalS" :disabled="disabled" controls-position="right" data-testid="link-calc-updateIntervalS"
            @update:model-value="updateLinkCalc({ updateIntervalS: $event ?? Number.NaN })" />
        </el-form-item>
        <el-form-item v-if="fieldMessage?.('messageIntervalS')" label="历史业务周期（秒，待修正）" :error="fieldMessage?.('messageIntervalS') ?? ''">
          <el-input-number :model-value="settings.messageIntervalS" :disabled="disabled" controls-position="right" data-testid="link-message-interval"
            @update:model-value="value => { if (!disabled) emit('update:modelValue', { ...settings, messageIntervalS: value ?? Number.NaN }) }" />
        </el-form-item>
        <el-form-item v-if="fieldMessage?.('linkCalc.jammingRangeKm')" :label="`历史干扰圈半径（km，${JAMMING_RANGE_KM.min}～${JAMMING_RANGE_KM.max}，待修正）`" :error="fieldMessage?.('linkCalc.jammingRangeKm') ?? ''">
          <el-input-number :model-value="linkCalc.jammingRangeKm" :min="fieldMessage ? undefined : JAMMING_RANGE_KM.min" :max="fieldMessage ? undefined : JAMMING_RANGE_KM.max" controls-position="right"
            data-testid="link-calc-jammingRangeKm" @update:model-value="updateLinkCalc({ jammingRangeKm: $event ?? Number.NaN })" />
        </el-form-item>
      </section>
      </div>
      <div class="link-settings__column" data-testid="link-settings-right">
      <details class="link-settings__disclosure scenario-advanced" data-testid="hot-link-settings" :open="expanded.hotLinks"
        @toggle="toggleSection('hotLinks', $event)">
        <summary>
          <span>热链配置</span>
          <el-tag class="link-settings__summary-status" size="small" :type="hotLinkCount > 0 ? 'primary' : 'info'" effect="plain" data-testid="hot-link-state">
            {{ hotLinkCount > 0 ? `已配置 ${hotLinkCount} 条` : '未配置' }}
          </el-tag>
        </summary>
        <div v-if="expanded.hotLinks" class="link-settings__disclosure-body">
        <p class="link-settings__empty">逐跳添加：先选第一跳，之后每跳只列出可衔接的已启用链路；最后一跳可删，中间跳不可删。</p>
        <div v-for="group in hotDirections" :key="group.key" class="link-settings__hot-group" :data-testid="`hot-link-${group.key}`">
          <div class="link-settings__heading"><span>{{ group.label }}</span></div>
          <div class="link-settings__hot-quick">
            <el-select :model-value="quickStart[group.key]" size="small" placeholder="起点平台" class="link-settings__hot-quick-select"
              :data-testid="`hot-link-${group.key}-quick-start`" @update:model-value="setQuickPlatform('start', group.key, $event)">
              <el-option v-for="option in platformChoices(group.direction, false)" :key="option.value" :value="option.value" :label="option.label" />
            </el-select>
            <span class="link-settings__hot-arrow">→</span>
            <el-select :model-value="quickEnd[group.key]" size="small" placeholder="终点平台" class="link-settings__hot-quick-select"
              :data-testid="`hot-link-${group.key}-quick-end`" @update:model-value="setQuickPlatform('end', group.key, $event)">
              <el-option v-for="option in platformChoices(group.direction, true)" :key="option.value" :value="option.value" :label="option.label" />
            </el-select>
            <el-button size="small" :disabled="disabled || platformChoices(group.direction, false).length === 0"
              :data-testid="`hot-link-${group.key}-quick-generate`" @click="generateByEndpoints(group.key)">按起终点生成</el-button>
          </div>
          <p v-if="hotNotice[group.key]" class="link-settings__error">{{ hotNotice[group.key] }}</p>
          <p v-if="hotLinks[group.key].length === 0 && platformChoices(group.direction, false).length === 0" class="link-settings__empty">没有同方向的已启用链路。</p>
          <p v-else-if="hotLinks[group.key].length === 0" class="link-settings__empty">尚未配置，可逐跳添加或用上方起终点生成。</p>
          <div v-for="(chain, index) in hotLinks[group.key]" :key="`${group.key}-${index}`" class="link-settings__rule" :data-testid="`hot-link-${group.key}-${index}`">
            <div class="link-settings__rule-head">
              <strong>{{ chain.length > 0 ? `第 ${index + 1} 条 · ${chain.length} 跳` : `第 ${index + 1} 条 · 尚未选择链路` }}</strong>
              <div class="link-settings__row-actions">
                <el-button v-if="group.key === 'forward'" link type="primary" :disabled="disabled || chain.length === 0"
                  :data-testid="`hot-link-${group.key}-${index}-reverse`" @click="generateReverse(index)">生成返向</el-button>
                <el-button link type="danger" :disabled="disabled" :data-testid="`hot-link-${group.key}-${index}-remove`" @click="removeChain(group.key, index)">删除</el-button>
              </div>
            </div>
            <div v-if="chain.length > 0" class="link-settings__hot-hops">
              <span class="link-settings__hot-node">{{ chainStartName(chain) }}</span>
              <template v-for="(id, hopIndex) in chain" :key="`${id}-${hopIndex}`">
                <span class="link-settings__hot-arrow">→</span>
                <span class="link-settings__hot-link">{{ hopTypeName(id) }}</span>
                <span class="link-settings__hot-arrow">→</span>
                <span class="link-settings__hot-node">{{ hopTargetName(id) }}</span>
              </template>
            </div>
            <div class="link-settings__hot-next">
              <el-select :model-value="pendingHop[`${group.key}-${index}`]" size="small" filterable
                :placeholder="chain.length === 0 ? '选择第一跳链路' : '添加下一跳链路'"
                :disabled="disabled || nextHopOptions(group.direction, chain).length === 0"
                :data-testid="`hot-link-${group.key}-${index}-next`" @update:model-value="appendHop(group.key, index, $event)">
                <el-option v-for="option in nextHopOptions(group.direction, chain)" :key="option.value" :value="option.value" :label="option.label" />
              </el-select>
              <el-button v-if="chain.length > 0" link type="danger" :disabled="disabled"
                :data-testid="`hot-link-${group.key}-${index}-remove-last`" @click="removeLastHop(group.key, index)">删除最后一跳</el-button>
            </div>
            <p v-if="chain.length > 0 && nextHopOptions(group.direction, chain).length === 0" class="link-settings__empty">已到路径末端，没有可继续的链路。</p>
            <p v-for="message in hotChainMessages(group.key, index, chain)" :key="message" class="link-settings__error">{{ message }}</p>
          </div>
          <el-button size="small" :disabled="disabled" :data-testid="`hot-link-${group.key}-add`" @click="addChain(group.key)">新增热链</el-button>
        </div>
        </div>
      </details>
      </div>
    </el-form>
    <template #footer>
      <el-button type="primary" data-testid="close-link-settings" @click="requestClose">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 弹框高度不超过视口，标题与底部按钮固定，内容区单独滚动。 */
.link-settings__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 0 2rem; }
.link-settings__column { display: grid; align-content: start; gap: 0.75rem; min-width: 0; }
.link-settings__hint { display: block; width: 100%; margin-top: 4px; color: var(--console-text-muted); font-size: 12px; line-height: 1.4; }
.link-settings__hint--error { color: var(--el-color-danger); }
.link-settings__heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
.link-settings__fields :deep(.el-input-number) { width: 100%; }
.link-settings__rules { display: grid; gap: 0.75rem; min-width: 0; }
.link-settings__disclosure { margin: 0; padding: 0; border-radius: var(--console-radius); background: var(--console-surface); }
.link-settings__disclosure > summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 44px;
  padding: 0.65rem 0.9rem;
  border-radius: inherit;
  list-style: none;
}
.link-settings__disclosure > summary::-webkit-details-marker { display: none; }
.link-settings__disclosure > summary:hover, .link-settings__disclosure[open] > summary { background: var(--console-surface-raised); }
.link-settings__disclosure > summary:focus-visible { outline-offset: -2px; }
.link-settings__disclosure > summary::after {
  content: '';
  flex: 0 0 0.45rem;
  height: 0.45rem;
  border-right: 2px solid var(--console-text-muted);
  border-bottom: 2px solid var(--console-text-muted);
  transform: rotate(-45deg);
}
.link-settings__disclosure[open] > summary { margin: 0; border-radius: var(--console-radius) var(--console-radius) 0 0; }
.link-settings__disclosure[open] > summary::after { transform: rotate(45deg); }
.link-settings__summary-status { margin-inline-start: auto; flex-shrink: 0; }
.link-settings__disclosure-body { display: grid; gap: 0.75rem; padding: 0.85rem; border-top: 1px solid var(--console-border); }
.link-settings__strategy-body { gap: 1rem; }
.link-settings__subgroup { display: grid; gap: 0.6rem; min-width: 0; }
.link-settings__subgroup + .link-settings__subgroup { padding-top: 0.85rem; border-top: 1px solid var(--console-border); }
.link-settings__subgroup-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 0.35rem 0.75rem; }
.link-settings__subgroup-head .link-settings__hint { width: auto; margin-top: 0; }
.link-settings__subgroup-title { color: var(--console-text); font-size: 13px; font-weight: 600; line-height: 1.4; }
.link-settings__strategy-body :deep(.el-form-item) { margin-bottom: 0.75rem; }
.link-settings__strategy-body :deep(.el-form-item__label) { line-height: 1.35; margin-bottom: 0.3rem; font-size: 12px; color: var(--console-text-muted); }
.link-settings__switch-box { display: flex; align-items: center; gap: 0.5rem; min-height: 32px; padding: 0 0.65rem; border: 1px solid var(--console-border); border-radius: 4px; background: var(--console-bg-elevated); width: 100%; box-sizing: border-box; }
.link-settings__switch-text { color: var(--console-text-muted); font-size: 12px; }
.link-settings__failure-list { display: grid; gap: 0.5rem; }
.link-settings__failure-item { margin-bottom: 0 !important; }
.link-settings__failure-item :deep(.el-form-item__content) { display: block; line-height: normal; }
.link-settings__failure-row { display: grid; gap: 0.5rem; width: 100%; padding: 0.55rem 0.75rem; border: 1px solid var(--console-border); border-radius: 4px; background: var(--console-bg-elevated); box-sizing: border-box; }
.link-settings__failure-item.is-enabled .link-settings__failure-row { border-color: color-mix(in srgb, var(--console-cyan) 45%, var(--console-border)); }
.link-settings__failure-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; min-height: 24px; }
.link-settings__failure-label { color: var(--console-text); font-size: 12px; line-height: 1.4; }
.link-settings__reset-hot-links { justify-self: end; }
.link-settings__empty { margin: 0; color: var(--console-text-muted); font-size: 12px; }
.link-settings__error { color: var(--el-color-danger); font-size: 12px; }
.link-settings__hot-group { display: grid; gap: 0.5rem; min-width: 0; }
.link-settings__hot-group .link-settings__rule small { display: block; margin: 0.25rem 0; }
.link-settings__rule { min-width: 0; padding: 0.65rem 0.75rem 0.25rem; border: 1px solid var(--console-border); border-radius: 4px; }
.link-settings__rule-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
.link-settings__row-actions { margin-left: auto; }
.link-settings__rule-head strong { flex: 1; min-width: 0; font-weight: 600; line-height: 1.4; }
.link-settings__hot-quick { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
.link-settings__hot-quick-select { flex: 1 1 8rem; min-width: 0; }
.link-settings__hot-hops { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; margin: 0.25rem 0; }
.link-settings__hot-node { padding: 1px 6px; border: 1px solid var(--console-border); border-radius: 4px; background: var(--console-bg-elevated); color: var(--console-text); font-size: 12px; }
.link-settings__hot-link { padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--console-cyan) 16%, transparent); color: var(--console-cyan); font-size: 12px; }
.link-settings__hot-arrow { color: var(--console-text-muted); font-size: 12px; }
.link-settings__hot-next { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.35rem; }
.link-settings__hot-next :deep(.el-select) { flex: 1; min-width: 0; }
.link-settings__rule-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 1rem; }
.link-settings__rule-grid :deep(.el-select) { width: 100%; }
.link-settings__rule-wide { grid-column: 1 / -1; }
@media (min-width: 961px) {
  :global(.el-dialog.link-settings-dialog > .el-dialog__body) { display: flex; overflow: hidden; }
  .link-settings__fields { flex: 1; min-width: 0; min-height: 0; grid-template-rows: minmax(0, 1fr); align-items: stretch; }
  .link-settings__column { overflow-y: auto; overscroll-behavior-y: contain; scrollbar-gutter: stable; }
}
@media (max-width: 960px) {
  .link-settings__fields { grid-template-columns: 1fr; }
}
@media (max-width: 600px) {
  .link-settings__rule-grid { grid-template-columns: 1fr; }
  .link-settings__rule-wide { grid-column: auto; }
}
</style>
