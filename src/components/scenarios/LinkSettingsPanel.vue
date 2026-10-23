<script setup lang="ts">
import { computed, ref } from 'vue'
import type { HotLinkSettings, Jammer, Link, LinkCalcSettings, LinkSwitchRule, LinkSwitchTrigger, LinkType, Platform, SatelliteType, ScenarioLinkSettings } from '../../contracts/domain-models'
import { isConfiguredLinkEnabled, readLinkSettings } from '../../features/scenarios/link-settings'
import { HOT_LINK_END_PLATFORM_TYPES, hotLinkChainError, readHotLinks } from '../../features/scenarios/hot-links'
import { CHANNEL_ENCODING_OPTIONS, JAMMING_RANGE_KM, readLinkCalcSettings } from '../../features/scenarios/link-calc-defaults'
import { scenarioPlatformLabel } from '../../features/scenarios/scenario-basic'

const props = withDefaults(defineProps<{
  modelValue?: ScenarioLinkSettings
  dialogVisible?: boolean
  platforms: Platform[]
  links?: Link[]
  jammers?: Jammer[]
  disabled: boolean
  typeOptions: readonly { value: LinkType; label: string }[]
}>(), { links: () => [], jammers: () => [] })
const emit = defineEmits<{
  'update:modelValue': [value: ScenarioLinkSettings]
  'update:dialogVisible': [visible: boolean]
}>()
const settings = computed(() => readLinkSettings({ platforms: props.platforms, linkSettings: props.modelValue }))
const satellites = [{ value: 'TIANTONG', label: '天通卫星' }, { value: 'SHENTONG', label: '神通卫星' }] as const
const draggedType = ref<LinkType | null>(null)
const dropTarget = ref<LinkType | null>(null)

/** 单选本场景使用的卫星；type 为天通或神通，同步两个底层开关且不删除卫星实体。 */
function selectSatellite(type: SatelliteType): void {
  if (props.disabled || !props.platforms.some(p => p.type === 'COMMUNICATION_SATELLITE' && p.satelliteType === type)) return
  emit('update:modelValue', { ...settings.value, enabledSatellites: { TIANTONG: type === 'TIANTONG', SHENTONG: type === 'SHENTONG' } })
}

/** 保存冷却秒数；清空值保留为非法数值供整体校验阻断，避免静默改回默认值。 */
function setCooldown(value: number | undefined): void {
  if (!props.disabled) emit('update:modelValue', { ...settings.value, switchCooldownS: value ?? Number.NaN })
}

/** 移动优先级；type 为待移动类型，index 为目标顺位（从零开始），其余类型按原顺序顺延。 */
function movePriority(type: LinkType, index: number): void {
  if (props.disabled) return
  const priority = [...settings.value.priority]
  const previousIndex = priority.indexOf(type)
  if (previousIndex < 0 || previousIndex === index || index < 0 || index >= priority.length) return
  priority.splice(previousIndex, 1)
  priority.splice(index, 0, type)
  emit('update:modelValue', { ...settings.value, priority })
}

/** 开始原生拖拽；type 为当前类型，event 提供浏览器拖放数据，仅记录来源，不提前修改配置。 */
function startDrag(type: LinkType, event: DragEvent): void {
  if (props.disabled) {
    event.preventDefault()
    return
  }
  draggedType.value = type
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', type)
  }
}

/** 松开后将本列表拖拽的类型移到 index 顺位；外部拖入不修改配置。 */
function dropPriority(index: number): void {
  if (draggedType.value !== null) movePriority(draggedType.value, index)
  resetDrag()
}

/** 拖拽完成或取消时清除来源和目标高亮，不修改优先级。 */
function resetDrag(): void {
  draggedType.value = null
  dropTarget.value = null
}

const linkCalc = computed(() => readLinkCalcSettings(settings.value.linkCalc))
const thresholdFields = [
  { key: 'emergencyThreshold', label: '紧急阈值（BER）' },
  { key: 'warningThreshold', label: '告警阈值（BER）' },
  { key: 'valueThresholdBer', label: '质量阈值（BER）' },
] as const

