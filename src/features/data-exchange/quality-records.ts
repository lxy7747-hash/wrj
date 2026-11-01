import {
  LINK_QUALITY_CSV_HEADER,
  type Link,
  type QualityDataset,
  type QualityImportRequest,
  type QualityLosses,
  type QualitySample,
  type QualityScope,
  type ScenarioConfig,
  type SwitchEvent,
  type ValidationIssue,
} from '../../contracts/domain-models'
import { parseCsvLine } from './csv-contract'
export type { QualityScope, QualityLosses, QualitySample, QualityDataset, QualityImportRequest } from '../../contracts/domain-models'

/** 连续帧只容忍浮点表示误差，不跨过缺失采样。 */
export function consecutiveQualitySamples(left: Pick<QualitySample, 'frameId' | 'time'>, right: Pick<QualitySample, 'frameId' | 'time'>, expectedStepS: number): boolean {
  const delta = right.time - left.time
  return expectedStepS > 0 && right.frameId === left.frameId + 1 && delta > 0
    && delta <= expectedStepS + Math.max(1, expectedStepS) * 1e-9
}
export type QualityParseResult = { data: QualityDataset; errors: [] } | { data: null; errors: ValidationIssue[] }
export type QualityConfig = Pick<ScenarioConfig, 'scenario' | 'platforms' | 'links' | 'linkSettings'>

/** 外部质量文件合同错误；可由纯 HTTP 层识别而不依赖本机文件实现。 */
export class QualityImportError extends Error {
  readonly issues: ValidationIssue[]
  constructor(issues: ValidationIssue[]) { super(issues[0]?.message ?? '质量文件不符合合同。'); this.name = 'QualityImportError'; this.issues = issues }
}

const MAX_IMPORT_BYTES = 4 * 1024 * 1024
const qualityKeys = ['time', 'sourcePlatform', 'destPlatform', 'linkType', 'frequency', 'bandwidth', 'distance', 'txPower',
  'txAntennaGain', 'rxAntennaGain', 'pathLoss', 'jammingPower', 'receivedPower', 'snr', 'modulation', 'ber', 'linkStatus',
  'berThreshold', 'dataRate', 'jsrDb', 'latencyMs', 'availabilityPercent', 'linkId', 'frameId', 'losses', 'interferenceActive'] as const
const lossKeys = ['freeSpaceLossDb', 'seaMultipathLossDb', 'atmosphericLossDb', 'cloudRainLossDb', 'jammingLossDb', 'totalLossDb'] as const
const switchKeys = ['eventId', 'frameId', 'time', 'sourceRegistryTime', 'type', 'direction', 'oldLinkId', 'newLinkId', 'oldBer', 'newBer',
  'stabilityFrames', 'minimumStableFrames', 'hysteresisSatisfied', 'cooldownRemainingS', 'decision', 'reason', 'dedupeKey'] as const
const sampleRequiredKeys = qualityKeys.filter(key => !['latencyMs', 'availabilityPercent', 'losses', 'interferenceActive'].includes(key))
const issue = (errors: ValidationIssue[], code: string, fieldPath: string, message: string) => errors.push({ severity: 'ERROR', code, fieldPath, message })
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key))
const validText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.trim() === value
/** 质量接收、推送和报表边界共用的运行作用域守卫。 */
export const isQualityScope = (value: unknown): value is QualityScope => isObject(value) && hasOnly(value, ['taskId', 'runId', 'scenarioId', 'revision', 'startedAt'])
  && validText(value.taskId) && /^TASK-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.taskId)
  && validText(value.runId) && /^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value.runId)
  && validText(value.scenarioId) && value.scenarioId.startsWith('SCN-') && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
  && validText(value.startedAt) && !Number.isNaN(Date.parse(value.startedAt))
const sameScope = (left: QualityScope, right: QualityScope) => left.taskId === right.taskId && left.runId === right.runId
  && left.scenarioId === right.scenarioId && left.revision === right.revision && left.startedAt === right.startedAt
