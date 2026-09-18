import type { AfsimConnectionRecord } from '../data-exchange/afsim-event-log'

export const FILE_COMMUNICATION_LABELS = { SAT: '卫星通信', MICROWAVE: '微波通信', DATALINK: '新一代数传链路', FIBER: '光纤链路' } as const
export type FileCommunicationType = keyof typeof FILE_COMMUNICATION_LABELS

/** 真实登记证据，不携带或推断 UP/DOWN、SNR、BER。 */
export interface FileCommunicationConnection extends AfsimConnectionRecord {
  sourceType: string
  targetType: string
}

export interface FileCommunicationLink {
  id: string
  type: FileCommunicationType
  sourcePlatformId: string
  targetPlatformId: string
  records: FileCommunicationConnection[]
}

/** 按事件文件中的设备类型和名称分类，不由节点名称推断通信制式。 */
export function fileCommunicationType(type: string, name = ''): FileCommunicationType | null {
  if (type === 'satcom_1' || type === 'satcom_2') return 'SAT'
  if (type === 'microwave') return 'MICROWAVE'
  if (type === 'WSF_RADIO_TRANSCEIVER' && ['sat_link', 'sat_link_a', 'sat_link_b'].includes(name)) return 'SAT'
  if (type === 'WSF_RADIO_TRANSCEIVER' && name === 'microwave_link') return 'MICROWAVE'
  if (type === 'WSF_RADIO_TRANSCEIVER' && ['c_band_uplink', 'c_band_downlink', 'l_band_uplink', 'l_band_downlink'].includes(name)) return 'DATALINK'
  return type === 'WSF_COMM_TRANSCEIVER' && name === 'fiber_link' ? 'FIBER' : null
}

/** 保留旧类型投影；新增名称映射要求两端同类，不能由单端推断跨用途登记的类别。 */
export function fileConnectionTypes(record: FileCommunicationConnection): FileCommunicationType[] {
  const legacy = [fileCommunicationType(record.sourceType), fileCommunicationType(record.targetType)]
    .filter((type): type is FileCommunicationType => type !== null)
  if (legacy.length) return [...new Set(legacy)]
  const source = fileCommunicationType(record.sourceType, record.source.communicationName)
  const target = fileCommunicationType(record.targetType, record.target.communicationName)
  return source && source === target ? [source] : []
}

export function isFileCommunicationConnection(value: unknown, platformIds: ReadonlySet<string>): value is FileCommunicationConnection {
  if (!value || typeof value !== 'object') return false
  const record = value as FileCommunicationConnection
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0
  return text(record.sourceEventId) && Number.isFinite(record.time) && record.time >= 0
    && record.scope === 'INTER_PLATFORM'
    && [record.source, record.target].every(endpoint => endpoint && typeof endpoint === 'object'
      && [endpoint.platformName, endpoint.communicationName, endpoint.address].every(text)
      && platformIds.has(endpoint.platformName))
    && record.source.platformName !== record.target.platformName
    && text(record.sourceType) && text(record.targetType)
    && fileConnectionTypes(record).length > 0
}

/** 同平台对同类别合并为一条线，方向和重复登记仍保留于明细；不提前显示未来登记。 */
export function selectFileCommunicationLinks(records: FileCommunicationConnection[], time: number): FileCommunicationLink[] {
  const links = new Map<string, FileCommunicationLink>()
  for (const record of records) {
    if (record.time > time || record.scope !== 'INTER_PLATFORM') continue
    const [sourcePlatformId, targetPlatformId] = [record.source.platformName, record.target.platformName].sort() as [string, string]
    for (const type of fileConnectionTypes(record)) {
      const id = JSON.stringify([type, sourcePlatformId, targetPlatformId])
      const link = links.get(id) ?? { id, type, sourcePlatformId, targetPlatformId, records: [] }
      link.records.push(record)
      links.set(id, link)
    }
  }
  return [...links.values()]
}