/** 写回 link_calc 全局设置；首次编辑时把文档默认值一并写入。 */
function updateLinkCalc(patch: Partial<LinkCalcSettings>): void {
  if (!props.disabled) emit('update:modelValue', { ...settings.value, linkCalc: { ...linkCalc.value, ...patch } })
}

/** 误码率按文本输入以支持 1e-7 这类科学计数；无法解析时写入 NaN 交给整体校验阻断。 */
function setThreshold(key: (typeof thresholdFields)[number]['key'], text: string): void {
  updateLinkCalc({ [key]: text.trim() === '' ? Number.NaN : Number(text) })
}

const hotEndLabels: Record<HotLinkSettings['endPlatformType'], string> = {
  REAR_COMMAND_NODE: '后方指挥节点（REAR_COMM_PLATFORM）',
  GROUND_CLUSTER_COMMAND_NODE: '地面集群指挥节点（COMMAND_VEHICLE_PLATFORM）',
  AIRBORNE_MISSION_CLUSTER: '空中任务集群（MISSION_UAV_PLATFORM）',
}
const hotDirections = [{ key: 'forward', direction: 'FORWARD', label: '前向热链（hot_link_fw）' },
  { key: 'reverse', direction: 'REVERSE', label: '返向热链（hot_link_ret）' }] as const
const enabledLinks = computed(() => props.links.filter(link => isConfiguredLinkEnabled(link, settings.value, props.platforms)))
const hotLinks = computed(() => readHotLinks(settings.value.hotLinks, enabledLinks.value, settings.value.priority))

/** 写回整份热链配置；首次编辑时把当前自动串联结果一并固化为自定义配置。 */
function emitHotLinks(next: HotLinkSettings | undefined): void {
  if (props.disabled) return
  const rest: ScenarioLinkSettings = { ...settings.value }
  delete rest.hotLinks
  emit('update:modelValue', next === undefined ? rest : { ...rest, hotLinks: next })
}

function updateChain(key: 'forward' | 'reverse', index: number, chain: string[] | null): void {
  const next = readHotLinks(settings.value.hotLinks, enabledLinks.value, settings.value.priority)
  if (chain === null) next[key].splice(index, 1)
  else if (index >= next[key].length) next[key].push(chain)
  else next[key][index] = chain
  emitHotLinks(next)
}

/** 热链路径文字：源平台 →（链路类型）→ 目标平台，便于核对首尾是否相接。 */
function chainPath(chain: readonly string[]): string {
  const parts: string[] = []
  chain.forEach((id, position) => {
    const link = props.links.find(item => item.id === id)
    if (!link) return
    if (position === 0) parts.push(scenarioPlatformLabel(props.platforms, link.sourcePlatformId))
    parts.push(`→（${typeLabel(link.type)}）→ ${scenarioPlatformLabel(props.platforms, link.targetPlatformId)}`)
  })
  return parts.join(' ')
}

function typeLabel(type: LinkType): string {
  return props.typeOptions.find(option => option.value === type)?.label ?? type
}

const triggerOptions: readonly { value: LinkSwitchTrigger; label: string }[] = [
  { value: 'DISTANCE_ABOVE', label: '两端距离大于阈值' },
  { value: 'DISTANCE_BELOW', label: '两端距离小于阈值' },
  { value: 'JAMMING_ACTIVE', label: '干扰设备开启' },
  { value: 'JAMMING_STOPPED', label: '干扰设备关闭' },
]
const rules = computed(() => settings.value.switchRules ?? [])
const isDistance = (trigger: LinkSwitchTrigger) => trigger === 'DISTANCE_ABOVE' || trigger === 'DISTANCE_BELOW'

/** 写回整组规则；next 为新的规则列表，空列表时移除字段以保持旧场景结构。 */
function emitRules(next: LinkSwitchRule[]): void {
  if (props.disabled) return
  const rest: ScenarioLinkSettings = { ...settings.value }
  delete rest.switchRules
  emit('update:modelValue', next.length > 0 ? { ...rest, switchRules: next } : rest)
}

