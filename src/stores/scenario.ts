import { apiFetch } from '../features/shared/api-fetch'
import { defineStore } from 'pinia'
import type {
  ApiErrorCode,
  CapabilityState,
  ConfirmationContext,
  DeleteResult,
  ScenarioConfig,
  ScenarioDraft,
  ScenarioId,
  ScenarioImportResult,
  ScenarioTemplate,
  ScriptContract,
  ValidationIssue,
  ValidationResult,
} from '../contracts/domain-models'
import { inspectScenarioConfig, inspectScenarioUiExtensions } from '../features/scenarios/scenario-validation'
import { createEmptyScenarioDraft, withScenarioBasicDefaults } from '../features/scenarios/scenario-basic'
import { buildLocalSceneImport, type LocalSceneImport } from '../features/scenarios/local-scene-import'
import { toRaw } from 'vue'
import { readApiFailure, readJson, unwrapSuccessData } from './api-envelope'
import { resolveMockOrigin, useAuthStore } from './auth'

class InvalidScenarioResponseError extends Error {
  /**
   * 创建场景响应不符合合同的标记错误。
   * @returns 初始化后的错误实例。
   * @remarks 只设置错误消息，不修改 Store 状态。
   */
  constructor() {
    super('场景数据格式不正确。')
  }
}

/**
 * 从成功信封中读取并校验完整场景草稿。
 * @param payload 服务端返回的已解析响应体。
 * @returns 合同有效时返回场景草稿，否则返回 `undefined`。
 * @remarks 校验场景外壳、全部规范字段及界面扩展，不修改响应载荷。
 */
function readScenarioDraft(payload: unknown): ScenarioDraft | undefined {
  const data = unwrapSuccessData(payload)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const draft = data as Partial<ScenarioDraft>
  const keys = Object.keys(data)
  const uiExtensions = draft.uiExtensions
  if (keys.length !== 5 || !keys.every((key) => ['config', 'uiExtensions', 'revision', 'officialLibraryChanged', 'locked'].includes(key))) return undefined
  if (!Number.isInteger(draft.revision) || (draft.revision ?? -1) < 0 || draft.officialLibraryChanged !== false || typeof draft.locked !== 'boolean') return undefined
  if (typeof uiExtensions !== 'object' || uiExtensions === null || !Array.isArray(uiExtensions.jammers) || !Array.isArray(uiExtensions.sensors)) return undefined
  const inspection = inspectScenarioConfig(draft.config)
  if (!inspection.result.valid || inspection.jammers === undefined) return undefined
  return inspectScenarioUiExtensions(
    uiExtensions,
    inspection.jammers.map((jammer) => jammer.id),
    inspection.sensors?.map((sensor) => sensor.id) ?? [],
  ).result.valid
    ? { ...draft, config: withScenarioBasicDefaults(draft.config!) } as ScenarioDraft
    : undefined
}

/** 从成功信封读取原子场景快照导入结果。 */
function readScenarioImportResult(payload: unknown): ScenarioImportResult | undefined {
  const data = unwrapSuccessData(payload)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const result = data as Partial<ScenarioImportResult>
  if (Object.keys(data).length !== 3 || !Number.isInteger(result.imported) || !Number.isInteger(result.rejected)
    || !Array.isArray(result.drafts) || result.imported !== result.drafts.length || result.rejected !== 0) return undefined
  const drafts = result.drafts.map((draft) => readScenarioDraft({ ok: true, data: draft }))
  return drafts.every((draft) => draft !== undefined) ? result as ScenarioImportResult : undefined
}

/** 从成功信封读取脚本预览合同。 */
function readScriptContract(payload: unknown): ScriptContract | undefined {
  const data = unwrapSuccessData(payload)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const script = data as Partial<ScriptContract>
  const keys = ['scriptId', 'taskId', 'scenarioId', 'configVersion', 'target', 'checksum', 'preview', 'generatedTime']
  return Object.keys(data).length === keys.length && Object.keys(data).every((key) => keys.includes(key))
    && keys.filter((key) => key !== 'target').every((key) => typeof (data as Record<string, unknown>)[key] === 'string' && (data as Record<string, string>)[key] !== '')
    && script.target === 'AFSIM 2.9.0'
    ? script as ScriptContract
    : undefined
}

/**
 * 判断未知值是否符合指定级别的字段校验问题合同。
 * @param value 服务端返回的未知问题对象。
 * @param severity 当前数组要求的错误级别。
 * @returns 字段完整且类型正确时返回 `true`。
 * @remarks 仅校验响应边界，不修改问题对象。
 */
function isValidationIssue(value: unknown, severity: ValidationIssue['severity']): value is ValidationIssue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const issue = value as Partial<ValidationIssue>
  return Object.keys(value).length === 4
    && issue.severity === severity
    && typeof issue.code === 'string'
    && typeof issue.message === 'string'
    && typeof issue.fieldPath === 'string'
}

/**
 * 从成功信封中读取整体场景校验结果。
 * @param payload 服务端返回的已解析响应体。
 * @returns 合同有效时返回校验结果，否则返回 `undefined`。
 * @remarks 同时验证错误级别、字段路径和 `valid` 与错误数量的一致性。
 */
function readValidationResult(payload: unknown): ValidationResult | undefined {
  const data = unwrapSuccessData(payload)
  if (typeof data !== 'object' || data === null || Array.isArray(data) || Object.keys(data).length !== 3) return undefined
  const result = data as Partial<ValidationResult>
  if (!Array.isArray(result.errors) || !Array.isArray(result.warnings)) return undefined
  if (!result.errors.every((issue) => isValidationIssue(issue, 'ERROR'))
    || !result.warnings.every((issue) => isValidationIssue(issue, 'WARNING'))
    || result.valid !== (result.errors.length === 0)) return undefined
  return result as ValidationResult
}

/**
 * 校验未知值是否为完整场景模板。
 * @param value 服务端成功信封中的模板候选值。
 * @returns 字段、类型和场景配置均有效时返回模板。
 * @remarks 只执行边界校验，不修改响应对象。
 */
