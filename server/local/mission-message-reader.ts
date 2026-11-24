import { open, type FileHandle } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { ScenarioDraft } from '../../src/contracts/domain-models.js'
import {
  fileCommunicationType,
} from '../../src/features/situation/file-communication-links.js'
import {
  createManifestEndpointTypeResolver,
  fileMessageDeviceKey,
  matchFileMessageReceive,
  MESSAGE_MAX_DELAY_S,
  readSingleMessageDirection,
  type FileMessageLinkIssues,
  type MessageHopHint,
  type MessageReceiveInput,
  type MessageTransmitCandidate,
} from '../../src/features/situation/file-message-links.js'
import type {
  MissionMessageDelivery,
  MissionMessageSnapshot,
  MissionUnconfirmedTransmit,
} from '../../src/features/situation/mission-messages.js'
import { engineNameMap, toScenarioDevices, toScenarioEvent } from './engine-name-mapping.js'
import { IncrementalEventDecoder, MAX_PENDING_EVENT_BYTES, splitCompleteLines } from './incremental-event-decoder.js'
import { resolveRunOutputFile, type RunOutputSource } from './mission-run-source.js'

const CHUNK_BYTES = 1024 * 1024
const MAX_PASS_BYTES = 4 * 1024 * 1024
const DELIVERY_BATCH_LIMIT = 500
const RECENT_DELIVERY_CAP = 4000
const UNCONFIRMED_SAMPLE_CAP = 200
const TRANSMIT_RETENTION_WINDOW_S = 10

const RELEVANT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'COMM_TURNED_ON',
  'MESSAGE_TRANSMITTED',
  'MESSAGE_RECEIVED',
  'MESSAGE_HOP',
  'SIMULATION_COMPLETE',
])

type StoredTransmit = MessageTransmitCandidate & { serial: string }

interface ReaderContext {
  platformIds: ReadonlySet<string>
  names: Map<string, string> | undefined
  resolveFallbackType: ReturnType<typeof createManifestEndpointTypeResolver>
}

interface MessageReaderInstance {
  read(afterCursor: number, simulationEnded: boolean): Promise<Omit<MissionMessageSnapshot, 'runId' | 'scenarioId' | 'revision'>>
}

