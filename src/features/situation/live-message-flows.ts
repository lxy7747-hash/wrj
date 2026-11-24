import type { FileCommunicationType } from './file-communication-links'
import type { FileMessageDirection, FileMessageLinkIssues, FileMessageRecord } from './file-message-links'
import {
  toFileMessageRecord,
  type MissionMessageDelivery,
  type MissionMessageSnapshot,
  type MissionUnconfirmedTransmit,
} from './mission-messages'

const MAX_RECORDS_PER_LANE = 200
const BACKLOG_FLOOD_COUNT = 20
const BACKLOG_FLOOD_SPAN_S = 10
const RECENT_LIVE_BURST_WINDOW_S = 2

export interface LiveMessageFlowLane {
  id: string
  type: FileCommunicationType
  sourcePlatformId: string
  targetPlatformId: string
  sourceDeviceId: string
  targetDeviceId: string
  direction?: FileMessageDirection
  messageTypes: string[]
  records: FileMessageRecord[]
  firstTimeS: number
  lastTimeS: number
  messageCount: number
  /** 最近一次未曾播放过脉冲的接收事件标识；仅历史吸收或无新投递时为 undefined。 */
  pulseId?: string
  latestDeliveryTimeS: number
  latestDelayS: number
}

export interface LiveMessageState {
  runId: string
  generation: number
  sourceAvailable: boolean
  waitingForLine: boolean
  messageDetailsComplete: boolean
  issueCount: number
  issues: FileMessageLinkIssues
  latestSimTime: number | null
  totalTransmits: number
  totalReceives: number
  totalPaired: number
  unconfirmedCount: number
  lanes: LiveMessageFlowLane[]
  unconfirmedTransmits: MissionUnconfirmedTransmit[]
}

function laneKey(delivery: MissionMessageDelivery): string {
  return JSON.stringify([
    delivery.type,
    delivery.source.platformName,
    delivery.target.platformName,
    delivery.direction ?? 'UNKNOWN',
  ])
}

interface InternalLane {
  id: string
  type: FileCommunicationType
  sourcePlatformId: string
  targetPlatformId: string
  sourceDeviceId: string
  targetDeviceId: string
  direction?: FileMessageDirection
  messageTypeSet: Set<string>
  records: FileMessageRecord[]
  firstTimeS: number
  lastTimeS: number
  messageCount: number
  pulseId?: string
  latestDeliveryTimeS: number
  latestDelayS: number
}

function toPublicLane(lane: InternalLane): LiveMessageFlowLane {
  return {
    id: lane.id,
    type: lane.type,
    sourcePlatformId: lane.sourcePlatformId,
    targetPlatformId: lane.targetPlatformId,
    sourceDeviceId: lane.sourceDeviceId,
    targetDeviceId: lane.targetDeviceId,
    direction: lane.direction,
    messageTypes: [...lane.messageTypeSet].sort(),
    records: [...lane.records],
    firstTimeS: lane.firstTimeS,
    lastTimeS: lane.lastTimeS,
    messageCount: lane.messageCount,
    pulseId: lane.pulseId,
    latestDeliveryTimeS: lane.latestDeliveryTimeS,
    latestDelayS: lane.latestDelayS,
  }
}

/**
 * 维护单个运行轮次的实时报文流向投影与严格去重状态。
 * - 按 `(runId, generation, sourceEventId)` 去重：同一接收记录只计数与触发脉冲一次；
 *   同一发射广播给多个接收方时因 `sourceEventId` 不同而分别保留，不合并接收端。
 * - 首次载入已存在的历史积压数据时仅沉淀记录与方向图例，不把积压记录冒充刚发生的实时脉冲。
 */