const validFileName = (value: unknown): value is string => validText(value) && value.length <= 255 && !/[\\/:*?"<>|]/u.test(value) && value !== '.' && value !== '..'
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const linkTypes = new Set(['SAT', 'MICROWAVE', 'DATALINK', 'LASER', 'FIBER'])
const modulations = new Set(['BPSK', 'QPSK', 'OOK'])
const decimalNumber = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u

function inspectLosses(value: unknown, path: string, errors: ValidationIssue[]): value is QualityLosses {
  if (!isObject(value) || !hasOnly(value, lossKeys) || !lossKeys.every(key => key in value && isFiniteNumber(value[key]))) {
    issue(errors, 'QUALITY_LOSSES_INVALID', path, '链路损耗必须完整提供六个有限数值分量。')
    return false
  }
  return true
}

function inspectSample(value: unknown, path: string, links: ReadonlyMap<string, Link>, errors: ValidationIssue[]): value is QualitySample {
  if (!isObject(value) || !hasOnly(value, qualityKeys) || !sampleRequiredKeys.every(key => key in value)) {
    issue(errors, 'QUALITY_SAMPLE_SHAPE_INVALID', path, '质量样本包含未知字段或缺少必填字段。')
    return false
  }
  const numberFields = ['time', 'frequency', 'bandwidth', 'distance', 'txPower', 'txAntennaGain', 'rxAntennaGain', 'pathLoss',
    'jammingPower', 'receivedPower', 'snr', 'ber', 'berThreshold', 'dataRate', 'jsrDb']
  if (!numberFields.every(key => isFiniteNumber(value[key])) || !Number.isSafeInteger(value.frameId) || (value.frameId as number) < 0
    || !validText(value.linkId) || !validText(value.sourcePlatform) || !validText(value.destPlatform)
    || !linkTypes.has(String(value.linkType)) || !modulations.has(String(value.modulation)) || !['UP', 'DOWN'].includes(String(value.linkStatus))) {
    issue(errors, 'QUALITY_SAMPLE_TYPE_INVALID', path, '质量样本字段类型、枚举或帧编号无效。')
    return false
  }
  if ((value.time as number) < 0 || (value.frequency as number) <= 0 || (value.bandwidth as number) <= 0 || (value.distance as number) < 0
    || (value.txPower as number) < 0 || (value.dataRate as number) < 0 || (value.ber as number) < 0 || (value.ber as number) > 1
    || (value.berThreshold as number) < 0 || (value.berThreshold as number) > 1
    || ('latencyMs' in value && (!isFiniteNumber(value.latencyMs) || value.latencyMs < 0))
    || ('availabilityPercent' in value && (!isFiniteNumber(value.availabilityPercent) || value.availabilityPercent < 0 || value.availabilityPercent > 100))
    || ('interferenceActive' in value && typeof value.interferenceActive !== 'boolean')) {
    issue(errors, 'QUALITY_SAMPLE_RANGE_INVALID', path, '质量样本数值范围或干扰活动标记无效。')
    return false
  }
  if ('losses' in value && value.losses !== undefined && !inspectLosses(value.losses, `${path}.losses`, errors)) return false
  const link = links.get(value.linkId as string)
  if (!link || link.enabled === false || link.sourcePlatformId !== value.sourcePlatform || link.targetPlatformId !== value.destPlatform || link.type !== value.linkType) {
    issue(errors, 'QUALITY_LINK_MAPPING_INVALID', path, '样本链路标识、端点或类型与当前已启用场景配置不一致。')
    return false
  }
  return true
}

function inspectSwitch(value: unknown, path: string, samplesAtTime: ReadonlyMap<number, ReadonlyMap<string, QualitySample>>, links: ReadonlyMap<string, Link>, errors: ValidationIssue[], projected = false): value is SwitchEvent {
  if (!isObject(value) || !hasOnly(value, switchKeys) || !switchKeys.filter(key => key !== 'sourceRegistryTime').every(key => key in value)) {
    issue(errors, 'QUALITY_SWITCH_SHAPE_INVALID', path, '切换事件包含未知字段或缺少必填字段。')
    return false
  }
  const event = value as unknown as SwitchEvent
  if (!validText(event.eventId) || !validText(event.frameId) || !isFiniteNumber(event.time) || event.time < 0 || event.type !== 'LINK_SWITCH'
    || !['FORWARD', 'REVERSE'].includes(event.direction) || !validText(event.oldLinkId) || !validText(event.newLinkId)
    || !isFiniteNumber(event.oldBer) || event.oldBer < 0 || event.oldBer > 1 || !isFiniteNumber(event.newBer) || event.newBer < 0 || event.newBer > 1
    || !Number.isSafeInteger(event.stabilityFrames) || event.stabilityFrames < 0 || !Number.isSafeInteger(event.minimumStableFrames) || event.minimumStableFrames < 0
    || typeof event.hysteresisSatisfied !== 'boolean' || !isFiniteNumber(event.cooldownRemainingS) || event.cooldownRemainingS < 0
    || !['ACCEPTED', 'REJECTED'].includes(event.decision) || !validText(event.reason) || !validText(event.dedupeKey)
    || ('sourceRegistryTime' in value && value.sourceRegistryTime !== undefined && (!isFiniteNumber(value.sourceRegistryTime) || value.sourceRegistryTime < 0))) {
    issue(errors, 'QUALITY_SWITCH_TYPE_INVALID', path, '切换事件字段类型、枚举或测量值无效。')
    return false
  }
  const measurements = samplesAtTime.get(event.time)
  const oldSample = measurements?.get(event.oldLinkId), newSample = measurements?.get(event.newLinkId)
  if (!measurements || (!projected && (!links.has(event.oldLinkId) || !links.has(event.newLinkId) || !oldSample || !newSample))
    || (projected && !oldSample && !newSample)
    || (oldSample !== undefined && oldSample.ber !== event.oldBer) || (newSample !== undefined && newSample.ber !== event.newBer)) {
    issue(errors, 'QUALITY_SWITCH_CLOSURE_INVALID', path, '切换事件必须由同一显式采样时刻的旧、新链路测量值支撑。')
    return false
  }
  return true
}

function validateOrdering(samples: readonly QualitySample[], errors: ValidationIssue[]): void {
  const frameTimes = new Map<number, number>()
  const frameLinks = new Map<number, Set<string>>()
  let previousFrame = -1
  let previousTime = -1
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!
    const priorTime = frameTimes.get(sample.frameId)
    if (priorTime !== undefined && priorTime !== sample.time) issue(errors, 'QUALITY_FRAME_TIME_INVALID', `samples[${index}].time`, '同一帧的采样时间必须一致。')
    if (priorTime === undefined) {
      if (sample.frameId <= previousFrame || sample.time <= previousTime) issue(errors, 'QUALITY_FRAME_ORDER_INVALID', `samples[${index}]`, '帧编号和帧时间必须严格递增。')
      frameTimes.set(sample.frameId, sample.time); frameLinks.set(sample.frameId, new Set()); previousFrame = sample.frameId; previousTime = sample.time
    }
    const identities = frameLinks.get(sample.frameId)!
    if (identities.has(sample.linkId)) issue(errors, 'QUALITY_DUPLICATE_SAMPLE', `samples[${index}].linkId`, '同一帧不能包含同一链路的重复质量样本。')
    identities.add(sample.linkId)
  }
}

