import { defineStore } from 'pinia'
import type {
  ApiFailure,
  CapabilityState,
  ScenarioDraft,
  ScenarioId,
  ValidationResult,
} from '../contracts/domain-models'
import { inspectScenarioConfig } from '../features/scenarios/scenario-validation'
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
 * 从未知载荷中读取最小 API 失败合同。
 * @param payload 服务端返回的已解析响应体。
 * @returns 载荷满足失败信封时返回失败对象，否则返回 `undefined`。
 * @remarks 纯边界校验，不修改载荷或 Store 状态。
 */
function readFailure(payload: unknown): ApiFailure | undefined {
  if (typeof payload !== 'object' || payload === null || (payload as { ok?: unknown }).ok !== false) return undefined
  const error = (payload as { error?: { code?: unknown; message?: unknown } }).error
  return typeof error?.code === 'string' && typeof error.message === 'string' ? payload as ApiFailure : undefined
}

/**
 * 从成功信封中读取并校验 P2-1 场景草稿。
 * @param payload 服务端返回的已解析响应体。
 * @returns 合同有效时返回场景草稿，否则返回 `undefined`。
 * @remarks 校验场景外壳和本阶段字段，不修改响应载荷。
 */
function readScenarioDraft(payload: unknown): ScenarioDraft | undefined {
  if (typeof payload !== 'object' || payload === null || (payload as { ok?: unknown }).ok !== true) return undefined
  const data = (payload as { data?: unknown }).data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const draft = data as Partial<ScenarioDraft>
  const keys = Object.keys(data)
  const uiExtensions = draft.uiExtensions
  if (keys.length !== 5 || !keys.every((key) => ['config', 'uiExtensions', 'revision', 'officialLibraryChanged', 'locked'].includes(key))) return undefined
  if (!Number.isInteger(draft.revision) || (draft.revision ?? -1) < 0 || draft.officialLibraryChanged !== false || typeof draft.locked !== 'boolean') return undefined
  if (typeof uiExtensions !== 'object' || uiExtensions === null || !Array.isArray(uiExtensions.jammers) || !Array.isArray(uiExtensions.sensors)) return undefined
  return inspectScenarioConfig(draft.config).result.valid ? draft as ScenarioDraft : undefined
}

export const useScenarioStore = defineStore('scenario', {
  state: () => ({
    draft: null as ScenarioDraft | null,
    panelState: 'EMPTY' as CapabilityState,
    dirty: false,
    validation: { valid: true, errors: [], warnings: [] } as ValidationResult,
    resultCode: 'EMPTY',
    resultMessage: '尚未加载场景草稿。',
    requestEpoch: 0,
  }),

  actions: {
    /**
     * 将异常转换为统一的中文场景面板错误。
     * @param error 捕获到的网络、合同或 API 失败对象。
     * @param fallback 无法读取明确消息时使用的中文提示。
     * @returns 无返回值。
     * @sideEffects 将面板状态设为错误，并更新结果代码、消息和可选字段错误。
     */
    showError(error: unknown, fallback: string): void {
      const apiFailure = readFailure(error)
      this.panelState = 'ERROR'
      this.resultCode = error instanceof InvalidScenarioResponseError
        ? 'INVALID_RESPONSE'
        : apiFailure?.error.code ?? 'NETWORK_ERROR'
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
     * 从本机 Node.js Mock 服务加载指定场景草稿。
     * @param scenarioId 需要加载的场景编号，默认读取确定性场景 SCN-001。
     * @returns 加载成功时返回 `true`，失败时返回 `false`。
     * @sideEffects 更新六态面板状态；成功时替换草稿并清除未保存标记。
     */
    async loadScenario(scenarioId: ScenarioId = 'SCN-001'): Promise<boolean> {
      const requestEpoch = this.requestEpoch
      this.panelState = 'LOADING'
      try {
        const auth = useAuthStore()
        const response = await fetch(`${resolveMockOrigin()}/api/v1/scenarios/${encodeURIComponent(scenarioId)}`, {
          headers: { 'X-Demo-Role': auth.role },
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.panelState = 'VALIDATING'
        const payload: unknown = await response.json().catch(() => undefined)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readFailure(payload) ?? new InvalidScenarioResponseError()
        const draft = readScenarioDraft(payload)
        if (draft === undefined) throw new InvalidScenarioResponseError()

        this.draft = draft
        this.dirty = false
        this.validation = { valid: true, errors: [], warnings: [] }
        this.panelState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '场景草稿已加载。'
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showError(error, '场景草稿加载失败。')
        return false
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

      this.panelState = 'VALIDATING'
      const inspection = inspectScenarioConfig(this.draft.config)
      this.validation = inspection.result
      if (!inspection.result.valid) {
        this.panelState = 'ERROR'
        this.resultCode = 'VALIDATION_FAILED'
        this.resultMessage = inspection.result.errors[0]?.message ?? '场景配置校验失败。'
        return false
      }

      try {
        this.panelState = 'EXECUTING'
        const scenarioId = this.draft.config.scenario.id
        const response = await fetch(`${resolveMockOrigin()}/api/v1/scenarios/${encodeURIComponent(scenarioId)}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Demo-Role': auth.role,
          },
          body: JSON.stringify(this.draft.config),
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.panelState = 'VALIDATING'
        const payload: unknown = await response.json().catch(() => undefined)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readFailure(payload) ?? new InvalidScenarioResponseError()
        const draft = readScenarioDraft(payload)
        if (draft === undefined) throw new InvalidScenarioResponseError()

        this.draft = draft
        this.dirty = false
        this.validation = { valid: true, errors: [], warnings: [] }
        this.panelState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = `场景草稿已保存，当前修订号为 ${draft.revision}。`
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showError(error, '场景草稿保存失败。')
        return false
      }
    },

    /**
     * 清空场景数据并恢复安全空态。
     * @returns 无返回值。
     * @sideEffects 使在途请求失效，清除草稿、校验问题和未保存标记，并将面板状态重置为空。
     */
    resetToSafeEmpty(): void {
      this.requestEpoch += 1
      this.draft = null
      this.panelState = 'EMPTY'
      this.dirty = false
      this.validation = { valid: true, errors: [], warnings: [] }
      this.resultCode = 'EMPTY'
      this.resultMessage = '尚未加载场景草稿。'
    },
  },
})