/** 新增一条距离规则，默认取第一条链路的端点，编号取未占用的最小序号。 */
function addRule(): void {
  const first = props.links[0]
  let index = rules.value.length + 1
  while (rules.value.some(rule => rule.id === `RULE-${index}`)) index += 1
  emitRules([...rules.value, {
    id: `RULE-${index}`, enabled: true, trigger: 'DISTANCE_ABOVE',
    sourcePlatformId: first?.sourcePlatformId ?? '', targetPlatformId: first?.targetPlatformId ?? '',
    toLinkId: first?.id ?? '', distanceThresholdM: 200_000,
  }])
}

/** 修改第 index 条规则；切换条件类型时清除另一类条件的参数，端点变化后清除不再匹配的目标链路。 */
function updateRule(index: number, patch: Partial<LinkSwitchRule>): void {
  const next = rules.value.map(rule => ({ ...rule }))
  const rule = { ...next[index]!, ...patch }
  if (patch.trigger !== undefined) {
    if (isDistance(patch.trigger)) { delete rule.jammerId; rule.distanceThresholdM ??= 200_000 }
    else { delete rule.distanceThresholdM; rule.jammerId ??= props.jammers[0]?.id ?? '' }
  }
  if ((patch.sourcePlatformId !== undefined || patch.targetPlatformId !== undefined)
    && !candidateLinks(rule).some(link => link.id === rule.toLinkId)) rule.toLinkId = candidateLinks(rule)[0]?.id ?? ''
  next[index] = rule
  emitRules(next)
}

function removeRule(index: number): void {
  emitRules(rules.value.filter((_, position) => position !== index))
}

/** 切换目标只能是连接同一对源、目标平台的链路。 */
function candidateLinks(rule: LinkSwitchRule): Link[] {
  return props.links.filter(link => link.sourcePlatformId === rule.sourcePlatformId && link.targetPlatformId === rule.targetPlatformId)
}

function linkLabel(link: Link): string {
  const type = props.typeOptions.find(option => option.value === link.type)?.label ?? link.type
  return `${type}（${link.id}）`
}
</script>

