import type {
  ApiErrorCode,
  MutationRequest,
  ScenarioConfig,
  ScenarioDraft,
  ScenarioDraftUpdate,
  ScenarioId,
  ScenarioImportResult,
  ScenarioValidationRequest,
  ValidationResult,
} from '../../src/contracts/domain-models.js'
import { inspectScenarioConfig, inspectScenarioUiExtensions } from '../../src/features/scenarios/scenario-validation.js'
import { SCENARIO_BASIC_DEFAULTS, withScenarioBasicDefaults } from '../../src/features/scenarios/scenario-basic.js'
import { loadFixtureProjection } from '../fixtures/source.js'

export type ScenarioProjectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 404 | 409 | 422 | 503; fieldPath?: string; message: string }

export interface ScenarioStorage {
  load(id?: string): ScenarioDraft | undefined
  list(): ScenarioDraft[]
  save(draft: ScenarioDraft, expected: { id: string; revision: number } | undefined): boolean
  delete(id: string, revision: number): boolean
}

/**
 * 创建可重置的确定性场景草稿。
 * @returns 由冻结 fixture 克隆出的场景草稿。
 * @remarks 每次调用都会创建新的可变配置，不共享基线引用。
 */
function createDraft(): ScenarioDraft {
  const config = withScenarioBasicDefaults(loadFixtureProjection().scenario)
  // 只设置新工作草稿和显式重置的默认时长；加载旧场景、导入和撤销不改已有时长。
  config.scenario.duration = SCENARIO_BASIC_DEFAULTS.duration
  return {
    config,
    uiExtensions: createUiExtensions(config),
    revision: 4,
    officialLibraryChanged: false,
    locked: false,
  }
}

/**
 * 从规范配置生成当前已开放的界面扩展。
 * @param config 场景规范配置。
 * @returns 与干扰设备一一对应的界面扩展。
 * @remarks 模板复制和初始草稿共用同一确定性规则。
 */
function createUiExtensions(config: ScenarioConfig): ScenarioDraft['uiExtensions'] {
  return {
    jammers: config.jammers.map((jammer) => ({
      jammerId: jammer.id,
      direction: jammer.type === 'BARRAGE' ? 360 : 45,
      duration: jammer.type === 'BARRAGE' ? 120 : 60,
      enabled: jammer.type === 'BARRAGE',
    })),
    sensors: config.sensors.map((sensor) => ({
      sensorId: sensor.id,
      type: 'ESM',
      direction: 'OMNI',
      probability: 0.95,
      enabled: true,
    })),
  }
}

/**
 * 校验场景撤销或重置请求中的预期修订号。
 * @param value 未受信任的请求体。
 * @returns 结构闭合且修订号有效时返回规范请求。
 */
function readMutationRequest(value: unknown): MutationRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'expectedRevision')) return undefined
  const expectedRevision = (value as { expectedRevision?: unknown }).expectedRevision
  return Number.isInteger(expectedRevision) && (expectedRevision as number) >= 0
    ? { expectedRevision: expectedRevision as number }
    : undefined
}

/**
 * 按链路端点和干扰设备归属重建平台反向关联。
 * @param value 客户端提交的未知场景配置。
 * @returns 带规范化 `linkIds` 和 `jammerIds` 的浅拷贝；结构不足时返回可继续校验的原值或副本。
 * @remarks 不信任客户端反向关联，避免直接 PUT 形成不一致数据。
 */
