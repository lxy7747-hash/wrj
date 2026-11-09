import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { EngineFrameSnapshot, QualityDataset, QualitySample, SwitchEvent, ValidationIssue } from '../contracts/domain-models'
import { isEngineFrameSnapshot } from '../features/data-exchange/engine-frame-snapshot'
import { adaptRuntimeLinkQuality, type RuntimeLinkQualityData } from '../features/data-exchange/runtime-link-quality'
import { RuntimeLinkDecisionTracker, type RuntimeLinkStatus, type RuntimeRouteCandidate, type RuntimeRouteDecision } from '../features/data-exchange/runtime-link-decisions'
import { consecutiveQualitySamples, isQualityDataset } from '../features/data-exchange/quality-records'
import { useAuthStore } from './auth'
import { useSimulationStore } from './simulation'

export interface RuntimeQualityScope {
  taskId: string
  runId: string
  scenarioId: string
  revision: number
  startedAt: string
}

export interface RuntimeQualityBinding {
  linkId: string
  sourceLinkId: string
  sourcePlatformId: string
  destinationPlatformId: string
  sourcePortId: string
  destinationPortId: string
}

export interface RuntimeQualityFrameMeta {
  frameId: number
  simulationTime: number
}

export interface RuntimeQualitySnapshot {
  frameId: number
  simulationTime: number
  data: RuntimeLinkQualityData
  /** Native adapter data and canonical imported data have distinct identity guarantees. */
  source?: 'NATIVE_LINK_CALC' | 'FILE_IMPORT'
  frameIdKind?: 'PROVIDED' | 'IMPORT_SEQUENCE'
}

