import type { Link, LinkParameterField, LinkParameterSource, PortParameters, ScenarioConfig, TemplatePlatformType } from '../../contracts/domain-models'
import { readDeviceParameters, resolveTemplateLinkPorts, type TemplateLinkPort } from './template-defaults'

export const LINK_PORT_FIELDS = [
  { portKey: 'txFrequency', linkKey: 'frequency', label: '频率(MHz)' },
  { portKey: 'txBandwidth', linkKey: 'bandwidth', label: '发射带宽(MHz)' },
  { portKey: 'txPower', linkKey: 'txPower', label: '功率(W)' },
  { portKey: 'transferRate', linkKey: 'dataRate', label: '速率(Mbps)' },
  { portKey: 'rxFrequency', linkKey: 'rxFrequency', label: '接收频率(MHz)' },
  { portKey: 'rxBandwidth', linkKey: 'rxBandwidth', label: '接收带宽(MHz)' },
  { portKey: 'noiseFigureDb', linkKey: 'noiseFigureDb', label: '噪声系数(dB)' },
  { portKey: 'eirpDbw', linkKey: 'eirpDbw', label: 'EIRP(dBW)' },
  { portKey: 'gtDbk', linkKey: 'gtDbk', label: 'G/T(dB/K)' },
] as const

export const RADIO_MAPPED_PORT_FIELDS = LINK_PORT_FIELDS.map(({ portKey }) => portKey)
export const FIBER_MAPPED_PORT_FIELDS = ['transferRate'] as const

export function isPlatformPortLinkField(type: Link['type'], field: LinkParameterField): boolean {
  if (type === 'LASER') return false
  return type === 'FIBER' ? field === 'dataRate' : LINK_PORT_FIELDS.some(item => item.linkKey === field)
}

export function mappedPortFields(port: string): readonly (typeof LINK_PORT_FIELDS[number]['portKey'])[] {
  return port === 'fiber_link' ? FIBER_MAPPED_PORT_FIELDS : RADIO_MAPPED_PORT_FIELDS
}

export function linkOverride(link: Link, port: string): Partial<PortParameters> {
  const override: Partial<PortParameters> = {}
  for (const { portKey, linkKey } of LINK_PORT_FIELDS) {
    const value = link[linkKey]
    if (mappedPortFields(port).includes(portKey) && typeof value === 'number') override[portKey] = value
  }
  return override
}

type LinkPortValues = Partial<Pick<Link, typeof LINK_PORT_FIELDS[number]['linkKey']>>
type PortConfig = Pick<ScenarioConfig, 'deviceParameters' | 'platforms'>

export interface LinkPortEditorProjection {
  source: TemplateLinkPort
  target: TemplateLinkPort
  values: LinkPortValues
  conflict?: string
}

function readLinkPortProjection(config: PortConfig, link: Link): LinkPortEditorProjection | null {
  const match = resolveTemplateLinkPorts(config, link)
  if (match.status !== 'MAPPED') return null
  const { source, target } = match
  const ports = readDeviceParameters(config).ports
  const tx = ports[source.platformType]?.[source.portName]
  const rx = ports[target.platformType]?.[target.portName]
  if (!tx || !rx) return null
  const values: LinkPortValues = link.type === 'FIBER' ? { dataRate: tx.transferRate } : {
    frequency: tx.txFrequency, bandwidth: tx.txBandwidth, txPower: tx.txPower, dataRate: tx.transferRate,
    rxFrequency: rx.rxFrequency, rxBandwidth: rx.rxBandwidth, noiseFigureDb: rx.noiseFigureDb,
  }
  return { source, target, values }
}

/** 兼容仍读取 Link 数值的页面；继承链路的脚本取值始终直接读取端口配置。 */
export function materializeInheritedLink(config: PortConfig, link: Link): Link {
  if (link.inheritPortParameters !== true) return link
  const projection = readLinkPortProjection(config, link)
  if (!projection || Object.values(projection.values).some(value => !Number.isFinite(value))) return link
  return { ...link, ...projection.values }
}

function pruneOverwrittenParameterSource(link: Link, overwrittenFields: readonly LinkParameterField[]): Link {
  const source = (link as Link & { parameterSource?: LinkParameterSource }).parameterSource
  if (!source) return link
  const remaining = source.fields.filter(field => !overwrittenFields.includes(field))
  if (remaining.length === source.fields.length) return link
  if (remaining.length === 0) {
    const { parameterSource: _, ...rest } = link as Link & { parameterSource?: LinkParameterSource }
    return rest as Link
  }
  return { ...link, parameterSource: { ...source, fields: remaining } } as Link
}

