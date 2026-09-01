import type {
  ApiErrorCode,
  ScenarioConfig,
  ScenarioDraft,
  ScenarioId,
} from '../../src/contracts/domain-models.js'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation.js'
import { loadFixtureProjection } from '../fixtures/source.js'

export type ScenarioProjectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 404 | 422; fieldPath?: string; message: string }

/**
 * 创建可重置的确定性场景草稿。
 * @returns 由冻结 fixture 克隆出的场景草稿。
 * @remarks 每次调用都会创建新的可变配置，不共享基线引用。
 */
function createDraft(): ScenarioDraft {
  return {
    config: loadFixtureProjection().scenario,
    uiExtensions: { jammers: [], sensors: [] },
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
  const readOnlyFields = ['jammers', 'sensors', 'output', 'informationDemand'] as const
  return readOnlyFields.find((field) => JSON.stringify(candidate[field]) !== JSON.stringify(current[field]))
}

function withDerivedPlatformLinkIds(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const candidate = { ...value } as Record<string, unknown>
  if (!Array.isArray(candidate.platforms) || !Array.isArray(candidate.links)) return candidate

  const linkIdsByPlatform = new Map<string, Set<string>>()
  candidate.platforms.forEach((platform) => {
    if (typeof platform === 'object' && platform !== null && !Array.isArray(platform) && typeof platform.id === 'string') {
      linkIdsByPlatform.set(platform.id, new Set())
    }
  })
  candidate.links.forEach((link) => {
    if (typeof link !== 'object' || link === null || Array.isArray(link) || typeof link.id !== 'string') return
    for (const platformId of [link.sourcePlatformId, link.targetPlatformId]) {
      if (typeof platformId === 'string') linkIdsByPlatform.get(platformId)?.add(link.id)
    }
  })
  candidate.platforms = candidate.platforms.map((platform) => (
    typeof platform === 'object' && platform !== null && !Array.isArray(platform)
      ? { ...platform, linkIds: typeof platform.id === 'string' ? [...(linkIdsByPlatform.get(platform.id) ?? [])] : [] }
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
   * 校验并保存场景基础、环境、时序、平台、航点和链路参数。
   * @param scenarioId 路由中的场景编号。
   * @param value 客户端提交的未知 JSON 值。
   * @returns 保存后的草稿副本，或带字段路径的失败结果。
   * @remarks 成功时替换场景身份、递增修订号；失败时保持原草稿不变。
   */
  save(scenarioId: string, value: unknown): ScenarioProjectionResult<ScenarioDraft> {
    if (scenarioId !== this.draft.config.scenario.id) {
      return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定场景。' }
    }

    const candidate = withDerivedPlatformLinkIds(value)
    const inspection = inspectScenarioConfig(candidate)
    if (!inspection.result.valid || inspection.identity === undefined || inspection.platforms === undefined || inspection.links === undefined) {
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

    const readOnlyField = changedReadOnlyField(candidate as Record<string, unknown>, this.draft.config)
    if (readOnlyField !== undefined) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: readOnlyField, message: '当前阶段不允许修改该配置。' }
    }

    this.draft = {
      ...this.draft,
      config: {
        ...this.draft.config,
        scenario: inspection.identity,
        platforms: structuredClone(inspection.platforms),
        links: structuredClone(inspection.links),
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