function samplesByTime(samples: readonly QualitySample[]): Map<number, Map<string, QualitySample>> {
  const result = new Map<number, Map<string, QualitySample>>()
  for (const sample of samples) {
    let links = result.get(sample.time)
    if (!links) { links = new Map(); result.set(sample.time, links) }
    links.set(sample.linkId, sample)
  }
  return result
}

function linksFor(config: QualityConfig, errors: ValidationIssue[]): Map<string, Link> {
  const links = new Map<string, Link>()
  const platformIds = new Set(config.platforms.map(platform => platform.id))
  if (config.scenario.id.trim() === '' || !config.links.every(link => platformIds.has(link.sourcePlatformId) && platformIds.has(link.targetPlatformId))) {
    issue(errors, 'QUALITY_CONFIG_INVALID', 'config', '当前场景链路端点不完整，不能映射质量文件。')
    return links
  }
  for (const link of config.links) {
    if (links.has(link.id)) { issue(errors, 'QUALITY_CONFIG_AMBIGUOUS_LINK', 'config.links', '当前场景存在重复链路标识。'); continue }
    if (link.enabled !== false) links.set(link.id, link)
  }
  return links
}

function csvSamples(text: string, scope: QualityScope, config: QualityConfig, links: ReadonlyMap<string, Link>, errors: ValidationIssue[]): QualitySample[] {
  if (text.includes('\uFFFD')) { issue(errors, 'QUALITY_ENCODING_INVALID', 'text', 'CSV 包含无效 UTF-8 替换字符。'); return [] }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.at(-1) === '') lines.pop()
  if (lines.shift() !== LINK_QUALITY_CSV_HEADER) { issue(errors, 'QUALITY_CSV_HEADER_INVALID', 'text', 'CSV 表头必须等于 link_quality.csv 规范表头。'); return [] }
  const header = LINK_QUALITY_CSV_HEADER.split(',')
  const rows: QualitySample[] = []
  const frameForTime = new Map<number, number>()
  for (let row = 0; row < lines.length; row += 1) {
    const cells = parseCsvLine(lines[row]!)
    const path = `rows[${row}]`
    if (!cells || cells.length !== header.length) { issue(errors, 'QUALITY_CSV_ROW_INVALID', path, 'CSV 行列数或引号格式无效。'); continue }
    const record = Object.fromEntries(header.map((key, index) => [key, cells[index]!]))
    if (record.task_id !== scope.taskId || record.SchemaVersion !== '1.1') { issue(errors, 'QUALITY_CSV_SCOPE_INVALID', path, 'CSV 的任务标识或版本与当前运行不一致。'); continue }
    const candidates = [...links.values()].filter(link => link.sourcePlatformId === record.SourcePlatform && link.targetPlatformId === record.DestPlatform && link.type === record.LinkType)
    if (candidates.length !== 1) { issue(errors, candidates.length ? 'QUALITY_LINK_MAPPING_AMBIGUOUS' : 'QUALITY_LINK_MAPPING_INVALID', path, 'CSV 链路端点和类型必须唯一对应当前已启用链路。'); continue }
    // `Number('')` 与 `Number('0x10')` 会把缺测或非规范文本伪造成数值，CSV 输入必须逐格闭合为十进制有限数。
    const numeric = (name: string) => {
      const text = record[name]?.trim() ?? ''
      return text !== '' && decimalNumber.test(text) ? Number(text) : Number.NaN
    }
    const time = numeric('Time')
    let frameId = frameForTime.get(time)
    if (frameId === undefined) { frameId = frameForTime.size; frameForTime.set(time, frameId) }
    const sample: QualitySample = { time, sourcePlatform: record.SourcePlatform!, destPlatform: record.DestPlatform!, linkType: record.LinkType as QualitySample['linkType'],
      frequency: numeric('Frequency'), bandwidth: numeric('Bandwidth'), distance: numeric('Distance'), txPower: numeric('TxPower'), txAntennaGain: numeric('TxAntennaGain'),
      rxAntennaGain: numeric('RxAntennaGain'), pathLoss: numeric('PathLoss'), jammingPower: numeric('JammingPower'), receivedPower: numeric('ReceivedPower'), snr: numeric('SNR'),
      jsrDb: numeric('GXB'), modulation: record.Modulation as QualitySample['modulation'], ber: numeric('BER'), linkStatus: record.LinkStatus as QualitySample['linkStatus'],
      berThreshold: numeric('BERThreshold'), dataRate: numeric('DataRate'), linkId: candidates[0]!.id, frameId }
    if (inspectSample(sample, path, links, errors)) rows.push(sample)
  }
  return rows
}