function createMessageEventReader(inputPath: string, context: ReaderContext): MessageReaderInstance {
  const filePath = resolve(inputPath)
  let identity = ''
  let offset = 0
  let anchor = Buffer.alloc(0)
  let pendingText = ''
  let utf8Decoder = new TextDecoder('utf-8', { fatal: true })
  let decoder = new IncrementalEventDecoder()
  let generation = 0
  let eventOrder = 0

  let latestSimTime: number | null = null
  let simulationComplete = false
  let fatalIncomplete = false
  let issueCount = 0
  let issues: FileMessageLinkIssues = { undelivered: 0, ambiguous: 0, unclassified: 0 }
  let totalTransmits = 0
  let totalReceives = 0
  let totalPaired = 0
  let lastSequence = 0
  let agedOutUnconfirmedCount = 0
  let endedFinalized = false

  let deviceTypes = new Map<string, string>()
  let transmitsBySerial = new Map<string, StoredTransmit[]>()
  let hopsBySerial = new Map<string, MessageHopHint[]>()
  let openTransmitsById = new Map<string, StoredTransmit>()
  let confirmedTransmitIds = new Map<string, number>()
  let unconfirmedById = new Map<string, MissionUnconfirmedTransmit>()
  let recentDeliveries: MissionMessageDelivery[] = []
  let inFlight: Promise<boolean> | null = null

  function resetState(): void {
    offset = 0
    anchor = Buffer.alloc(0)
    pendingText = ''
    utf8Decoder = new TextDecoder('utf-8', { fatal: true })
    decoder = new IncrementalEventDecoder()
    generation += 1
    eventOrder = 0
    latestSimTime = null
    simulationComplete = false
    fatalIncomplete = false
    issueCount = 0
    issues = { undelivered: 0, ambiguous: 0, unclassified: 0 }
    totalTransmits = 0
    totalReceives = 0
    totalPaired = 0
    lastSequence = 0
    agedOutUnconfirmedCount = 0
    endedFinalized = false
    deviceTypes = new Map()
    transmitsBySerial = new Map()
    hopsBySerial = new Map()
    openTransmitsById = new Map()
    confirmedTransmitIds = new Map()
    unconfirmedById = new Map()
    recentDeliveries = []
  }

  function advanceTime(time: number): void {
    latestSimTime = latestSimTime === null ? time : Math.max(latestSimTime, time)
  }

  function processEvent(rawEvent: ReturnType<IncrementalEventDecoder['read']>[number]): void {
    const event = toScenarioEvent(context.names, rawEvent)
    advanceTime(event.time)
    if (event.type === 'SIMULATION_COMPLETE') {
      simulationComplete = true
      return
    }
    if (event.type === 'COMM_TURNED_ON') {
      const platform = event.subject.trim()
      const comm = (event.fields.system ?? event.fields.Comm ?? event.fields.comm ?? '').trim()
      const systemType = (event.fields.system_type ?? event.fields.Type ?? '').trim()
      if (platform && comm && systemType) {
        deviceTypes.set(fileMessageDeviceKey(platform, comm), systemType)
      }
      return
    }
    if (event.type === 'MESSAGE_HOP') {
      const serial = (event.fields.message_serial_number ?? event.fields.Number ?? '').trim()
      const messageType = (event.fields.message_type ?? event.fields.Type ?? '').trim()
      const platformName = event.subject.trim()
      const communicationName = (event.fields.receiver_system ?? event.fields.System ?? event.fields.comm ?? '').trim()
      const destination = (event.fields.destination ?? event.fields.Destination ?? '').trim()
      if (!serial || !messageType || !platformName || !communicationName || !destination.includes('.')) return
      const bucket = hopsBySerial.get(serial)
      const hint: MessageHopHint = { time: event.time, serial, messageType, platformName, communicationName, destination }
      if (bucket) bucket.push(hint)
      else hopsBySerial.set(serial, [hint])
      return
    }
    if (event.type !== 'MESSAGE_TRANSMITTED' && event.type !== 'MESSAGE_RECEIVED') return
    const platformName = event.subject.trim()
    const communicationName = (event.fields.comm ?? '').trim()
    const serial = (event.fields.message_serial_number ?? '').trim()
    const messageType = (event.fields.message_type ?? '').trim()
    if (!platformName || !communicationName || !serial || !messageType) return

    eventOrder += 1
    if (event.type === 'MESSAGE_TRANSMITTED') {
      totalTransmits += 1
      const entry: StoredTransmit = {
        eventId: event.id,
        time: event.time,
        platformName,
        communicationName,
        messageType,
        order: eventOrder,
        serial,
      }
      const bucket = transmitsBySerial.get(serial)
      if (bucket) bucket.push(entry)
      else transmitsBySerial.set(serial, [entry])
      openTransmitsById.set(entry.eventId, entry)
      return
    }

    const messageSizeBits = Number(event.fields.message_size)
    if (!Number.isFinite(messageSizeBits)) return
    totalReceives += 1
    const receive: MessageReceiveInput = {
      eventId: event.id,
      time: event.time,
      platformName,
      communicationName,
      messageType,
      order: eventOrder,
      serial,
      messageSizeBits,
    }
    const outcome = matchFileMessageReceive(
      receive,
      transmitsBySerial.get(serial) ?? [],
      context.platformIds,
      deviceTypes,
      { resolveFallbackType: context.resolveFallbackType, hops: hopsBySerial.get(serial) },
    )
    if (outcome.kind !== 'PAIRED') {
      if (outcome.kind === 'UNDELIVERED') issues.undelivered += 1
      else if (outcome.kind === 'AMBIGUOUS') issues.ambiguous += 1
      else issues.unclassified += 1
      return
    }

    const { type, transmit, record } = outcome
    confirmedTransmitIds.set(transmit.eventId, transmit.time)
    openTransmitsById.delete(transmit.eventId)
    unconfirmedById.delete(transmit.eventId)
    totalPaired += 1
    lastSequence += 1
    recentDeliveries.push({
      sequence: lastSequence,
      sourceEventId: record.sourceEventId,
      transmitEventId: record.transmitEventId,
      type,
      time: record.time,
      delayS: record.delayS,
      source: record.source,
      target: record.target,
      messageType: record.messageType,
      messageSizeBits: record.messageSizeBits,
      direction: readSingleMessageDirection(record.messageType),
    })
    if (recentDeliveries.length > RECENT_DELIVERY_CAP) recentDeliveries.shift()
  }

  function decodeLine(line: string, tolerateTruncatedTail: boolean): void {
    try {
      const events = decoder.read(line, {
        includeTypes: RELEVANT_EVENT_TYPES,
        onSkippedTime: advanceTime,
      })
      for (const event of events) processEvent(event)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (tolerateTruncatedTail && decoder.isTruncatedTail(line, reason)) {
        fatalIncomplete = true
        issueCount += 1
        return
      }
      issueCount += 1
      fatalIncomplete = true
    }
  }

  function promoteAndPrune(ended: boolean): void {
    const pruneCutoff = latestSimTime !== null ? latestSimTime - TRANSMIT_RETENTION_WINDOW_S : -Infinity
    for (const [eventId, entry] of openTransmitsById) {
      if (confirmedTransmitIds.has(eventId)) {
        openTransmitsById.delete(eventId)
        continue
      }
      const expired = ended || simulationComplete || (latestSimTime !== null && latestSimTime - entry.time > MESSAGE_MAX_DELAY_S)
      if (!expired) continue
      openTransmitsById.delete(eventId)
      const knownDeviceType = deviceTypes.get(fileMessageDeviceKey(entry.platformName, entry.communicationName)) ?? ''
      const resolvedLinkType = fileCommunicationType(knownDeviceType, entry.communicationName) ?? undefined
      unconfirmedById.set(eventId, {
        eventId,
        transmitTime: entry.time,
        platformName: entry.platformName,
        communicationName: entry.communicationName,
        messageType: entry.messageType,
        direction: readSingleMessageDirection(entry.messageType),
        ...(resolvedLinkType ? { linkType: resolvedLinkType } : {}),
      })
      while (unconfirmedById.size > UNCONFIRMED_SAMPLE_CAP) {
        const oldestKey = unconfirmedById.keys().next().value
        if (!oldestKey) break
        unconfirmedById.delete(oldestKey)
        agedOutUnconfirmedCount += 1
      }
    }

    if (Number.isFinite(pruneCutoff)) {
      for (const [serial, bucket] of transmitsBySerial) {
        const kept = bucket.filter((entry) => entry.time >= pruneCutoff)
        if (kept.length === 0) transmitsBySerial.delete(serial)
        else if (kept.length !== bucket.length) transmitsBySerial.set(serial, kept)
      }
      for (const [serial, bucket] of hopsBySerial) {
        const kept = bucket.filter((entry) => entry.time >= pruneCutoff)
        if (kept.length === 0) hopsBySerial.delete(serial)
        else if (kept.length !== bucket.length) hopsBySerial.set(serial, kept)
      }
      for (const [eventId, time] of confirmedTransmitIds) {
        if (time < pruneCutoff) confirmedTransmitIds.delete(eventId)
      }
    }
  }

  async function verifyReset(file: FileHandle, size: number, nextIdentity: string): Promise<boolean> {
    let reset = identity !== nextIdentity || size < offset
    if (!reset && anchor.length > 0) {
      const check = Buffer.alloc(anchor.length)
      const { bytesRead } = await file.read(check, 0, check.length, offset - anchor.length)
      reset = bytesRead !== anchor.length || !check.equals(anchor)
    }
    if (reset) resetState()
    return reset
  }

  async function advanceFile(simulationEnded: boolean): Promise<boolean> {
    const file = await open(filePath, 'r')
    let fileHasMore = false
    try {
      const before = await file.stat()
      if (!before.isFile()) throw new Error(`${basename(filePath)} 必须为普通文件。`)
      const nextIdentity = `${before.dev}:${before.ino}:${before.birthtimeMs}`
      await verifyReset(file, before.size, nextIdentity)

      const targetSize = Math.min(before.size, offset + MAX_PASS_BYTES)
      let currentOffset = offset
      while (currentOffset < targetSize) {
        const sizeToRead = Math.min(CHUNK_BYTES, targetSize - currentOffset)
        const chunk = Buffer.alloc(sizeToRead)
        let readBytes = 0
        while (readBytes < sizeToRead) {
          const { bytesRead } = await file.read(chunk, readBytes, sizeToRead - readBytes, currentOffset + readBytes)
          if (bytesRead === 0) throw new Error('事件日志文件正在重建，请重试。')
          readBytes += bytesRead
        }
        const afterChunk = await file.stat()
        if ((afterChunk.dev !== 0 && before.dev !== 0 && afterChunk.dev !== before.dev)
          || afterChunk.ino !== before.ino || afterChunk.size < before.size
          || afterChunk.birthtimeMs !== before.birthtimeMs) {
          throw new Error('事件日志文件正在替换，请重试。')
        }
        try {
          pendingText += utf8Decoder.decode(chunk, { stream: true })
        } catch {
          fatalIncomplete = true
          issueCount += 1
          throw new Error('事件日志文件编码无效，已保留当前已解析证据。')
        }
        const split = splitCompleteLines(pendingText)
        // CR at the end of this chunk may belong to a CRLF split across reads.
        const pendingLine = split.pending.endsWith('\r') ? split.pending.slice(0, -1) : split.pending
        if (Buffer.byteLength(pendingLine, 'utf8') > MAX_PENDING_EVENT_BYTES
          || split.lines.some(line => Buffer.byteLength(line, 'utf8') > MAX_PENDING_EVENT_BYTES)) {
          fatalIncomplete = true
          issueCount += 1
          throw new Error('事件日志文件存在过长或缺少换行的记录。')
        }
        pendingText = split.pending
        for (const line of split.lines) decodeLine(line, false)
        currentOffset += readBytes
      }

      if (currentOffset !== offset) {
        const nextAnchor = Buffer.alloc(Math.min(64, currentOffset))
        if (nextAnchor.length > 0) {
          const anchorRead = await file.read(nextAnchor, 0, nextAnchor.length, currentOffset - nextAnchor.length)
          if (anchorRead.bytesRead !== nextAnchor.length) throw new Error('事件日志文件正在重建，请重试。')
        }
        anchor = nextAnchor
        offset = currentOffset
      }
      identity = nextIdentity
      const after = await file.stat()
      fileHasMore = after.size > offset

      if (!fileHasMore && simulationEnded && !endedFinalized) {
        endedFinalized = true
        try {
          pendingText += utf8Decoder.decode()
        } catch {
          fatalIncomplete = true
          issueCount += 1
        }
        if (pendingText) {
          const tail = pendingText
          pendingText = ''
          decodeLine(tail, true)
        }
        try {
          for (const event of decoder.close()) processEvent(event)
        } catch {
          fatalIncomplete = true
          issueCount += 1
        }
      }
      promoteAndPrune(simulationEnded && !fileHasMore)
    } finally {
      await file.close()
    }
    return fileHasMore
  }

  return {
    async read(afterCursor: number, simulationEnded: boolean) {
      inFlight ??= advanceFile(simulationEnded).finally(() => { inFlight = null })
      const fileHasMore = await inFlight
      const startIndex = recentDeliveries.findIndex((delivery) => delivery.sequence > afterCursor)
      const matching = startIndex >= 0 ? recentDeliveries.slice(startIndex) : []
      const batch = matching.slice(0, DELIVERY_BATCH_LIMIT)
      const remaining = matching.length > DELIVERY_BATCH_LIMIT
      const nextCursor = batch.length > 0
        ? batch[batch.length - 1]!.sequence
        : Math.max(afterCursor, lastSequence)
      const waitingForLine = pendingText.length > 0
      return {
        generation,
        cursor: nextCursor,
        hasMore: fileHasMore || remaining,
        sourceAvailable: true,
        latestSimTime,
        waitingForLine,
        messageDetailsComplete: !fatalIncomplete && !(simulationEnded && waitingForLine),
        issueCount,
        issues: { ...issues },
        totalTransmits,
        totalReceives,
        totalPaired,
        unconfirmedCount: agedOutUnconfirmedCount + unconfirmedById.size,
        deliveries: batch,
        unconfirmedTransmits: [...unconfirmedById.values()],
      }
    },
  }
}

