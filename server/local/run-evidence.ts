import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { QualityDataset, QualityScope } from '../../src/contracts/domain-models.js'
import { isQualityScope, type QualityConfig } from '../../src/features/data-exchange/quality-records.js'
import {
  EvidenceImportError, evidenceBundlePayload, inspectEvidenceImportRequest, isEvidenceImportResult,
  type EvidenceImportResult,
} from '../../src/features/data-exchange/evidence-contract.js'
import { parseEvidenceBundle, type ParsedEvidenceBundle } from '../../src/features/data-exchange/evidence-records.js'

export { EvidenceImportError } from '../../src/features/data-exchange/evidence-contract.js'

export interface RunEvidenceBundle extends ParsedEvidenceBundle { publishedAt: string; expectedStepS?: number }
export interface RunEvidenceStore {
  import(request: unknown, scope: QualityScope, config: QualityConfig, canPublish?: () => boolean): Promise<EvidenceImportResult>
  load(runId: string, bundleSha256?: string, expectedScope?: QualityScope): Promise<RunEvidenceBundle | null>
}

const fileHash = (text: string) => createHash('sha256').update(text).digest('hex')
const safeRunId = (value: string) => /^RUN-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const sameScope = (left: QualityScope, right: QualityScope) => left.taskId === right.taskId && left.runId === right.runId
  && left.scenarioId === right.scenarioId && left.revision === right.revision && left.startedAt === right.startedAt

/**
 * 运行隔离的文件集归档：每次成功导入都是独立原子目录，旧批次不被覆盖；原文按文件留存，
 * 批次摘要由文件名排序后的名称与摘要确定。任一失败整批回滚，不发布半批指针。
 */
