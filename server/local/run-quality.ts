import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import {
  LINK_LOSS_CSV_HEADER, LINK_QUALITY_CSV_HEADER, LINK_STATE_CSV_HEADER, LINK_SWITCH_CSV_HEADER,
  type QualityDataset, type QualityScope,
} from '../../src/contracts/domain-models.js'
import {
  isQualityDataset, parseQualityImport, QualityImportError, type QualityConfig,
} from '../../src/features/data-exchange/quality-records.js'
import { inspectCsvText } from '../../src/features/data-exchange/csv-contract.js'
import { TIME_SERIES_CONTRACTS } from './time-series.js'

const fileHash = (text: string) => createHash('sha256').update(text).digest('hex')
const safeRunId = (value: string) => /^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
const FILE_TYPES: Readonly<Record<string, string>> = {
  'quality.json': 'application/json; charset=utf-8', 'manifest.json': 'application/json; charset=utf-8',
  'link_quality.csv': 'text/csv; charset=utf-8', 'link_state.csv': 'text/csv; charset=utf-8',
  'link_loss.csv': 'text/csv; charset=utf-8', 'link_switch.csv': 'text/csv; charset=utf-8',
  'source.json': 'application/json; charset=utf-8', 'source.csv': 'text/csv; charset=utf-8',
}

export { QualityImportError } from '../../src/features/data-exchange/quality-records.js'

export interface RunQualityStore {
  import(request: unknown, scope: QualityScope, config: QualityConfig, canPublish?: () => boolean): Promise<QualityDataset>
  load(runId: string, sourceSha256?: string): Promise<QualityDataset | null>
  getFile(runId: string, fileName: string, sourceSha256?: string): Promise<{ filePath: string; contentType?: string } | null>
}

