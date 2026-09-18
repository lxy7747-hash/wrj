import type { AfsimLogEvent } from '../data-exchange/afsim-event-log'

/**
 * 平台删除记录：AFSIM 在仿真结束时为每个平台发出一次 PLATFORM_DELETED。
 * 只陈述平台退出的时刻，不推断退出原因，也不代表该平台曾参与业务。
 */
export interface FilePlatformDeletion {
  sourceEventId: string
  platformId: string
  time: number
}

/** 校验一条平台删除记录；未登记的平台不接受删除记录。 */
export function isFilePlatformDeletion(value: unknown, platformIds: ReadonlySet<string>): value is FilePlatformDeletion {
  if (!value || typeof value !== 'object') return false
  const deletion = value as FilePlatformDeletion
  return typeof deletion.sourceEventId === 'string' && deletion.sourceEventId.trim().length > 0
    && typeof deletion.platformId === 'string' && platformIds.has(deletion.platformId)
    && Number.isFinite(deletion.time) && deletion.time >= 0
}

/**
 * 提取平台删除记录。
 * @param events 已解析的事件日志事件；只读取 PLATFORM_DELETED。
 * @param platformIds 已登记的平台集合，未登记平台的删除记录被忽略而不是新建节点。
 * @returns 按源文件顺序排列、每个平台最多一条的删除记录。
 */
export function buildFilePlatformDeletions(events: readonly AfsimLogEvent[], platformIds: ReadonlySet<string>): FilePlatformDeletion[] {
  const deletions = new Map<string, FilePlatformDeletion>()
  for (const event of events) {
    if (event.type !== 'PLATFORM_DELETED' || event.unparsedText) continue
    const platformId = event.subject.trim()
    if (!platformIds.has(platformId)) continue
    const deletion: FilePlatformDeletion = { sourceEventId: event.id, platformId, time: event.time }
    if (!isFilePlatformDeletion(deletion, platformIds)) continue
    // 同一平台重复删除时保留最早时刻，避免后发记录把节点重新显示回来。
    const previous = deletions.get(platformId)
    if (!previous || deletion.time < previous.time) deletions.set(platformId, deletion)
  }
  return [...deletions.values()]
}

/**
 * 判断平台在给定时刻是否仍存在。
 * @param deletions 平台删除记录。
 * @param platformId 待判断的平台标识。
 * @param seconds 当前回放游标秒数。
 * @returns 删除时刻不晚于当前游标时返回 false；没有删除记录时返回 true。
 */
export function isPlatformPresentAt(deletions: readonly FilePlatformDeletion[], platformId: string, seconds: number): boolean {
  const deletion = deletions.find(record => record.platformId === platformId)
  return deletion === undefined || deletion.time > seconds
}
