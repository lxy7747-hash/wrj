import type { AfsimConnectionRecord } from '../data-exchange/afsim-event-log'

export const FILE_COMMUNICATION_LABELS = { SAT: '卫星通信', MICROWAVE: '微波通信' } as const
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

/** 按明确的设备类型分类，不从平台名、设备名或地址猜测制式。 */
export function fileCommunicationType(type: string): FileCommunicationType | null {
  if (type === 'satcom_1' || type === 'satcom_2') return 'SAT'
  return type === 'microwave' ? 'MICROWAVE' : null
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
    && Boolean(fileCommunicationType(record.sourceType) || fileCommunicationType(record.targetType))
}

/** 同平台对同类别合并为一条线，方向和重复登记仍保留于明细；不提前显示未来登记。 */
export function selectFileCommunicationLinks(records: FileCommunicationConnection[], time: number): FileCommunicationLink[] {
  const links = new Map<string, FileCommunicationLink>()
  for (const record of records) {
    if (record.time > time || record.scope !== 'INTER_PLATFORM') continue
    const [sourcePlatformId, targetPlatformId] = [record.source.platformName, record.target.platformName].sort() as [string, string]
    const types = new Set([fileCommunicationType(record.sourceType), fileCommunicationType(record.targetType)])
    for (const type of types) {
      if (!type) continue
      const id = JSON.stringify([type, sourcePlatformId, targetPlatformId])
      const link = links.get(id) ?? { id, type, sourcePlatformId, targetPlatformId, records: [] }
      link.records.push(record)
      links.set(id, link)
    }
  }
  return [...links.values()]
}