export function createRunEvidenceStore(directory: string, now: () => string): RunEvidenceStore {
  const root = resolve(directory)
  const queues = new Map<string, Promise<void>>()
  const runDirectory = (runId: string) => {
    if (!safeRunId(runId)) return null
    const path = resolve(root, runId)
    const outside = relative(root, path)
    return outside === '..' || outside.startsWith(`..${sep}`) ? null : path
  }
  async function plainFile(path: string): Promise<void> {
    const file = await lstat(path)
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('证据归档包含非普通文件。')
  }
  async function readGeneration(runId: string, runRoot: string, generation: string): Promise<RunEvidenceBundle | null> {
    if (!/^evidence-[0-9a-f-]{36}$/u.test(generation)) return null
    const folder = join(runRoot, generation)
    const stat = await lstat(folder)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    const bundlePath = join(folder, 'bundle.json')
    await plainFile(bundlePath)
    let bundle: unknown
    try { bundle = JSON.parse(await readFile(bundlePath, 'utf8')) } catch { throw new Error('证据归档不是有效 JSON。') }
    if (!isObject(bundle) || !isEvidenceImportResult(bundle.result)) throw new Error('证据归档批次结构无效。')
    const result = bundle.result
    if (!isQualityScope(result.scope) || result.scope.runId !== runId) throw new Error('证据归档作用域无效。')
    // 原文与批次清单必须完全一致；用原文重算摘要，不信任 bundle.json 声明值。
    const originalDir = join(folder, 'files')
    const names = (await readdir(originalDir)).sort()
    const declared = new Map(result.files.map(file => [file.fileName, file]))
    if (names.length !== result.files.length || names.some(name => !declared.has(name))) throw new Error('证据归档原文与批次清单不一致。')
    const texts = new Map<string, string>()
    for (const name of names) {
      if (basename(name) !== name) throw new Error('证据归档文件名无效。')
      const text = await readFile(join(originalDir, name), 'utf8')
      if (fileHash(text) !== declared.get(name)!.sha256) throw new Error('证据归档原文摘要校验失败。')
      texts.set(name, text)
    }
    // 证据不足（缺冻结映射）明确失败，不借当前场景猜。
    const frozen = isObject(bundle.config) ? bundle.config : undefined
    if (!frozen) throw new Error('EVIDENCE_ARCHIVE_EVIDENCE_INSUFFICIENT')
    const expectedStepS = typeof bundle.expectedStepS === 'number' && Number.isFinite(bundle.expectedStepS) && bundle.expectedStepS > 0 ? bundle.expectedStepS : undefined
    const config = frozen as unknown as QualityConfig
    // 用原文重新解析并重建派生记录（state/loss/switch/quality），不信任声明数组。
    const rebuilt = parseEvidenceBundle({ files: [...texts].map(([fileName, text]) => ({ fileName, text })) }, result.scope, config, { sha256: fileHash, importedAt: String(bundle.publishedAt ?? '2026-01-01T00:00:00.000Z') })
    if (rebuilt.result.bundleSha256 !== result.bundleSha256) throw new Error('证据归档批次摘要与原文重算不一致。')
    return { result: rebuilt.result, ...(rebuilt.quality ? { quality: rebuilt.quality } : {}), state: rebuilt.state, loss: rebuilt.loss, switch: rebuilt.switch, expectedStepS, publishedAt: String(bundle.publishedAt ?? '') }
  }
  async function latest(runId: string, expectedScope?: QualityScope): Promise<RunEvidenceBundle | null> {
    const runRoot = runDirectory(runId)
    if (!runRoot) return null
    try { const run = await lstat(runRoot); if (!run.isDirectory() || run.isSymbolicLink()) throw new Error('证据归档运行目录必须是普通目录。') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const pointerPath = join(runRoot, 'current.json')
    try { await plainFile(pointerPath) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    let pointer: unknown
    try { pointer = JSON.parse(await readFile(pointerPath, 'utf8')) } catch { throw new Error('证据归档指针不是有效 JSON。') }
    if (!isObject(pointer) || typeof pointer.generation !== 'string') throw new Error('证据归档指针无效。')
    const bundle = await readGeneration(runId, runRoot, pointer.generation)
    if (bundle && expectedScope && !sameScope(bundle.result.scope, expectedScope)) throw new Error('EVIDENCE_SCOPE_MISMATCH')
    return bundle
  }
  async function byBundle(runId: string, bundleSha256: string, expectedScope?: QualityScope): Promise<RunEvidenceBundle | null> {
    const runRoot = runDirectory(runId)
    if (!runRoot || !/^[a-f0-9]{64}$/u.test(bundleSha256)) return null
    try { const run = await lstat(runRoot); if (!run.isDirectory() || run.isSymbolicLink()) throw new Error('证据归档运行目录必须是普通目录。') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    const generations = (await readdir(runRoot)).filter(name => /^evidence-[0-9a-f-]{36}$/u.test(name)).sort()
    let corrupted = false
    for (const generation of generations) {
      let bundle: RunEvidenceBundle | null
      // 单个旧批次损坏不阻止其他合法摘要读取。
      try { bundle = await readGeneration(runId, runRoot, generation) } catch { corrupted = true; continue }
      if (bundle && bundle.result.bundleSha256 === bundleSha256) {
        if (expectedScope && !sameScope(bundle.result.scope, expectedScope)) throw new Error('EVIDENCE_SCOPE_MISMATCH')
        return bundle
      }
    }
    if (corrupted) throw new Error('EVIDENCE_ARCHIVE_CORRUPT')
    return null
  }
  async function serialized<T>(runId: string, action: () => Promise<T>): Promise<T> {
    const prior = queues.get(runId) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolve => { release = resolve })
    const queued = prior.then(() => tail)
    queues.set(runId, queued)
    await prior
    try { return await action() } finally { release(); if (queues.get(runId) === queued) queues.delete(runId) }
  }
  return {
    async import(request, scope, config, canPublish = () => true) {
      return serialized(scope.runId, async () => {
        if (!canPublish()) throw new EvidenceImportError([{ severity: 'ERROR', code: 'EVIDENCE_PUBLISH_CANCELLED', file: 'scope', fieldPath: 'scope', message: '运行或登录状态已改变，未开始写入证据归档。' }])
        const inspected = inspectEvidenceImportRequest(request)
        if ('issues' in inspected) throw new EvidenceImportError(inspected.issues)
        if (!isQualityScope(scope)) throw new EvidenceImportError([{ severity: 'ERROR', code: 'EVIDENCE_SCOPE_INVALID', file: 'scope', fieldPath: 'scope', message: '运行作用域无效。' }])
        const bundle = parseEvidenceBundle(inspected.request, scope, config, { sha256: fileHash, importedAt: now() })
        const runRoot = runDirectory(scope.runId)
        if (!runRoot) throw new EvidenceImportError([{ severity: 'ERROR', code: 'EVIDENCE_SCOPE_INVALID', file: 'scope', fieldPath: 'scope.runId', message: '运行标识无效。' }])
        await mkdir(runRoot, { recursive: true })
        const pointerPath = join(runRoot, 'current.json')
        let priorPointer: string | undefined
        try { await plainFile(pointerPath); priorPointer = await readFile(pointerPath, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        const pending = await mkdtemp(join(runRoot, '.evidence-'))
        let generationDirectory: string | undefined
        let pendingPointer: string | undefined
        try {
          const originalDir = join(pending, 'files')
          await mkdir(originalDir)
          for (const file of inspected.request.files) {
            if (basename(file.fileName) !== file.fileName) throw new EvidenceImportError([{ severity: 'ERROR', code: 'EVIDENCE_FILE_NAME_INVALID', file: file.fileName, fieldPath: 'fileName', message: '文件名不得包含路径。' }])
            await writeFile(join(originalDir, file.fileName), file.text, { encoding: 'utf8', flag: 'wx' })
          }
          await writeFile(join(pending, 'bundle.json'), JSON.stringify({
            result: bundle.result,
            // 冻结映射与步长随批次内部上下文保存，读回时据原文重解析，不信任声明派生值。
            config: { scenario: { id: config.scenario.id, timeStep: config.scenario.timeStep }, platforms: config.platforms.map(platform => ({ id: platform.id })),
              links: config.links.map(link => ({ id: link.id, type: link.type, sourcePlatformId: link.sourcePlatformId, targetPlatformId: link.targetPlatformId, enabled: link.enabled })), linkSettings: {} },
            ...(typeof config.scenario.timeStep === 'number' && config.scenario.timeStep > 0 ? { expectedStepS: config.scenario.timeStep } : {}),
            publishedAt: now(),
          }), { encoding: 'utf8', flag: 'wx' })
          if (!canPublish()) throw new EvidenceImportError([{ severity: 'ERROR', code: 'EVIDENCE_PUBLISH_CANCELLED', file: 'scope', fieldPath: 'scope', message: '运行或登录状态已改变，未发布证据归档。' }])
          const generation = `evidence-${randomUUID()}`
          generationDirectory = join(runRoot, generation)
          await rename(pending, generationDirectory)
          pendingPointer = join(runRoot, `.current-${randomUUID()}.json`)
          await writeFile(pendingPointer, JSON.stringify({ generation }), { encoding: 'utf8', flag: 'wx' })
          await rename(pendingPointer, pointerPath)
          pendingPointer = undefined
          if (!canPublish()) {
            if (priorPointer === undefined) await unlink(pointerPath)
            else { const rollback = join(runRoot, `.current-${randomUUID()}.json`); await writeFile(rollback, priorPointer, { encoding: 'utf8', flag: 'wx' }); await rename(rollback, pointerPath) }
            await rm(generationDirectory, { recursive: true, force: true })
            throw new EvidenceImportError([{ severity: 'ERROR', code: 'EVIDENCE_PUBLISH_CANCELLED', file: 'scope', fieldPath: 'scope', message: '运行或登录状态已改变，已撤销未授权的证据归档发布。' }])
          }
          return bundle.result
        } catch (error) {
          await rm(pending, { recursive: true, force: true })
          if (pendingPointer) await rm(pendingPointer, { force: true })
          if (generationDirectory) await rm(generationDirectory, { recursive: true, force: true })
          throw error
        }
      })
    },
    async load(runId, bundleSha256, expectedScope) {
      return serialized(runId, async () => bundleSha256 === undefined ? await latest(runId, expectedScope) : await byBundle(runId, bundleSha256, expectedScope))
    },
  }
}