<template>
  <div data-testid="link-settings">
    <el-button size="small" :disabled="disabled" data-testid="open-link-settings" @click="emit('update:dialogVisible', true)">链路设置</el-button>
  </div>
  <el-dialog :model-value="dialogVisible" class="link-settings-dialog" title="链路设置" width="max(80vw, min(760px, calc(100vw - 2rem)))" top="5vh"
    destroy-on-close append-to-body data-testid="link-settings-dialog" @closed="resetDrag" @update:model-value="emit('update:dialogVisible', $event)">
    <el-form label-position="top" :disabled="disabled" class="link-settings__fields">
      <!-- 左列：选路策略与全局计算参数；右列：热链与切换规则（可增删的列表，内容较长）。 -->
      <div class="link-settings__column" data-testid="link-settings-left">
      <div class="link-settings__strategy">
        <div class="link-settings__heading">链路优先级 <small>拖拽排序，越靠上优先级越高</small></div>
        <ol class="link-settings__priority" aria-label="链路优先级，从高到低">
          <li v-for="(type, index) in settings.priority" :key="type"
            :class="{ 'is-dragging': draggedType === type, 'is-drop-target': !disabled && dropTarget === type && draggedType !== type }"
            @dragover.prevent="!disabled && draggedType !== null && (dropTarget = type)" @drop.prevent="dropPriority(index)">
            <button type="button" class="link-settings__priority-item" :disabled="disabled" :draggable="!disabled"
              :data-testid="`link-priority-${index}`"
              :aria-label="`${typeOptions.find(option => option.value === type)?.label ?? type}，优先级 ${index + 1}，使用上下方向键调整`"
              title="拖拽调整顺序，也可使用上下方向键"
              @dragstart="startDrag(type, $event)" @dragend="resetDrag"
              @keydown.up.prevent="movePriority(type, index - 1)" @keydown.down.prevent="movePriority(type, index + 1)">
              <svg class="link-settings__drag-handle" viewBox="0 0 16 20" aria-hidden="true" fill="currentColor">
                <circle v-for="n in 6" :key="n" :cx="n % 2 ? 5 : 11" :cy="4 + Math.floor((n - 1) / 2) * 6" r="1.5" />
              </svg>
              <span class="link-settings__rank">{{ index + 1 }}</span>
              <span>{{ typeOptions.find(option => option.value === type)?.label ?? type }}</span>
              <small v-if="index === 0">最高</small>
            </button>
          </li>
        </ol>
      </div>
      <el-form-item label="本场景选用卫星">
        <el-select :model-value="settings.enabledSatellites.TIANTONG ? 'TIANTONG' : settings.enabledSatellites.SHENTONG ? 'SHENTONG' : undefined"
          placeholder="请先在节点配置中配置卫星" aria-label="本场景选用卫星" data-testid="link-relay-satellite" @change="selectSatellite">
          <el-option v-for="satellite in satellites" :key="satellite.value" :value="satellite.value" :label="satellite.label"
            :disabled="!platforms.some(p => p.type === 'COMMUNICATION_SATELLITE' && p.satelliteType === satellite.value)" />
        </el-select>
      </el-form-item>
      <el-form-item label="防乒乓滞回时间（秒）">
        <el-input-number :model-value="settings.switchCooldownS" :min="0" :step="1" controls-position="right"
          data-testid="link-switch-cooldown" @update:model-value="setCooldown" />
      </el-form-item>
      <section class="link-settings__rules" data-testid="channel-encoding-settings" aria-labelledby="channel-encoding-title">
        <div class="link-settings__heading">
          <span id="channel-encoding-title">编码方案（全局）</span>
          <small>channel_encoding_scheme，用于链路计算中的干扰余量</small>
        </div>
        <el-form-item label="信道编码">
          <el-select :model-value="linkCalc.channelEncodingScheme" data-testid="link-calc-channelEncodingScheme"
            @update:model-value="updateLinkCalc({ channelEncodingScheme: $event })">
            <el-option v-for="option in CHANNEL_ENCODING_OPTIONS" :key="option.value" :value="option.value" :label="option.label" />
          </el-select>
        </el-form-item>
      </section>
      <section class="link-settings__rules" data-testid="link-calc-settings" aria-labelledby="link-calc-title">
        <div class="link-settings__heading">
          <span id="link-calc-title">链路计算阈值（全局）</span>
          <small>写入后方节点 link_calc，供对接方链路计算使用</small>
        </div>
        <div class="link-settings__rule-grid">
          <el-form-item v-for="field in thresholdFields" :key="field.key" :label="field.label">
            <el-input :model-value="String(linkCalc[field.key])" placeholder="如 1e-5" :data-testid="`link-calc-${field.key}`"
              @change="setThreshold(field.key, $event)" />
          </el-form-item>
          <el-form-item :label="`干扰圈半径（km，${JAMMING_RANGE_KM.min}～${JAMMING_RANGE_KM.max}）`">
            <el-input-number :model-value="linkCalc.jammingRangeKm" :min="JAMMING_RANGE_KM.min" :max="JAMMING_RANGE_KM.max" controls-position="right"
              data-testid="link-calc-jammingRangeKm" @update:model-value="updateLinkCalc({ jammingRangeKm: $event ?? Number.NaN })" />
          </el-form-item>
        </div>
      </section>
      </div>
      <div class="link-settings__column" data-testid="link-settings-right">
      <section class="link-settings__rules" data-testid="hot-link-settings" aria-labelledby="hot-link-title">
        <div class="link-settings__heading">
          <span id="hot-link-title">热链配置（全局）</span>
          <small data-testid="hot-link-state">{{ settings.hotLinks ? '已手动调整' : '自动生成' }}</small>
          <el-button v-if="settings.hotLinks" link type="primary" data-testid="hot-link-reset" @click="emitHotLinks(undefined)">恢复自动串联</el-button>
        </div>
        <el-form-item label="热链终点平台类型（end_platform_type）">
          <el-select :model-value="hotLinks.endPlatformType" data-testid="hot-link-end-type"
            @update:model-value="emitHotLinks({ ...hotLinks, endPlatformType: $event })">
            <el-option v-for="type in HOT_LINK_END_PLATFORM_TYPES" :key="type" :value="type" :label="hotEndLabels[type]" />
          </el-select>
        </el-form-item>
        <div v-for="group in hotDirections" :key="group.key" class="link-settings__hot-group" :data-testid="`hot-link-${group.key}`">
          <div class="link-settings__heading"><span>{{ group.label }}</span></div>
          <p v-if="hotLinks[group.key].length === 0" class="link-settings__empty">没有同方向的已启用链路。</p>
          <div v-for="(chain, index) in hotLinks[group.key]" :key="`${group.key}-${index}`" class="link-settings__rule">
            <div class="link-settings__rule-head">
              <strong>link{{ index + 1 }}</strong>
              <el-button link type="danger" :data-testid="`hot-link-${group.key}-${index}-remove`" @click="updateChain(group.key, index, null)">删除</el-button>
            </div>
            <el-select :model-value="chain" multiple placeholder="按路径顺序选择链路" style="width: 100%" :data-testid="`hot-link-${group.key}-${index}`"
              @update:model-value="updateChain(group.key, index, $event)">
              <el-option v-for="link in links.filter(item => item.direction === group.direction)" :key="link.id" :value="link.id" :label="linkLabel(link)" />
            </el-select>
            <small class="link-settings__empty">{{ chainPath(chain) }}</small>
            <small v-if="hotLinkChainError(chain, links, group.direction)" class="link-settings__error">{{ hotLinkChainError(chain, links, group.direction) }}</small>
          </div>
          <el-button size="small" :disabled="disabled || !links.some(item => item.direction === group.direction)"
            :data-testid="`hot-link-${group.key}-add`" @click="updateChain(group.key, hotLinks[group.key].length, [])">新增热链</el-button>
        </div>
      </section>
      <section class="link-settings__rules" data-testid="link-switch-rules" aria-labelledby="link-switch-rules-title">
        <div class="link-settings__heading">
          <span id="link-switch-rules-title">阶段切换规则</span>
          <small>条件满足时，源到目标的业务改走指定链路；两次切换间隔不少于滞回时间</small>
        </div>
        <p v-if="rules.length === 0" class="link-settings__empty">未配置规则时，仿真全程使用优先级最高的链路。</p>
        <div v-for="(rule, index) in rules" :key="rule.id" class="link-settings__rule" :data-testid="`switch-rule-${index}`">
          <div class="link-settings__rule-head">
            <strong>{{ rule.id }}</strong>
            <el-switch :model-value="rule.enabled !== false" active-text="启用" inactive-text="停用"
              :data-testid="`switch-rule-${index}-enabled`" @update:model-value="updateRule(index, { enabled: Boolean($event) })" />
            <el-button link type="danger" :data-testid="`switch-rule-${index}-remove`" @click="removeRule(index)">删除</el-button>
          </div>
          <div class="link-settings__rule-grid">
            <el-form-item label="切换条件">
              <el-select :model-value="rule.trigger" :data-testid="`switch-rule-${index}-trigger`"
                @update:model-value="updateRule(index, { trigger: $event })">
                <el-option v-for="option in triggerOptions" :key="option.value" :value="option.value" :label="option.label" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="isDistance(rule.trigger)" label="距离阈值（km）">
              <el-input-number :model-value="rule.distanceThresholdM === undefined ? undefined : rule.distanceThresholdM / 1000"
                :min="0" :step="10" controls-position="right" :data-testid="`switch-rule-${index}-distanceThresholdM`"
                @update:model-value="updateRule(index, { distanceThresholdM: $event === undefined || $event === null ? Number.NaN : $event * 1000 })" />
            </el-form-item>
            <el-form-item v-else label="干扰设备">
              <el-select :model-value="rule.jammerId" placeholder="请选择干扰设备" :data-testid="`switch-rule-${index}-jammerId`"
                @update:model-value="updateRule(index, { jammerId: $event })">
                <el-option v-for="jammer in jammers" :key="jammer.id" :value="jammer.id"
                  :label="`${jammer.id}（${scenarioPlatformLabel(platforms, jammer.platformId)}）`" />
              </el-select>
            </el-form-item>
            <el-form-item label="源平台">
              <el-select :model-value="rule.sourcePlatformId" filterable :data-testid="`switch-rule-${index}-sourcePlatformId`"
                @update:model-value="updateRule(index, { sourcePlatformId: $event })">
                <el-option v-for="platform in platforms" :key="platform.id" :value="platform.id" :label="scenarioPlatformLabel(platforms, platform.id)" />
              </el-select>
            </el-form-item>
            <el-form-item label="目标平台">
              <el-select :model-value="rule.targetPlatformId" filterable :data-testid="`switch-rule-${index}-targetPlatformId`"
                @update:model-value="updateRule(index, { targetPlatformId: $event })">
                <el-option v-for="platform in platforms" :key="platform.id" :value="platform.id" :label="scenarioPlatformLabel(platforms, platform.id)" />
              </el-select>
            </el-form-item>
            <el-form-item class="link-settings__rule-wide" label="切换到链路">
              <el-select :model-value="rule.toLinkId" placeholder="该源、目标平台之间没有链路" :data-testid="`switch-rule-${index}-toLinkId`"
                @update:model-value="updateRule(index, { toLinkId: $event })">
                <el-option v-for="link in candidateLinks(rule)" :key="link.id" :value="link.id" :label="linkLabel(link)" />
              </el-select>
            </el-form-item>
          </div>
        </div>
        <el-button size="small" :disabled="disabled || links.length === 0" data-testid="add-switch-rule" @click="addRule">新增规则</el-button>
      </section>
      </div>
    </el-form>
    <template #footer>
      <el-button type="primary" data-testid="close-link-settings" @click="emit('update:dialogVisible', false)">完成</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 弹框高度不超过视口，标题与底部按钮固定，内容区单独滚动。 */
