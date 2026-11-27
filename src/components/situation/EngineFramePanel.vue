<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { EngineLinkSegment, EnginePathNode, LinkType, Link, EngineFrameSnapshot } from '../../contracts/domain-models'
import { useRuntimeQualityStore, type EngineAlarmContext } from '../../stores/runtime-quality'
import { useSimulationStore } from '../../stores/simulation'
import { engineSegmentDisplayStatus } from '../../features/situation/engine-link-statuses'
import { engineSegmentLossRows } from '../../features/reports/engine-segment-details'
import { reportLinkLabel } from '../../features/reports/report-link-label'
import { formatSimulationTime, LINK_TYPE_LABELS, PLATFORM_TYPE_LABELS, qualityNodeOptionLabel } from '../../features/situation/situation-model'
import { includesEngineSimulationTime, resolveEngineSwitchHighlights, type EngineRouteResolution, type EngineSwitchHighlights } from '../../features/situation/engine-route-highlights'
import type { EngineReplayEvidence } from '../../features/replays/engine-replay'
import type { SituationMapNode } from '../../features/situation/initial-nodes'
import { nodeCategory } from '../../config/map.config'
import { wattsToDbm } from '../../features/scenarios/jammer-settings'
import { formatCommunicationPortLabel, formatMessageTypeLabel } from '../../features/situation/file-message-links'
import { describeSwitchReasonThreshold, summarizeSegmentJammingEvidence, type LinkCalcThresholds } from '../../features/situation/engine-narrative'

const props = defineProps<{
  section: 'quality' | 'decisions' | 'jammers' | 'events'
  selectedLinkId?: string
  berThresholds?: LinkCalcThresholds
  links?: Pick<Link, 'id' | 'type' | 'sourcePlatformId' | 'targetPlatformId'>[]
  evidence?: EngineReplayEvidence
  nodeNames?: Record<string, string>
  sourceLabel?: string
  nodePlatforms?: readonly Pick<SituationMapNode, 'platformId' | 'name' | 'type'>[]
}>()
const sourceLabel = computed(() => props.evidence ? '历史引擎数据' : props.sourceLabel ?? '引擎数据（状态未确认）')
const qualityStatusLabels: Record<string, string> = {
  '引擎实时数据': '实时更新',
  '最后收到的引擎数据（等待新帧）': '等待更新',
  '最后收到的引擎数据（连接中断）': '连接中断',
  '暂停展示的引擎数据': '已暂停',
  '历史引擎数据（运行已结束）': '已结束',
  '历史引擎数据': '历史回放',
  '引擎数据（状态未确认）': '状态未确认',
}
const qualityStatus = computed(() => qualityStatusLabels[sourceLabel.value] ?? '状态未确认')
const runtimeQuality = useRuntimeQualityStore()
const quality = computed(() => props.evidence ?? runtimeQuality)
const simulation = useSimulationStore()
const qualityView = ref<'segments' | 'paths'>('segments')
const nodeFilter = ref('')
const linkFilter = ref('')
const typeFilter = ref<LinkType | ''>('')
const timeRangeStart = ref<number | undefined>()
const timeRangeEnd = ref<number | undefined>()
const value = (v: string | number | null | undefined, unit = '') => v == null || v === '' ? '暂无数据' : `${typeof v === 'number' ? Number(v.toPrecision(8)) : v}${unit}`
const scenePlatform = (id: string | null) => props.evidence || simulation.run?.fileSource
  ? undefined : simulation.selectedScene?.config.platforms.find(platform => platform.id === id)
const name = (id: string | null) => props.evidence ? props.nodeNames?.[id ?? ''] ?? value(id)
  : scenePlatform(id)?.name ?? value(id)
function segmentEvidence(segment: EngineLinkSegment) {
  return summarizeSegmentJammingEvidence(
    segment,
    (platformId, engineName) => {
      const resolved = name(platformId)
      return resolved !== '暂无数据' ? resolved : (engineName ?? '暂无数据')
    },
    quality.value.engineFrame?.jammers,
  )
}
function nodeFilterLabel(id: string, index: number): string {
  const displayName = name(id)
  const platform = props.nodePlatforms?.find(item => item.platformId === id)
  const type = scenePlatform(id)?.type ?? (platform && nodeCategory(platform))
  return qualityNodeOptionLabel(displayName === id ? platform?.name ?? id : displayName, index, id, type)
}
function portLabel(port: string | null | undefined): string {
  if (!port) return ''
  if (port === 'laser_link') return '激光通信'
  return formatCommunicationPortLabel(port)
}
/** 将节点与出/入端口序列整理为“节点 → 通信手段 → 节点”可视化跳点，消除冗余的“入/出：暂无数据”。 */
function routeHops(nodes: EnginePathNode[]): Array<{ nodeName: string; linkLabel: string }> {
  return nodes.map((node, index) => {
    const next = nodes[index + 1]
    if (!next) return { nodeName: name(node.platformId), linkLabel: '' }
    const out = portLabel(node.outPort)
    const nextIn = portLabel(next.inPort)
    const linkLabel = out && nextIn && out !== nextIn ? `${out} / ${nextIn}` : (out || nextIn)
    return { nodeName: name(node.platformId), linkLabel }
  })
}
const thresholdNodes = computed<readonly Pick<SituationMapNode, 'platformId' | 'name' | 'type'>[]>(() => {
  if (props.nodePlatforms?.length) return props.nodePlatforms
  const platforms = simulation.selectedScene?.config.platforms ?? []
  return platforms.map(platform => ({ platformId: platform.id, name: platform.name, type: platform.type }))
})
function switchReasonThresholds(
  item: (typeof quality.value.engineSwitches)[number],
  reason: { linkId: string | null; reasons: string[] },
): string[] {
  const frameLinks = item.frameId === quality.value.engineFrame?.frameId ? quality.value.engineFrame.links : []
  const alarms = quality.value.engineAlarms
    .filter(entry => entry.frameId === item.frameId)
    .map(entry => entry.alarm)
  const details: string[] = []
  for (const code of reason.reasons) {
    if (!code) continue
    const text = describeSwitchReasonThreshold(code, reason.linkId, item.route, frameLinks, thresholdNodes.value, props.berThresholds, alarms)
    if (text && !details.includes(text)) details.push(text)
  }
  return details
}
/** 业务枚举去重并翻译为中文标签。 */
function businessLabels(types: readonly string[]): string[] {
  return [...new Set(types.filter(Boolean).map(formatMessageTypeLabel))]
}
function formatRouteMetric(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '暂无数据'
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)))
}
function shortIdentifier(id: string | null | undefined): string {
  if (!id) return '暂无数据'
  return id.length > 16 ? `${id.slice(0, 8)}…` : id
}
const labels: Record<string, string> = { UP: '正常', DEGRADED: '劣化', DOWN: '中断', UNKNOWN: '未知',
  BARRAGE: '宽带压制', SPOT: '瞄准式', SWEEP: '扫频', DETECTED: '已侦测', NOT_DETECTED: '未侦测到目标',
  UNDETECTED: '未侦测到目标', NO_TARGET: '未侦测到目标', IDLE: '未侦测到目标', NONE: '未侦测到目标',
  ON: '开启', OFF: '关闭', JAM_ON: '起扰', JAM_OFF: '停扰',
  beyond_weitch: '超视距切换', ber_switch: '链路劣化切换', alarm_switch: '链路告警切换', into_detect: '进入探测圈',
  into_jamm: '进入干扰圈', release_detect: '离开探测圈', release_jamm: '离开干扰圈', esm_info: '敌方探测消息', bey_switch: '超视距切换' }