function readScenarioTemplateValue(value: unknown): ScenarioTemplate | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Partial<ScenarioTemplate>
  const keys = Object.keys(value)
  if (!['templateId', 'name', 'version', 'official', 'config', 'referenceCount'].every(key => keys.includes(key))
    || !keys.every(key => ['templateId', 'name', 'version', 'official', 'config', 'referenceCount', 'uiExtensions'].includes(key))) return undefined
  if (typeof candidate.templateId !== 'string' || candidate.templateId === ''
    || typeof candidate.name !== 'string' || candidate.name === ''
    || typeof candidate.version !== 'string' || candidate.version === ''
    || typeof candidate.official !== 'boolean'
    || !Number.isInteger(candidate.referenceCount) || (candidate.referenceCount ?? -1) < 0
    || !inspectScenarioConfig(candidate.config).result.valid) return undefined
  if (Object.hasOwn(candidate, 'uiExtensions') && !inspectScenarioUiExtensions(candidate.uiExtensions,
    candidate.config!.jammers.map(item => item.id), candidate.config!.sensors.map(item => item.id)).result.valid) return undefined
  return candidate as ScenarioTemplate
}

/** 从成功信封读取单个模板。 */
function readScenarioTemplate(payload: unknown): ScenarioTemplate | undefined {
  return readScenarioTemplateValue(unwrapSuccessData(payload))
}

/** 从成功信封读取模板列表。 */
function readTemplateList(payload: unknown): ScenarioTemplate[] | undefined {
  const data = unwrapSuccessData(payload)
  if (!Array.isArray(data)) return undefined
  const templates = data.map(readScenarioTemplateValue)
  return templates.every((template) => template !== undefined) ? templates as ScenarioTemplate[] : undefined
}

/**
 * 从成功信封读取指定状态的确认上下文。
 * @param payload 服务端响应载荷。
 * @param expectedState 当前步骤要求的确认状态。
 * @returns 合同有效且状态匹配时返回确认上下文。
 */
function readConfirmationContext(
  payload: unknown,
  expectedState: ConfirmationContext['state'],
): ConfirmationContext | undefined {
  const data = unwrapSuccessData(payload)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const context = data as Partial<ConfirmationContext>
  return Object.keys(data).length === 6
    && Object.keys(data).every((key) => ['confirmationId', 'state', 'actor', 'role', 'createdAt', 'expiresAt'].includes(key))
    && typeof context.confirmationId === 'string' && context.confirmationId !== ''
    && context.state === expectedState
    && typeof context.actor === 'string'
    && (context.role === 'ADMIN' || context.role === 'OPERATOR')
    && typeof context.createdAt === 'string'
    && typeof context.expiresAt === 'string'
    ? context as ConfirmationContext
    : undefined
}

/** 从成功信封读取模板删除结果。 */
function readDeleteResult(payload: unknown): DeleteResult | undefined {
  const data = unwrapSuccessData(payload)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const result = data as Partial<DeleteResult>
  return Object.keys(data).length === 2
    && Object.keys(data).every((key) => key === 'deleted' || key === 'objectId')
    && result.deleted === true
    && typeof result.objectId === 'string'
    && result.objectId !== ''
    ? result as DeleteResult
    : undefined
}

