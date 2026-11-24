import type {
  EngineFrameEvent,
  EngineFrameSnapshot,
  EngineRouteSwitch,
  Link,
} from '../../contracts/domain-models'
import type { SituationMapFocusTarget } from '../../components/situation/situation-map-controller'
import { formatCommunicationPortLabel } from './file-message-links'
import type { SituationMapNode } from './initial-nodes'

export interface ActiveJammingBeam {
  id: string
  jammerPlatformId: string
  targetPlatformId: string
  jammerName: string
  targetName: string
  lossDb: number | null
  mode: string | null
}

export interface ActiveJammingOverlay {
  activeJammerPlatformIds: ReadonlySet<string>
  beams: ActiveJammingBeam[]
}

export type MapStoryKind = 'DETECT' | 'JAMMED' | 'SWITCH'

export interface MapStoryItem {
  id: string
  kind: MapStoryKind
  timeS: number
  tag: string
  summary: string
  detail: string
  focusTarget?: SituationMapFocusTarget
}

const JAM_MODE_LABELS: Record<string, string> = {
  BARRAGE: '宽带压制',
  broadband: '宽带压制',
  SPOT: '瞄准干扰',
  spot: '瞄准干扰',
  SWEEP: '扫频干扰',
  sweep: '扫频干扰',
}

function formatJamMode(mode: string | null | undefined): string | null {
  if (!mode) return null
  return JAM_MODE_LABELS[mode] ?? mode
}

function resolveNode(
  nodes: readonly SituationMapNode[],
  platformId: string | null | undefined,
  fallbackName?: string | null,
): SituationMapNode | undefined {
  if (platformId) {
    const byId = nodes.find(node => node.platformId === platformId)
    if (byId) return byId
  }
  if (fallbackName) {
    const byName = nodes.find(node => node.platformId === fallbackName || node.name === fallbackName)
    if (byName) return byName
  }
  return undefined
}

function formatNodeName(
  nodes: readonly SituationMapNode[],
  platformId: string | null | undefined,
  fallbackName?: string | null,
): string {
  const matched = resolveNode(nodes, platformId, fallbackName)
  return matched?.name ?? fallbackName ?? platformId ?? '未知节点'
}

/**
 * 仅依据引擎帧中的真实干扰机状态、闭环动作与链路干扰损耗提取当前活跃压制源与干扰射线。
 */
export function extractActiveJammingOverlay(
  frame: EngineFrameSnapshot | null | undefined,
  nodes: readonly SituationMapNode[],
): ActiveJammingOverlay {
  const activeJammerPlatformIds = new Set<string>()
  const beamMap = new Map<string, ActiveJammingBeam>()
  if (!frame || nodes.length === 0) return { activeJammerPlatformIds, beams: [] }

  const upsertBeam = (
    jammerNode: SituationMapNode,
    targetNode: SituationMapNode,
    lossDb: number | null,
    mode: string | null,
  ) => {
    if (jammerNode.platformId === targetNode.platformId) return
    const key = `${jammerNode.platformId}->${targetNode.platformId}`
    const existing = beamMap.get(key)
    const nextLoss = lossDb !== null && Number.isFinite(lossDb) && lossDb > 0
      ? (existing?.lossDb !== null && existing?.lossDb !== undefined ? Math.max(existing.lossDb, lossDb) : lossDb)
      : (existing?.lossDb ?? null)
    beamMap.set(key, {
      id: `beam:${key}`,
      jammerPlatformId: jammerNode.platformId,
      targetPlatformId: targetNode.platformId,
      jammerName: jammerNode.name,
      targetName: targetNode.name,
      lossDb: nextLoss,
      mode: existing?.mode ?? mode,
    })
  }

  for (const jammer of frame.jammers) {
    const jammerNode = resolveNode(nodes, jammer.platformId, jammer.name)
    if (!jammerNode) continue
    const hasJamOnAction = jammer.actions.some(action => action.action?.toUpperCase() === 'JAM_ON' || action.action?.toUpperCase() === 'START')
    const isOn = jammer.deviceStatus === 'ON' || hasJamOnAction
    if (!isOn) continue
    activeJammerPlatformIds.add(jammerNode.platformId)

    let addedActionTarget = false
    for (const action of jammer.actions) {
      if (action.action?.toUpperCase() === 'JAM_OFF' || action.action?.toUpperCase() === 'STOP') continue
      const targetNode = resolveNode(nodes, action.targetPlatformId, action.targetName)
      if (!targetNode) continue
      addedActionTarget = true
      upsertBeam(jammerNode, targetNode, null, formatJamMode(action.mode ?? action.engineMode ?? jammer.engineMode))
    }

    if (!addedActionTarget) {
      for (const detection of jammer.detections) {
        const candidates = detection.targets.length
          ? detection.targets.map(item => resolveNode(nodes, item.platformId, item.name))
          : detection.targetIds.map((id, index) => resolveNode(nodes, id, detection.targetNames[index]))
        for (const targetNode of candidates) {
          if (targetNode) upsertBeam(jammerNode, targetNode, null, formatJamMode(jammer.engineMode))
        }
      }
    }
  }

  for (const segment of frame.links) {
    const segmentLoss = segment.losses.jammingDb
    const segmentJammed = typeof segmentLoss === 'number' && Number.isFinite(segmentLoss) && segmentLoss > 0
    if (!segmentJammed && segment.status !== 'DEGRADED' && segment.status !== 'DOWN') continue
    const targetNode = resolveNode(nodes, segment.targetPlatformId, segment.targetName)
    if (!targetNode) continue
    for (const traceJammer of segment.inputTrace.jammers) {
      const jammerNode = resolveNode(nodes, traceJammer.platformId, traceJammer.jammerName)
      if (!jammerNode) continue
      const effectiveLoss = segmentJammed ? segmentLoss : traceJammer.lossDb
      if (effectiveLoss === null || !Number.isFinite(effectiveLoss) || effectiveLoss <= 0) continue
      activeJammerPlatformIds.add(jammerNode.platformId)
      upsertBeam(jammerNode, targetNode, effectiveLoss, null)
    }
  }

  return {
    activeJammerPlatformIds,
    beams: [...beamMap.values()],
  }
}