export function createLiveMessageTracker() {
  let activeKey = ''
  let generation = -1
  let pendingBaselineDrain = false
  const seenKeys = new Set<string>()
  const lanes = new Map<string, InternalLane>()
  let state: LiveMessageState | null = null

  function resetData(): void {
    seenKeys.clear()
    lanes.clear()
    state = null
  }

  return {
    reset(nextKey: string, options?: { baselineFirstLoad?: boolean }): void {
      if (nextKey === activeKey) return
      activeKey = nextKey
      generation = -1
      pendingBaselineDrain = options?.baselineFirstLoad === true
      resetData()
    },

    current(): LiveMessageState | null {
      return state
    },

    clearAll(): void {
      activeKey = ''
      generation = -1
      pendingBaselineDrain = false
      resetData()
    },

    ingest(snapshot: MissionMessageSnapshot, options: { allowNewPulses: boolean }): LiveMessageState {
      if (snapshot.generation !== generation) {
        generation = snapshot.generation
        seenKeys.clear()
        lanes.clear()
      }

      const unseen: MissionMessageDelivery[] = []
      for (const delivery of snapshot.deliveries) {
        const dedupKey = `${snapshot.runId}:${snapshot.generation}:${delivery.sourceEventId}`
        if (seenKeys.has(dedupKey)) continue
        seenKeys.add(dedupKey)
        unseen.push(delivery)
      }

      let pulseCutoffTime = -Infinity
      let triggerPulses = options.allowNewPulses && !pendingBaselineDrain
      if (triggerPulses && unseen.length > BACKLOG_FLOOD_COUNT) {
        const minT = unseen.reduce((min, item) => Math.min(min, item.time), Infinity)
        const maxT = unseen.reduce((max, item) => Math.max(max, item.time), -Infinity)
        if (maxT - minT > BACKLOG_FLOOD_SPAN_S) {
          pulseCutoffTime = maxT - RECENT_LIVE_BURST_WINDOW_S
        }
      }

      for (const delivery of unseen) {
        const key = laneKey(delivery)
        const record = toFileMessageRecord(delivery)
        let entry = lanes.get(key)
        if (!entry) {
          entry = {
            id: key,
            type: delivery.type,
            sourcePlatformId: delivery.source.platformName,
            targetPlatformId: delivery.target.platformName,
            sourceDeviceId: delivery.source.communicationName,
            targetDeviceId: delivery.target.communicationName,
            direction: delivery.direction,
            messageTypeSet: new Set([delivery.messageType]),
            records: [record],
            firstTimeS: delivery.time,
            lastTimeS: delivery.time,
            messageCount: 1,
            latestDeliveryTimeS: delivery.time,
            latestDelayS: delivery.delayS,
          }
          lanes.set(key, entry)
        } else {
          entry.messageTypeSet.add(delivery.messageType)
          entry.records.push(record)
          if (entry.records.length > MAX_RECORDS_PER_LANE) entry.records.shift()
          entry.firstTimeS = Math.min(entry.firstTimeS, delivery.time)
          entry.lastTimeS = Math.max(entry.lastTimeS, delivery.time)
          entry.messageCount += 1
          entry.latestDeliveryTimeS = delivery.time
          entry.latestDelayS = delivery.delayS
          entry.sourceDeviceId = delivery.source.communicationName
          entry.targetDeviceId = delivery.target.communicationName
        }
        if (triggerPulses && delivery.time >= pulseCutoffTime) {
          entry.pulseId = `${snapshot.runId}:${snapshot.generation}:${delivery.sourceEventId}`
        }
      }

      if (pendingBaselineDrain && !snapshot.hasMore) {
        pendingBaselineDrain = false
      }

      state = {
        runId: snapshot.runId,
        generation: snapshot.generation,
        sourceAvailable: snapshot.sourceAvailable,
        waitingForLine: snapshot.waitingForLine,
        messageDetailsComplete: snapshot.messageDetailsComplete,
        issueCount: snapshot.issueCount,
        issues: { ...snapshot.issues },
        latestSimTime: snapshot.latestSimTime,
        totalTransmits: snapshot.totalTransmits,
        totalReceives: snapshot.totalReceives,
        totalPaired: snapshot.totalPaired,
        unconfirmedCount: snapshot.unconfirmedCount,
        lanes: [...lanes.values()].map(toPublicLane),
        unconfirmedTransmits: [...snapshot.unconfirmedTransmits],
      }
      return state
    },
  }
}