/** 严格解析一份由外部质量计算器明确导出的质量文件；不从场景或本机决策补齐字段。 */
export function parseQualityImport(request: unknown, scope: QualityScope, config: QualityConfig, source: { sha256: string; importedAt: string }): QualityParseResult {
  const errors: ValidationIssue[] = []
  if (!isQualityScope(scope) || !isObject(request) || !hasOnly(request, ['scope', 'fileName', 'format', 'text'])) {
    issue(errors, 'QUALITY_REQUEST_INVALID', 'request', '质量导入请求格式无效。'); return { data: null, errors }
  }
  const input = request as unknown as QualityImportRequest
  // UTF-8 BOM 属于原始来源字节的一部分：摘要与归档保留它，解析时才忽略首字符。
  const text = typeof input.text === 'string' && input.text.startsWith('\uFEFF') ? input.text.slice(1) : input.text
  if (!isQualityScope(input.scope) || !sameScope(input.scope, scope)) issue(errors, 'QUALITY_SCOPE_INVALID', 'scope', '文件作用域必须与当前任务、运行、场景版本和启动时间完全一致。')
  if (!validFileName(input.fileName) || (input.format !== 'JSON' && input.format !== 'CSV') || typeof input.text !== 'string' || new TextEncoder().encode(input.text).byteLength > MAX_IMPORT_BYTES
    || !validHash(source.sha256) || !validText(source.importedAt) || Number.isNaN(Date.parse(source.importedAt)) || config.scenario.id !== scope.scenarioId) {
    issue(errors, 'QUALITY_REQUEST_INVALID', 'request', '文件名、格式、大小、来源摘要或当前场景不符合质量导入要求。')
  }
  const links = linksFor(config, errors)
  if (errors.length) return { data: null, errors }
  let samples: QualitySample[] = []
  let switchEvents: SwitchEvent[] = []
  let switchEventsProvided = false
  let frameIdKind: 'PROVIDED' | 'IMPORT_SEQUENCE' = 'PROVIDED'
  if (input.format === 'CSV') { samples = csvSamples(text, scope, config, links, errors); frameIdKind = 'IMPORT_SEQUENCE' }
  else {
    let document: unknown
    try { document = JSON.parse(text) } catch { issue(errors, 'QUALITY_JSON_INVALID', 'text', 'JSON 质量文件无法解析。'); return { data: null, errors } }
    if (!isObject(document) || !hasOnly(document, ['format', 'scope', 'samples', 'switchEvents']) || document.format !== 'wrj.quality.v1' || !isQualityScope(document.scope) || !sameScope(document.scope, scope) || !Array.isArray(document.samples) || (document.switchEvents !== undefined && !Array.isArray(document.switchEvents))) {
      issue(errors, 'QUALITY_JSON_SHAPE_INVALID', 'text', 'JSON 必须使用 wrj.quality.v1 格式并完整声明当前作用域。')
    } else {
      switchEventsProvided = Object.hasOwn(document, 'switchEvents')
      document.samples.forEach((sample, index) => { if (inspectSample(sample, `samples[${index}]`, links, errors)) samples.push(sample) })
      const measurements = samplesByTime(samples)
      const dedupe = new Set<string>()
      document.switchEvents?.forEach((event, index) => { if (inspectSwitch(event, `switchEvents[${index}]`, measurements, links, errors)) {
        if (dedupe.has(event.dedupeKey)) issue(errors, 'QUALITY_SWITCH_DUPLICATE', `switchEvents[${index}].dedupeKey`, '切换事件去重键不能重复。')
        dedupe.add(event.dedupeKey); switchEvents.push(event)
      } })
    }
  }
  if (samples.length === 0) issue(errors, 'QUALITY_SAMPLES_EMPTY', 'samples', '质量文件必须至少包含一条实际测量样本。')
  if (samples.length > 100000) issue(errors, 'QUALITY_SAMPLES_LIMIT_EXCEEDED', 'samples', '质量样本不能超过 100000 条。')
  validateOrdering(samples, errors)
  // 时间缺口可能来自导出丢帧或抽样，不能被误称为连续质量周期；只使用场景已绑定的仿真步长。
  const expectedStepS = config.scenario.timeStep
  if (!isFiniteNumber(expectedStepS) || expectedStepS <= 0) issue(errors, 'QUALITY_CONFIG_INVALID', 'config.scenario.timeStep', '当前场景未提供有效的仿真步长。')
  if (errors.length) return { data: null, errors }
  return { data: { schemaVersion: '1.0', scope: { ...scope }, source: { kind: 'FILE_IMPORT', fileName: input.fileName, sha256: source.sha256, importedAt: source.importedAt, frameIdKind, switchEventsProvided }, expectedStepS, samples, switchEvents }, errors: [] }
}