function summarizeSwitchRoute(
  route: EngineRouteSwitch,
  nodes: readonly SituationMapNode[],
): { summary: string; detail: string } {
  const newPorts = [...new Set(route.nodes.map(node => node.outPort || node.inPort).filter((port): port is string => Boolean(port)))]
  const oldPorts = [...new Set(route.oldNodes.map(node => node.outPort || node.inPort).filter((port): port is string => Boolean(port)))]
  const toLabel = newPorts.length ? newPorts.map(formatCommunicationPortLabel).join(' / ') : '新路径'
  const fromLabel = oldPorts.length ? oldPorts.map(formatCommunicationPortLabel).join(' / ') : ''
  const pathNames = route.nodes.map(node => formatNodeName(nodes, node.platformId, node.platformName))
  const reasonText = route.reasons.flatMap(item => item.reasons).filter(Boolean).map(reason => {
    if (reason === 'alarm_switch') return '受扰告警触发'
    return reason
  })
  const summary = fromLabel && fromLabel !== toLabel
    ? `路由切换：${fromLabel} → ${toLabel}`
    : `路由切换至 ${toLabel}`
  const parts: string[] = []
  if (pathNames.length >= 2) parts.push(pathNames.join(' → '))
  if (reasonText.length) parts.push([...new Set(reasonText)].join('、'))
  return { summary, detail: parts.join(' · ') }
}

function classifyEventType(event: EngineFrameEvent): MapStoryKind | null {
  const raw = (event.type ?? '').toLowerCase()
  if (!raw) return null
  if (raw.includes('switch')) return 'SWITCH'
  if (raw.includes('jamm') || raw.includes('alarm')) return 'JAMMED'
  if (raw.includes('esm') || raw.includes('detect')) return 'DETECT'
  return null
}

/**
 * 为地图内事件浮层提取当前帧的因果链条（侦测/开扰 → 链路受扰 → 路由切换），最多返回 2 条核心胶囊。
 */
