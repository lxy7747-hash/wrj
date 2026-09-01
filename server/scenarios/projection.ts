import type {
  ApiErrorCode,
  ScenarioConfig,
  ScenarioDraft,
  ScenarioDraftUpdate,
  ScenarioId,
  ScenarioValidationRequest,
  ValidationResult,
} from '../../src/contracts/domain-models.js'
import { inspectScenarioConfig, inspectScenarioUiExtensions } from '../../src/features/scenarios/scenario-validation.js'
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
  const config = loadFixtureProjection().scenario
  return {
    config,
    uiExtensions: {
      jammers: config.jammers.map((jammer) => ({
        jammerId: jammer.id,
        direction: jammer.type === 'BARRAGE' ? 360 : 45,
        duration: jammer.type === 'BARRAGE' ? 120 : 60,
        enabled: jammer.type === 'BARRAGE',
      })),
      sensors: [],
    },
    revision: 4,
    officialLibraryChanged: false,
    locked: false,
  }
}

/**
 * 判断请求是否修改了本阶段尚未开放的配置区段。
 * @param candidate 客户端提交的场景配置对象。
 * @param current 服务端当前场景配置。
 * @returns 首个被修改的只读字段路径；未修改时返回 `undefined`。
 * @remarks 只读取并比较值，不修改候选对象或当前草稿。
 */
function changedReadOnlyField(candidate: Record<string, unknown>, current: ScenarioConfig): string | undefined {
  const readOnlyFields = ['sensors', 'output', 'informationDemand'] as const
  return readOnlyFields.find((field) => JSON.stringify(candidate[field]) !== JSON.stringify(current[field]))
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
  candidate.platforms.forEach((platform) => {
    if (typeof platform === 'object' && platform !== null && !Array.isArray(platform) && typeof platform.id === 'string') {
      linkIdsByPlatform.set(platform.id, new Set())
      jammerIdsByPlatform.set(platform.id, new Set())
    }
  })
  if (Array.isArray(candidate.links)) candidate.links.forEach((link) => {
    if (typeof link !== 'object' || link === null || Array.isArray(link) || typeof link.id !== 'string') return
    for (const platformId of [link.sourcePlatformId, link.targetPlatformId]) {
      if (typeof platformId === 'string') linkIdsByPlatform.get(platformId)?.add(link.id)
    }
  })
  if (Array.isArray(candidate.jammers)) candidate.jammers.forEach((jammer) => {
    if (typeof jammer !== 'object' || jammer === null || Array.isArray(jammer) || typeof jammer.id !== 'string') return
    if (typeof jammer.platformId === 'string') jammerIdsByPlatform.get(jammer.platformId)?.add(jammer.id)
  })
  candidate.platforms = candidate.platforms.map((platform) => (
    typeof platform === 'object' && platform !== null && !Array.isArray(platform)
      ? {
          ...platform,
          linkIds: typeof platform.id === 'string' ? [...(linkIdsByPlatform.get(platform.id) ?? [])] : [],
          jammerIds: typeof platform.id === 'string' ? [...(jammerIdsByPlatform.get(platform.id) ?? [])] : [],
        }
      : platform
  ))
  return candidate
}

export class ScenarioProjection {
  private draft = createDraft()

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

    const inspection = inspectScenarioConfig((value as unknown as ScenarioValidationRequest).config)
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
   * 校验并保存场景基础、环境、时序、平台、航点、链路和干扰设备参数。
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
    const inspection = inspectScenarioConfig(candidate)
    if (!inspection.result.valid || inspection.identity === undefined || inspection.platforms === undefined || inspection.links === undefined || inspection.jammers === undefined) {
      const issue = inspection.result.errors[0]
      return {
        ok: false,
        code: issue?.code === 'NODE_LIMIT_EXCEEDED' ? 'NODE_LIMIT_EXCEEDED' : 'VALIDATION_FAILED',
        status: 422,
        fieldPath: issue?.fieldPath ?? 'config',
        message: issue?.message ?? '场景配置校验失败。',
      }
    }
    if (inspection.identity.id !== scenarioId) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'scenario.id', message: '场景编号与请求地址不一致。' }
    }

    const extensionInspection = inspectScenarioUiExtensions(update.uiExtensions, inspection.jammers.map((jammer) => jammer.id))
    if (!extensionInspection.result.valid || extensionInspection.jammers === undefined) {
      const issue = extensionInspection.result.errors[0]
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        status: 422,
        fieldPath: issue?.fieldPath ?? 'uiExtensions',
        message: issue?.message ?? '场景界面扩展校验失败。',
      }
    }

    const readOnlyField = changedReadOnlyField(candidate as Record<string, unknown>, this.draft.config)
    if (readOnlyField !== undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: readOnlyField, message: '当前阶段不允许修改该配置。' }
    }
    if (JSON.stringify(update.uiExtensions.sensors) !== JSON.stringify(this.draft.uiExtensions.sensors)) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'uiExtensions.sensors', message: '当前阶段不允许修改该配置。' }
    }

    this.draft = {
      ...this.draft,
      config: {
        ...this.draft.config,
        scenario: inspection.identity,
        platforms: structuredClone(inspection.platforms),
        links: structuredClone(inspection.links),
        jammers: structuredClone(inspection.jammers),
      },
      uiExtensions: {
        ...this.draft.uiExtensions,
        jammers: structuredClone(extensionInspection.jammers),
      },
      revision: this.draft.revision + 1,
    }
    return { ok: true, data: structuredClone(this.draft) }
  }

  /**
   * 恢复确定性场景草稿基线。
   * @returns 无返回值。
   * @remarks 替换当前内存草稿，并将修订号恢复为 4。
   */
  reset(): void {
    this.draft = createDraft()
  }
}