function withDerivedPlatformAssociations(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const candidate = { ...value } as Record<string, unknown>
  if (!Array.isArray(candidate.platforms)) return candidate

  const linkIdsByPlatform = new Map<string, Set<string>>()
  const jammerIdsByPlatform = new Map<string, Set<string>>()
  const sensorIdsByPlatform = new Map<string, Set<string>>()
  candidate.platforms.forEach((platform) => {
    if (typeof platform === 'object' && platform !== null && !Array.isArray(platform) && typeof platform.id === 'string') {
      linkIdsByPlatform.set(platform.id, new Set())
      jammerIdsByPlatform.set(platform.id, new Set())
      sensorIdsByPlatform.set(platform.id, new Set())
    }
  })
  if (Array.isArray(candidate.links)) candidate.links.forEach((link) => {
    if (typeof link !== 'object' || link === null || Array.isArray(link) || typeof link.id !== 'string') return
    for (const platformId of [link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId]) {
      if (typeof platformId === 'string') linkIdsByPlatform.get(platformId)?.add(link.id)
    }
  })
  if (Array.isArray(candidate.jammers)) candidate.jammers.forEach((jammer) => {
    if (typeof jammer !== 'object' || jammer === null || Array.isArray(jammer) || typeof jammer.id !== 'string') return
    if (typeof jammer.platformId === 'string') jammerIdsByPlatform.get(jammer.platformId)?.add(jammer.id)
  })
  if (Array.isArray(candidate.sensors)) candidate.sensors.forEach((sensor) => {
    if (typeof sensor !== 'object' || sensor === null || Array.isArray(sensor) || typeof sensor.id !== 'string') return
    if (typeof sensor.platformId === 'string') sensorIdsByPlatform.get(sensor.platformId)?.add(sensor.id)
  })
  candidate.platforms = candidate.platforms.map((platform) => (
    typeof platform === 'object' && platform !== null && !Array.isArray(platform)
      ? {
          ...platform,
          linkIds: typeof platform.id === 'string' ? [...(linkIdsByPlatform.get(platform.id) ?? [])] : [],
          jammerIds: typeof platform.id === 'string' ? [...(jammerIdsByPlatform.get(platform.id) ?? [])] : [],
          sensorIds: typeof platform.id === 'string' ? [...(sensorIdsByPlatform.get(platform.id) ?? [])] : [],
        }
      : platform
  ))
  return candidate
}

class ScenarioDocument {
  private draft: ScenarioDraft | null
  private history: ScenarioDraft[] = []
  private persisted: { id: string; revision: number } | undefined

  constructor(private readonly storage?: Pick<ScenarioStorage, 'load' | 'save'>, initial: ScenarioDraft | null = null) {
    const loaded = storage ? storage.load() ?? null : initial
    this.draft = loaded ? { ...loaded, config: withScenarioBasicDefaults(loaded.config) } : null
    this.persisted = this.draft && storage ? { id: this.draft.config.scenario.id, revision: this.draft.revision } : undefined
  }