const label = (v: string | null | undefined) => v == null ? '暂无数据' : labels[v] ?? v
const ENGINE_PLATFORM_TYPE_LABELS: Record<string, string> = {
  ...PLATFORM_TYPE_LABELS,
  UAV: '无人机',
  MISSION_UAV: '空中无人作业节点',
  MISSION_UAV_PLATFORM: '空中无人作业节点',
  RELAY_UAV: '高空前出中继节点',
  RELAY_UAV_PLATFORM: '高空前出中继节点',
  COMMAND_VEHICLE: '地面无人集群指挥车',
  COMMAND_VEHICLE_PLATFORM: '地面无人集群指挥车',
  REAR_COMM_PLATFORM: '后方指挥节点',
  TIAN_TONG_SAT: '通信卫星（天通）',
  SHEN_TONG_SAT: '通信卫星（神通）',
  SAT: '通信卫星',
  SATELLITE: '通信卫星',
  GROUND_JAMMER_STATION: '地面干扰设备',
}
const UNDETECTED_STATUSES = new Set(['NOT_DETECTED', 'UNDETECTED', 'NO_TARGET', 'NONE', 'IDLE'])
const isJammerDetected = (jammer: EngineFrameSnapshot['jammers'][number]) =>
  jammer.detectStatus === 'DETECTED' || (jammer.detectStatus == null && jammer.detections.length > 0)
const detectStatusLabel = (jammer: EngineFrameSnapshot['jammers'][number]) => {
  if (jammer.detectStatus == null || jammer.detectStatus === '') return jammer.detections.length > 0 ? '已侦测' : '未侦测到目标'
  if (UNDETECTED_STATUSES.has(jammer.detectStatus)) return '未侦测到目标'
  return label(jammer.detectStatus)
}
const jammerModeLabel = (mode: string | null | undefined) =>
  label(mode === 'broadband' ? 'BARRAGE' : mode === 'spot' ? 'SPOT' : mode === 'sweep' ? 'SWEEP' : mode)
const platformTypeLabel = (platformType: string | null | undefined) =>
  platformType == null || platformType === '' ? '暂无数据' : ENGINE_PLATFORM_TYPE_LABELS[platformType] ?? platformType
const formatCoord = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '暂无数据' : `${Number(v.toFixed(4))}°`
const formatAltitude = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? '暂无数据' : `${Number(v.toFixed(1))} m`
const formatKm = (meters: number | null | undefined) =>
  meters == null || !Number.isFinite(meters) ? '暂无数据' : `${Number((meters / 1000).toFixed(2))} km`
const formatPercent = (prob: number | null | undefined) =>
  prob == null || !Number.isFinite(prob) ? '暂无数据' : `${Number((prob * 100).toFixed(1))}%`
function formatFrequencyHz(raw: number | null | undefined): string {
  if (raw == null || !Number.isFinite(raw)) return '暂无数据'
  if (raw <= 0) return '0 Hz'
  if (raw >= 1e9) return `${Number((raw / 1e9).toPrecision(6))} GHz`
  if (raw >= 1e6) return `${Number((raw / 1e6).toPrecision(6))} MHz`
  if (raw >= 1e3) return `${Number((raw / 1e3).toPrecision(6))} kHz`
  return `${Number(raw.toPrecision(6))} Hz`
}
function formatJamFrequency(raw: number | null | undefined): string {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return ''
  if (raw >= 1e9) return `${Number((raw / 1e9).toPrecision(6))} GHz`
  if (raw >= 1e6) return `${Number((raw / 1e6).toPrecision(6))} MHz`
  if (raw >= 1e3) return `${Number((raw / 1e3).toPrecision(6))} kHz`
  return `${Number(raw.toPrecision(6))} GHz`
}
function detectionProbabilityText(detection: EngineFrameSnapshot['jammers'][number]['detections'][number]): string {
  if (detection.probability != null && Number.isFinite(detection.probability)) return formatPercent(detection.probability)
  const probs = detection.targets.map(target => target.probability).filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
  if (!probs.length) return '暂无数据'
  const min = Math.min(...probs), max = Math.max(...probs)
  return Math.abs(max - min) < 1e-9 ? formatPercent(min) : `${formatPercent(min)} ～ ${formatPercent(max)}`
}
/** 同时展示 dBm 与 W，方便与场景配置（-10～+65 dBm）逐档核对。 */
function formatJammerPower(watts: number | null | undefined): string {
  if (watts == null || !Number.isFinite(watts)) return '暂无数据'
  if (watts <= 0) return '0 W'
  const dbm = Number(wattsToDbm(watts).toFixed(1))
  const sign = dbm > 0 ? '+' : ''
  return `${sign}${dbm} dBm（${Number(watts.toPrecision(6))} W）`
}
const JAMMER_LIFECYCLE_EVENTS = new Set(['into_jamm', 'release_jamm', 'into_detect', 'release_detect'])
function jammerEventsFor(jammer: EngineFrameSnapshot['jammers'][number]) {
  const keys = new Set([jammer.platformId, jammer.name].filter((id): id is string => Boolean(id)))
  const singleJammer = (quality.value.engineFrame?.jammers.length ?? 0) === 1
  return quality.value.engineEvents
    .filter(item => item.event.type !== null && JAMMER_LIFECYCLE_EVENTS.has(item.event.type)
      && (item.event.jammerIds.some(id => keys.has(id)) || (item.event.jammerIds.length === 0 && singleJammer)))
    .slice(-8)
    .reverse()
}
const expandedJammerEvents = ref<Record<string, boolean>>({})
function jammerEventKey(jammerKey: string | number, entry: ReturnType<typeof jammerEventsFor>[number]): string {
  return `${jammerKey}:${entry.frameId}:${entry.simulationTime}:${entry.event.type ?? ''}:${entry.event.uavIds.join(',')}`
}
function toggleJammerEvent(key: string): void {
  expandedJammerEvents.value = { ...expandedJammerEvents.value, [key]: !expandedJammerEvents.value[key] }
}
function jammerEventTargetsText(uavIds: readonly string[]): string {
  return uavIds.map(name).join('、') || '—'
}
function jammerEventTagType(type: string | null): 'danger' | 'success' | 'warning' | 'info' {
  if (type === 'into_jamm') return 'danger'
  if (type === 'release_jamm') return 'success'
  if (type === 'into_detect') return 'warning'
  return 'info'
}

const configuredLinks = computed(() => props.links ?? (props.evidence ? [] : simulation.selectedScene?.config.links ?? []))
const segmentLinkIds = computed(() => new Set(quality.value.engineFrame?.links.flatMap(link => link.linkIds) ?? []))
const selectableLinks = computed(() => configuredLinks.value.filter(link => segmentLinkIds.value.has(link.id)))
const unboundSegments = computed(() => [...new Map((quality.value.engineFrame?.links ?? [])
  .filter(segment => !selectableLinks.value.some(link => segment.linkIds.includes(link.id)))
  .map(segment => [segment.linkId, segment])).values()])