/** API、WS 和报表边界使用的独立格式守卫；不把未知对象当成质量结果。 */
export function isQualityDataset(value: unknown): value is QualityDataset {
  return inspectQualityDataset(value, false)
}

/** 已校验归档的报表投影可省略筛选外的切换对端样本；仍核对投影内的每项测量。 */
export function isQualityDatasetProjection(value: unknown): value is QualityDataset {
  return inspectQualityDataset(value, true)
}

function inspectQualityDataset(value: unknown, projected: boolean): value is QualityDataset {
  if (!isObject(value) || !hasOnly(value, ['schemaVersion', 'scope', 'source', 'expectedStepS', 'samples', 'switchEvents']) || value.schemaVersion !== '1.0'
    || !isQualityScope(value.scope) || !isObject(value.source) || !hasOnly(value.source, ['kind', 'fileName', 'sha256', 'importedAt', 'frameIdKind', 'switchEventsProvided'])
    || value.source.kind !== 'FILE_IMPORT' || !validFileName(value.source.fileName) || !validHash(value.source.sha256) || !validText(value.source.importedAt)
    || Number.isNaN(Date.parse(value.source.importedAt)) || !['PROVIDED', 'IMPORT_SEQUENCE'].includes(String(value.source.frameIdKind))
    || ('switchEventsProvided' in value.source && typeof value.source.switchEventsProvided !== 'boolean')
    || !isFiniteNumber(value.expectedStepS) || value.expectedStepS <= 0 || !Array.isArray(value.samples) || !Array.isArray(value.switchEvents)
    || !value.samples.every(isObject)) return false
  const syntheticLinks = new Map<string, Link>()
  for (const sample of value.samples) {
    if (!validText(sample.linkId) || !validText(sample.sourcePlatform) || !validText(sample.destPlatform)) return false
    syntheticLinks.set(sample.linkId, { id: sample.linkId, type: sample.linkType, sourcePlatformId: sample.sourcePlatform, targetPlatformId: sample.destPlatform, enabled: true } as Link)
  }
  const errors: ValidationIssue[] = []
  if (!value.samples.every((sample, index) => inspectSample(sample, `samples[${index}]`, syntheticLinks, errors))) return false
  validateOrdering(value.samples, errors)
  if (errors.length) return false
  if (value.samples.length > 100000) return false
  const measurements = samplesByTime(value.samples)
  const dedupe = new Set<string>()
  return value.switchEvents.every((event, index) => inspectSwitch(event, `switchEvents[${index}]`, measurements, syntheticLinks, errors, projected) && !dedupe.has(event.dedupeKey) && (dedupe.add(event.dedupeKey), true)) && errors.length === 0
}