  // 先提交数据库再更新内存和撤销栈，落盘失败不能留下“保存成功”的半成品。
  private commit(draft: ScenarioDraft, undo = false): ScenarioProjectionResult<ScenarioDraft> {
    draft = { ...draft, config: withScenarioBasicDefaults(draft.config) }
    if (this.storage) {
      try {
        if (!this.storage.save(draft, this.persisted)) {
          return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'revision', message: '数据库场景已变化，请重新加载后再操作。' }
        }
      } catch {
        return { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '场景写入数据库失败，原数据未改变，请检查数据库是否可写后重试。' }
      }
      this.persisted = { id: draft.config.scenario.id, revision: draft.revision }
    }
    if (undo) this.history.pop()
    else if (this.draft) this.history.push(structuredClone(this.draft))
    this.draft = structuredClone(draft)
    return { ok: true, data: structuredClone(this.draft) }
  }

  /**
   * 同步仿真运行持有的场景配置锁。
   * @param scenarioId 需要加锁或解锁的场景编号。
   * @param locked `true` 表示锁定，`false` 表示解锁。
   * @returns 更新后的场景草稿，场景不存在时返回 404 结果。
   * @remarks 只改变运行期锁投影，不递增配置修订号，也不写入撤销历史。
   */
  setLocked(scenarioId: string, locked: boolean): ScenarioProjectionResult<ScenarioDraft> {
    if (!this.draft || scenarioId !== this.draft.config.scenario.id) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    }
    this.draft.locked = locked
    return { ok: true, data: structuredClone(this.draft) }
  }

  /**
   * 读取指定场景的独立草稿副本。
   * @param scenarioId 路由中的场景编号。
   * @returns 找到时返回草稿副本，否则返回 404 结果。
   * @remarks 本机存储变化时刷新工作副本，纯 Mock 仅返回内存副本。
   */
  get(scenarioId: string): ScenarioProjectionResult<ScenarioDraft> {
    if (this.storage) {
      let stored: ScenarioDraft | undefined
      try {
        stored = this.storage.load()
      } catch {
        return { ok: false, code: 'ATOMIC_REPLACE_FAILED', status: 503, message: '场景数据库读取失败，请检查数据库，未回退到演示数据。' }
      }
      if (!stored) {
        this.draft = null
        this.persisted = undefined
        this.history = []
      }
      if (stored && (stored.revision !== this.persisted?.revision || stored.config.scenario.id !== this.persisted?.id)) {
        this.draft = { ...stored, config: withScenarioBasicDefaults(stored.config), locked: this.draft?.locked ?? false }
        this.persisted = { id: stored.config.scenario.id, revision: stored.revision }
        this.history = []
      }
    }
    if (!this.draft || scenarioId !== this.draft.config.scenario.id) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    }
    return { ok: true, data: structuredClone(this.draft) }
  }

  /**
   * 将模板配置复制到当前临时工作场景。
   * @param config 模板中的完整规范配置。
   * @param name 临时工作场景名称。
   * @returns 新的工作草稿，或锁定、字段校验错误。
   * @remarks 保留当前工作场景编号，成功时替换内存草稿并递增修订号。
   */
  copyTemplate(config: ScenarioConfig, name: string, uiExtensions?: ScenarioDraft['uiExtensions']): ScenarioProjectionResult<ScenarioDraft> {
    if (this.draft?.locked) {
      return { ok: false, code: 'CONFIG_LOCKED', status: 409, fieldPath: 'scenario', message: '场景正在运行，当前配置已锁定。' }
    }
    if (name.trim() === '') {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'name', message: '临时场景名称不能为空。' }
    }
    const candidate = structuredClone(config)
    candidate.scenario.id = this.draft?.config.scenario.id ?? candidate.scenario.id
    candidate.scenario.name = name.trim()
    const inspection = inspectScenarioConfig(candidate, 'write')
    if (!inspection.result.valid) {
      const issue = inspection.result.errors[0]!
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        status: 422,
        fieldPath: issue.fieldPath,
        message: issue.message,
      }
    }
    const extensions = uiExtensions ?? createUiExtensions(candidate)
    const extensionInspection = inspectScenarioUiExtensions(extensions, candidate.jammers.map(item => item.id), candidate.sensors.map(item => item.id))
    if (!extensionInspection.result.valid) {
      const issue = extensionInspection.result.errors[0]!
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: issue.fieldPath, message: issue.message }
    }
    return this.commit({
      config: candidate,
      uiExtensions: structuredClone(extensions),
      revision: (this.draft?.revision ?? 0) + 1,
      officialLibraryChanged: false,
      locked: false,
    })
  }

  /**
   * 校验指定场景的完整规范配置。
   * @param scenarioId 路由中的场景编号。
   * @param value 客户端提交的未知 JSON 值。
   * @returns 可定位字段的校验结果，或请求外壳、场景编号及配置锁错误。
   * @remarks 只读取候选配置，不修改服务端草稿和修订号。
   */
  validate(scenarioId: string, value: unknown): ScenarioProjectionResult<ValidationResult> {
    if (!this.draft || scenarioId !== this.draft.config.scenario.id) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    }
    if (this.draft.locked) {
      return { ok: false, code: 'CONFIG_LOCKED', status: 409, fieldPath: 'scenario', message: '场景正在运行，当前配置已锁定。' }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'config')) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '场景校验请求结构不正确。' }
    }

    const inspection = inspectScenarioConfig((value as unknown as ScenarioValidationRequest).config, 'write')
    if (inspection.result.valid && inspection.identity?.id !== scenarioId) {
      return {
        ok: true,
        data: {
          valid: false,
          errors: [{
            severity: 'ERROR',
            code: 'SCENARIO_ID_MISMATCH',
            message: '场景编号与请求地址不一致。',
            fieldPath: 'scenario.id',
          }],
          warnings: inspection.result.warnings,
        },
      }
    }
    return { ok: true, data: structuredClone(inspection.result) }
  }

  /**
   * 校验并保存完整场景配置和界面扩展。
   * @param scenarioId 路由中的场景编号。
   * @param value 客户端提交的未知 JSON 值。
   * @returns 保存后的草稿副本，或带字段路径的失败结果。
   * @remarks 成功时替换场景身份、递增修订号；失败时保持原草稿不变。
   */
  save(scenarioId: string, value: unknown): ScenarioProjectionResult<ScenarioDraft> {
    if (this.draft && scenarioId !== this.draft.config.scenario.id) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    }
    if (this.draft?.locked) {
      return { ok: false, code: 'CONFIG_LOCKED', status: 409, fieldPath: 'scenario', message: '场景正在运行，当前配置已锁定。' }
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !Object.keys(value).every(key => ['config', 'uiExtensions', 'expectedRevision'].includes(key)) || !Object.hasOwn(value, 'config') || !Object.hasOwn(value, 'uiExtensions')) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '场景草稿更新结构不正确。' }
    }
    const update = value as unknown as ScenarioDraftUpdate
    if (!Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'expectedRevision', message: '请提供有效的预期修订号。' }
    }
    if (update.expectedRevision !== (this.draft?.revision ?? 0)) {
      return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'expectedRevision', message: '场景已被更新，请重新加载后再保存。' }
    }
    const candidate = withDerivedPlatformAssociations(update.config)
    const inspection = inspectScenarioConfig(candidate, 'write')
    if (!inspection.result.valid) {
      const issue = inspection.result.errors[0]!
      return {
        ok: false,
        code: issue.code === 'NODE_LIMIT_EXCEEDED' ? 'NODE_LIMIT_EXCEEDED' : 'VALIDATION_FAILED',
        status: 422,
        fieldPath: issue.fieldPath,
        message: issue.message,
      }
    }
    if (inspection.identity!.id !== scenarioId) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'scenario.id', message: '场景编号与请求地址不一致。' }
    }

    const extensionInspection = inspectScenarioUiExtensions(
      update.uiExtensions,
      inspection.jammers!.map((jammer) => jammer.id),
      inspection.sensors!.map((sensor) => sensor.id),
    )
    if (!extensionInspection.result.valid) {
      const issue = extensionInspection.result.errors[0]!
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        status: 422,
        fieldPath: issue.fieldPath,
        message: issue.message,
      }
    }

    return this.commit({
      locked: false,
      officialLibraryChanged: false,
      ...this.draft,
      config: structuredClone(candidate as ScenarioConfig),
      uiExtensions: {
        jammers: structuredClone(extensionInspection.jammers!),
        sensors: structuredClone(extensionInspection.sensors!),
      },
      revision: (this.draft?.revision ?? 0) + 1,
    })
  }

  /** 校验并导入一个完整场景配置快照。 */
  importSnapshots(value: unknown): ScenarioProjectionResult<ScenarioImportResult> {
    if (this.draft?.locked) {
      return { ok: false, code: 'CONFIG_LOCKED', status: 409, fieldPath: 'scenario', message: '场景正在运行，当前配置已锁定。' }
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'items')
      || !Array.isArray((value as { items?: unknown }).items) || (value as { items: unknown[] }).items.length !== 1) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'items', message: '场景快照导入请求结构不正确。' }
    }

    const item = (value as { items: unknown[] }).items[0]
    const inspection = inspectScenarioConfig(item, 'write')
    if (!inspection.result.valid) {
      const issue = inspection.result.errors[0]!
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: `items[0].${issue.fieldPath}`, message: issue.message }
    }
    const config = structuredClone(item as ScenarioConfig)
    const draft: ScenarioDraft = {
      config,
      uiExtensions: createUiExtensions(config),
      revision: (this.draft?.revision ?? 0) + 1,
      officialLibraryChanged: false,
      locked: false,
    }

    const saved = this.commit(draft)
    if (!saved.ok) return saved
    return { ok: true, data: { imported: 1, rejected: 0, drafts: [structuredClone(draft)] } }
  }

  /**
   * 撤销最近一次已持久化的场景操作并恢复完整快照。
   * @param scenarioId 当前场景编号。
   * @param value 包含调用方预期修订号的请求体。
   * @returns 恢复后的新修订草稿，或编号、锁、修订冲突错误。
   */
  undo(scenarioId: string, value: unknown): ScenarioProjectionResult<ScenarioDraft> {
    if (!this.draft) return { ok: false, code: 'NOT_FOUND', status: 404, message: '暂无场景。' }
    if (scenarioId !== this.draft.config.scenario.id) return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    if (this.draft.locked) return { ok: false, code: 'CONFIG_LOCKED', status: 409, fieldPath: 'scenario', message: '场景正在运行，当前配置已锁定。' }
    const request = readMutationRequest(value)
    if (request === undefined) return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'expectedRevision', message: '预期修订号格式不正确。' }
    if (request.expectedRevision !== this.draft.revision) return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'expectedRevision', message: '场景修订号已变化，请重新加载。' }
    const previous = this.history.at(-1)
    if (previous === undefined) return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'history', message: '没有可撤销的场景操作。' }
    return this.commit({ ...structuredClone(previous), revision: this.draft.revision + 1, locked: false }, true)
  }

  /**
   * 将当前场景草稿重置为冻结的 SCN-001 配置快照。
   * @param scenarioId 当前场景编号。
   * @param value 包含调用方预期修订号的请求体。
   * @returns 可撤销的新修订草稿。
   */
  resetDraft(scenarioId: string, value: unknown): ScenarioProjectionResult<ScenarioDraft> {
    if (!this.draft) return { ok: false, code: 'NOT_FOUND', status: 404, message: '暂无场景。' }
    if (scenarioId !== this.draft.config.scenario.id) return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    if (this.draft.locked) return { ok: false, code: 'CONFIG_LOCKED', status: 409, fieldPath: 'scenario', message: '场景正在运行，当前配置已锁定。' }
    const request = readMutationRequest(value)
    if (request === undefined) return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'expectedRevision', message: '预期修订号格式不正确。' }
    if (request.expectedRevision !== this.draft.revision) return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'expectedRevision', message: '场景修订号已变化，请重新加载。' }
    const baseline = createDraft()
    baseline.config.scenario.id = this.draft.config.scenario.id
    return this.commit({ ...baseline, revision: this.draft.revision + 1 })
  }

}

