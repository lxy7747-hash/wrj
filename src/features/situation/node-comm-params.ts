import type { EngineFrameSnapshot, EngineLinkSegment, Link, ScenarioConfig } from '../../contracts/domain-models'
import { effectiveLinkFromPorts } from '../scenarios/link-port-parameters'
import type { SituationMapLink } from './engine-link-statuses'
import type { SituationMapNode } from './initial-nodes'
import { LINK_TYPE_LABELS } from './situation-model'

const EARTH_RADIUS_METERS = 6_371_008.8

export interface NodeLinkParameterRow {
  linkId: string
  typeLabel: string
  directionLabel: string
  roleLabel: string
  peerLabel: string
  txPowerText: string
  antennaGainText: string
  distanceText: string
  distanceSource: 'ENGINE' | 'COORDINATES' | 'NONE'
  antiJammingGainText: string
  spatialIsolationText: string
}

export interface BuildNodeLinkParameterRowsOptions {
  platformId: string
  nodes: readonly SituationMapNode[]
  configuredLinks?: readonly SituationMapLink[]
  focusLinks?: readonly Link[]
  engineFrame?: EngineFrameSnapshot | null
  configuredScenario?: Pick<ScenarioConfig, 'platforms' | 'deviceParameters'> | null
}

function toCartesianMeters(latitudeDeg: number, longitudeDeg: number, altitudeM: number): [number, number, number] {
  const lat = (latitudeDeg * Math.PI) / 180
  const lon = (longitudeDeg * Math.PI) / 180
  const radius = EARTH_RADIUS_METERS + altitudeM
  const cosLat = Math.cos(lat)
  return [
    radius * cosLat * Math.cos(lon),
    radius * cosLat * Math.sin(lon),
    radius * Math.sin(lat),
  ]
}

/** 按地球半径 + 节点海拔计算两点间三维斜距（米），兼容高轨卫星与低空平台。 */
export function slantDistanceMeters(
  a: Pick<SituationMapNode, 'latitude' | 'longitude' | 'altitude'>,
  b: Pick<SituationMapNode, 'latitude' | 'longitude' | 'altitude'>,
): number | null {
  if (![a.latitude, a.longitude, a.altitude, b.latitude, b.longitude, b.altitude].every(Number.isFinite)) return null
  const [ax, ay, az] = toCartesianMeters(a.latitude, a.longitude, a.altitude)
  const [bx, by, bz] = toCartesianMeters(b.latitude, b.longitude, b.altitude)
  return Math.hypot(ax - bx, ay - by, az - bz)
}

function formatNumber(value: number, maxFractionDigits = 2): string {
  const rounded = Number(value.toFixed(maxFractionDigits))
  return String(Object.is(rounded, -0) ? 0 : rounded)
}

function formatDistanceKm(meters: number): string {
  const km = meters / 1000
  return km >= 1000 ? formatNumber(km, 1) : formatNumber(km, 2)
}

function resolveEngineLinkDistanceMeters(
  link: SituationMapLink,
  engineFrame?: EngineFrameSnapshot | null,
): number | null {
  if (typeof link.distanceM === 'number' && Number.isFinite(link.distanceM) && link.distanceM >= 0) {
    return link.distanceM
  }
  const candidates: EngineLinkSegment[] = (engineFrame?.links ?? []).filter(segment =>
    segment.linkIds.includes(link.id) && typeof segment.distanceM === 'number' && Number.isFinite(segment.distanceM) && segment.distanceM >= 0,
  )
  if (!candidates.length) return null

  if (link.relayPlatformId) {
    const hop1 = candidates.find(segment =>
      segment.sourcePlatformId === link.sourcePlatformId && segment.targetPlatformId === link.relayPlatformId,
    )
    const hop2 = candidates.find(segment =>
      segment.sourcePlatformId === link.relayPlatformId && segment.targetPlatformId === link.targetPlatformId,
    )
    if (hop1?.distanceM !== undefined && hop1.distanceM !== null && hop2?.distanceM !== undefined && hop2.distanceM !== null) {
      return hop1.distanceM + hop2.distanceM
    }
    const direct = candidates.find(segment =>
      segment.sourcePlatformId === link.sourcePlatformId && segment.targetPlatformId === link.targetPlatformId,
    )
    return direct?.distanceM ?? null
  }

  return candidates.length === 1 ? (candidates[0]!.distanceM ?? null) : null
}