type RuntimeQualityState = 'EMPTY' | 'SUCCESS' | 'ERROR'
export type EngineLinkStatus = Pick<RuntimeLinkStatus, 'linkId' | 'frameId' | 'simulationTime' | 'status' | 'gxbDb' | 'ber' | 'receivedPowerDbm'>
  & { source: 'ENGINE_FRAME'; stableFrames?: undefined }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameScope(left: RuntimeQualityScope | null, right: RuntimeQualityScope | null): boolean {
  return left !== null && right !== null
    && left.taskId === right.taskId && left.runId === right.runId && left.scenarioId === right.scenarioId
    && left.revision === right.revision && left.startedAt === right.startedAt
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameBindings(left: readonly RuntimeQualityBinding[], right: readonly RuntimeQualityBinding[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.keys(value).every(key => value[key as keyof RuntimeQualityBinding] === right[index]![key as keyof RuntimeQualityBinding]))
}

function sourceIdentity(value: Pick<RuntimeQualityBinding, 'sourceLinkId' | 'sourcePlatformId' | 'destinationPlatformId'> & { sourcePortId: string | null; destinationPortId: string | null }): string {
  return JSON.stringify([value.sourceLinkId, value.sourcePlatformId, value.destinationPlatformId, value.sourcePortId, value.destinationPortId])
}

function isScope(value: unknown): value is RuntimeQualityScope {
  return isRecord(value) && Object.keys(value).length === 5
    && ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt'].every(key => Object.hasOwn(value, key))
    && typeof value.taskId === 'string' && value.taskId.length > 0
    && typeof value.runId === 'string' && value.runId.length > 0
    && typeof value.scenarioId === 'string' && value.scenarioId.length > 0
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0
    && typeof value.startedAt === 'string' && value.startedAt.length > 0
}

function isMeta(value: unknown): value is RuntimeQualityFrameMeta {
  return isRecord(value) && Object.keys(value).length === 2 && Object.hasOwn(value, 'frameId') && Object.hasOwn(value, 'simulationTime')
    && typeof value.frameId === 'number' && Number.isSafeInteger(value.frameId) && value.frameId >= 0
    && typeof value.simulationTime === 'number' && Number.isFinite(value.simulationTime) && value.simulationTime >= 0
}

function parseBindings(value: unknown, allowedLinkIds: ReadonlySet<string>): RuntimeQualityBinding[] | null {
  if (!Array.isArray(value)) return null
  const linkIds = new Set<string>()
  const sourceIds = new Set<string>()
  const parsed: RuntimeQualityBinding[] = []
  for (const item of value) {
    if (!isRecord(item) || Object.keys(item).length !== 6
      || !['linkId', 'sourceLinkId', 'sourcePlatformId', 'destinationPlatformId', 'sourcePortId', 'destinationPortId'].every(key => Object.hasOwn(item, key))) return null
    const binding = item as unknown as RuntimeQualityBinding
    if (!Object.values(binding).every(text => typeof text === 'string' && text.trim().length > 0)
      || !allowedLinkIds.has(binding.linkId) || linkIds.has(binding.linkId) || sourceIds.has(sourceIdentity(binding))) return null
    linkIds.add(binding.linkId)
    sourceIds.add(sourceIdentity(binding))
    parsed.push({ ...binding })
  }
  return parsed
}

/** Maps a validated canonical record without inventing a physical port identity. */
function importedSample(sample: QualitySample) {
  return {
    linkId: sample.linkId,
    sourcePlatformId: sample.sourcePlatform,
    destinationPlatformId: sample.destPlatform,
    sourcePortId: null,
    destinationPortId: null,
    distanceMeters: sample.distance,
    losses: {
      freeSpaceLossDb: sample.losses?.freeSpaceLossDb ?? null,
      seaMultipathLossDb: sample.losses?.seaMultipathLossDb ?? null,
      atmosphericLossDb: sample.losses?.atmosphericLossDb ?? null,
      cloudRainLossDb: sample.losses?.cloudRainLossDb ?? null,
      jammingLossDb: sample.losses?.jammingLossDb ?? null,
      totalLossDb: sample.losses?.totalLossDb ?? sample.pathLoss,
    },
    quality: {
      gxbDb: sample.jsrDb,
      snrDb: sample.snr,
      ber: sample.ber,
      receivedPowerDbm: sample.receivedPower,
      interferencePowerDbm: sample.jammingPower,
      modelVersion: null,
      modulation: sample.modulation,
      inputTrace: { eirpDbw: null, gOverTDbK: null, dataRateMbps: sample.dataRate, jammerIds: null },
    },
  }
}

/**
 * 单次真实运行的质量快照及独立的本机质量判定；不补造 SNR 或 WebSocket 序号。
 * 激活、绑定和帧接收均复核当前会话、运行和保存场景，迟到数据只能被忽略。
 */
export const useRuntimeQualityStore = defineStore('runtime-quality', () => {
  const auth = useAuthStore()
  const simulation = useSimulationStore()
  const scope = ref<RuntimeQualityScope | null>(null)
  const bindings = ref<RuntimeQualityBinding[]>([])
  const snapshot = ref<RuntimeQualitySnapshot | null>(null)
  const engineFrame = ref<EngineFrameSnapshot | null>(null)
  const engineEvents = ref<{ frameId: number; simulationTime: number; event: EngineFrameSnapshot['events'][number] }[]>([])
  const engineSwitches = ref<{ frameId: number; simulationTime: number; route: EngineFrameSnapshot['routing']['switches'][number] }[]>([])
  const engineAlarms = ref<{ frameId: number; simulationTime: number; alarm: EngineFrameSnapshot['routing']['alarms'][number] }[]>([])
  const source = computed(() => engineFrame.value ? 'ENGINE_FRAME' : snapshot.value?.source ?? null)
  /** Events recorded by the imported source; never populated from local route decisions. */
  const importedSwitchEvents = ref<SwitchEvent[]>([])
  const importedDataset = ref<(Pick<QualityDataset, 'source' | 'expectedStepS'> & { hasCompleteLosses: boolean; hasSwitchEvidence: boolean }) | null>(null)
  const linkStatuses = ref<(RuntimeLinkStatus | EngineLinkStatus)[]>([])
  const routeCandidates = ref<RuntimeRouteCandidate[]>([])
  const routeDecisions = ref<RuntimeRouteDecision[]>([])
  /** 本地质量快照的选路记录，不是引擎切换执行回执。 */
  const decisionEvents = ref<RuntimeRouteDecision[]>([])
  const errors = ref<ValidationIssue[]>([])
  const state = ref<RuntimeQualityState>('EMPTY')
  const epoch = ref(0)
  let allowedLinkIds: string[] = []
  let activatedUserId: string | null = null
  let activatedAuthEpoch: number | null = null
  // 数据校验失败的较新源帧同样已被处理；不能让更早的成功帧回写 ERROR。
  let latestMeta: RuntimeQualityFrameMeta | null = null
  const decisionTracker = new RuntimeLinkDecisionTracker()
  const clearEngine = () => { engineFrame.value = null; engineEvents.value = []; engineSwitches.value = []; engineAlarms.value = [] }

  const resetCurrentDecisions = () => {
    decisionTracker.reset()
    linkStatuses.value = []
    routeCandidates.value = []
    routeDecisions.value = []
  }
  const invalidateCurrentDecisions = () => {
    decisionTracker.invalidate()
    linkStatuses.value = []
    routeCandidates.value = []
    routeDecisions.value = []
  }

  const reset = () => {
    clearEngine()
    epoch.value += 1
    scope.value = null
    bindings.value = []
    snapshot.value = null
    importedSwitchEvents.value = []
    importedDataset.value = null
    errors.value = []
    state.value = 'EMPTY'
    resetCurrentDecisions()
    decisionEvents.value = []
    allowedLinkIds = []
    latestMeta = null
    activatedUserId = null
    activatedAuthEpoch = null
  }

  const currentScope = (): RuntimeQualityScope | null => {
    const run = simulation.run
    const scene = simulation.selectedScene
    if (!auth.principal || auth.runtimeMode !== 'LOCAL' || !run || !scene
      || typeof run.startedAt !== 'string' || run.startedAt.length === 0
      || scene.config.scenario.id !== run.scenarioId) return null
    return {
      taskId: run.taskId,
      runId: run.runId,
      scenarioId: run.scenarioId,
      revision: scene.revision,
      startedAt: run.startedAt,
    }
  }

  const active = (): boolean => sameScope(scope.value, currentScope())
    && activatedUserId === auth.principal?.userId
    && activatedAuthEpoch === auth.requestEpoch

  const savedLinkIds = (): Set<string> | null => {
    const links = simulation.selectedScene?.config.links
    if (!Array.isArray(links)) return null
    const ids = links.map(link => link.id)
    return ids.every(id => typeof id === 'string' && id.trim().length > 0) ? new Set(ids) : null
  }
  const decisionConfig = () => {
    const config = simulation.selectedScene?.config
    if (!config || !Array.isArray(config.links) || !Array.isArray(config.platforms)
      || !config.links.every(link => typeof link.id === 'string' && typeof link.type === 'string'
        && (link.direction === 'FORWARD' || link.direction === 'REVERSE'))) return null
    return config
  }
  const fail = (issue: ValidationIssue | ValidationIssue[]): false => {
    clearEngine()
    snapshot.value = null
    importedSwitchEvents.value = []
    importedDataset.value = null
    invalidateCurrentDecisions()
    errors.value = Array.isArray(issue) ? issue : [issue]
    state.value = 'ERROR'
    return false
  }

  /** 激活当前真实运行的质量域；同一运行和同一已保存链路集合保留已验证快照。 */
  function activate(candidate: RuntimeQualityScope | null, candidateLinkIds: string[]): number {
    const allowed = Array.isArray(candidateLinkIds) && candidateLinkIds.every(id => typeof id === 'string' && id.trim().length > 0)
      ? [...new Set(candidateLinkIds)].sort() : []
    const candidateLinkCount = Array.isArray(candidateLinkIds) ? candidateLinkIds.length : -1
    const persistedIds = savedLinkIds()
    if (candidate === null) { reset(); return epoch.value }
    if (!isScope(candidate) || allowed.length !== candidateLinkCount || !sameScope(candidate, currentScope())
      || persistedIds === null || !allowed.every(id => persistedIds.has(id))) {
      reset()
      return epoch.value
    }
    if (sameScope(scope.value, candidate) && sameStrings(allowedLinkIds, allowed) && active()) return epoch.value
    epoch.value += 1
    scope.value = { ...candidate }
    clearEngine()
    bindings.value = []
    snapshot.value = null
    importedSwitchEvents.value = []
    importedDataset.value = null
    resetCurrentDecisions()
    decisionEvents.value = []
    errors.value = []
    state.value = 'EMPTY'
    allowedLinkIds = allowed
    latestMeta = null
    activatedUserId = auth.principal!.userId
    activatedAuthEpoch = auth.requestEpoch
    return epoch.value
  }

  /** 只接受显式的生成脚本设备映射；变化后作废旧质量帧。 */
  function bindLinks(requestEpoch: number, candidate: unknown): boolean {
    if (requestEpoch !== epoch.value || !active()) return false
    const next = parseBindings(candidate, new Set(allowedLinkIds))
    if (next === null) return false
    if (sameBindings(bindings.value, next)) return true
    epoch.value += 1
    bindings.value = next
    clearEngine()
    snapshot.value = null
    importedSwitchEvents.value = []
    importedDataset.value = null
    resetCurrentDecisions()
    decisionEvents.value = []
    errors.value = []
    state.value = 'EMPTY'
    latestMeta = null
    return true
  }

  /** 接收已解析的 link_calc：只在完全绑定、单调帧号和单调仿真时刻下保存。 */
  function acceptFrame(requestEpoch: number, meta: unknown, linkCalc: unknown): boolean {
    if (requestEpoch !== epoch.value || !active()) return false
    if (!isMeta(meta)) return fail({ severity: 'ERROR', code: 'RUNTIME_QUALITY_META_INVALID', fieldPath: 'meta', message: '质量快照帧号必须为非负安全整数，仿真时刻必须为非负有限数。' })
    if (latestMeta && (meta.frameId <= latestMeta.frameId || meta.simulationTime <= latestMeta.simulationTime)) return false
    latestMeta = { ...meta }
    const result = adaptRuntimeLinkQuality(linkCalc)
    if (result.data === null) return fail(result.errors.length ? result.errors : { severity: 'ERROR', code: 'RUNTIME_QUALITY_INVALID', fieldPath: 'link_calc', message: '链路质量数据不正确。' })
    const bound = new Map(bindings.value.map(binding => [sourceIdentity(binding), binding]))
    for (const [index, link] of result.data.links.entries()) {
      const key = sourceIdentity({ sourceLinkId: link.linkId, sourcePlatformId: link.sourcePlatformId, destinationPlatformId: link.destinationPlatformId, sourcePortId: link.sourcePortId, destinationPortId: link.destinationPortId })
      if (!bound.has(key)) return fail({ severity: 'ERROR', code: 'RUNTIME_QUALITY_UNBOUND_LINK', fieldPath: `link_calc.links[${index}]`, message: '质量链路未与当前保存场景的通信设备显式绑定。' })
    }
    clearEngine()
    snapshot.value = { frameId: meta.frameId, simulationTime: meta.simulationTime, data: result.data, source: 'NATIVE_LINK_CALC' }
    importedSwitchEvents.value = []
    importedDataset.value = null
    const config = decisionConfig()
    if (config === null) {
      invalidateCurrentDecisions()
    } else {
      const decisionData: RuntimeLinkQualityData = {
        ...result.data,
        links: result.data.links.map(link => {
          const binding = bound.get(sourceIdentity({ sourceLinkId: link.linkId, sourcePlatformId: link.sourcePlatformId, destinationPlatformId: link.destinationPlatformId, sourcePortId: link.sourcePortId, destinationPortId: link.destinationPortId }))!
          return { ...link, linkId: binding.linkId }
        }),
      }
      const decisions = decisionTracker.accept({ frameId: meta.frameId, simulationTime: meta.simulationTime, data: decisionData }, config)
      linkStatuses.value = decisions.statuses
      routeCandidates.value = decisions.candidates
      routeDecisions.value = decisions.decisions
      const changes = decisions.decisions.filter(decision => decision.previousLinkId !== decision.selectedLinkId)
      if (changes.length) decisionEvents.value = [...decisionEvents.value, ...changes].slice(-200)
    }
    errors.value = []
    state.value = result.data.links.length ? 'SUCCESS' : 'EMPTY'
    return true
  }

  /**
   * Receives the validated, persisted canonical file dataset.  Unlike the raw
   * link_calc adapter this deliberately has no device-port binding: the source
   * identifies a saved scenario link directly and no port is fabricated.
   */
  function acceptDataset(requestEpoch: number, candidate: unknown): boolean {
    if (requestEpoch !== epoch.value || !active()) return false
    if (!isQualityDataset(candidate)) {
      return fail({ severity: 'ERROR', code: 'QUALITY_DATASET_INVALID', fieldPath: 'quality', message: '质量文件返回数据不符合规范合同。' })
    }
    const dataset = candidate
    if (!sameScope(dataset.scope, scope.value)) return false
    if (importedDataset.value?.source.sha256 === dataset.source.sha256) return true

    const allowed = new Set(allowedLinkIds)
    const frameTimes = new Map<number, number>()
    const identities = new Set<string>()
    for (const [index, sample] of dataset.samples.entries()) {
      if (!allowed.has(sample.linkId)) {
        return fail({ severity: 'ERROR', code: 'QUALITY_DATASET_UNKNOWN_LINK', fieldPath: `quality.samples[${index}].linkId`, message: '质量文件引用了当前已保存场景之外的链路。' })
      }
      const identity = `${sample.frameId}\u0000${sample.linkId}`
      if (identities.has(identity)) {
        return fail({ severity: 'ERROR', code: 'QUALITY_DATASET_DUPLICATE_SAMPLE', fieldPath: `quality.samples[${index}]`, message: '同一采样帧中的链路测量重复。' })
      }
      identities.add(identity)
      const time = frameTimes.get(sample.frameId)
      if (time !== undefined && time !== sample.time) {
        return fail({ severity: 'ERROR', code: 'QUALITY_DATASET_FRAME_TIME_MISMATCH', fieldPath: `quality.samples[${index}].time`, message: '同一采样帧不能包含多个仿真时刻。' })
      }
      frameTimes.set(sample.frameId, sample.time)
    }

    const byFrame = new Map<number, QualitySample[]>()
    for (const sample of dataset.samples) byFrame.set(sample.frameId, [...(byFrame.get(sample.frameId) ?? []), sample])
    const frames = [...byFrame.entries()].sort(([leftFrame, left], [rightFrame, right]) => leftFrame - rightFrame || left[0]!.time - right[0]!.time)
    clearEngine()
    const config = decisionConfig()
    resetCurrentDecisions()
    decisionEvents.value = []
    latestMeta = null
    let latest: RuntimeQualitySnapshot | null = null
    let previousFrame: QualitySample | undefined
    for (const [frameId, samples] of frames) {
      const simulationTime = samples[0]!.time
      const data: RuntimeLinkQualityData = {
        modelVersion: null,
        modulation: null,
        links: samples.map(importedSample),
      }
      latest = { frameId, simulationTime, data, source: 'FILE_IMPORT', frameIdKind: dataset.source.frameIdKind }
      latestMeta = { frameId, simulationTime }
      if (config === null) continue
      // CSV frame ids are local import sequence numbers.  A missing real-time
      // interval must break stability accumulation even when those ids remain
      // numerically adjacent; invalidate preserves any active route cooldown.
      if (previousFrame !== undefined && !consecutiveQualitySamples(previousFrame, samples[0]!, dataset.expectedStepS)) decisionTracker.invalidate()
      const decisions = decisionTracker.accept({ frameId, simulationTime, data }, config)
      linkStatuses.value = decisions.statuses
      routeCandidates.value = decisions.candidates
      routeDecisions.value = decisions.decisions
      const changes = decisions.decisions.filter(decision => decision.previousLinkId !== decision.selectedLinkId)
      if (changes.length) decisionEvents.value = [...decisionEvents.value, ...changes].slice(-200)
      previousFrame = samples[0]!
    }
    snapshot.value = latest
    importedSwitchEvents.value = structuredClone(dataset.switchEvents)
    importedDataset.value = {
      source: { ...dataset.source }, expectedStepS: dataset.expectedStepS,
      hasCompleteLosses: dataset.samples.every(sample => sample.losses !== undefined),
      hasSwitchEvidence: dataset.source.switchEventsProvided === true || dataset.switchEvents.some(event => event.decision === 'ACCEPTED'),
    }
    errors.value = []
    state.value = latest === null ? 'EMPTY' : 'SUCCESS'
    return true
  }

  /** 引擎已完成判定，绝不送入本机 decisionTracker 再判一次。 */
  function acceptEngineFrame(requestEpoch: number, candidate: unknown): boolean {
    if (requestEpoch !== epoch.value || !active() || !isEngineFrameSnapshot(candidate) || candidate.runId !== scope.value?.runId) return false
    if (engineFrame.value && (candidate.engineEpoch < engineFrame.value.engineEpoch
      || (candidate.engineEpoch === engineFrame.value.engineEpoch && candidate.frameId <= engineFrame.value.frameId))) return false
    const frame = structuredClone(candidate)
    if (engineFrame.value && frame.engineEpoch > engineFrame.value.engineEpoch) clearEngine()
    if (!engineFrame.value) resetCurrentDecisions()
    engineFrame.value = frame
    snapshot.value = null; importedDataset.value = null; importedSwitchEvents.value = []
    routeCandidates.value = []; routeDecisions.value = []; decisionEvents.value = []
    latestMeta = null
    linkStatuses.value = frame.links.map(link => ({ source: 'ENGINE_FRAME', linkId: link.linkId, frameId: frame.frameId,
      simulationTime: frame.simulationTime, status: link.status, gxbDb: link.quality.gxbDb, ber: link.quality.ber, receivedPowerDbm: link.quality.rxPowerDbm }))
    const meta = { frameId: frame.frameId, simulationTime: frame.simulationTime }
    engineEvents.value = [...engineEvents.value, ...frame.events.map(event => ({ ...meta, event }))].slice(-200)
    engineSwitches.value = [...engineSwitches.value, ...frame.routing.switches.map(route => ({ ...meta, route }))].slice(-200)
    engineAlarms.value = [...engineAlarms.value, ...frame.routing.alarms.map(alarm => ({ ...meta, alarm }))].slice(-200)
    errors.value = []
    state.value = frame.links.length || frame.jammers.length || frame.events.length || frame.initRouting?.length || engineSwitches.value.length || engineAlarms.value.length ? 'SUCCESS' : 'EMPTY'
    return true
  }

  // 会话、运行实例、场景修订或场景选择改变时立即使旧回调失效；当前时间刷新不影响已接收帧。
  watch(() => {
    return [auth.principal?.userId ?? '', auth.requestEpoch, auth.runtimeMode, simulation.run?.taskId ?? '', simulation.run?.runId ?? '', simulation.run?.scenarioId ?? '', simulation.run?.startedAt ?? '', simulation.selectedScene?.config.scenario.id ?? '', simulation.selectedScene?.revision ?? 0]
  }, () => { if (!active() && (scope.value !== null || bindings.value.length || snapshot.value !== null || errors.value.length)) reset() }, { flush: 'sync' })

  return { scope, bindings, snapshot, source, engineFrame, engineEvents, engineSwitches, engineAlarms, importedSwitchEvents, importedDataset, linkStatuses, routeCandidates, routeDecisions, decisionEvents, errors, state, epoch, activate, bindLinks, acceptFrame, acceptDataset, acceptEngineFrame, resetToSafeEmpty: reset }
})
