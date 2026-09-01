import type {
  ApiErrorCode,
  DeleteResult,
  ScenarioConfig,
  ScenarioTemplate,
  TemplateMutationRequest,
} from '../../src/contracts/domain-models.js'
import { inspectScenarioConfig } from '../../src/features/scenarios/scenario-validation.js'
import { loadFixtureProjection } from '../fixtures/source.js'

export type TemplateProjectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 404 | 409 | 422; fieldPath?: string; message: string }

interface TemplateRuntimeState {
  templates: ScenarioTemplate[]
  nextSequence: number
}

/**
 * 从冻结夹具创建可重置的模板投影。
 * @returns 独立的官方模板数组和后续编号。
 * @remarks 模板配置复用同一场景事实源，避免生成互相矛盾的假数据。
 */
function createRuntimeState(): TemplateRuntimeState {
  const fixture = loadFixtureProjection()
  return {
    templates: fixture.templates.map((template) => ({
      templateId: template.templateId,
      name: template.name,
      version: template.version,
      official: template.official,
      config: structuredClone(fixture.scenario),
      referenceCount: template.referenceCount,
    })),
    nextSequence: fixture.templates.length + 1,
  }
}

/**
 * 校验官方模板新建或更新请求。
 * @param value 未受信任的请求体。
 * @returns 规范请求，或首个可定位错误。
 * @remarks 仅检查闭合结构和场景配置，不修改模板投影。
 */
function inspectMutation(value: unknown): TemplateProjectionResult<TemplateMutationRequest> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'config')) {
    return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'request', message: '模板请求结构不正确。' }
  }
  const candidate = value as Partial<TemplateMutationRequest>
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'name', message: '模板名称不能为空。' }
  }
  const inspection = inspectScenarioConfig(candidate.config)
  if (!inspection.result.valid) {
    const issue = inspection.result.errors[0]
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      status: 422,
      fieldPath: issue?.fieldPath ?? 'config',
      message: issue?.message ?? '模板场景配置校验失败。',
    }
  }
  return { ok: true, data: { name: candidate.name.trim(), config: candidate.config as ScenarioConfig } }
}

export class TemplateProjection {
  private state = createRuntimeState()

  /** 返回全部模板的独立副本。 */
  list(): ScenarioTemplate[] {
    return structuredClone(this.state.templates)
  }

  /**
   * 读取指定模板。
   * @param templateId 模板编号。
   * @returns 模板副本，或未找到错误。
   */
  get(templateId: string): TemplateProjectionResult<ScenarioTemplate> {
    const template = this.state.templates.find((item) => item.templateId === templateId)
    return template === undefined
      ? { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定模板。' }
      : { ok: true, data: structuredClone(template) }
  }

  /**
   * 新建官方内存模板。
   * @param value 未受信任的模板请求体。
   * @returns 新建模板，或校验、重名错误。
   * @remarks 成功时版本从 1 开始且引用数为 0。
   */
  create(value: unknown): TemplateProjectionResult<ScenarioTemplate> {
    const mutation = inspectMutation(value)
    if (!mutation.ok) return mutation
    if (this.state.templates.some((template) => template.name === mutation.data.name)) {
      return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'name', message: '模板名称已存在。' }
    }
    const template: ScenarioTemplate = {
      templateId: `TPL-SCN-${String(this.state.nextSequence).padStart(3, '0')}`,
      name: mutation.data.name,
      version: '1',
      official: true,
      config: structuredClone(mutation.data.config),
      referenceCount: 0,
    }
    this.state.nextSequence += 1
    this.state.templates.push(template)
    return { ok: true, data: structuredClone(template) }
  }

  /**
   * 使用完整配置更新官方模板并递增版本。
   * @param templateId 模板编号。
   * @param value 未受信任的模板请求体。
   * @returns 更新后的模板，或未找到、校验、重名错误。
   */
  update(templateId: string, value: unknown): TemplateProjectionResult<ScenarioTemplate> {
    const index = this.state.templates.findIndex((template) => template.templateId === templateId)
    if (index < 0) return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定模板。' }
    const mutation = inspectMutation(value)
    if (!mutation.ok) return mutation
    if (this.state.templates.some((template, candidateIndex) => candidateIndex !== index && template.name === mutation.data.name)) {
      return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'name', message: '模板名称已存在。' }
    }
    const current = this.state.templates[index]!
    const updated: ScenarioTemplate = {
      ...current,
      name: mutation.data.name,
      version: String(Number(current.version) + 1),
      config: structuredClone(mutation.data.config),
    }
    this.state.templates[index] = updated
    return { ok: true, data: structuredClone(updated) }
  }

  /**
   * 删除未被引用的官方模板。
   * @param templateId 模板编号。
   * @returns 删除结果，或未找到、引用冲突错误。
   * @remarks 二次确认由路由层先行消费；引用检查在确认后再次执行。
   */
  delete(templateId: string): TemplateProjectionResult<DeleteResult> {
    const index = this.state.templates.findIndex((template) => template.templateId === templateId)
    if (index < 0) return { ok: false, code: 'NOT_FOUND', status: 404, message: '未找到指定模板。' }
    if (this.state.templates[index]!.referenceCount > 0) {
      return { ok: false, code: 'CONFLICT', status: 409, fieldPath: 'referenceCount', message: '模板仍被历史记录引用，不能删除。' }
    }
    this.state.templates.splice(index, 1)
    return { ok: true, data: { deleted: true, objectId: templateId } }
  }

  /** 恢复冻结夹具中的模板基线。 */
  reset(): void {
    this.state = createRuntimeState()
  }
}
