import type { InformationDemand, Link, PlatformType, SatelliteType, ScenarioConfig, ValidationIssue } from '../../contracts/domain-models'
import { isInitialNodeSnapshot, type InitialNodeSnapshot } from '../situation/initial-nodes'
import { isPositionSnapshot, type PositionSnapshot } from '../situation/position-updates'
import { selectFileCommunicationLinks } from '../situation/file-communication-links'
import { inspectScenarioConfig, PLATFORM_TYPE_DOMAINS } from './scenario-validation'
import { PLATFORM_POSITION_RULES } from './platform-position-rules'

export interface LocalNodeChoice {
  sourceId: string
  selected: boolean
  targetId: string
  type?: PlatformType
  satelliteType?: SatelliteType
  useLatest: boolean
}

export interface LocalLinkChoice {
  sourceId: string
  selected: boolean
  id: string
  reverseEndpoints: boolean
  parameters: Partial<Link>
  demand: Partial<InformationDemand>
}

export interface LocalSceneImport {
  initial: InitialNodeSnapshot
  positions: PositionSnapshot | null
  nodes: LocalNodeChoice[]
  links: LocalLinkChoice[]
}

/** 仅列出已到达快照时刻的设备关联；不推断链路质量、业务方向或参数。 */
export function localImportLinks(initial: InitialNodeSnapshot, positions: PositionSnapshot | null) {
  const time = Math.max(...initial.nodes.map(node => node.time), ...(positions?.nodes.map(node => node.time) ?? []))
  return selectFileCommunicationLinks(initial.connections ?? [], time)
}

/** 创建独立候选配置；只合并明确选择的节点/新链路，全部校验通过后才可原子应用。 */
export function buildLocalSceneImport(base: ScenarioConfig, input: LocalSceneImport): { config?: ScenarioConfig; errors: ValidationIssue[] } {
  const errors: ValidationIssue[] = []
  const fail = (message: string, fieldPath: string) => errors.push({ severity: 'ERROR', code: 'LOCAL_IMPORT_INVALID', message, fieldPath })
  if (!input.initial || !isInitialNodeSnapshot(input.initial) || !isPositionSnapshot(input.positions)) {
    fail('本地文件快照格式不正确，请重新加载。', 'source')
    return { errors }
  }
  const config = structuredClone(base)
  const platforms: unknown[] = [...config.platforms]
  const mapping = new Map<string, string>()
  const usedTargets = new Set<string>()
  const selected = input.nodes.filter(node => node.selected)
  if (!selected.length) fail('请至少选择一个节点，并确认其场景类型或对应节点。', 'nodes')
  for (const [index, choice] of selected.entries()) {
    const path = `nodes[${index}]`
    const source = input.initial.nodes.find(node => node.platformId === choice.sourceId)
    const targetId = choice.targetId.trim()
    if (!source || !targetId || mapping.has(choice.sourceId) || usedTargets.has(targetId)) {
      fail('来源节点不存在、目标 ID 为空或节点映射重复。', path)
      continue
    }
    mapping.set(choice.sourceId, targetId)
    usedTargets.add(targetId)
    const existing = config.platforms.find(node => node.id === targetId)
    const type = existing?.type ?? choice.type
    if (!type || !Object.hasOwn(PLATFORM_TYPE_DOMAINS, type)) {
      fail('请选择场景实体类型，文件类型不会自动映射。', `${path}.type`)
      continue
    }
    const latest = input.positions?.nodes.find(node => node.platformId === source.platformId)
    if (choice.useLatest && (!latest || latest.time < source.time || input.positions?.hasMore)) {
      fail('此节点没有可用的最新位置，或位置文件尚未读取完整。', `${path}.position`)
      continue
    }
    const position = choice.useLatest ? latest! : source
    const { longitude, latitude, altitude } = position
    const rule = PLATFORM_POSITION_RULES[type]
    // 导入不绕过节点编辑器的受控位置规则，也不将真实坐标静默裁剪成合法值。
    if (rule && (longitude < rule.minLongitude || longitude > rule.maxLongitude
      || latitude < rule.minLatitude || latitude > rule.maxLatitude
      || (rule.altitude !== undefined && altitude !== rule.altitude))) {
      fail('文件坐标不符合该节点类型的位置约束；请核对来源或取消选择，不会自动修正坐标。', `${path}.position`)
    }
    const node = existing ? { ...existing, initialPosition: { longitude, latitude, altitude } } : {
      id: targetId, name: source.name, type, category: PLATFORM_TYPE_DOMAINS[type],
      initialPosition: { longitude, latitude, altitude }, waypoints: [], linkIds: [], sensorIds: [], jammerIds: [],
      ...(type === 'COMMUNICATION_SATELLITE' ? { satelliteType: choice.satelliteType } : {}),
    }
    if (existing) platforms[config.platforms.indexOf(existing)] = node
    else platforms.push(node)
  }
  const available = localImportLinks(input.initial, input.positions)
  const usedLinks = new Set<string>()
  const links: unknown[] = [...config.links]
  const demands: unknown[] = [...config.informationDemand]
  for (const [index, choice] of input.links.filter(link => link.selected).entries()) {
    const source = available.find(link => link.id === choice.sourceId)
    const id = choice.id.trim()
    if (!source || usedLinks.has(choice.sourceId) || !id || config.links.some(link => link.id === id)) {
      fail('关联不存在、重复选择或链路 ID 已占用；本次只新增链路，不覆盖已有链路。', `importLinks[${index}]`)
      continue
    }
    usedLinks.add(choice.sourceId)
    const sourcePlatformId = mapping.get(choice.reverseEndpoints ? source.targetPlatformId : source.sourcePlatformId)
    const targetPlatformId = mapping.get(choice.reverseEndpoints ? source.sourcePlatformId : source.targetPlatformId)
    if (!sourcePlatformId || !targetPlatformId) {
      fail('请先选择并映射该关联的两个节点。', `importLinks[${index}].endpoints`)
      continue
    }
    const p = choice.parameters
    links.push({ id, type: source.type, sourcePlatformId, targetPlatformId,
      frequency: p.frequency, bandwidth: p.bandwidth, txPower: p.txPower,
      antennaGain: p.antennaGain, modulation: p.modulation, berThreshold: p.berThreshold,
      dataRate: p.dataRate, direction: p.direction })
    const d = choice.demand
    // 内部需求编号及默认优先级仅是配置结构，不作为文件观测数据展示。
    demands.push({ id: `IMP-${id}`, linkId: id, sourcePlatformId, destinationPlatformIds: [targetPlatformId],
      direction: p.direction, informationType: d.informationType, volumeMb: d.volumeMb,
      frequencyHz: d.frequencyHz, priority: 'NORMAL', maxLatencyMs: d.maxLatencyMs, minDataRateMbps: d.minDataRateMbps })
    for (const platform of platforms as ScenarioConfig['platforms']) {
      if (platform.id === sourcePlatformId || platform.id === targetPlatformId) platform.linkIds = [...platform.linkIds, id]
    }
  }
  if (errors.length) return { errors }
  const candidate = { ...config, platforms, links, informationDemand: demands }
  const inspection = inspectScenarioConfig(candidate, 'write')
  return inspection.result.valid ? { config: candidate as ScenarioConfig, errors: [] } : { errors: inspection.result.errors }
}