export const useScenarioStore = defineStore('scenario', {
  state: () => ({
    draft: null as ScenarioDraft | null,
    currentScenarioId: null as ScenarioId | null,
    panelState: 'EMPTY' as CapabilityState,
    dirty: false,
    validation: { valid: true, errors: [], warnings: [] } as ValidationResult,
    resultCode: 'EMPTY',
    resultMessage: '尚未加载场景草稿。',
    templates: [] as ScenarioTemplate[],
    selectedTemplate: null as ScenarioTemplate | null,
    templateState: 'EMPTY' as CapabilityState,
    templateResultCode: 'EMPTY',
    templateResultMessage: '尚未加载场景模板。',
    lastConfirmation: null as ConfirmationContext | null,
    script: null as ScriptContract | null,
    scriptState: 'EMPTY' as CapabilityState,
    scriptResultCode: 'EMPTY',
    scriptResultMessage: '尚未生成脚本预览。',
    preflight: { valid: true, errors: [], warnings: [] } as ValidationResult,
    requestEpoch: 0,
    scriptEpoch: 0,
    localImportEpoch: 0,
    scenes: [] as ScenarioDraft[],
    listState: 'EMPTY' as CapabilityState,
    listMessage: '',
    listEpoch: 0,
  }),

  actions: {
    async loadScenes(): Promise<boolean> {
      const epoch = ++this.listEpoch
      const session = this.requestEpoch
      this.listState = 'LOADING'
      this.listMessage = ''
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scenarios`, { headers: { 'X-Demo-Role': useAuthStore().role } })
        const payload = await readJson(response)
        if (epoch !== this.listEpoch || session !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const data = unwrapSuccessData(payload)
        if (!Array.isArray(data)) throw new InvalidScenarioResponseError()
        const scenes = data.map(item => readScenarioDraft({ ok: true, data: item }))
        if (scenes.some(item => !item) || new Set(scenes.map(item => item!.config.scenario.id)).size !== scenes.length) throw new InvalidScenarioResponseError()
        this.scenes = scenes as ScenarioDraft[]
        this.listState = scenes.length ? 'SUCCESS' : 'EMPTY'
        return true
      } catch (error) {
        if (epoch !== this.listEpoch || session !== this.requestEpoch) return false
        this.scenes = []
        this.listState = 'ERROR'
        this.listMessage = readApiFailure(error)?.error.message ?? (error instanceof Error ? error.message : '场景列表加载失败。')
        return false
      }
    },
    async deleteScene(scene: ScenarioDraft): Promise<boolean> {
      if (scene.locked || !useAuthStore().authorize('SCENARIO_DRAFT_WRITE').allowed) return false
      const epoch = this.requestEpoch
      this.listState = 'EXECUTING'
      try {
        const id = scene.config.scenario.id
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scenarios/${encodeURIComponent(id)}?expectedRevision=${scene.revision}`, {
          method: 'DELETE', headers: { 'X-Demo-Role': useAuthStore().role },
        })
        const payload = await readJson(response)
        if (epoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        if (readDeleteResult(payload)?.objectId !== id) throw new InvalidScenarioResponseError()
        if (this.draft?.config.scenario.id === id) this.resetToSafeEmpty()
        await this.loadScenes()
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.listState = 'ERROR'
        this.listMessage = readApiFailure(error)?.error.message ?? '场景删除失败，请刷新后重试。'
        return false
      }
    },
    /** 复制只创建待保存草稿，生成新身份；不会改写来源场景或模板。 */
    prepareSceneCopy(config: ScenarioConfig, extensions: ScenarioDraft['uiExtensions'], name: string): boolean {
      if (!useAuthStore().authorize('SCENARIO_DRAFT_WRITE').allowed) return false
      this.resetToSafeEmpty()
      this.draft = { config: structuredClone(toRaw(config)), uiExtensions: structuredClone(toRaw(extensions)), revision: 0, locked: false, officialLibraryChanged: false }
      this.draft.config.scenario.id = `SCN-${crypto.randomUUID()}` as ScenarioId
      this.currentScenarioId = this.draft.config.scenario.id
      this.draft.config.scenario.name = name
      this.dirty = true
      this.panelState = 'SUCCESS'
      this.resultCode = 'SCENARIO_NEW'
      this.resultMessage = '场景副本尚未保存。'
      return true
    },
    /** 初始空态的新建动作只创建本地草稿，不请求接口、不覆盖已有草稿。 */
    createScenario(): boolean {
      if (this.draft !== null || this.panelState !== 'EMPTY') return false
      if (!useAuthStore().authorize('SCENARIO_DRAFT_WRITE').allowed) {
        this.showError(undefined, '当前账号没有新建场景权限。', 'PERMISSION_DENIED')
        return false
      }
      this.requestEpoch += 1
      this.invalidateLocalFileImport()
      this.clearScriptPreview()
      this.lastConfirmation = null
      this.draft = createEmptyScenarioDraft(`SCN-${crypto.randomUUID()}`)
      this.currentScenarioId = this.draft.config.scenario.id
      this.dirty = true
      this.validation = { valid: true, errors: [], warnings: [] }
      this.panelState = 'SUCCESS'
      this.resultCode = 'SCENARIO_NEW'
      this.resultMessage = '新场景尚未保存，请填写配置。'
      return true
    },
    /**
     * 将异常转换为统一的中文场景面板错误。
     * @param error 捕获到的网络、合同或 API 失败对象。
     * @param fallback 无法读取明确消息时使用的中文提示。
     * @returns 无返回值。
     * @sideEffects 将面板状态设为错误，并更新结果代码、消息和可选字段错误。
     */
    showError(error: unknown, fallback: string, fallbackCode: ApiErrorCode | 'NETWORK_ERROR' = 'NETWORK_ERROR'): void {
      const apiFailure = readApiFailure(error)
      this.panelState = 'ERROR'
      this.resultCode = error instanceof InvalidScenarioResponseError
        ? 'INVALID_RESPONSE'
        : apiFailure?.error.code ?? fallbackCode
      this.resultMessage = apiFailure?.error.message ?? (error instanceof Error ? error.message : fallback)
      if (apiFailure?.error.fieldPath !== undefined) {
        this.validation = {
          valid: false,
          errors: [{
            severity: 'ERROR',
            code: apiFailure.error.code,
            message: apiFailure.error.message,
            fieldPath: apiFailure.error.fieldPath,
          }],
          warnings: [],
        }
      }
    },

    /**
     * 将异常转换为模板库中文错误。
     * @param error 捕获到的网络、合同或 API 失败对象。
     * @param fallback 无明确消息时使用的中文提示。
     * @returns 无返回值。
     * @sideEffects 更新模板六态、结果代码和消息，不修改模板数组。
     */
    showTemplateError(error: unknown, fallback: string): void {
      const apiFailure = readApiFailure(error)
      this.templateState = 'ERROR'
      this.templateResultCode = error instanceof InvalidScenarioResponseError
        ? 'INVALID_RESPONSE'
        : apiFailure?.error.code ?? 'NETWORK_ERROR'
      this.templateResultMessage = apiFailure?.error.message ?? (error instanceof Error ? error.message : fallback)
    },

    /**
     * 从本机 Node.js Mock 服务加载指定场景草稿。
     * @param scenarioId 需要加载的场景编号；省略时重试当前场景，尚未选择时才读取 SCN-001。
     * @returns 加载成功时返回 `true`，失败时返回 `false`。
     * @sideEffects 更新六态面板状态；成功时替换草稿并清除未保存标记。
     */
    async loadScenario(scenarioId?: ScenarioId): Promise<boolean> {
      scenarioId ??= this.draft?.config.scenario.id ?? this.currentScenarioId ?? 'SCN-001'
      const requestEpoch = ++this.requestEpoch
      // 加载失败仍保留目标身份，不依赖即将清空的草稿。
      this.currentScenarioId = scenarioId
      this.draft = null
      this.dirty = false
      this.lastConfirmation = null
      this.clearScriptPreview()
      this.panelState = 'LOADING'
      try {
        const auth = useAuthStore()
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scenarios/${encodeURIComponent(scenarioId)}`, {
          headers: { 'X-Demo-Role': auth.role },
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.panelState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (response.status === 404 && readApiFailure(payload)?.error.code === 'NOT_FOUND') {
          this.draft = null
          this.dirty = false
          this.validation = { valid: true, errors: [], warnings: [] }
          this.panelState = 'EMPTY'
          this.resultCode = 'EMPTY'
          this.resultMessage = '暂无场景，请新建场景、导入快照或选择场景模板。'
          this.lastConfirmation = null
          this.invalidateLocalFileImport()
          this.clearScriptPreview()
          return false
        }
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const draft = readScenarioDraft(payload)
        if (draft === undefined || draft.config.scenario.id !== scenarioId) throw new InvalidScenarioResponseError()

        this.draft = draft
        this.currentScenarioId = draft.config.scenario.id
        this.dirty = false
        this.validation = { valid: true, errors: [], warnings: [] }
        this.panelState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '场景草稿已加载。'
        this.clearScriptPreview()
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showError(error, '场景草稿加载失败。')
        return false
      }
    },

    /**
     * 同步仿真接口返回的场景配置锁投影。
     * @param scenarioId 仿真运行绑定的场景编号。
     * @param locked 当前运行是否持有配置锁。
     * @returns 无返回值。
     * @sideEffects 仅在已加载同一场景时更新草稿锁标记，不改变配置、修订号或未保存状态。
     */
    projectRuntimeLock(scenarioId: ScenarioId, locked: boolean): void {
      if (this.draft?.config.scenario.id === scenarioId && this.draft.locked !== locked) {
        this.invalidateLocalFileImport()
        this.draft.locked = locked
      }
    },

    /**
     * 标记当前场景草稿存在未保存修改。
     * @returns 无返回值。
     * @sideEffects 草稿存在时将 `dirty` 设为 `true`，恢复就绪态并清除旧校验与操作反馈。
     */
    markDirty(): void {
      if (this.draft === null) return
      this.dirty = true
      this.validation = { valid: true, errors: [], warnings: [] }
      this.panelState = 'SUCCESS'
      this.resultCode = 'EMPTY'
      this.resultMessage = ''
      this.clearScriptPreview()
    },

    /** 本地文件只写入草稿；会话、草稿版本或配置锁变化后拒绝旧预览，仍需用户手动保存。 */
    applyLocalFileImport(input: LocalSceneImport, requestEpoch: number, scriptEpoch: number, localImportEpoch: number): ValidationIssue[] {
      if (!this.draft || this.draft.locked || requestEpoch !== this.requestEpoch || scriptEpoch !== this.scriptEpoch
        || localImportEpoch !== this.localImportEpoch
        || ['LOADING', 'VALIDATING', 'EXECUTING'].includes(this.panelState)
        || !useAuthStore().authorize('SCENARIO_DRAFT_WRITE').allowed) {
        return [{ severity: 'ERROR', code: 'LOCAL_IMPORT_STALE', message: '草稿、权限或锁状态已变化，请重新打开导入预览。', fieldPath: 'scenario' }]
      }
      const result = buildLocalSceneImport(toRaw(this.draft.config), input)
      if (!result.config) return result.errors
      this.draft.config = result.config
      this.markDirty()
      return []
    },

    /** 预览关闭或锁状态变化只淘汰导入确认，不重置其他模块的在途操作。 */
    invalidateLocalFileImport(): void {
      this.localImportEpoch += 1
    },

    /** 清除脚本结果并使在途预览/预检失效，不影响其他场景和模板请求。 */
    clearScriptPreview(): void {
      this.scriptEpoch += 1
      this.script = null
      this.scriptState = 'EMPTY'
      this.scriptResultCode = 'EMPTY'
      this.scriptResultMessage = '场景已变化，请重新生成脚本预览。'
      this.preflight = { valid: true, errors: [], warnings: [] }
    },

    /**
     * 通过 Node.js Mock 对当前完整场景执行整体校验。
     * @returns 没有阻断错误时返回 `true`，权限、配置锁、合同或网络失败时返回 `false`。
     * @sideEffects 更新六态面板状态、校验问题集合及中文结果反馈，不修改场景草稿。
     */
    async validateScenario(): Promise<boolean> {
      const requestEpoch = this.requestEpoch
      const scriptEpoch = this.scriptEpoch
      const auth = useAuthStore()
      if (!auth.authorize('SCENARIO_DRAFT_WRITE').allowed) {
        this.panelState = 'ERROR'
        this.resultCode = 'PERMISSION_DENIED'
        this.resultMessage = '当前账号没有场景草稿校验权限。'
        return false
      }
      if (this.draft === null) {
        this.panelState = 'EMPTY'
        this.resultCode = 'EMPTY'
        this.resultMessage = '请先加载场景草稿。'
        return false
      }
      if (this.draft.locked) {
        this.validation = {
          valid: false,
          errors: [{
            severity: 'ERROR',
            code: 'CONFIG_LOCKED',
            message: '场景正在运行，当前配置已锁定。',
            fieldPath: 'scenario',
          }],
          warnings: [],
        }
        this.panelState = 'ERROR'
        this.resultCode = 'CONFIG_LOCKED'
        this.resultMessage = '场景正在运行，当前配置已锁定。'
        return false
      }

      this.panelState = 'VALIDATING'
      this.validation = inspectScenarioConfig(this.draft.config, 'write').result
      // 新草稿尚无服务端资源，使用同一规则本地预检；首次 POST 仍由服务端再次严格校验。
      if (this.draft.revision === 0) {
        const valid = this.validation.valid
        this.panelState = valid ? 'SUCCESS' : 'ERROR'
        this.resultCode = valid ? 'VALIDATION_SUCCESS' : 'VALIDATION_FAILED'
        this.resultMessage = valid ? '新场景本地校验通过，请保存草稿。' : `整体校验发现 ${this.validation.errors.length} 个错误。`
        return valid
      }
      try {
        this.panelState = 'EXECUTING'
        const scenarioId = this.draft.config.scenario.id
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scenarios/${encodeURIComponent(scenarioId)}/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ config: this.draft.config }),
        })
        if (requestEpoch !== this.requestEpoch || scriptEpoch !== this.scriptEpoch) return false
        this.panelState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch || scriptEpoch !== this.scriptEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const result = readValidationResult(payload)
        if (result === undefined) throw new InvalidScenarioResponseError()

        this.validation = result
        if (result.errors.length > 0) {
          this.panelState = 'ERROR'
          this.resultCode = 'VALIDATION_FAILED'
          this.resultMessage = `整体校验发现 ${result.errors.length} 个错误。`
          return false
        }
        this.panelState = 'SUCCESS'
        this.resultCode = result.warnings.length > 0 ? 'VALIDATION_WARNING' : 'VALIDATION_SUCCESS'
        this.resultMessage = result.warnings.length > 0
          ? `整体校验通过，存在 ${result.warnings.length} 个警告。`
          : '整体校验通过，未发现错误或警告。'
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch || scriptEpoch !== this.scriptEpoch) return false
        this.showError(error, '场景整体校验失败。')
        return false
      }
    },

    /**
     * 校验并保存当前场景草稿。
     * @returns 保存成功时返回 `true`，权限、校验或网络失败时返回 `false`。
     * @sideEffects 依次更新校验和执行状态；成功时替换服务端草稿并清除未保存标记。
     */
    async saveScenario(): Promise<boolean> {
      const requestEpoch = this.requestEpoch
      const auth = useAuthStore()
      if (!auth.authorize('SCENARIO_DRAFT_WRITE').allowed) {
        this.panelState = 'ERROR'
        this.resultCode = 'PERMISSION_DENIED'
        this.resultMessage = '当前账号没有场景草稿编辑权限。'
        return false
      }
      if (this.draft === null) {
        this.panelState = 'ERROR'
        this.resultCode = 'EMPTY'
        this.resultMessage = '请先加载场景草稿。'
        return false
      }
      if (this.draft.locked) {
        this.panelState = 'ERROR'
        this.resultCode = 'CONFIG_LOCKED'
        this.resultMessage = '场景正在运行，当前配置已锁定。'
        return false
      }

      this.panelState = 'VALIDATING'
      const inspection = inspectScenarioConfig(this.draft.config, 'write')
      this.validation = inspection.result
      if (!inspection.result.valid || inspection.jammers === undefined) {
        const issue = inspection.result.errors[0]
        this.panelState = 'ERROR'
        this.resultCode = 'VALIDATION_FAILED'
        this.resultMessage = issue === undefined ? '场景配置校验失败。' : issue.message
        return false
      }
      const extensionInspection = inspectScenarioUiExtensions(
        this.draft.uiExtensions,
        inspection.jammers.map((jammer) => jammer.id),
        inspection.sensors?.map((sensor) => sensor.id) ?? [],
      )
      if (!extensionInspection.result.valid) {
        const issue = extensionInspection.result.errors[0]
        this.validation = extensionInspection.result
        this.panelState = 'ERROR'
        this.resultCode = 'VALIDATION_FAILED'
        this.resultMessage = issue === undefined ? '场景界面扩展校验失败。' : issue.message
        return false
      }

      try {
        this.panelState = 'EXECUTING'
        const scenarioId = this.draft.config.scenario.id
        const creating = this.draft.revision === 0
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scenarios${creating ? '' : `/${encodeURIComponent(scenarioId)}`}`, {
          method: creating ? 'POST' : 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Demo-Role': auth.role,
          },
          body: JSON.stringify({ config: this.draft.config, uiExtensions: this.draft.uiExtensions, expectedRevision: this.draft.revision }),
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.panelState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const draft = readScenarioDraft(payload)
        if (draft === undefined || draft.config.scenario.id !== scenarioId) throw new InvalidScenarioResponseError()

        this.draft = draft
        this.currentScenarioId = draft.config.scenario.id
        this.dirty = false
        this.validation = { valid: true, errors: [], warnings: [] }
        this.panelState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = `场景草稿已保存，当前修订号为 ${draft.revision}。`
        this.clearScriptPreview()
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showError(error, '场景草稿保存失败。')
        return false
      }
    },

    /**
     * 加载可见模板列表。
     * @returns 成功时返回 `true`，合同或网络失败时返回 `false`。
     * @sideEffects 更新模板列表和模板能力六态。
     */
    async loadTemplates(): Promise<boolean> {
      const requestEpoch = this.requestEpoch
      this.templateState = 'LOADING'
      try {
        const auth = useAuthStore()
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/templates`, {
          headers: { 'X-Demo-Role': auth.role },
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.templateState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const templates = readTemplateList(payload)
        if (templates === undefined) throw new InvalidScenarioResponseError()
        this.templates = templates
        this.templateState = templates.length === 0 ? 'EMPTY' : 'SUCCESS'
        this.templateResultCode = templates.length === 0 ? 'EMPTY' : 'TEMPLATES_LOADED'
        this.templateResultMessage = templates.length === 0 ? '模板库暂无数据。' : ''
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showTemplateError(error, '场景模板加载失败。')
        return false
      }
    },

    /**
     * 加载单个模板详情。
     * @param templateId 模板编号。
     * @returns 成功时返回模板，否则返回 `undefined`。
     * @sideEffects 更新当前选中模板和模板能力六态，不替换工作草稿。
     */
    async loadTemplate(templateId: string): Promise<ScenarioTemplate | undefined> {
      const requestEpoch = this.requestEpoch
      this.templateState = 'LOADING'
      try {
        const auth = useAuthStore()
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/templates/${encodeURIComponent(templateId)}`, {
          headers: { 'X-Demo-Role': auth.role },
        })
        if (requestEpoch !== this.requestEpoch) return undefined
        this.templateState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return undefined
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const template = readScenarioTemplate(payload)
        if (template === undefined) throw new InvalidScenarioResponseError()
        this.selectedTemplate = template
        this.templateState = 'SUCCESS'
        this.templateResultCode = 'TEMPLATE_LOADED'
        this.templateResultMessage = `模板“${template.name}”版本 ${template.version} 已加载。`
        return template
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return undefined
        this.showTemplateError(error, '模板详情加载失败。')
        return undefined
      }
    },

    /**
     * 使用给定配置新建官方模板。
     * @param name 模板名称。
     * @param config 模板保存的完整场景配置，默认使用当前草稿。
     * @returns 新建成功时返回 `true`。
     * @sideEffects 管理员成功时追加模板并选中；失败不修改模板列表。
     */
    async createTemplate(name: string, config?: ScenarioConfig, uiExtensions?: ScenarioDraft['uiExtensions']): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.authorize('OFFICIAL_TEMPLATE_MAINTAIN').allowed) {
        this.templateState = 'ERROR'
        this.templateResultCode = 'PERMISSION_DENIED'
        this.templateResultMessage = '当前账号不能维护场景模板库。'
        return false
      }
      const templateConfig = config ?? this.draft?.config
      const templateExtensions = config === undefined ? this.draft?.uiExtensions : uiExtensions
      if (templateConfig === undefined || name.trim() === '') {
        this.templateState = 'ERROR'
        this.templateResultCode = 'VALIDATION_FAILED'
        this.templateResultMessage = templateConfig === undefined ? '请先加载场景草稿。' : '模板名称不能为空。'
        return false
      }
      const requestEpoch = this.requestEpoch
      this.templateState = 'VALIDATING'
      try {
        this.templateState = 'EXECUTING'
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ name: name.trim(), config: templateConfig, ...(templateExtensions === undefined ? {} : { uiExtensions: templateExtensions }) }),
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.templateState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const template = readScenarioTemplate(payload)
        if (template === undefined) throw new InvalidScenarioResponseError()
        this.templates.push(template)
        this.selectedTemplate = template
        this.templateState = 'SUCCESS'
        this.templateResultCode = 'TEMPLATE_CREATED'
        this.templateResultMessage = `场景模板“${template.name}”版本 ${template.version} 已新建。`
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showTemplateError(error, '场景模板新建失败。')
        return false
      }
    },

    /**
     * 从 JSON 文本导入官方模板。
     * @param text 包含 `name` 和 `config` 的 JSON 文本。
     * @returns 导入成功时返回 `true`。
     * @sideEffects 解析成功后复用新建模板动作；不读写真实文件。
     */
    async importTemplate(text: string): Promise<boolean> {
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        this.templateState = 'ERROR'
        this.templateResultCode = 'INVALID_REQUEST'
        this.templateResultMessage = '模板 JSON 语法不正确。'
        return false
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)
        || !Object.keys(value).every(key => ['name', 'config', 'uiExtensions'].includes(key)) || !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'config')
        || typeof (value as { name?: unknown }).name !== 'string') {
        this.templateState = 'ERROR'
        this.templateResultCode = 'VALIDATION_FAILED'
        this.templateResultMessage = '模板 JSON 必须包含 name、config，可选 uiExtensions，不允许其他字段。'
        return false
      }
      const request = value as { name: string; config: ScenarioConfig; uiExtensions?: ScenarioDraft['uiExtensions'] }
      return this.createTemplate(request.name, request.config, request.uiExtensions)
    },

    /**
     * 使用当前场景草稿更新指定官方模板。
     * @param templateId 模板编号。
     * @param name 模板名称。
     * @returns 更新成功时返回 `true`。
     * @sideEffects 成功时原位替换模板并递增服务端版本。
     */
    async updateTemplate(templateId: string, name: string): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.authorize('OFFICIAL_TEMPLATE_MAINTAIN').allowed || this.draft === null) {
        this.templateState = 'ERROR'
        this.templateResultCode = this.draft === null ? 'EMPTY' : 'PERMISSION_DENIED'
        this.templateResultMessage = this.draft === null ? '请先加载场景草稿。' : '当前账号不能维护场景模板库。'
        return false
      }
      const requestEpoch = this.requestEpoch
      this.templateState = 'VALIDATING'
      try {
        this.templateState = 'EXECUTING'
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/templates/${encodeURIComponent(templateId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ name, config: this.draft.config, uiExtensions: this.draft.uiExtensions }),
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.templateState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const template = readScenarioTemplate(payload)
        if (template === undefined) throw new InvalidScenarioResponseError()
        const index = this.templates.findIndex((item) => item.templateId === templateId)
        if (index >= 0) this.templates[index] = template
        else this.templates.push(template)
        this.selectedTemplate = template
        this.templateState = 'SUCCESS'
        this.templateResultCode = 'TEMPLATE_UPDATED'
        this.templateResultMessage = `场景模板“${template.name}”已更新为版本 ${template.version}。`
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showTemplateError(error, '场景模板更新失败。')
        return false
      }
    },

    /**
     * 将官方模板以复制方式应用到临时工作场景。
     * @param templateId 模板编号。
     * @param name 新工作场景名称。
     * @returns 复制成功时返回 `true`。
     * @sideEffects 成功时替换当前场景草稿并清除未保存标记。
     */
    async copyTemplate(templateId: string, name: string): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.authorize('SCENARIO_DRAFT_WRITE').allowed) {
        this.templateState = 'ERROR'
        this.templateResultCode = 'PERMISSION_DENIED'
        this.templateResultMessage = '当前账号不能应用场景模板。'
        return false
      }
      const requestEpoch = this.requestEpoch
      this.templateState = 'VALIDATING'
      try {
        this.templateState = 'EXECUTING'
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/templates/${encodeURIComponent(templateId)}/copy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ name, scenarioId: this.draft?.config.scenario.id ?? `SCN-${crypto.randomUUID()}` }),
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.templateState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const draft = readScenarioDraft(payload)
        if (draft === undefined) throw new InvalidScenarioResponseError()
        this.draft = draft
        this.currentScenarioId = draft.config.scenario.id
        this.dirty = false
        this.validation = { valid: true, errors: [], warnings: [] }
        this.templateState = 'SUCCESS'
        this.templateResultCode = 'TEMPLATE_COPIED'
        this.templateResultMessage = `模板已应用到临时工作场景“${draft.config.scenario.name}”。`
        this.panelState = 'SUCCESS'
        this.resultCode = 'TEMPLATE_COPIED'
        this.resultMessage = this.templateResultMessage
        this.clearScriptPreview()
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showTemplateError(error, '模板应用失败。')
        return false
      }
    },

    /**
     * 生成模板 JSON 内存预览。
     * @param templateId 模板编号。
     * @returns 成功时返回格式化 JSON 文本，否则返回 `undefined`。
     * @sideEffects 复用模板详情加载并更新导出反馈，不创建文件。
     */
    async exportTemplate(templateId: string): Promise<string | undefined> {
      const auth = useAuthStore()
      if (!auth.authorize('OFFICIAL_TEMPLATE_MAINTAIN').allowed) {
        this.templateState = 'ERROR'
        this.templateResultCode = 'PERMISSION_DENIED'
        this.templateResultMessage = '当前账号不能导出场景模板。'
        return undefined
      }
      const template = await this.loadTemplate(templateId)
      if (template === undefined) return undefined
      this.templateResultCode = 'TEMPLATE_EXPORTED'
      this.templateResultMessage = `模板“${template.name}”JSON 预览已生成，未写入真实文件。`
      return JSON.stringify({ name: template.name, config: template.config, ...(template.uiExtensions ? { uiExtensions: template.uiExtensions } : {}) }, null, 2)
    },

    /**
     * 经二次确认删除未被引用的官方模板。
     * @param templateId 模板编号。
     * @returns 删除成功时返回 `true`。
     * @sideEffects 顺序创建、确认并消费一次性上下文；成功时移除模板。
     */
    async deleteTemplate(templateId: string): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.authorize('OFFICIAL_TEMPLATE_MAINTAIN').allowed) {
        this.templateState = 'ERROR'
        this.templateResultCode = 'PERMISSION_DENIED'
        this.templateResultMessage = '当前账号不能删除场景模板。'
        return false
      }
      const requestEpoch = this.requestEpoch
      this.templateState = 'VALIDATING'
      try {
        this.templateState = 'EXECUTING'
        const createResponse = await apiFetch(`${resolveMockOrigin()}/api/v1/confirmations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ action: 'OFFICIAL_TEMPLATE_DELETE', objectId: templateId }),
        })
        const createPayload = await readJson(createResponse)
        if (requestEpoch !== this.requestEpoch) return false
        if (!createResponse.ok) throw readApiFailure(createPayload) ?? new InvalidScenarioResponseError()
        const awaiting = readConfirmationContext(createPayload, 'AWAITING_CONFIRMATION')
        if (awaiting === undefined) throw new InvalidScenarioResponseError()
        this.lastConfirmation = awaiting

        const confirmResponse = await apiFetch(`${resolveMockOrigin()}/api/v1/confirmations/${encodeURIComponent(awaiting.confirmationId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ confirm: true }),
        })
        const confirmPayload = await readJson(confirmResponse)
        if (requestEpoch !== this.requestEpoch) return false
        const confirmed = readConfirmationContext(confirmPayload, 'CONFIRMED')
        if (!confirmResponse.ok || confirmed === undefined) {
          throw readApiFailure(confirmPayload) ?? new InvalidScenarioResponseError()
        }
        this.lastConfirmation = confirmed

        const deleteResponse = await apiFetch(`${resolveMockOrigin()}/api/v1/templates/${encodeURIComponent(templateId)}`, {
          method: 'DELETE',
          headers: { 'X-Demo-Role': auth.role, 'X-Confirmation-Id': awaiting.confirmationId },
        })
        const deletePayload = await readJson(deleteResponse)
        if (requestEpoch !== this.requestEpoch) return false
        if (!deleteResponse.ok) {
          const deleteFailure = readApiFailure(deletePayload)
          if (deleteFailure?.error.code !== 'CONFIRMATION_EXPIRED') {
            this.lastConfirmation = { ...confirmed, state: 'CLOSED' }
          }
          throw deleteFailure ?? new InvalidScenarioResponseError()
        }
        const result = readDeleteResult(deletePayload)
        if (result === undefined || result.objectId !== templateId) throw new InvalidScenarioResponseError()
        this.lastConfirmation = { ...confirmed, state: 'CLOSED' }
        this.templates = this.templates.filter((template) => template.templateId !== templateId)
        if (this.selectedTemplate?.templateId === templateId) this.selectedTemplate = null
        this.templateState = this.templates.length === 0 ? 'EMPTY' : 'SUCCESS'
        this.templateResultCode = 'TEMPLATE_DELETED'
        this.templateResultMessage = `场景模板 ${templateId} 已删除。`
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showTemplateError(error, '场景模板删除失败。')
        return false
      }
    },

    /** 从 JSON 文本原子导入一个完整场景快照。 */
    async importScenarioSnapshot(text: string): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.authorize('SCENARIO_DRAFT_WRITE').allowed) {
        this.showError(undefined, '当前账号没有场景快照导入权限。', 'PERMISSION_DENIED')
        return false
      }
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        this.showError(undefined, '场景快照 JSON 语法不正确。', 'VALIDATION_FAILED')
        return false
      }
      if (Array.isArray(value)) {
        this.showError(undefined, '一次只能导入一个完整场景快照。', 'VALIDATION_FAILED')
        return false
      }
      const requestEpoch = this.requestEpoch
      this.panelState = 'EXECUTING'
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scenarios/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ items: [value] }),
        })
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const result = readScenarioImportResult(payload)
        if (result === undefined || result.imported !== 1 || result.rejected !== 0 || result.drafts.length !== 1) throw new InvalidScenarioResponseError()
        this.draft = result.drafts[0]
        this.currentScenarioId = this.draft.config.scenario.id
        this.dirty = false
        this.validation = { valid: true, errors: [], warnings: [] }
        this.panelState = 'SUCCESS'
        this.resultCode = 'SCENARIO_IMPORTED'
        this.resultMessage = '已导入 1 个完整场景快照。'
        this.clearScriptPreview()
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showError(error, '场景快照导入失败。')
        return false
      }
    },

    /** 撤销最近一次已持久化的场景操作。 */
    async undoScenario(): Promise<boolean> {
      return this.mutateScenarioSnapshot('undo', '场景操作已撤销。')
    },

    /** 将当前场景恢复为确定性初始快照；该操作可撤销。 */
    async resetScenario(): Promise<boolean> {
      return this.mutateScenarioSnapshot('reset', '场景已恢复为初始快照。')
    },

    /** 调用场景级撤销或重置端点并替换当前完整草稿。 */
    async mutateScenarioSnapshot(action: 'undo' | 'reset', successMessage: string): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.authorize('SCENARIO_DRAFT_WRITE').allowed || this.draft === null) {
        const missingDraft = this.draft === null
        this.showError(
          undefined,
          missingDraft ? '请先加载场景草稿。' : '当前账号没有场景操作权限。',
          missingDraft ? 'NOT_FOUND' : 'PERMISSION_DENIED',
        )
        return false
      }
      const requestEpoch = this.requestEpoch
      this.panelState = 'EXECUTING'
      try {
        const scenarioId = this.draft.config.scenario.id
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scenarios/${encodeURIComponent(scenarioId)}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ expectedRevision: this.draft.revision }),
        })
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const draft = readScenarioDraft(payload)
        if (draft === undefined) throw new InvalidScenarioResponseError()
        this.draft = draft
        this.dirty = false
        this.validation = { valid: true, errors: [], warnings: [] }
        this.panelState = 'SUCCESS'
        this.resultCode = action === 'undo' ? 'SCENARIO_UNDONE' : 'SCENARIO_RESET'
        this.currentScenarioId = draft.config.scenario.id
        this.resultMessage = successMessage
        this.clearScriptPreview()
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showError(error, action === 'undo' ? '场景撤销失败。' : '场景重置失败。')
        return false
      }
    },

    /** 生成 T-XQ-008 脚本预览；警告只在用户明确确认后继续一次。 */
    async generateScriptPreview(confirmWarnings = false): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.authorize('SCENARIO_DRAFT_WRITE').allowed || this.draft === null || this.dirty) {
        this.scriptState = 'ERROR'
        this.scriptResultCode = this.draft === null ? 'EMPTY' : this.dirty ? 'UNSAVED_CHANGES' : 'PERMISSION_DENIED'
        this.scriptResultMessage = this.draft === null ? '请先加载场景草稿。' : this.dirty ? '请先保存当前场景草稿。' : '当前账号没有脚本预览权限。'
        return false
      }
      const scriptEpoch = ++this.scriptEpoch
      const valid = await this.validateScenario()
      if (scriptEpoch !== this.scriptEpoch) return false
      if (!valid) {
        this.scriptState = 'ERROR'
        this.scriptResultCode = this.resultCode
        this.scriptResultMessage = this.resultMessage
        return false
      }
      let confirmationId: string | undefined
      this.scriptState = 'EXECUTING'
      try {
        if (this.validation.warnings.length > 0 && confirmWarnings) {
          const createResponse = await apiFetch(`${resolveMockOrigin()}/api/v1/confirmations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
            body: JSON.stringify({ action: 'SCENARIO_WARNING_CONTINUE', objectId: this.draft.config.scenario.id }),
          })
          if (scriptEpoch !== this.scriptEpoch) return false
          const createPayload = await readJson(createResponse)
          if (scriptEpoch !== this.scriptEpoch) return false
          if (!createResponse.ok) throw readApiFailure(createPayload) ?? new InvalidScenarioResponseError()
          const awaiting = readConfirmationContext(createPayload, 'AWAITING_CONFIRMATION')
          if (awaiting === undefined) throw new InvalidScenarioResponseError()
          const confirmResponse = await apiFetch(`${resolveMockOrigin()}/api/v1/confirmations/${encodeURIComponent(awaiting.confirmationId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
            body: JSON.stringify({ confirm: true }),
          })
          if (scriptEpoch !== this.scriptEpoch) return false
          const confirmPayload = await readJson(confirmResponse)
          if (scriptEpoch !== this.scriptEpoch) return false
          const confirmed = readConfirmationContext(confirmPayload, 'CONFIRMED')
          if (!confirmResponse.ok || confirmed === undefined) throw readApiFailure(confirmPayload) ?? new InvalidScenarioResponseError()
          this.lastConfirmation = confirmed
          confirmationId = confirmed.confirmationId
        }
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scripts/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ scenarioId: this.draft.config.scenario.id, ...(confirmationId === undefined ? {} : { warningConfirmationId: confirmationId }) }),
        })
        if (scriptEpoch !== this.scriptEpoch) return false
        const payload = await readJson(response)
        if (scriptEpoch !== this.scriptEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const script = readScriptContract(payload)
        if (script === undefined) throw new InvalidScenarioResponseError()
        if (this.lastConfirmation !== null && confirmationId !== undefined) this.lastConfirmation = { ...this.lastConfirmation, state: 'CLOSED' }
        this.script = script
        this.preflight = { valid: true, errors: [], warnings: [] }
        this.scriptState = 'SUCCESS'
        this.scriptResultCode = 'SCRIPT_PREVIEW_READY'
        this.scriptResultMessage = '脚本预览已生成。'
        return true
      } catch (error) {
        if (scriptEpoch !== this.scriptEpoch) return false
        const failure = readApiFailure(error)
        this.scriptState = 'ERROR'
        this.scriptResultCode = error instanceof InvalidScenarioResponseError ? 'INVALID_RESPONSE' : failure?.error.code ?? 'NETWORK_ERROR'
        this.scriptResultMessage = failure?.error.message ?? (error instanceof Error ? error.message : '脚本预览生成失败。')
        return false
      }
    },

    /** 使用脚本编号和校验和执行 T-XQ-008 预检。 */
    async preflightScript(): Promise<boolean> {
      if (this.script === null) return false
      const auth = useAuthStore()
      const scriptEpoch = ++this.scriptEpoch
      this.scriptState = 'VALIDATING'
      try {
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scripts/${encodeURIComponent(this.script.scriptId)}/preflight`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ checksum: this.script.checksum }),
        })
        if (scriptEpoch !== this.scriptEpoch) return false
        const payload = await readJson(response)
        if (scriptEpoch !== this.scriptEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidScenarioResponseError()
        const result = readValidationResult(payload)
        if (result === undefined) throw new InvalidScenarioResponseError()
        this.preflight = result
        this.scriptState = result.valid ? 'SUCCESS' : 'ERROR'
        this.scriptResultCode = result.valid ? 'PREFLIGHT_SUCCESS' : 'PREFLIGHT_FAILED'
        this.scriptResultMessage = result.valid ? '脚本结构、版本、路径和校验和预检通过。' : `脚本预检发现 ${result.errors.length} 个错误。`
        return result.valid
      } catch (error) {
        if (scriptEpoch !== this.scriptEpoch) return false
        const failure = readApiFailure(error)
        this.scriptState = 'ERROR'
        this.scriptResultCode = error instanceof InvalidScenarioResponseError ? 'INVALID_RESPONSE' : failure?.error.code ?? 'NETWORK_ERROR'
        this.scriptResultMessage = failure?.error.message ?? (error instanceof Error ? error.message : '脚本预检失败。')
        return false
      }
    },

    /**
     * 清空场景数据并恢复安全空态。
     * @returns 无返回值。
     * @sideEffects 使在途请求失效，清除草稿、校验问题和未保存标记，并将面板状态重置为空。
     */
    resetToSafeEmpty(): void {
      this.currentScenarioId = null
      this.listEpoch += 1
      this.scenes = []
      this.listState = 'EMPTY'
      this.listMessage = ''
      this.requestEpoch += 1
      this.scriptEpoch += 1
      this.invalidateLocalFileImport()
      this.draft = null
      this.panelState = 'EMPTY'
      this.dirty = false
      this.validation = { valid: true, errors: [], warnings: [] }
      this.resultCode = 'EMPTY'
      this.resultMessage = '尚未加载场景草稿。'
      this.templates = []
      this.selectedTemplate = null
      this.templateState = 'EMPTY'
      this.templateResultCode = 'EMPTY'
      this.templateResultMessage = '尚未加载场景模板。'
      this.lastConfirmation = null
      this.script = null
      this.scriptState = 'EMPTY'
      this.scriptResultCode = 'EMPTY'
      this.scriptResultMessage = '尚未生成脚本预览。'
      this.preflight = { valid: true, errors: [], warnings: [] }
    },
  },
})