const selectableTypes = computed(() => [...new Set(selectableLinks.value.map(link => link.type))])
const selectableNodes = computed(() => [...new Set((quality.value.engineFrame?.links ?? []).flatMap(link => [link.sourcePlatformId, link.targetPlatformId]).filter((id): id is string => id !== null))])
const nodeLabels = computed(() => {
  const ids = new Set(selectableNodes.value)
  for (const link of selectableLinks.value) {
    if (link.sourcePlatformId) ids.add(link.sourcePlatformId)
    if (link.targetPlatformId) ids.add(link.targetPlatformId)
  }
  return new Map([...ids].map((id, index) => [id, nodeFilterLabel(id, index)]))
})
const nodeLabel = (id: string | null) => nodeLabels.value.get(id ?? '') ?? '未知节点'
const selectedType = (link: EngineLinkSegment): LinkType[] => link.linkIds.flatMap(id => configuredLinks.value.filter(configured => configured.id === id).map(configured => configured.type))
const statusTagTypes = { UP: 'success', DEGRADED: 'warning', DOWN: 'danger', UNKNOWN: 'info' } as const
const displayedStatus = (link: EngineLinkSegment) => engineSegmentDisplayStatus(link, props.berThresholds)
const segmentKey = (link: EngineLinkSegment) => JSON.stringify([quality.value.engineFrame?.runId, quality.value.engineFrame?.engineEpoch,
  link.linkId, link.sourcePlatformId, link.sourcePort, link.targetPlatformId, link.targetPort])
const filteredLinks = computed(() => (quality.value.engineFrame?.links ?? []).filter(link =>
  (!nodeFilter.value || link.sourcePlatformId === nodeFilter.value || link.targetPlatformId === nodeFilter.value)
  && (!linkFilter.value || link.linkId === linkFilter.value || link.linkIds.includes(linkFilter.value))
  && (!typeFilter.value || selectedType(link).includes(typeFilter.value))
  && includesEngineSimulationTime(quality.value.engineFrame?.simulationTime ?? NaN, timeRangeStart.value, timeRangeEnd.value),
))
watch(() => props.selectedLinkId, value => {
  linkFilter.value = selectableLinks.value.some(link => link.id === value) || unboundSegments.value.some(link => link.linkId === value) ? value ?? '' : ''
  if (linkFilter.value) qualityView.value = 'segments'
}, { immediate: true })
const switchHighlights = (oldNodes: EnginePathNode[], newNodes: EnginePathNode[]) => resolveEngineSwitchHighlights(quality.value.engineFrame, oldNodes, newNodes)
type SwitchEntry = { frameId: number; simulationTime: number; route: EngineFrameSnapshot['routing']['switches'][number]; resolution?: EngineSwitchHighlights }
/** 优先使用接收切换事件帧时冻结的解析结果；回放证据无冻结结果时仅对同帧在现有帧上解析，历史项明确缺失。 */
const switchResolution = (item: SwitchEntry): EngineSwitchHighlights | undefined => {
  if (item.resolution) return item.resolution
  const frame = quality.value.engineFrame
  return frame && item.frameId === frame.frameId ? switchHighlights(item.route.oldNodes, item.route.nodes) : undefined
}
/** 将配置链路 ID 或引擎段 ID 转为直观的中文“手段（源节点 → 目标节点）”，避免向用户暴露英文下划线编号。 */
function linkDisplayName(linkId: string | null | undefined): string {
  if (!linkId) return '暂无数据'
  const seg = quality.value.engineFrame?.links.find(item => item.linkId === linkId || item.linkIds.includes(linkId))
  const configured = configuredLinks.value.find(link => link.id === linkId)
    ?? (seg ? configuredLinks.value.find(link => seg.linkIds.includes(link.id)) : undefined)
  const sourceId = configured?.sourcePlatformId ?? seg?.sourcePlatformId ?? null
  const targetId = configured?.targetPlatformId ?? seg?.targetPlatformId ?? null
  const typeLabel = configured ? LINK_TYPE_LABELS[configured.type] : portLabel(seg?.sourcePort || seg?.targetPort)
  if (sourceId || targetId) {
    const endpoints = `${name(sourceId)} → ${name(targetId)}`
    return typeLabel ? `${typeLabel}（${endpoints}）` : endpoints
  }
  return typeLabel || shortIdentifier(linkId)
}
const resolutionLabel = (title: string, resolution: EngineRouteResolution) => {
  if (resolution.totalHops === 0) return `${title}：无对应链路`
  const items = resolution.linkIds.map(linkDisplayName).join('、') || '无'
  if (resolution.resolvedHops === resolution.totalHops) {
    return `${title}（已匹配 ${resolution.resolvedHops}/${resolution.totalHops} 段）：${items}`
  }
  return `${title}（部分匹配 ${resolution.resolvedHops}/${resolution.totalHops} 段，其余未匹配）：${items}`
}

type AlarmEntry = {
  frameId: number
  simulationTime: number
  alarm: EngineFrameSnapshot['routing']['alarms'][number]
  context?: EngineAlarmContext
}
interface MergedAlarm {
  key: string
  alarm: AlarmEntry['alarm']
  context?: EngineAlarmContext
  firstTime: number
  latestTime: number
  count: number
}
/** 合并同路径、同链路、同内容的重复告警，保留起止时刻与累计触发次数，按最新触发时刻倒序展示。 */
const mergedAlarms = computed<MergedAlarm[]>(() => {
  const grouped = new Map<string, MergedAlarm>()
  for (const entry of quality.value.engineAlarms as AlarmEntry[]) {
    const key = JSON.stringify([entry.alarm.pathId ?? '', entry.alarm.linkId ?? '', entry.alarm.message?.trim() ?? ''])
    const existing = grouped.get(key)
    if (existing) {
      existing.count += 1
      if (entry.simulationTime < existing.firstTime) existing.firstTime = entry.simulationTime
      if (entry.simulationTime >= existing.latestTime) {
        existing.latestTime = entry.simulationTime
        existing.alarm = entry.alarm
        if (entry.context) {
          existing.context = {
            link: entry.context.link ?? existing.context?.link,
            path: entry.context.path ?? existing.context?.path,
          }
        }
      } else if (entry.context) {
        existing.context = {
          link: existing.context?.link ?? entry.context.link,
          path: existing.context?.path ?? entry.context.path,
        }
      }
    } else {
      grouped.set(key, {
        key,
        alarm: entry.alarm,
        context: entry.context,
        firstTime: entry.simulationTime,
        latestTime: entry.simulationTime,
        count: 1,
      })
    }
  }
  return [...grouped.values()].sort((a, b) => b.latestTime - a.latestTime)
})
function alarmLinkLabel(item: MergedAlarm): string {
  const ctxLink = item.context?.link
  if (ctxLink) {
    const configured = configuredLinks.value.find(link => ctxLink.linkIds.includes(link.id))
    const typeLabel = configured ? LINK_TYPE_LABELS[configured.type] : portLabel(ctxLink.sourcePort || ctxLink.targetPort)
    const sourceId = configured?.sourcePlatformId ?? ctxLink.sourcePlatformId
    const targetId = configured?.targetPlatformId ?? ctxLink.targetPlatformId
    if (sourceId || targetId) {
      const endpoints = `${name(sourceId)} → ${name(targetId)}`
      return typeLabel ? `${typeLabel}（${endpoints}）` : endpoints
    }
    if (typeLabel) return typeLabel
  }
  return item.alarm.linkId ? linkDisplayName(item.alarm.linkId) : ''
}
function alarmPathLabel(item: MergedAlarm): string {
  const path = item.context?.path
    ?? (item.alarm.pathId
      ? quality.value.engineFrame?.initRouting?.find(route => route.pathId === item.alarm.pathId)
        ?? quality.value.engineSwitches.find(entry => entry.route.pathId === item.alarm.pathId || entry.route.oldPathId === item.alarm.pathId)?.route
      : undefined)
  if (!path || (!path.sourcePlatformId && !path.targetPlatformId)) return ''
  const direction = path.direction === 'FORWARD' ? '前向' : '返向'
  return `所属${direction}路径：${name(path.sourcePlatformId)} → ${name(path.targetPlatformId)}`
}
function alarmMessageText(item: MergedAlarm): string {
  const message = item.alarm.message?.trim()
  if (message) return message
  const status = item.context?.link?.status
    ?? (item.alarm.linkId ? quality.value.engineFrame?.links.find(link => link.linkId === item.alarm.linkId || link.linkIds.includes(item.alarm.linkId!))?.status : undefined)
  if (status === 'DOWN') return '链路中断告警（引擎标记该链路段中断）'
  if (status === 'DEGRADED') return '链路劣化告警（链路质量触发告警门限）'
  return '链路质量告警（触发引擎告警门限）'
}
function alarmTimeLabel(item: MergedAlarm): string {
  if (item.count > 1 && item.firstTime !== item.latestTime) {
    return `${formatSimulationTime(item.firstTime)} ～ ${formatSimulationTime(item.latestTime)}`
  }
  return formatSimulationTime(item.latestTime)
}
function alarmTooltip(item: MergedAlarm): string {
  const parts: string[] = []
  if (item.alarm.linkId) parts.push(`链路 ID：${item.alarm.linkId}`)
  if (item.alarm.pathId) parts.push(`路径 ID：${item.alarm.pathId}`)
  return parts.join(' · ')
}
</script>