function resolveCoordinateDistanceMeters(
  link: Pick<Link, 'sourcePlatformId' | 'targetPlatformId' | 'relayPlatformId'>,
  nodesById: ReadonlyMap<string, SituationMapNode>,
): number | null {
  const source = nodesById.get(link.sourcePlatformId)
  const target = nodesById.get(link.targetPlatformId)
  if (!source || !target) return null
  if (link.relayPlatformId) {
    const relay = nodesById.get(link.relayPlatformId)
    if (relay) {
      const hop1 = slantDistanceMeters(source, relay)
      const hop2 = slantDistanceMeters(relay, target)
      if (hop1 !== null && hop2 !== null) return hop1 + hop2
    }
  }
  return slantDistanceMeters(source, target)
}

function nodeLabel(nodesById: ReadonlyMap<string, SituationMapNode>, platformId: string): string {
  return nodesById.get(platformId)?.name || platformId
}

/** 汇总选中节点关联的通信链路终端参数（功率、天线增益、通信距离、波形抗干扰增益、空域隔离大小）。 */
export function buildNodeLinkParameterRows(options: BuildNodeLinkParameterRowsOptions): NodeLinkParameterRow[] {
  const { platformId, nodes, configuredLinks, focusLinks, engineFrame, configuredScenario } = options
  if (!platformId) return []

  const mergedLinks = new Map<string, SituationMapLink>()
  for (const link of configuredLinks ?? []) {
    if (link.enabled !== false) mergedLinks.set(link.id, link)
  }
  for (const link of focusLinks ?? []) {
    if (link.enabled !== false && !mergedLinks.has(link.id)) mergedLinks.set(link.id, link)
  }
  if (!mergedLinks.size) return []

  const nodesById = new Map(nodes.map(node => [node.platformId, node]))
  const rows: NodeLinkParameterRow[] = []

  for (const link of mergedLinks.values()) {
    const isSource = link.sourcePlatformId === platformId
    const isTarget = link.targetPlatformId === platformId
    const isRelay = link.relayPlatformId === platformId
    if (!isSource && !isTarget && !isRelay) continue

    const effective = configuredScenario ? effectiveLinkFromPorts(configuredScenario, link) : link
    const isFiber = effective.type === 'FIBER'
    const isLaser = effective.type === 'LASER'

    const roleLabel = isSource ? '发送端' : isTarget ? '接收端' : '中继节点'
    const sourceName = nodeLabel(nodesById, link.sourcePlatformId)
    const targetName = nodeLabel(nodesById, link.targetPlatformId)
    const relayName = link.relayPlatformId ? nodeLabel(nodesById, link.relayPlatformId) : ''
    const peerLabel = isRelay
      ? `${sourceName} → ${targetName}`
      : `${isSource ? targetName : sourceName}${relayName ? `（经 ${relayName}）` : ''}`

    const txPowerText = isFiber
      ? '—'
      : Number.isFinite(effective.txPower) ? `${formatNumber(effective.txPower)} W` : '暂无数据'

    let antennaGainText = '—'
    if (!isFiber) {
      const tx = effective.antennaGain?.tx
      const rx = effective.antennaGain?.rx
      if (Number.isFinite(tx) && Number.isFinite(rx)) {
        const corr = effective.antennaGainCorrectionDb
        const corrSuffix = typeof corr === 'number' && Number.isFinite(corr) && corr !== 0
          ? `（修正 ${corr > 0 ? '+' : ''}${formatNumber(corr)} dB）`
          : ''
        antennaGainText = `发 ${formatNumber(tx)} / 收 ${formatNumber(rx)} dBi${corrSuffix}`
      } else {
        antennaGainText = '暂无数据'
      }
    }

    const engineDistanceM = resolveEngineLinkDistanceMeters(link, engineFrame)
    let distanceText = '暂无数据'
    let distanceSource: NodeLinkParameterRow['distanceSource'] = 'NONE'
    if (engineDistanceM !== null) {
      distanceText = `${formatDistanceKm(engineDistanceM)} km（实时）`
      distanceSource = 'ENGINE'
    } else {
      const coordDistanceM = resolveCoordinateDistanceMeters(link, nodesById)
      if (coordDistanceM !== null) {
        distanceText = `${formatDistanceKm(coordDistanceM)} km（参考）`
        distanceSource = 'COORDINATES'
      }
    }

    const antiJammingGainText = isFiber || isLaser
      ? '—'
      : `${formatNumber(effective.antiJammingGainDb ?? 0)} dB`
    const spatialIsolationText = isFiber || isLaser
      ? '—'
      : `${formatNumber(effective.spatialIsolationDb ?? 0)} dB`

    rows.push({
      linkId: link.id,
      typeLabel: LINK_TYPE_LABELS[effective.type] ?? effective.type,
      directionLabel: effective.direction === 'REVERSE' ? '返向' : '前向',
      roleLabel,
      peerLabel,
      txPowerText,
      antennaGainText,
      distanceText,
      distanceSource,
      antiJammingGainText,
      spatialIsolationText,
    })
  }

  return rows
}