/** 读取链路在「端口参数设置」下的有效值投影；保留非法校验注入值以便校验提示生效。 */
export function effectiveLinkFromPorts(config: PortConfig, link: Link): Link {
  if (link.type === 'LASER') return link
  const projection = readLinkPortProjection(config, link)
  if (!projection) return link
  const next = { ...link }
  for (const [key, portValue] of Object.entries(projection.values) as Array<[keyof LinkPortValues, number | undefined]>) {
    if (typeof portValue !== 'number' || !Number.isFinite(portValue)) continue
    const current = next[key]
    const invalid = typeof current === 'number' && (
      !Number.isFinite(current)
      || (key === 'txPower' ? current < 0 : key === 'noiseFigureDb' ? current < 0 || current > 100 : current <= 0)
    )
    if (!invalid) Object.assign(next, { [key]: portValue })
  }
  return next
}

/** 所有映射到平台端口的非激光链路均强制采用「端口参数设置」的值，并清理被覆盖字段的参数来源引用。 */
export function overwriteLegacyLinkFromPorts(config: PortConfig, link: Link): Link {
  if (link.type === 'LASER' || !readLinkPortProjection(config, link)) return link

  const inherited: Link = materializeInheritedLink(config, { ...link, inheritPortParameters: true })
  const overwrittenFields = LINK_PORT_FIELDS
    .map(item => item.linkKey)
    .filter(field => isPlatformPortLinkField(link.type, field))
  return pruneOverwrittenParameterSource(inherited, overwrittenFields)
}

export function projectLinkPortParameters(config: PortConfig, link: Link, _previousId?: string): LinkPortEditorProjection | null {
  return readLinkPortProjection(config, link)
}

export type LinkPortFieldTarget = {
  fieldPath: string
  platformType: TemplatePlatformType
  portName: string
  portKey: (typeof LINK_PORT_FIELDS)[number]['portKey']
  legacyLinkOverrideInvalid: boolean
}

const TARGET_SIDE_PORT_KEYS = new Set(['rxFrequency', 'rxBandwidth', 'noiseFigureDb'])

/**
 * 将链路层字段路径解析到对应的「端口参数设置」字段路径。
 * 仅对非激光且成功映射到模板端口的受管字段生效；激光或非端口字段返回 `null`。
 */
export function resolveLinkPortFieldTarget(
  config: Pick<ScenarioConfig, 'deviceParameters' | 'platforms' | 'links'>,
  linkIndex: number,
  linkField: string,
): LinkPortFieldTarget | null {
  const link = config.links[linkIndex]
  if (!link || link.type === 'LASER') return null
  const mapped = LINK_PORT_FIELDS.find(item => item.linkKey === linkField)
  if (!mapped || !isPlatformPortLinkField(link.type, mapped.linkKey)) return null
  const resolution = resolveTemplateLinkPorts(config, link)
  if (resolution.status !== 'MAPPED') return null
  const port = TARGET_SIDE_PORT_KEYS.has(mapped.portKey) ? resolution.target : resolution.source
  const portValue = readDeviceParameters(config).ports[port.platformType]?.[port.portName]?.[mapped.portKey]
  const rawLinkValue = link[mapped.linkKey]
  const isPortValid = typeof portValue === 'number' && Number.isFinite(portValue)
    && (mapped.portKey === 'txPower' ? portValue >= 0 : mapped.portKey === 'noiseFigureDb' ? (portValue >= 0 && portValue <= 100) : portValue > 0)
  const isRawLinkInvalid = typeof rawLinkValue === 'number' && rawLinkValue !== portValue
    && (mapped.portKey === 'txPower' ? rawLinkValue < 0 : mapped.portKey === 'noiseFigureDb' ? (rawLinkValue < 0 || rawLinkValue > 100) : !Number.isFinite(rawLinkValue) || rawLinkValue <= 0)
  return {
    fieldPath: `deviceParameters.ports.${port.platformType}.${port.portName}.${mapped.portKey}`,
    platformType: port.platformType,
    portName: port.portName,
    portKey: mapped.portKey,
    legacyLinkOverrideInvalid: isPortValid && isRawLinkInvalid,
  }
}