<template>
  <section v-if="quality.engineFrame" class="engine-evidence" :class="{ 'engine-evidence--quality': section === 'quality', 'quality-card-panel': section === 'quality' }" :data-testid="`engine-${section}`">
    <div v-if="section === 'quality'" class="quality-card-source">
      <el-tooltip :content="`${sourceLabel} · 帧 ${quality.engineFrame.frameId} · ${formatSimulationTime(quality.engineFrame.simulationTime)}。时间范围只筛选当前帧。`" :trigger="['hover', 'focus']" :popper-style="{ maxWidth: '280px', whiteSpace: 'normal', overflowWrap: 'anywhere' }">
        <button type="button" class="engine-evidence__source quality-card-info" data-testid="quality-source">数据时刻：{{ formatSimulationTime(quality.engineFrame.simulationTime).replace('T+ ', '') }} · {{ qualityStatus }}</button>
      </el-tooltip>
    </div>
    <template v-else>
    <p class="engine-evidence__source">{{ sourceLabel }} · 帧 {{ quality.engineFrame.frameId }} · {{ formatSimulationTime(quality.engineFrame.simulationTime) }}</p>
    </template>
    <template v-if="section === 'quality'">
      <el-radio-group v-model="qualityView" class="quality-card-view" aria-label="质量指标类型">
        <el-radio-button value="segments">链路段</el-radio-button>
        <el-radio-button value="paths">整条热链</el-radio-button>
      </el-radio-group>
      <el-form v-if="qualityView === 'segments'" label-position="top" class="engine-evidence__filters quality-card-filters">
        <el-form-item label="节点">
          <el-select v-model="nodeFilter" clearable placeholder="全部节点">
            <el-option v-for="node in selectableNodes" :key="node" :value="node" :label="nodeLabel(node)" />
          </el-select>
        </el-form-item>
        <el-form-item label="链路类型"><el-select v-model="typeFilter" clearable placeholder="全部类型"><el-option v-for="type in selectableTypes" :key="type" :label="LINK_TYPE_LABELS[type]" :value="type" /></el-select></el-form-item>
        <details class="quality-card-advanced">
          <summary>更多筛选<span v-if="linkFilter || timeRangeStart != null || timeRangeEnd != null">（已应用）</span></summary>
          <el-form-item label="链路">
            <el-select v-model="linkFilter" clearable placeholder="全部链路 / 引擎段">
              <el-option v-for="(link, index) in selectableLinks" :key="`link:${link.id}`" :value="link.id"
                :label="reportLinkLabel(link.id, index, link.type, [nodeLabel(link.sourcePlatformId), nodeLabel(link.targetPlatformId)])" />
              <el-option v-for="(link, index) in unboundSegments" :key="`segment:${link.linkId}`" :value="link.linkId"
                :label="`引擎段 · ${reportLinkLabel(link.linkId, index, undefined, [nodeLabel(link.sourcePlatformId), nodeLabel(link.targetPlatformId)])}`" />
            </el-select>
          </el-form-item>
          <el-form-item label="仿真时间范围（秒）"><div class="engine-evidence__time-range"><el-input-number v-model="timeRangeStart" :min="0" :precision="3" controls-position="right" placeholder="起始" /><span>至</span><el-input-number v-model="timeRangeEnd" :min="0" :precision="3" controls-position="right" placeholder="结束" /></div></el-form-item>
        </details>
      </el-form>
      <div v-if="qualityView === 'segments' && filteredLinks.length" class="quality-card-list" role="list" aria-label="引擎链路段质量">
        <article v-for="link in filteredLinks" :key="segmentKey(link)" class="quality-card" role="listitem" :data-link-id="link.linkId">
          <header class="quality-card-heading" :title="`引擎上报：${label(link.status)}`">
            <strong>{{ name(link.sourcePlatformId) }} → {{ name(link.targetPlatformId) }}</strong>
            <el-tag :type="statusTagTypes[displayedStatus(link)]">{{ link.error ? '异常（状态未知）' : label(displayedStatus(link)) }}</el-tag>
          </header>
          <p v-if="link.error" class="quality-card-error" role="alert">{{ link.error }}</p>
          <dl class="quality-card-metrics">
            <div><dt>干信比(GXB)（dB）</dt><dd>{{ value(link.quality.gxbDb) }}</dd></div>
            <div><dt>误码率(BER)</dt><dd>{{ value(link.quality.ber) }}</dd></div>
            <div><dt>发射辐射功率（dBW）</dt><dd>{{ value(link.inputTrace.eirpDbw) }}</dd></div>
            <div><dt>干扰损耗（dB）</dt><dd>{{ value(link.losses.jammingDb) }}</dd></div>
            <div><dt>距离（m）</dt><dd>{{ value(link.distanceM) }}</dd></div>
            <div><dt>抗干扰余量（dB）</dt><dd>{{ value(link.quality.marginDb) }}</dd></div>
            <div><dt>时延（ms）</dt><dd>{{ value(link.quality.delayMs) }}</dd></div>
          </dl>
          <div
            v-if="segmentEvidence(link).shouldShow"
            class="quality-card-evidence"
            :class="{ 'quality-card-evidence--jammed': segmentEvidence(link).isJammed }"
            data-testid="quality-card-evidence"
          >
            <div class="quality-card-evidence__head">
              <strong>{{ segmentEvidence(link).title }}</strong>
            </div>
            <p class="quality-card-evidence__summary">{{ segmentEvidence(link).summary }}</p>
            <ul v-if="segmentEvidence(link).jammers.length" class="quality-card-evidence__jammers">
              <li v-for="jammer in segmentEvidence(link).jammers" :key="jammer.key">
                <span>{{ jammer.jammerName }}</span>
                <span class="quality-card-evidence__meta">
                  <template v-if="jammer.distanceKm !== null">距 {{ jammer.distanceKm.toFixed(2) }} km</template>
                  <template v-if="jammer.eirpDbw !== null"> · EIRP {{ Number(jammer.eirpDbw.toFixed(1)) }} dBW</template>
                  <template v-if="jammer.lossDb !== null"> · 路径损耗 {{ Number(jammer.lossDb.toFixed(2)) }} dB</template>
                </span>
              </li>
            </ul>
          </div>
          <details v-if="!evidence" class="quality-card-details">
            <summary>分项损耗</summary>
            <dl class="quality-card-losses">
              <div v-for="[label, loss] in engineSegmentLossRows(link.losses, { showMissingCombined: true })" :key="label">
                <dt>{{ label }}</dt><dd>{{ loss }}</dd>
              </div>
            </dl>
          </details>
        </article>
      </div>
      <p v-else-if="qualityView === 'segments'">当前帧暂无符合筛选条件的引擎链路段。</p>
      <template v-else>
        <div v-if="quality.engineFrame.pathQuality?.length" class="quality-card-list" role="list" aria-label="整条热链质量">
          <article v-for="(route, index) in quality.engineFrame.pathQuality" :key="index" class="quality-card" role="listitem">
            <header class="quality-card-heading"><strong>热链 ID · {{ value(route.pathId) }}</strong></header>
            <dl class="quality-card-metrics">
              <div><dt>干信比(GXB)（dB）</dt><dd>{{ value(route.gxbDb) }}</dd></div>
              <div><dt>误码率(BER)</dt><dd>{{ value(route.ber) }}</dd></div>
              <div><dt>抗干扰余量（dB）</dt><dd>{{ value(route.marginDb) }}</dd></div>
              <div><dt>时延（ms）</dt><dd>{{ value(route.delayMs) }}</dd></div>
              <div><dt>速率（bit/s）</dt><dd>{{ value(route.rateBps) }}</dd></div>
            </dl>
          </article>
        </div>
        <p v-else>暂无数据</p>
      </template>
    </template>
    <template v-else-if="section === 'decisions'">
      <section class="decision-group" aria-label="初始热链">
        <header class="decision-group__head">
          <h4>初始热链</h4>
          <el-tag size="small" type="info" effect="plain">{{ quality.engineFrame.initRouting?.length ?? 0 }} 条</el-tag>
        </header>
        <p v-if="!quality.engineFrame.initRouting?.length" class="decision-empty">暂无数据</p>
        <div v-else class="decision-card-list" role="list">
          <article v-for="(route, index) in quality.engineFrame.initRouting" :key="index" class="decision-card" role="listitem" :title="`路径 ID：${route.pathId}`">
            <header class="decision-card__head">
              <div class="decision-card__title">
                <el-tag size="small" :type="route.direction === 'FORWARD' ? 'primary' : 'success'" effect="plain">
                  {{ route.direction === 'FORWARD' ? '前向' : '返向' }}
                </el-tag>
                <strong>{{ name(route.sourcePlatformId) }} → {{ name(route.targetPlatformId) }}</strong>
              </div>
              <span v-if="route.nodes.length > 1" class="decision-card__hops-count">{{ route.nodes.length - 1 }} 跳</span>
            </header>

            <div class="decision-hops" aria-label="路由跳点">
              <template v-if="route.nodes.length">
                <template v-for="(hop, h) in routeHops(route.nodes)" :key="h">
                  <span class="decision-hop__node">{{ hop.nodeName }}</span>
                  <template v-if="h < route.nodes.length - 1">
                    <span class="decision-hop__arrow" aria-hidden="true">→</span>
                    <span v-if="hop.linkLabel" class="decision-hop__link">{{ hop.linkLabel }}</span>
                    <span v-if="hop.linkLabel" class="decision-hop__arrow" aria-hidden="true">→</span>
                  </template>
                </template>
              </template>
              <span v-else class="decision-empty">暂无路径节点</span>
            </div>

            <div class="decision-business" aria-label="承载业务">
              <span class="decision-label">承载业务</span>
              <div v-if="businessLabels(route.transTypes).length" class="decision-business__tags">
                <el-tag v-for="biz in businessLabels(route.transTypes)" :key="biz" size="small" effect="plain" type="info">{{ biz }}</el-tag>
              </div>
              <span v-else class="decision-empty">暂无数据</span>
            </div>

            <dl v-if="route.parameters" class="decision-metrics" aria-label="路径参数">
              <div><dt>时延（原值）</dt><dd :title="value(route.parameters.delay)">{{ formatRouteMetric(route.parameters.delay) }}</dd></div>
              <div><dt>传输频次</dt><dd :title="value(route.parameters.transFrequency)">{{ formatRouteMetric(route.parameters.transFrequency) }}</dd></div>
              <div><dt>信息量</dt><dd :title="value(route.parameters.dataContent)">{{ formatRouteMetric(route.parameters.dataContent) }}</dd></div>
            </dl>
          </article>
        </div>
      </section>

      <section class="decision-group" aria-label="切换记录">
        <header class="decision-group__head">
          <h4>切换记录</h4>
          <el-tag size="small" :type="quality.engineSwitches.length ? 'warning' : 'info'" effect="plain">{{ quality.engineSwitches.length }} 次</el-tag>
        </header>
        <p v-if="!quality.engineSwitches.length" class="decision-empty">暂无数据</p>
        <div v-else class="decision-card-list" role="list">
          <article v-for="(item, index) in quality.engineSwitches" :key="index" class="decision-card decision-card--switch" role="listitem">
            <header class="decision-card__head">
              <div class="decision-card__title">
                <el-tag size="small" :type="item.route.direction === 'FORWARD' ? 'primary' : 'success'" effect="plain">
                  {{ item.route.direction === 'FORWARD' ? '前向' : '返向' }}
                </el-tag>
                <strong>{{ name(item.route.sourcePlatformId) }} → {{ name(item.route.targetPlatformId) }}</strong>
              </div>
              <span class="decision-card__time">{{ formatSimulationTime(item.simulationTime) }}</span>
            </header>

            <div class="decision-route-diff">
              <div class="decision-route-row decision-route-row--old" :title="item.route.oldPathId ? `旧路径 ID：${item.route.oldPathId}` : undefined">
                <span class="decision-route-badge decision-route-badge--old">旧路径</span>
                <div class="decision-hops">
                  <template v-if="item.route.oldNodes.length">
                    <template v-for="(hop, h) in routeHops(item.route.oldNodes)" :key="h">
                      <span class="decision-hop__node">{{ hop.nodeName }}</span>
                      <template v-if="h < item.route.oldNodes.length - 1">
                        <span class="decision-hop__arrow" aria-hidden="true">→</span>
                        <span v-if="hop.linkLabel" class="decision-hop__link">{{ hop.linkLabel }}</span>
                        <span v-if="hop.linkLabel" class="decision-hop__arrow" aria-hidden="true">→</span>
                      </template>
                    </template>
                  </template>
                  <span v-else class="decision-empty">{{ shortIdentifier(item.route.oldPathId) }}</span>
                </div>
              </div>
              <div class="decision-route-row decision-route-row--new" :title="`新路径 ID：${item.route.pathId}`">
                <span class="decision-route-badge decision-route-badge--new">新路径</span>
                <div class="decision-hops">
                  <template v-if="item.route.nodes.length">
                    <template v-for="(hop, h) in routeHops(item.route.nodes)" :key="h">
                      <span class="decision-hop__node">{{ hop.nodeName }}</span>
                      <template v-if="h < item.route.nodes.length - 1">
                        <span class="decision-hop__arrow" aria-hidden="true">→</span>
                        <span v-if="hop.linkLabel" class="decision-hop__link">{{ hop.linkLabel }}</span>
                        <span v-if="hop.linkLabel" class="decision-hop__arrow" aria-hidden="true">→</span>
                      </template>
                    </template>
                  </template>
                  <span v-else class="decision-empty">{{ shortIdentifier(item.route.pathId) }}</span>
                </div>
              </div>
            </div>

            <div class="decision-business" aria-label="承载业务">
              <span class="decision-label">承载业务</span>
              <div v-if="businessLabels(item.route.transTypes).length" class="decision-business__tags">
                <el-tag v-for="biz in businessLabels(item.route.transTypes)" :key="biz" size="small" effect="plain" type="info">{{ biz }}</el-tag>
              </div>
              <span v-else class="decision-empty">暂无数据</span>
            </div>

            <dl v-if="item.route.parameters" class="decision-metrics" aria-label="路径参数">
              <div><dt>时延（原值）</dt><dd :title="value(item.route.parameters.delay)">{{ formatRouteMetric(item.route.parameters.delay) }}</dd></div>
              <div><dt>传输频次</dt><dd :title="value(item.route.parameters.transFrequency)">{{ formatRouteMetric(item.route.parameters.transFrequency) }}</dd></div>
              <div><dt>信息量</dt><dd :title="value(item.route.parameters.dataContent)">{{ formatRouteMetric(item.route.parameters.dataContent) }}</dd></div>
            </dl>

            <div class="decision-reasons">
              <span class="decision-label">切换原因</span>
              <span v-if="!item.route.reasons.length" class="decision-empty">暂无数据</span>
              <div v-else class="decision-reason-list">
                <div v-for="(reason, r) in item.route.reasons" :key="r" class="decision-reason-row">
                  <el-tag v-for="(cause, c) in reason.reasons" :key="c" size="small" type="warning" effect="plain">{{ label(cause) }}</el-tag>
                  <span v-if="reason.linkId" class="decision-reason-link" :title="reason.linkId">{{ linkDisplayName(reason.linkId) }}</span>
                  <span v-for="threshold in switchReasonThresholds(item, reason)" :key="threshold" class="decision-reason-threshold" data-testid="switch-threshold-reason">{{ threshold }}</span>
                </div>
              </div>
            </div>

            <div class="decision-highlights">
              <template v-if="switchResolution(item)">
                <p class="engine-evidence__switch-before">{{ resolutionLabel('切换前链路', switchResolution(item)!.before) }}</p>
                <p class="engine-evidence__switch-after">{{ resolutionLabel('切换后链路', switchResolution(item)!.after) }}</p>
              </template>
              <p v-else class="engine-evidence__note">该次历史切换暂无可高亮的链路。</p>
            </div>
          </article>
        </div>
      </section>

      <section class="decision-group" aria-label="告警">
        <header class="decision-group__head">
          <h4>告警</h4>
          <el-tag size="small" :type="mergedAlarms.length ? 'danger' : 'info'" effect="plain" data-testid="alarm-summary-tag"
            :title="mergedAlarms.length < quality.engineAlarms.length ? `已将最近 ${quality.engineAlarms.length} 条告警按路径与链路合并为 ${mergedAlarms.length} 项` : undefined">
            <template v-if="mergedAlarms.length < quality.engineAlarms.length">{{ mergedAlarms.length }} 项 · 共 {{ quality.engineAlarms.length }} 次</template>
            <template v-else>{{ mergedAlarms.length }} 条</template>
          </el-tag>
        </header>
        <p v-if="!mergedAlarms.length" class="decision-empty">暂无数据</p>
        <div v-else class="decision-card-list" role="list">
          <article v-for="item in mergedAlarms" :key="item.key" class="decision-card decision-card--alarm" role="listitem" :title="alarmTooltip(item) || undefined">
            <header class="decision-card__head">
              <span class="decision-card__time">{{ alarmTimeLabel(item) }}</span>
              <el-tag v-if="item.count > 1" size="small" type="danger" effect="plain" data-testid="alarm-repeat-count">重复 {{ item.count }} 次</el-tag>
            </header>
            <strong v-if="alarmLinkLabel(item)" class="decision-alarm__link">{{ alarmLinkLabel(item) }}</strong>
            <p class="decision-alarm__msg">{{ alarmMessageText(item) }}</p>
            <p v-if="alarmPathLabel(item)" class="decision-alarm__path">{{ alarmPathLabel(item) }}</p>
          </article>
        </div>
      </section>
    </template>
    <template v-else-if="section === 'jammers'">
      <p v-if="!quality.engineFrame.jammers.length" class="jammer-card__empty">暂无数据</p>
      <div v-else class="jammer-card-list" role="list" aria-label="干扰与侦测设备">
        <article v-for="(jammer, index) in quality.engineFrame.jammers" :key="jammer.platformId ?? jammer.name ?? index" class="jammer-card" role="listitem">
          <header class="jammer-card__head">
            <strong>{{ name(jammer.platformId) }}</strong>
            <div class="jammer-card__tags">
              <el-tag size="small" :type="jammer.deviceStatus === 'ON' ? 'danger' : 'info'" effect="plain">{{ label(jammer.deviceStatus) }}</el-tag>
              <el-tag size="small" :type="isJammerDetected(jammer) ? 'warning' : 'info'" effect="plain" data-testid="jammer-detect-status">{{ detectStatusLabel(jammer) }}</el-tag>
            </div>
          </header>

          <dl class="jammer-card__metrics">
            <div class="jammer-card__metric-wide"><dt title="插件回传的 power_w 配置值；链路干扰按干扰辐射功率（EIRP）计算">干扰功率</dt> <dd data-testid="jammer-power-value" :title="formatJammerPower(jammer.powerW)">{{ formatJammerPower(jammer.powerW) }}</dd></div>
            <div v-if="jammer.eirpDbw !== undefined"><dt>干扰辐射功率</dt> <dd data-testid="jammer-eirp-value">{{ value(jammer.eirpDbw, ' dBW') }}</dd></div>
            <div v-if="jammer.antennaGainDbi !== undefined"><dt>天线增益</dt> <dd data-testid="jammer-gain-value">{{ value(jammer.antennaGainDbi, ' dBi') }}</dd></div>
            <template v-if="jammer.freqBands === undefined">
              <div><dt>设备模式</dt> <dd>{{ jammerModeLabel(jammer.engineMode) }}</dd></div>
              <div><dt>干扰频率</dt> <dd data-testid="jammer-frequency-value" :title="jammer.frequencyHz != null ? `${jammer.frequencyHz} Hz` : undefined">{{ formatFrequencyHz(jammer.frequencyHz) }}</dd></div>
            </template>
            <div><dt>干扰圈半径</dt> <dd>{{ formatKm(jammer.rangeM) }}</dd></div>
          </dl>

          <div v-if="jammer.freqBands !== undefined" class="jammer-card__section" data-testid="jammer-freq-bands">
            <span class="jammer-card__section-title">干扰频段</span>
            <p v-if="!jammer.freqBands.length" class="jammer-card__empty">暂无频段</p>
            <div v-else class="jammer-card__bands">
              <div v-for="(band, b) in jammer.freqBands" :key="b" class="jammer-card__band-row">
                <span class="jammer-card__band-spec">{{ value(band.frequencyGHz, ' GHz') }} · 带宽 {{ value(band.bandwidthMHz, ' MHz') }}</span>
                <el-tag size="small" :type="band.mode === 'BARRAGE' ? 'danger' : band.mode === 'SPOT' ? 'warning' : 'info'" effect="plain">{{ jammerModeLabel(band.mode ?? band.engineMode) }}</el-tag>
              </div>
            </div>
          </div>

          <div v-if="jammer.position" class="jammer-card__section">
            <span class="jammer-card__section-title">干扰站位置</span>
            <div class="jammer-card__coords">
              <span>经度 {{ formatCoord(jammer.position.longitude) }}</span>
              <span>纬度 {{ formatCoord(jammer.position.latitude) }}</span>
              <span>高度 {{ formatAltitude(jammer.position.altitudeM) }}</span>
            </div>
          </div>

          <div class="jammer-card__section">
            <span class="jammer-card__section-title">侦测结果</span>
            <p v-if="!jammer.detections.length" class="jammer-card__empty" data-testid="jammer-no-detection">未侦测到目标</p>
            <div v-for="(detection, d) in jammer.detections" :key="d" class="jammer-card__detection">
              <dl class="jammer-card__metrics">
                <div class="jammer-card__metric-wide"><dt>探测目标</dt> <dd>{{ detection.targetIds.map(name).join('、') || '暂无数据' }}</dd></div>
                <div><dt>目标平台类型</dt> <dd data-testid="detection-platform-type">{{ platformTypeLabel(detection.platformType) }}</dd></div>
                <div><dt>探测概率</dt> <dd data-testid="detection-probability">{{ detectionProbabilityText(detection) }}</dd></div>
                <div><dt>探测范围</dt> <dd>{{ formatKm(detection.rangeM) }}</dd></div>
                <div><dt>探测频率</dt> <dd data-testid="detection-frequency-value" :title="detection.frequencyHz != null ? `${detection.frequencyHz} Hz` : undefined">{{ formatFrequencyHz(detection.frequencyHz) }}</dd></div>
              </dl>
              <div v-if="detection.targets.length" class="jammer-card__targets">
                <div v-for="(target, t) in detection.targets" :key="target.platformId ?? target.name ?? t" class="jammer-card__target-row">
                  <div class="jammer-card__target-head">
                    <strong class="jammer-card__target-name">{{ name(target.platformId) }}</strong>
                    <span v-if="target.probability != null" class="jammer-card__target-prob" data-testid="target-detect-prob">探测概率 {{ formatPercent(target.probability) }}</span>
                  </div>
                  <div class="jammer-card__coords">
                    <span>经度 {{ formatCoord(target.longitude) }}</span>
                    <span>纬度 {{ formatCoord(target.latitude) }}</span>
                    <span>高度 {{ formatAltitude(target.altitudeM) }}</span>
                  </div>
                </div>
              </div>
              <p v-else class="jammer-card__empty">目标位置：暂无数据</p>
            </div>
          </div>

          <div class="jammer-card__section">
            <span class="jammer-card__section-title">起扰目标</span>
            <p v-if="!jammer.actions.length" class="jammer-card__empty">暂无数据</p>
            <div v-else class="jammer-card__actions">
              <div v-for="(action, a) in jammer.actions" :key="a" class="jammer-card__action-row">
                <el-tag size="small" :type="action.action === 'JAM_ON' ? 'danger' : 'info'" effect="plain">{{ label(action.action) }}</el-tag>
                <span class="jammer-card__action-target" :title="name(action.targetPlatformId)">{{ name(action.targetPlatformId) }}</span>
                <span v-if="formatJamFrequency(action.jamFreqHz)" class="jammer-card__action-freq" data-testid="jammer-action-freq">{{ formatJamFrequency(action.jamFreqHz) }}</span>
                <span class="jammer-card__action-mode">{{ jammerModeLabel(action.mode ?? action.engineMode) }}</span>
              </div>
            </div>
          </div>

          <div class="jammer-card__section" data-testid="jammer-lifecycle-events">
            <span class="jammer-card__section-title">启停事件记录</span>
            <p v-if="!jammerEventsFor(jammer).length" class="jammer-card__empty">暂无启停事件</p>
            <div v-else class="jammer-card__events">
              <div
                v-for="(entry, e) in jammerEventsFor(jammer)"
                :key="jammerEventKey(jammer.platformId ?? jammer.name ?? index, entry) + ':' + e"
                class="jammer-card__event-row"
                :class="{ 'is-expanded': expandedJammerEvents[jammerEventKey(jammer.platformId ?? jammer.name ?? index, entry)] }"
              >
                <span class="jammer-card__event-time">{{ formatSimulationTime(entry.simulationTime) }}</span>
                <el-tag size="small" :type="jammerEventTagType(entry.event.type)" effect="plain">{{ label(entry.event.type) }}</el-tag>
                <span
                  class="jammer-card__event-targets"
                  :class="{ 'is-expandable': entry.event.uavIds.length > 1 }"
                  :title="jammerEventTargetsText(entry.event.uavIds)"
                  data-testid="jammer-event-targets"
                  @click="entry.event.uavIds.length > 1 && toggleJammerEvent(jammerEventKey(jammer.platformId ?? jammer.name ?? index, entry))"
                >{{ jammerEventTargetsText(entry.event.uavIds) }}</span>
                <button
                  v-if="entry.event.uavIds.length > 1"
                  type="button"
                  class="jammer-card__event-toggle"
                  :title="expandedJammerEvents[jammerEventKey(jammer.platformId ?? jammer.name ?? index, entry)] ? '收起目标列表' : `展开全部 ${entry.event.uavIds.length} 架目标`"
                  data-testid="jammer-event-toggle"
                  @click="toggleJammerEvent(jammerEventKey(jammer.platformId ?? jammer.name ?? index, entry))"
                >{{ expandedJammerEvents[jammerEventKey(jammer.platformId ?? jammer.name ?? index, entry)] ? '收起' : `共${entry.event.uavIds.length}架` }}</button>
              </div>
            </div>
          </div>
        </article>
      </div>
    </template>
    <template v-else>
      <p v-if="!quality.engineEvents.length">暂无数据</p>
      <article v-for="(item, index) in quality.engineEvents" :key="index">
        <strong>{{ formatSimulationTime(item.simulationTime) }} · {{ label(item.event.type) }}</strong>
        <p>路径：{{ value(item.event.pathId) }}</p><p>任务机：{{ item.event.uavIds.map(name).join('、') || '暂无数据' }} · 干扰站：{{ item.event.jammerIds.map(name).join('、') || '暂无数据' }}</p>
      </article>
    </template>
  </section>