/** 每个场景独立维护锁、修订及撤销历史；读取列表不能切换另一个请求的写入目标。 */
export class ScenarioProjection {
  private documents = new Map<string, ScenarioDocument>()

  constructor(private readonly storage?: ScenarioStorage) { this.reset() }

  /** 仅纯内存模式使用；持久化模式由装备库跨库事务提交，再由 get 按修订号重载。 */
  applyEquipmentScenes(updates: { after: ScenarioDraft }[]): void {
    if (this.storage) throw new Error('持久化场景必须在装备保存事务中更新。')
    for (const { after } of updates) this.documents.set(after.config.scenario.id, new ScenarioDocument(undefined, structuredClone(after)))
  }

  private document(id: string): ScenarioDocument {
    let document = this.documents.get(id)
    if (!document) {
      document = new ScenarioDocument(this.storage ? {
        load: () => this.storage!.load(id),
        save: (draft, expected) => this.storage!.save(draft, expected),
      } : undefined)
      this.documents.set(id, document)
    }
    return document
  }

  list(): ScenarioDraft[] {
    const ids = this.storage ? this.storage.list().map(item => item.config.scenario.id) : [...this.documents.keys()]
    return ids.flatMap(id => {
      const result = this.get(id)
      if (!result.ok) {
        if (result.status === 404) return []
        throw new Error(result.message)
      }
      return [result.data]
    })
  }