export function extractEngineMapStoryBanner(
  frame: EngineFrameSnapshot | null | undefined,
  nodes: readonly SituationMapNode[],
  configuredLinks?: readonly Link[],
): MapStoryItem[] {
  if (!frame) return []
  const items: MapStoryItem[] = []
  const timeS = frame.simulationTime

  // 1) 受扰/告警（链路出现干扰损耗或显式告警，或进入干扰事件）
  const jammedSegments = frame.links
    .filter(segment => (typeof segment.losses.jammingDb === 'number' && Number.isFinite(segment.losses.jammingDb) && segment.losses.jammingDb > 0)
      || ((segment.status === 'DEGRADED' || segment.status === 'DOWN') && segment.inputTrace.jammers.length > 0))
    .sort((left, right) => (right.losses.jammingDb ?? 0) - (left.losses.jammingDb ?? 0))
  const alarm = frame.routing.alarms[0]
  const jamEvent = frame.events.find(event => classifyEventType(event) === 'JAMMED')

  if (alarm || jammedSegments.length > 0 || jamEvent) {
    const topSegment = jammedSegments[0]
    const targetLinkId = alarm?.linkId && configuredLinks?.some(link => link.id === alarm.linkId)
      ? alarm.linkId
      : topSegment?.linkIds.find(id => configuredLinks?.some(link => link.id === id))
    const targetNodeId = topSegment?.targetPlatformId ?? jamEvent?.uavIds[0] ?? undefined
    const focusTarget: SituationMapFocusTarget | undefined = targetLinkId
      ? { kind: 'link', targetId: targetLinkId }
      : targetNodeId ? { kind: 'node', targetId: targetNodeId } : undefined

    if (topSegment) {
      const portLabel = formatCommunicationPortLabel(topSegment.sourcePort ?? topSegment.targetPort ?? '')
      const targetName = formatNodeName(nodes, topSegment.targetPlatformId, topSegment.targetName)
      const lossText = typeof topSegment.losses.jammingDb === 'number' && topSegment.losses.jammingDb > 0
        ? `干扰损耗 ${topSegment.losses.jammingDb.toFixed(1)} dB`
        : ''
      const statusText = topSegment.status === 'DOWN' ? '中断' : topSegment.status === 'DEGRADED' ? '劣化' : '受扰'
      items.push({
        id: `jammed:${frame.frameId}:${topSegment.linkId}`,
        kind: 'JAMMED',
        timeS,
        tag: topSegment.status === 'DOWN' ? '受扰中断' : '链路受扰',
        summary: `${portLabel || '通信链路'} → ${targetName} ${statusText}`,
        detail: [lossText, alarm?.message ?? ''].filter(Boolean).join(' · ') || '检测到电磁压制',
        focusTarget,
      })
    } else if (alarm) {
      items.push({
        id: `alarm:${frame.frameId}:${alarm.pathId ?? alarm.linkId ?? '0'}`,
        kind: 'JAMMED',
        timeS,
        tag: '受扰告警',
        summary: alarm.message?.trim() || '链路触发受扰告警',
        detail: alarm.linkId ? `关联链路 ${alarm.linkId}` : '',
        focusTarget,
      })
    } else if (jamEvent) {
      const jammerLabel = formatNodeName(nodes, jamEvent.jammerIds[0], jamEvent.jammerNames[0])
      const uavLabel = formatNodeName(nodes, jamEvent.uavIds[0], jamEvent.uavNames[0])
      items.push({
        id: `jam-event:${frame.frameId}`,
        kind: 'JAMMED',
        timeS,
        tag: '进入干扰',
        summary: `${jammerLabel} 压制 ${uavLabel}`,
        detail: '目标已进入有效干扰范围',
        focusTarget,
      })
    }
  } else {
    // 尚无受扰或告警时，若当前帧有侦测或开机事件则展示侦测阶段
    const activeJammer = frame.jammers.find(jammer => jammer.deviceStatus === 'ON' || jammer.detectStatus === 'DETECTED' || jammer.detections.length > 0)
    const detectEvent = frame.events.find(event => classifyEventType(event) === 'DETECT')
    if (activeJammer || detectEvent) {
      const jammerId = activeJammer?.platformId ?? detectEvent?.jammerIds[0] ?? undefined
      const jammerLabel = formatNodeName(nodes, jammerId, activeJammer?.name ?? detectEvent?.jammerNames[0])
      const firstTargetId = activeJammer?.detections[0]?.targetIds[0] ?? detectEvent?.uavIds[0] ?? undefined
      const firstTargetName = activeJammer?.detections[0]?.targetNames[0] ?? detectEvent?.uavNames[0]
      const targetLabel = firstTargetId || firstTargetName ? formatNodeName(nodes, firstTargetId, firstTargetName) : ''
      const isJamming = activeJammer?.deviceStatus === 'ON'
      items.push({
        id: `detect:${frame.frameId}:${jammerId ?? '0'}`,
        kind: isJamming ? 'JAMMED' : 'DETECT',
        timeS,
        tag: isJamming ? '开启压制' : '目标侦测',
        summary: targetLabel
          ? `${jammerLabel} ${isJamming ? '正在压制' : '已侦测到'} ${targetLabel}`
          : `${jammerLabel} ${isJamming ? '已开启电磁压制' : '发现通信目标'}`,
        detail: formatJamMode(activeJammer?.engineMode) ?? '',
        focusTarget: jammerId ? { kind: 'node', targetId: jammerId } : undefined,
      })
    }
  }

  // 2) 路由切换（同一帧发生切换时与上方受扰胶囊并排形成「受扰 → 切换」因果）
  const routeSwitch = frame.routing.switches[0]
  if (routeSwitch) {
    const { summary, detail } = summarizeSwitchRoute(routeSwitch, nodes)
    const switchTargetId = routeSwitch.targetPlatformId ?? routeSwitch.nodes.at(-1)?.platformId ?? undefined
    items.push({
      id: `switch:${frame.frameId}:${routeSwitch.pathId}`,
      kind: 'SWITCH',
      timeS,
      tag: '已切换链路',
      summary,
      detail,
      focusTarget: switchTargetId ? { kind: 'node', targetId: switchTargetId } : undefined,
    })
  } else {
    const switchEvent = frame.events.find(event => classifyEventType(event) === 'SWITCH')
    if (switchEvent) {
      items.push({
        id: `switch-event:${frame.frameId}:${switchEvent.pathId ?? '0'}`,
        kind: 'SWITCH',
        timeS,
        tag: '已切换链路',
        summary: '触发链路重路由切换',
        detail: switchEvent.pathId ? `新路径 ${switchEvent.pathId.slice(0, 8)}` : '',
      })
    }
  }

  return items.slice(0, 2)
}