</template>

<style scoped>
.engine-evidence { min-width: 0; color: var(--text-color, #c5dae7); font-size: 12px; overflow-wrap: anywhere; }
.engine-evidence__source { color: #4bd9f2; font-variant-numeric: tabular-nums; }
.engine-evidence article { padding: 10px 0; border-bottom: 1px solid #244455; }
.engine-evidence p { margin: 6px 0; }
.quality-card-view { margin: 4px 0 8px; }
.engine-evidence__note { color: var(--el-text-color-secondary); }
.engine-evidence__switch-before { color: #f5b942; }
.engine-evidence__switch-after { color: #4bd9f2; }
.engine-evidence__filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.engine-evidence__filters :deep(.el-form-item) { min-width: 0; margin-bottom: 0; }
.engine-evidence__time-range { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 4px; }
.engine-evidence__time-range :deep(.el-input-number) { width: 100%; }
.engine-evidence small { display: block; margin-top: 4px; }
.jammer-card-list { display: grid; gap: 10px; padding-bottom: 8px; }
.engine-evidence .jammer-card { padding: 10px; border: 1px solid #244455; border-radius: 6px; background: rgba(5, 20, 32, .38); }
.jammer-card__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.jammer-card__head strong { min-width: 0; color: var(--console-text, #e7f0f8); font-size: 13px; line-height: 1.4; }
.jammer-card__tags { display: flex; flex-shrink: 0; align-items: center; gap: 4px; }
.jammer-card__metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; margin: 0; }
.jammer-card__metrics > div { min-width: 0; }
.jammer-card__metric-wide { grid-column: 1 / -1; }
.jammer-card__metrics dt { color: var(--el-text-color-secondary, #8aa6b8); font-size: 11px; line-height: 1.4; }
.jammer-card__metrics dd { margin: 2px 0 0; color: var(--console-text, #e7f0f8); font-family: Consolas, "Microsoft YaHei", monospace; font-size: 12px; line-height: 1.4; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jammer-card__metric-wide dd { white-space: normal; overflow-wrap: anywhere; }
.jammer-card__section { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(36, 68, 85, .85); }
.jammer-card__section-title { display: block; margin-bottom: 6px; color: #8fb6d9; font-size: 11px; font-weight: 600; line-height: 1.4; }
.jammer-card__coords { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(0, 1.02fr) minmax(0, .9fr); gap: 4px; padding: 4px 6px; border-radius: 4px; background: rgba(16, 40, 58, .55); color: #c5dae7; font-family: Consolas, "Microsoft YaHei", monospace; font-size: 11px; font-variant-numeric: tabular-nums; }
.jammer-card__coords span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jammer-card__detection + .jammer-card__detection { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #244455; }
.jammer-card__targets { display: grid; gap: 6px; margin-top: 6px; }
.jammer-card__target-row { display: grid; gap: 3px; }
.jammer-card__target-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.jammer-card__target-name { color: #e7f0f8; font-size: 11px; font-weight: 600; }
.jammer-card__target-prob { flex-shrink: 0; color: #f5b942; font-family: Consolas, "Microsoft YaHei", monospace; font-size: 11px; font-variant-numeric: tabular-nums; }
.jammer-card__bands { display: grid; gap: 5px; }
.jammer-card__band-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 6px; border-radius: 4px; background: rgba(16, 40, 58, .55); font-size: 11px; }
.jammer-card__band-spec { min-width: 0; color: #e7f0f8; font-family: Consolas, "Microsoft YaHei", monospace; font-variant-numeric: tabular-nums; }
.jammer-card__actions { display: grid; gap: 6px; }
.jammer-card__action-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.jammer-card__action-target { flex: 1; min-width: 0; color: #e7f0f8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jammer-card__action-freq { flex-shrink: 0; color: #4bd9f2; font-family: Consolas, "Microsoft YaHei", monospace; font-size: 11px; font-variant-numeric: tabular-nums; }
.jammer-card__action-mode { flex-shrink: 0; color: #8fb6d9; font-size: 11px; }
.jammer-card__events { display: grid; gap: 5px; }
.jammer-card__event-row { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 11px; }
.jammer-card__event-row.is-expanded { align-items: flex-start; }
.jammer-card__event-time { flex-shrink: 0; color: #8aa6b8; font-family: Consolas, "Microsoft YaHei", monospace; font-variant-numeric: tabular-nums; }
.jammer-card__event-targets { flex: 1; min-width: 0; color: #e7f0f8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jammer-card__event-targets.is-expandable { cursor: pointer; }
.jammer-card__event-row.is-expanded .jammer-card__event-targets { white-space: normal; overflow: visible; overflow-wrap: anywhere; line-height: 1.5; }
.jammer-card__event-toggle { flex-shrink: 0; padding: 0 4px; border: none; background: transparent; color: #4bd9f2; font: inherit; font-size: 11px; cursor: pointer; }
.jammer-card__event-toggle:hover { text-decoration: underline; }
.engine-evidence .jammer-card__empty { margin: 2px 0 0; color: var(--el-text-color-secondary, #8aa6b8); font-size: 12px; }
.decision-group + .decision-group { margin-top: 14px; }
.decision-group__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.decision-group__head h4 { margin: 0; color: var(--console-text, #e7f0f8); font-size: 13px; font-weight: 600; }
.decision-card-list { display: grid; gap: 10px; }
.engine-evidence .decision-card { display: grid; gap: 8px; padding: 10px 11px; border: 1px solid #244455; border-radius: 6px; background: rgba(5, 20, 32, .45); }
.engine-evidence .decision-card--switch { border-left: 3px solid #f5b942; }
.engine-evidence .decision-card--alarm { border-left: 3px solid #ff667a; }
.decision-card__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.decision-card__title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.decision-card__title strong { min-width: 0; color: var(--console-text, #e7f0f8); font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; }
.decision-card__hops-count, .decision-card__time, .decision-alarm__meta { flex-shrink: 0; color: #8aa6b8; font-family: Consolas, "Microsoft YaHei", monospace; font-size: 11px; font-variant-numeric: tabular-nums; }
.decision-hops { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 5px; padding: 6px 8px; border-radius: 5px; background: rgba(16, 40, 58, .55); }
.decision-hop__node { padding: 1px 6px; border: 1px solid rgba(114, 154, 180, .35); border-radius: 4px; background: rgba(7, 21, 34, .85); color: #e7f0f8; font-size: 11px; line-height: 1.5; }
.decision-hop__link { padding: 1px 6px; border-radius: 999px; background: rgba(66, 216, 255, .14); color: #4fd6ff; font-size: 11px; font-weight: 500; line-height: 1.5; }
.decision-hop__arrow { color: #6c8ea4; font-size: 11px; }
.decision-business, .decision-reasons { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.decision-label { flex-shrink: 0; color: #8aa6b8; font-size: 11px; }
.decision-business__tags, .decision-reason-list { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.decision-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 0; padding-top: 8px; border-top: 1px solid rgba(36, 68, 85, .75); }
.decision-metrics > div { min-width: 0; padding: 4px 6px; border-radius: 4px; background: rgba(16, 40, 58, .42); }
.decision-metrics dt { color: #8aa6b8; font-size: 11px; line-height: 1.35; }
.decision-metrics dd { margin: 2px 0 0; color: #e7f0f8; font-family: Consolas, "Microsoft YaHei", monospace; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.decision-route-diff { display: grid; gap: 6px; }
.decision-route-row { display: grid; gap: 4px; }
.decision-route-badge { justify-self: start; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.decision-route-badge--old { background: rgba(245, 185, 66, .16); color: #f5b942; }
.decision-route-badge--new { background: rgba(75, 217, 242, .16); color: #4bd9f2; }
.decision-reason-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.decision-reason-link { color: #8aa6b8; font-family: Consolas, "Microsoft YaHei", monospace; font-size: 11px; }
.decision-reason-threshold { color: #ffd88a; font-family: Consolas, "Microsoft YaHei", monospace; font-size: 11px; font-variant-numeric: tabular-nums; }
.decision-highlights { padding-top: 6px; border-top: 1px dashed rgba(36, 68, 85, .8); }
.engine-evidence .decision-highlights p { margin: 2px 0; font-size: 11px; }
.decision-alarm__link { color: var(--console-text, #e7f0f8); font-size: 12px; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
.engine-evidence .decision-alarm__msg { margin: 0; color: #ffd4da; font-size: 12px; line-height: 1.5; }
.engine-evidence .decision-alarm__path { margin: 0; color: #8aa6b8; font-size: 11px; line-height: 1.4; }
.engine-evidence .decision-empty { margin: 0; color: var(--el-text-color-secondary, #8aa6b8); font-size: 12px; }
.quality-card-evidence { margin: 6px 0 8px; padding: 6px 8px; border: 1px solid rgba(245, 185, 66, .42); border-left: 3px solid #f5b942; border-radius: 5px; background: rgba(66, 44, 12, .28); }
.quality-card-evidence--jammed { border-color: rgba(255, 92, 118, .52); border-left-color: #ff4d6d; background: rgba(96, 18, 34, .36); }
.quality-card-evidence__head strong { color: #ffd88a; font-size: 11px; }
.quality-card-evidence--jammed .quality-card-evidence__head strong { color: #ff9eb0; }
.engine-evidence .quality-card-evidence__summary { margin: 3px 0 0; color: #e7f0f8; font-size: 11px; line-height: 1.45; }
.quality-card-evidence__jammers { display: grid; gap: 3px; margin: 5px 0 0; padding: 4px 0 0; border-top: 1px dashed rgba(255, 120, 140, .28); list-style: none; }
.quality-card-evidence__jammers li { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px; font-size: 11px; color: #fff; }
.quality-card-evidence__meta { color: #c5dae7; font-family: Consolas, "Microsoft YaHei", monospace; font-size: 11px; font-variant-numeric: tabular-nums; }
</style>

<style scoped src="./quality-cards.css"></style>
