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
  | { ok: false; code: ApiErrorCode; status: 404 | 409 | 422; fieldPath?: string; message: string }

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

export class ScenarioProjection {
  private draft = createDraft()
  private history: ScenarioDraft[] = []

  /**
   * 同步仿真运行持有的场景配置锁。
   * @param scenarioId 需要加锁或解锁的场景编号。
   * @param locked `true` 表示锁定，`false` 表示解锁。
   * @returns 更新后的场景草稿，场景不存在时返回 404 结果。
   * @remarks 只改变运行期锁投影，不递增配置修订号，也不写入撤销历史。
   */
  setLocked(scenarioId: string, locked: boolean): ScenarioProjectionResult<ScenarioDraft> {
    if (scenarioId !== this.draft.config.scenario.id) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    }
    this.draft.locked = locked
    return { ok: true, data: structuredClone(this.draft) }
  }

  /**
   * 读取指定场景的独立草稿副本。
   * @param scenarioId 路由中的场景编号。
   * @returns 找到时返回草稿副本，否则返回 404 结果。
   * @remarks 不修改服务端草稿状态。
   */
  get(scenarioId: string): ScenarioProjectionResult<ScenarioDraft> {
    if (scenarioId !== this.draft.config.scenario.id) {
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
  copyTemplate(config: ScenarioConfig, name: string): ScenarioProjectionResult<ScenarioDraft> {
    if (this.draft.locked) {
      return { ok: false, code: 'CONFIG_LOCKED', status: 409, fieldPath: 'scenario', message: '场景正在运行，当前配置已锁定。' }
    }
    if (name.trim() === '') {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'name', message: '临时场景名称不能为空。' }
    }
    const candidate = structuredClone(config)
    candidate.scenario.id = this.draft.config.scenario.id
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
    this.history.push(structuredClone(this.draft))
    this.draft = {
      config: candidate,
      uiExtensions: createUiExtensions(candidate),
      revision: this.draft.revision + 1,
      officialLibraryChanged: false,
      locked: false,
    }
    return { ok: true, data: structuredClone(this.draft) }
  }

  /**
   * 校验指定场景的完整规范配置。
   * @param scenarioId 路由中的场景编号。
   * @param value 客户端提交的未知 JSON 值。
   * @returns 可定位字段的校验结果，或请求外壳、场景编号及配置锁错误。
   * @remarks 只读取候选配置，不修改服务端草稿和修订号。
   */
  validate(scenarioId: string, value: unknown): ScenarioProjectionResult<ValidationResult> {
    if (scenarioId !== this.draft.config.scenario.id) {
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
    if (scenarioId !== this.draft.config.scenario.id) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    }
    if (this.draft.locked) {
      return { ok: false, code: 'CONFIG_LOCKED', status: 409, fieldPath: 'scenario', message: '场景正在运行，当前配置已锁定。' }
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'config') || !Object.hasOwn(value, 'uiExtensions')) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '场景草稿更新结构不正确。' }
    }
    const update = value as unknown as ScenarioDraftUpdate
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

    this.history.push(structuredClone(this.draft))
    this.draft = {
      ...this.draft,
      config: structuredClone(candidate as ScenarioConfig),
      uiExtensions: {
        jammers: structuredClone(extensionInspection.jammers!),
        sensors: structuredClone(extensionInspection.sensors!),
      },
      revision: this.draft.revision + 1,
    }
    return { ok: true, data: structuredClone(this.draft) }
  }

  /** 校验并导入一个完整场景配置快照。 */
  importSnapshots(value: unknown): ScenarioProjectionResult<ScenarioImportResult> {
    if (this.draft.locked) {
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
      revision: this.draft.revision + 1,
      officialLibraryChanged: false,
      locked: false,
    }

    this.history.push(structuredClone(this.draft))
    this.draft = structuredClone(draft)
    return { ok: true, data: { imported: 1, rejected: 0, drafts: [structuredClone(draft)] } }
  }

  /**
   * 撤销最近一次已持久化的场景操作并恢复完整快照。
   * @param scenarioId 当前场景编号。
   * @param value 包含调用方预期修订号的请求体。
   * @returns 恢复后的新修订草稿，或编号、锁、修订冲突错误。
   */
  undo(scenarioId: string, value: unknown): ScenarioProjectionResult<ScenarioDraft> {
    if (scenarioId !== this.draft.config.scenario.id) return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    if (this.draft.locked) return { ok: false, code: 'CONFIG_LOCKED', status: 409, fieldPath: 'scenario', message: '场景正在运行，当前配置已锁定。' }
    const request = readMutationRequest(value)
    if (request === undefined) return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'expectedRevision', message: '预期修订号格式不正确。' }
    if (request.expectedRevision !== this.draft.revision) return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'expectedRevision', message: '场景修订号已变化，请重新加载。' }
    const previous = this.history.pop()
    if (previous === undefined) return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'history', message: '没有可撤销的场景操作。' }
    this.draft = { ...structuredClone(previous), revision: this.draft.revision + 1, locked: false }
    return { ok: true, data: structuredClone(this.draft) }
  }

  /**
   * 将当前场景草稿重置为冻结的 SCN-001 配置快照。
   * @param scenarioId 当前场景编号。
   * @param value 包含调用方预期修订号的请求体。
   * @returns 可撤销的新修订草稿。
   */
  resetDraft(scenarioId: string, value: unknown): ScenarioProjectionResult<ScenarioDraft> {
    if (scenarioId !== this.draft.config.scenario.id) return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    if (this.draft.locked) return { ok: false, code: 'CONFIG_LOCKED', status: 409, fieldPath: 'scenario', message: '场景正在运行，当前配置已锁定。' }
    const request = readMutationRequest(value)
    if (request === undefined) return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'expectedRevision', message: '预期修订号格式不正确。' }
    if (request.expectedRevision !== this.draft.revision) return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'expectedRevision', message: '场景修订号已变化，请重新加载。' }
    const baseline = createDraft()
    this.history.push(structuredClone(this.draft))
    this.draft = { ...baseline, revision: this.draft.revision + 1 }
    return { ok: true, data: structuredClone(this.draft) }
  }

  /**
   * 恢复确定性场景草稿基线。
   * @returns 无返回值。
   * @remarks 替换当前内存草稿，并将修订号恢复为 4。
   */
  reset(): void {
    this.draft = createDraft()
    this.history = []
  }
}