type RunMessageSource = RunOutputSource & {
  eventLogPath?: string
  reader?: MessageReaderInstance
}

/** 从本次 mission 运行目录增量读取真实 scenario_events.csv 收发报文并按 0.15s 配对。 */
export class MissionMessageReader {
  private readonly sources = new Map<string, RunMessageSource>()

  attach(runId: string, draft: ScenarioDraft, entryPath: string): void {
    this.sources.clear()
    this.sources.set(runId, { runId, scenarioId: draft.config.scenario.id, revision: draft.revision, entryPath: resolve(entryPath) })
  }

  has(runId: string): boolean { return this.sources.has(runId) }

  async read(
    runId: string,
    afterCursor = 0,
    options?: { simulationEnded?: boolean },
  ): Promise<MissionMessageSnapshot | null> {
    const source = this.sources.get(runId)
    if (!source) return null
    const resolved = await resolveRunOutputFile(source, 'scenario_events.csv', () => this.isCurrent(source), '事件日志文件')
    if (resolved.status === 'STALE') return null
    if (resolved.status === 'MISSING') {
      return {
        runId: source.runId,
        scenarioId: source.scenarioId,
        revision: source.revision,
        generation: 0,
        cursor: 0,
        hasMore: false,
        sourceAvailable: false,
        latestSimTime: null,
        waitingForLine: false,
        messageDetailsComplete: true,
        issueCount: 0,
        issues: { undelivered: 0, ambiguous: 0, unclassified: 0 },
        totalTransmits: 0,
        totalReceives: 0,
        totalPaired: 0,
        unconfirmedCount: 0,
        deliveries: [],
        unconfirmedTransmits: [],
      }
    }

    const { mapping, filePath } = resolved
    if (source.eventLogPath !== filePath || !source.reader) {
      const names = engineNameMap(mapping)
      const platformIds = new Set(mapping.platforms.map((platform) => platform.platformId))
      const mappedDevices = toScenarioDevices(names, mapping.devices)
      source.eventLogPath = filePath
      source.reader = createMessageEventReader(filePath, {
        platformIds,
        names,
        resolveFallbackType: createManifestEndpointTypeResolver(mappedDevices),
      })
    }

    const chunk = await source.reader.read(afterCursor, options?.simulationEnded === true)
    if (!this.isCurrent(source)) return null
    return {
      runId: source.runId,
      scenarioId: source.scenarioId,
      revision: source.revision,
      ...chunk,
    }
  }

  private isCurrent(source: RunMessageSource): boolean {
    return this.sources.get(source.runId) === source
  }
}