  get(id: string): ScenarioProjectionResult<ScenarioDraft> {
    try { return this.document(id).get(id) }
    catch { return { ok: false, status: 503, code: 'ATOMIC_REPLACE_FAILED', message: '场景数据库读取失败。' } }
  }
  setLocked(id: string, locked: boolean): ScenarioProjectionResult<ScenarioDraft> {
    const current = this.get(id)
    return current.ok ? this.document(id).setLocked(id, locked) : current
  }
  save(id: string, value: unknown): ScenarioProjectionResult<ScenarioDraft> {
    try { return this.document(id).save(id, value) }
    catch { return { ok: false, status: 503, code: 'ATOMIC_REPLACE_FAILED', message: '场景数据库读取失败。' } }
  }
  create(value: unknown): ScenarioProjectionResult<ScenarioDraft> {
    const id = (value as { config?: ScenarioConfig } | null)?.config?.scenario?.id
    if (typeof id !== 'string' || !id.trim()) return { ok: false, status: 422, code: 'VALIDATION_FAILED', fieldPath: 'scenario.id', message: '场景编号不能为空。' }
    const current = this.get(id)
    if (current.ok) return { ok: false, status: 409, code: 'CONFLICT', fieldPath: 'scenario.id', message: '场景编号已存在，请重新新建。' }
    return current.status === 404 ? this.document(id).save(id, value) : current
  }
  validate(id: string, value: unknown): ScenarioProjectionResult<ValidationResult> {
    const current = this.get(id)
    return current.ok ? this.document(id).validate(id, value) : current
  }
  undo(id: string, value: unknown): ScenarioProjectionResult<ScenarioDraft> {
    const current = this.get(id)
    return current.ok ? this.document(id).undo(id, value) : current
  }
  resetDraft(id: string, value: unknown): ScenarioProjectionResult<ScenarioDraft> {
    const current = this.get(id)
    return current.ok ? this.document(id).resetDraft(id, value) : current
  }
  copyTemplate(config: ScenarioConfig, name: string, extensions?: ScenarioDraft['uiExtensions'], id = 'SCN-001'): ScenarioProjectionResult<ScenarioDraft> {
    const current = this.get(id)
    if (!current.ok && current.status !== 404) return current
    const candidate = structuredClone(config)
    candidate.scenario.id = id as ScenarioId
    return this.document(id).copyTemplate(candidate, name, extensions)
  }
  importSnapshots(value: unknown): ScenarioProjectionResult<ScenarioImportResult> {
    const id = (value as { items?: ScenarioConfig[] } | null)?.items?.[0]?.scenario?.id
    if (typeof id !== 'string' || !id.trim()) return { ok: false, status: 422, code: 'VALIDATION_FAILED', fieldPath: 'items', message: '场景快照导入请求结构不正确。' }
    const current = this.get(id)
    if (!current.ok && current.status !== 404) return current
    return this.document(id).importSnapshots(value)
  }
  delete(id: string, value: unknown): ScenarioProjectionResult<{ deleted: true; objectId: string }> {
    const current = this.get(id)
    if (!current.ok) return current
    if (current.data.locked) return { ok: false, status: 409, code: 'CONFIG_LOCKED', message: '场景正在运行，不能删除。' }
    const request = readMutationRequest(value)
    if (!request) return { ok: false, status: 422, code: 'VALIDATION_FAILED', fieldPath: 'expectedRevision', message: '请提供待删除场景的修订号。' }
    if (request.expectedRevision !== current.data.revision) return { ok: false, status: 409, code: 'CONFLICT', message: '场景已变化，请刷新列表后重试。' }
    try {
      if (this.storage && !this.storage.delete(id, request.expectedRevision)) return { ok: false, status: 409, code: 'CONFLICT', message: '场景已变化，请刷新列表后重试。' }
    } catch { return { ok: false, status: 503, code: 'ATOMIC_REPLACE_FAILED', message: '场景删除失败，原数据未改变。' } }
    this.documents.delete(id)
    return { ok: true, data: { deleted: true, objectId: id } }
  }
  reset(): void {
    // 先验证全部存量数据，失败不清掉运行期上下文。
    this.storage?.list()
    this.documents.clear()
    if (!this.storage) {
      const initial = createDraft()
      this.documents.set(initial.config.scenario.id, new ScenarioDocument(undefined, initial))
    }
  }
}