type StoredFile = { fileName: string; sha256: string; rows?: number; source: 'FILE_IMPORT' }
type Manifest = {
  schemaVersion: '1.0'; scope: QualityScope; sourceSha256: string; publishedAt: string; contractsComplete: boolean
  files: StoredFile[]; missing: Array<{ fileName: string; status: 'SOURCE_MISSING'; reason: string }>
}
const csvCell = (value: unknown) => {
  const text = String(value)
  if (/[\r\n]/u.test(text)) throw new Error('规范 CSV 单元格不接受换行。')
  return /[",]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
const csv = (header: string, rows: readonly (readonly unknown[])[]) => `${header}\r\n${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}${rows.length ? '\r\n' : ''}`
const canonical = (value: number) => String(value)

function makeFiles(dataset: QualityDataset, config: QualityConfig, source: { fileName: 'source.json' | 'source.csv'; text: string }): { files: Map<string, string>; missing: Manifest['missing'] } {
  const task = dataset.scope.taskId
  const quality = csv(LINK_QUALITY_CSV_HEADER, dataset.samples.map(sample => [task, '1.1', canonical(sample.time), sample.sourcePlatform, sample.destPlatform,
    sample.linkType, canonical(sample.frequency), canonical(sample.bandwidth), canonical(sample.distance), canonical(sample.txPower), canonical(sample.txAntennaGain),
    canonical(sample.rxAntennaGain), canonical(sample.pathLoss), canonical(sample.jammingPower), canonical(sample.receivedPower), canonical(sample.snr), canonical(sample.jsrDb),
    sample.modulation, canonical(sample.ber), sample.linkStatus, canonical(sample.berThreshold), canonical(sample.dataRate)]))
  const state = csv(LINK_STATE_CSV_HEADER, dataset.samples.map(sample => [task, '1.1', canonical(sample.time), sample.sourcePlatform, sample.destPlatform,
    sample.linkType, sample.linkStatus, canonical(sample.jsrDb), canonical(sample.ber), canonical(sample.receivedPower)]))
  const files = new Map<string, string>([['quality.json', JSON.stringify(dataset, null, 2)], [source.fileName, source.text], ['link_quality.csv', quality], ['link_state.csv', state]])
  const missing: Manifest['missing'] = [{ fileName: 'events.csv', status: 'SOURCE_MISSING', reason: '质量文件未提供事件时序；系统不会伪造事件记录。' }]
  if (dataset.samples.every(sample => sample.losses !== undefined)) {
    files.set('link_loss.csv', csv(LINK_LOSS_CSV_HEADER, dataset.samples.map(sample => {
      const losses = sample.losses!
      return [task, '1.1', canonical(sample.time), sample.sourcePlatform, sample.destPlatform, sample.linkType, canonical(losses.freeSpaceLossDb),
        canonical(losses.seaMultipathLossDb), canonical(losses.atmosphericLossDb), canonical(losses.cloudRainLossDb), canonical(losses.jammingLossDb), canonical(losses.totalLossDb)]
    })))
  } else missing.push({ fileName: 'link_loss.csv', status: 'SOURCE_MISSING', reason: '来源未为每条质量样本完整提供六项链路损耗分量。' })
  const acceptedSwitches = dataset.switchEvents.filter(event => event.decision === 'ACCEPTED')
  if (acceptedSwitches.length || dataset.source.switchEventsProvided === true) {
    const links = new Map(config.links.map(link => [link.id, link]))
    files.set('link_switch.csv', csv(LINK_SWITCH_CSV_HEADER, acceptedSwitches.map(event => {
      const newLink = links.get(event.newLinkId)!
      const oldLink = links.get(event.oldLinkId)!
      return [task, '1.1', canonical(event.time), newLink.sourcePlatformId, newLink.targetPlatformId, event.direction, oldLink.type, newLink.type,
        canonical(event.oldBer), canonical(event.newBer), event.reason]
    })))
  } else missing.push({ fileName: 'link_switch.csv', status: 'SOURCE_MISSING', reason: '来源未显式提供已接受且测量闭合的链路切换事件；拒绝决策仅保留在质量明细中。' })
  return { files, missing }
}

function validateGeneratedCsv(name: string, text: string, allowEmpty = false): number {
  const contract = TIME_SERIES_CONTRACTS.find(candidate => candidate.name === name)
  if (!contract) throw new Error(`未知规范 CSV：${name}`)
  const result = inspectCsvText(contract, text)
  if (!result.valid || (!allowEmpty && result.rowCount === 0)) throw new Error(`${name} 生成后未通过规范合同校验。`)
  return result.rowCount
}

async function plainFile(path: string): Promise<void> {
  const file = await lstat(path)
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('质量归档包含非普通文件。')
}

/** 创建运行隔离的文件导入归档。每一次成功导入都是独立原子目录，旧版本不被覆盖。 */
export function createRunQualityStore(directory: string, now: () => string): RunQualityStore {
  const root = resolve(directory)
  const queues = new Map<string, Promise<void>>()
  const runDirectory = (runId: string) => {
    if (!safeRunId(runId)) return null
    const path = resolve(root, runId)
    return relative(root, path).startsWith(`..${sep}`) || relative(root, path) === '..' ? null : path
  }
  async function readGeneration(runId: string, runRoot: string, generation: string): Promise<{ directory: string; manifest: Manifest; dataset: QualityDataset }> {
    if (!/^quality-[0-9a-f-]{36}$/u.test(generation)) throw new Error('质量归档版本标识无效。')
    const newest = { directory: join(runRoot, generation) }
    const folder = await lstat(newest.directory)
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error('当前质量归档发布目录必须是普通目录。')
    const [manifestPath, datasetPath] = [join(newest.directory, 'manifest.json'), join(newest.directory, 'quality.json')]
    await Promise.all([plainFile(manifestPath), plainFile(datasetPath)])
    let manifest: unknown, dataset: unknown
    try { [manifest, dataset] = await Promise.all([readFile(manifestPath, 'utf8').then(JSON.parse), readFile(datasetPath, 'utf8').then(JSON.parse)]) }
    catch { throw new Error('最新质量归档不是有效 JSON。') }
    if (!isManifest(manifest) || !isQualityDataset(dataset) || dataset.scope.runId !== runId || !sameScope(dataset.scope, manifest.scope)
      || manifest.sourceSha256 !== dataset.source.sha256 || !manifest.files.some(file => file.fileName === 'quality.json')) throw new Error('最新质量归档的作用域或清单无效。')
    for (const file of manifest.files) {
      if (!Object.hasOwn(FILE_TYPES, file.fileName)) throw new Error('最新质量归档包含未批准的文件。')
      const path = join(newest.directory, file.fileName); await plainFile(path)
      if (fileHash(await readFile(path, 'utf8')) !== file.sha256) throw new Error('最新质量归档的文件摘要校验失败。')
    }
    const rawFile = dataset.source.fileName.toLowerCase().endsWith('.csv') ? 'source.csv' : 'source.json'
    const raw = manifest.files.find(file => file.fileName === rawFile)
    if (!raw || raw.sha256 !== dataset.source.sha256) throw new Error('最新质量归档缺少可核验的原始来源。')
    return { directory: newest.directory, manifest, dataset }
  }
  async function latest(runId: string): Promise<{ directory: string; manifest: Manifest; dataset: QualityDataset } | null> {
    const runRoot = runDirectory(runId)
    if (!runRoot) return null
    try {
      const run = await lstat(runRoot)
      if (!run.isDirectory() || run.isSymbolicLink()) throw new Error('质量归档运行目录必须是普通目录。')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const pointerPath = join(runRoot, 'current.json')
    try { await plainFile(pointerPath) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    let pointer: unknown
    try { pointer = JSON.parse(await readFile(pointerPath, 'utf8')) } catch { throw new Error('当前质量归档指针不是有效 JSON。') }
    if (!isObject(pointer) || Object.keys(pointer).length !== 1 || typeof pointer.generation !== 'string') throw new Error('当前质量归档指针无效。')
    return readGeneration(runId, runRoot, pointer.generation)
  }
  async function bySource(runId: string, sourceSha256: string): Promise<{ directory: string; manifest: Manifest; dataset: QualityDataset } | null> {
    const runRoot = runDirectory(runId)
    if (!runRoot || !/^[a-f0-9]{64}$/u.test(sourceSha256)) return null
    try {
      const run = await lstat(runRoot)
      if (!run.isDirectory() || run.isSymbolicLink()) throw new Error('质量归档运行目录必须是普通目录。')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const generations = (await readdir(runRoot)).filter(name => /^quality-[0-9a-f-]{36}$/u.test(name)).sort()
    for (const generation of generations) {
      const candidate = await readGeneration(runId, runRoot, generation)
      if (candidate.dataset.source.sha256 === sourceSha256) return candidate
    }
    return null
  }
  async function serialized<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const prior = queues.get(runId) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolve => { release = resolve })
    const queued = prior.then(() => tail)
    queues.set(runId, queued)
    await prior
    try { return await action() }
    finally { release(); if (queues.get(runId) === queued) queues.delete(runId) }
  }
  return {
    async import(request, scope, config, canPublish = () => true) {
      return serialized(scope.runId, async () => {
        if (!canPublish()) throw new QualityImportError([{ severity: 'ERROR', code: 'QUALITY_PUBLISH_CANCELLED', fieldPath: 'scope', message: '运行或登录状态已改变，未开始写入质量归档。' }])
        const text = isObject(request) && typeof request.text === 'string' ? request.text : ''
        const source = { sha256: fileHash(text), importedAt: now() }
        const parsed = parseQualityImport(request, scope, config, source)
        if (!parsed.data) throw new QualityImportError(parsed.errors)
        const runRoot = runDirectory(scope.runId)
        if (!runRoot) throw new QualityImportError([{ severity: 'ERROR', code: 'QUALITY_SCOPE_INVALID', fieldPath: 'scope.runId', message: '运行标识无效。' }])
        const sourceFile = parsed.data.source.fileName.toLowerCase().endsWith('.csv') ? 'source.csv' : 'source.json'
        const generated = makeFiles(parsed.data, config, { fileName: sourceFile, text })
        const contracts = [...generated.files].filter(([name]) => name.endsWith('.csv') && name !== 'source.csv')
          .map(([name, csvText]) => ({ name, text: csvText, rows: validateGeneratedCsv(name, csvText, name === 'link_switch.csv' && parsed.data.source.switchEventsProvided === true) }))
        const manifest: Manifest = { schemaVersion: '1.0', scope: parsed.data.scope, sourceSha256: parsed.data.source.sha256, publishedAt: now(),
          contractsComplete: generated.missing.length === 0,
          files: [...generated.files].map(([fileName, text]) => ({ fileName, sha256: fileHash(text), rows: contracts.find(contract => contract.name === fileName)?.rows, source: 'FILE_IMPORT' })), missing: generated.missing }
        await mkdir(runRoot, { recursive: true })
        const runStat = await lstat(runRoot)
        if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error('质量归档运行目录必须是普通目录。')
        const pointerPath = join(runRoot, 'current.json')
        let priorPointer: string | undefined
        try { await plainFile(pointerPath); priorPointer = await readFile(pointerPath, 'utf8') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const pending = await mkdtemp(join(runRoot, '.quality-'))
        let generationDirectory: string | undefined
        let pendingPointer: string | undefined
        try {
          for (const [name, text] of generated.files) await writeFile(join(pending, name), text, { encoding: 'utf8', flag: 'wx' })
          await writeFile(join(pending, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' })
          if (!canPublish()) throw new QualityImportError([{ severity: 'ERROR', code: 'QUALITY_PUBLISH_CANCELLED', fieldPath: 'scope', message: '运行或登录状态已改变，未发布质量归档。' }])
          const generation = `quality-${randomUUID()}`
          generationDirectory = join(runRoot, generation)
          await rename(pending, generationDirectory)
          pendingPointer = join(runRoot, `.current-${randomUUID()}.json`)
          await writeFile(pendingPointer, JSON.stringify({ generation }), { encoding: 'utf8', flag: 'wx' })
          await rename(pendingPointer, pointerPath)
          pendingPointer = undefined
          if (!canPublish()) {
            if (priorPointer === undefined) await unlink(pointerPath)
            else {
              const rollbackPointer = join(runRoot, `.current-${randomUUID()}.json`)
              await writeFile(rollbackPointer, priorPointer, { encoding: 'utf8', flag: 'wx' })
              await rename(rollbackPointer, pointerPath)
            }
            await rm(join(runRoot, generation), { recursive: true, force: true })
            throw new QualityImportError([{ severity: 'ERROR', code: 'QUALITY_PUBLISH_CANCELLED', fieldPath: 'scope', message: '运行或登录状态已改变，已撤销未授权的质量归档发布。' }])
          }
          return parsed.data
        } catch (error) {
          await rm(pending, { recursive: true, force: true })
          if (pendingPointer) await rm(pendingPointer, { force: true })
          if (generationDirectory) await rm(generationDirectory, { recursive: true, force: true })
          throw error
        }
      })
    },
    async load(runId, sourceSha256) { return serialized(runId, async () => (sourceSha256 === undefined ? await latest(runId) : await bySource(runId, sourceSha256))?.dataset ?? null) },
    async getFile(runId, fileName, sourceSha256) {
      return serialized(runId, async () => {
        if (!Object.hasOwn(FILE_TYPES, fileName) || basename(fileName) !== fileName) return null
        const current = sourceSha256 === undefined ? await latest(runId) : await bySource(runId, sourceSha256)
        if (!current) return null
        if (fileName !== 'manifest.json' && !current.manifest.files.some(file => file.fileName === fileName)) return null
        const path = join(current.directory, fileName)
        await plainFile(path)
        return { filePath: path, contentType: FILE_TYPES[fileName] }
      })
    },
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const sameScope = (left: QualityScope, right: QualityScope) => left.taskId === right.taskId && left.runId === right.runId && left.scenarioId === right.scenarioId && left.revision === right.revision && left.startedAt === right.startedAt
function isManifest(value: unknown): value is Manifest {
  return isObject(value) && value.schemaVersion === '1.0' && isObject(value.scope) && typeof value.sourceSha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sourceSha256)
    && typeof value.publishedAt === 'string' && Array.isArray(value.files) && Array.isArray(value.missing)
}