:global(.link-settings-dialog) { display: flex; flex-direction: column; max-height: 90vh; }
:global(.link-settings-dialog .el-dialog__body) { min-height: 0; overflow-y: auto; }
.link-settings__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 0 2rem; }
.link-settings__column { display: grid; align-content: start; gap: 0.75rem; min-width: 0; }
.link-settings__strategy { min-width: 0; margin-bottom: 1rem; }
.link-settings__heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
.link-settings__heading small, .link-settings__priority-item small { color: var(--console-text-muted); font-size: 12px; }
.link-settings__priority { display: grid; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
.link-settings__priority-item { display: flex; align-items: center; gap: 0.65rem; width: 100%; padding: 0.45rem 0.65rem; border: 1px solid var(--console-border); border-radius: 4px; background: var(--console-bg-elevated); color: var(--console-text); font: inherit; text-align: left; cursor: grab; }
.link-settings__priority-item small { margin-left: auto; }
.link-settings__priority-item:active { cursor: grabbing; }
.link-settings__priority-item:disabled { opacity: 0.5; cursor: not-allowed; }
.link-settings__priority-item:focus-visible { outline: 2px solid var(--console-cyan); outline-offset: 2px; }
.link-settings__priority-item:not(:disabled):hover, .is-drop-target .link-settings__priority-item { border-color: var(--console-cyan); }
.is-dragging { opacity: 0.5; }
.link-settings__drag-handle { width: 16px; height: 20px; flex-shrink: 0; color: var(--console-text-muted); }
.link-settings__rank { min-width: 1.25rem; color: var(--console-cyan); font-variant-numeric: tabular-nums; }
.link-settings__fields :deep(.el-input-number) { width: 100%; }
.link-settings__rules { display: grid; gap: 0.75rem; min-width: 0; }
.link-settings__empty { margin: 0; color: var(--console-text-muted); font-size: 12px; }
.link-settings__error { color: var(--el-color-danger); font-size: 12px; }
.link-settings__hot-group { display: grid; gap: 0.5rem; min-width: 0; }
.link-settings__hot-group .link-settings__rule small { display: block; margin: 0.25rem 0; }
.link-settings__rule { min-width: 0; padding: 0.65rem 0.75rem 0.25rem; border: 1px solid var(--console-border); border-radius: 4px; }
.link-settings__rule-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
.link-settings__rule-head .el-button { margin-left: auto; }
.link-settings__rule-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 1rem; }
.link-settings__rule-grid :deep(.el-select) { width: 100%; }
.link-settings__rule-wide { grid-column: 1 / -1; }
@media (max-width: 960px) {
  .link-settings__fields { grid-template-columns: 1fr; }
}
@media (max-width: 600px) {
  .link-settings__rule-grid { grid-template-columns: 1fr; }
  .link-settings__rule-wide { grid-column: auto; }
}
</style>
