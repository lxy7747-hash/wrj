import { apiFetch } from '../features/shared/api-fetch'
import { defineStore } from 'pinia'
import type {
  CapabilityState,
  ConfigurationLockState,
  ConfirmationContext,
  SimulationCommand,
  SimulationMode,
  SimulationRun,
  UiSimulationStatus,
} from '../contracts/domain-models'
import { resolveMockOrigin, useAuthStore } from './auth'
import { readApiFailure, readJson, unwrapSuccessData } from './api-envelope'
import { useScenarioStore } from './scenario'

const RUN_KEYS = new Set(['runId', 'taskId', 'scenarioId', 'uiStatus', 'canonical', 'configLocked', 'startedAt', 'completedAt'])
const CANONICAL_KEYS = new Set(['status', 'currentTime', 'totalDuration', 'processId', 'progress', 'errorMessage'])
const UI_STATUSES = new Set<UiSimulationStatus>(['IDLE', 'RUNNING', 'PAUSED', 'STOPPED', 'COMPLETED', 'ERROR'])
const CANONICAL_STATUSES = new Set(['IDLE', 'RUNNING', 'PAUSED', 'COMPLETED', 'ERROR'])
const REQUEST_TIMEOUT_MS = 5_000

class InvalidSimulationResponseError extends Error {
  /** 创建仿真响应不符合合同时使用的标记错误。 */
  constructor() {
    super('仿真运行数据格式不正确。')
  }
}

class SimulationTimeoutError extends Error {
  /** 创建仿真接口超时错误。 */
  constructor() {
    super('仿真服务响应超时。')
  }
}

const pendingRequests = new WeakMap<object, Map<AbortController, number>>()

/**
 * 为仿真控制请求增加统一超时和取消清理。
 * @param owner 拥有当前请求的 Store，便于重置时统一取消。
 * @param input fetch 请求地址。
 * @param init fetch 请求选项。
 * @returns 在超时前完成的 HTTP 响应。
 * @throws 超时时抛出 `SimulationTimeoutError`，其他异常保持原样。
 */
async function fetchSimulation(owner: object, input: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const requests = pendingRequests.get(owner) ?? new Map<AbortController, number>()
  pendingRequests.set(owner, requests)
  requests.set(controller, timer)
  try {
    return await apiFetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new SimulationTimeoutError()
    throw error
  } finally {
    window.clearTimeout(timer)
    requests.delete(controller)
  }
}

/** 判断未知值是否为闭合的仿真运行合同。 */
export function isSimulationRun(value: unknown): value is SimulationRun {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.keys(value).some((key) => !RUN_KEYS.has(key))) return false
  const run = value as Partial<SimulationRun>
  const canonical = run.canonical
  if (typeof canonical !== 'object' || canonical === null || Array.isArray(canonical)
    || Object.keys(canonical).some((key) => !CANONICAL_KEYS.has(key))) return false
  return typeof run.runId === 'string' && run.runId.startsWith('RUN-')
    && typeof run.taskId === 'string' && run.taskId.startsWith('TASK-')
    && typeof run.scenarioId === 'string' && run.scenarioId.startsWith('SCN-')
    && typeof run.uiStatus === 'string' && UI_STATUSES.has(run.uiStatus)
    && typeof run.configLocked === 'boolean'
    && typeof canonical.status === 'string' && CANONICAL_STATUSES.has(canonical.status)
    && typeof canonical.currentTime === 'number' && Number.isFinite(canonical.currentTime) && canonical.currentTime >= 0
    && typeof canonical.totalDuration === 'number' && Number.isFinite(canonical.totalDuration) && canonical.totalDuration >= 0
    && (canonical.processId === null || (Number.isInteger(canonical.processId) && canonical.processId > 0))
    && typeof canonical.progress === 'number' && canonical.progress >= 0 && canonical.progress <= 100
    && (canonical.errorMessage === undefined || typeof canonical.errorMessage === 'string')
    && (run.startedAt === undefined || typeof run.startedAt === 'string')
    && (run.completedAt === undefined || typeof run.completedAt === 'string')
}

/** 从成功信封读取一个仿真运行。 */
function readRun(payload: unknown): SimulationRun | undefined {
  const data = unwrapSuccessData(payload)
  return isSimulationRun(data) ? data : undefined
}

/** 从成功信封读取仿真运行列表。 */
function readRuns(payload: unknown): SimulationRun[] | undefined {
  const data = unwrapSuccessData(payload)
  return Array.isArray(data) && data.every(isSimulationRun) ? data : undefined
}

/** 从成功信封读取指定状态的一次性确认上下文。 */
function readConfirmation(payload: unknown, state: ConfirmationContext['state']): ConfirmationContext | undefined {
  const data = unwrapSuccessData(payload)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const confirmation = data as Partial<ConfirmationContext>
  return typeof confirmation.confirmationId === 'string'
    && confirmation.confirmationId.length > 0
    && confirmation.state === state
    && typeof confirmation.actor === 'string'
    && (confirmation.role === 'ADMIN' || confirmation.role === 'OPERATOR')
    && typeof confirmation.createdAt === 'string'
    && typeof confirmation.expiresAt === 'string'
    ? confirmation as ConfirmationContext
    : undefined
}

export const useSimulationStore = defineStore('simulation', {
  state: () => ({
    run: null as SimulationRun | null,
    mode: 'INTERACTIVE_SINGLE' as SimulationMode,
    speedMultiplier: 1,
    capabilityState: 'EMPTY' as CapabilityState,
    configurationLockState: 'UNLOCKED' as ConfigurationLockState,
    resultCode: 'EMPTY',
    resultMessage: '尚未创建仿真运行。',
    lastConfirmation: null as ConfirmationContext | null,
    requestEpoch: 0,
    runtimeSyncEpoch: 0,
  }),

  getters: {
    uiStatus: (state): UiSimulationStatus => state.run?.uiStatus ?? 'STOPPED',
    currentTime: (state): number => state.run?.canonical.currentTime ?? 0,
    pending: (state): boolean => (
      state.capabilityState === 'LOADING'
      || state.capabilityState === 'VALIDATING'
      || state.capabilityState === 'EXECUTING'
    ),
  },

  actions: {
    /**
     * 将异常转换为仿真控制的中文错误反馈。
     * @param error 捕获到的网络、合同或 API 失败对象。
     * @param fallback 无明确消息时使用的中文提示。
     * @returns 无返回值。
     * @sideEffects 更新能力状态、结果代码和消息，不覆盖最后一次有效运行。
     */
    showError(error: unknown, fallback: string): void {
      const failure = readApiFailure(error)
      this.capabilityState = 'ERROR'
      this.resultCode = error instanceof InvalidSimulationResponseError
        ? 'INVALID_RESPONSE'
        : error instanceof SimulationTimeoutError
          ? 'TIMEOUT'
        : failure?.error.code ?? 'NETWORK_ERROR'
      this.resultMessage = failure?.error.message ?? (error instanceof Error ? error.message : fallback)
    },

    /**
     * 原子应用服务端运行并同步场景 Store 的锁投影。
     * @param run 已通过响应合同校验的仿真运行。
     * @returns 无返回值。
     * @sideEffects 替换当前运行、锁状态，并更新已加载同场景的只读锁标记。
     */
    applyRun(run: SimulationRun): void {
      this.run = structuredClone(run)
      this.configurationLockState = run.configLocked ? 'LOCKED' : 'UNLOCKED'
      useScenarioStore().projectRuntimeLock(run.scenarioId, run.configLocked)
    },

    /**
     * 收到实时状态后重新读取完整运行，避免从规范 IDLE 猜测 UI 状态和配置锁。
     * @returns 同步成功或请求已被安全重置淘汰时返回 `true`，当前同步失败时返回 `false`。
     * @sideEffects 读取运行列表并原子更新当前运行及场景配置锁；失败时显示同步错误。
     */
    async synchronizeRuntimeState(): Promise<boolean> {
      const requestEpoch = this.requestEpoch
      const runtimeSyncEpoch = ++this.runtimeSyncEpoch
      try {
        const response = await fetchSimulation(this, `${resolveMockOrigin()}/api/v1/simulations`, {
          headers: { 'X-Demo-Role': useAuthStore().role },
        })
        if (requestEpoch !== this.requestEpoch || runtimeSyncEpoch !== this.runtimeSyncEpoch) return true
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch || runtimeSyncEpoch !== this.runtimeSyncEpoch) return true
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidSimulationResponseError()
        const runs = readRuns(payload)
        const run = runs?.find((candidate) => candidate.runId === 'RUN-001')
        if (run === undefined) throw new InvalidSimulationResponseError()
        this.applyRun(run)
        if (this.resultCode === 'RUNTIME_SYNC_FAILED') {
          this.capabilityState = 'SUCCESS'
          this.resultCode = 'SUCCESS'
          this.resultMessage = '仿真运行状态已同步。'
        }
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch || runtimeSyncEpoch !== this.runtimeSyncEpoch) return true
        this.showError(error, '仿真运行状态同步失败。')
        this.resultCode = 'RUNTIME_SYNC_FAILED'
        this.resultMessage = `仿真运行状态同步失败：${this.resultMessage}`
        return false
      }
    },

    /**
     * 从 Mock 服务恢复冻结的 RUN-001 投影。
     * @returns 加载成功时返回 `true`，否则返回 `false`。
     * @sideEffects 更新运行、锁状态和能力反馈。
     */
    async resetProjection(): Promise<boolean> {
      const requestEpoch = this.requestEpoch
      this.capabilityState = 'LOADING'
      try {
        const auth = useAuthStore()
        const response = await fetchSimulation(this, `${resolveMockOrigin()}/api/v1/simulations`, {
          headers: { 'X-Demo-Role': auth.role },
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.capabilityState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidSimulationResponseError()
        const runs = readRuns(payload)
        if (runs === undefined) throw new InvalidSimulationResponseError()
        const run = runs.find((candidate) => candidate.runId === 'RUN-001')
        if (run === undefined) {
          this.resetToSafeEmpty()
          return true
        }
        this.applyRun(run)
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '仿真运行状态已加载。'
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showError(error, '仿真运行状态加载失败。')
        return false
      }
    },

    /**
     * 创建 RUN-001 并由服务端锁定当前场景。
     * @returns 创建成功时返回 `true`，否则返回 `false`。
     * @sideEffects 更新能力状态、当前运行和场景配置锁投影。
     */
    async create(): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.authorize('SIMULATION_CONTROL').allowed) {
        this.showError(undefined, '当前账号没有仿真控制权限。')
        this.resultCode = 'PERMISSION_DENIED'
        return false
      }
      const requestEpoch = this.requestEpoch
      this.capabilityState = 'EXECUTING'
      this.configurationLockState = 'LOCKING'
      try {
        const response = await fetchSimulation(this, `${resolveMockOrigin()}/api/v1/simulations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ taskId: 'TASK-001', scenarioId: 'SCN-001' }),
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.capabilityState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidSimulationResponseError()
        const run = readRun(payload)
        if (run === undefined || !run.configLocked || run.uiStatus !== 'IDLE') throw new InvalidSimulationResponseError()
        this.applyRun(run)
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SIMULATION_CREATED'
        this.resultMessage = '仿真运行已创建，场景配置已锁定。'
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.configurationLockState = this.run?.configLocked ? 'LOCKED' : 'ERROR'
        this.showError(error, '仿真运行创建失败。')
        return false
      }
    },

    /**
     * 向当前运行发送一条规范命令。
     * @param command 已由调用动作组成的仿真命令。
     * @returns 命令成功时返回 `true`，否则返回 `false`。
     * @sideEffects 更新运行状态、场景锁投影和中文操作反馈。
     */
    async sendCommand(command: SimulationCommand): Promise<boolean> {
      const auth = useAuthStore()
      if (!auth.authorize('SIMULATION_CONTROL').allowed || this.run === null) {
        this.showError(undefined, this.run === null ? '请先创建仿真运行。' : '当前账号没有仿真控制权限。')
        this.resultCode = this.run === null ? 'EMPTY' : 'PERMISSION_DENIED'
        return false
      }
      const requestEpoch = this.requestEpoch
      const runId = this.run.runId
      this.capabilityState = 'EXECUTING'
      if (command.command === 'STOP') this.configurationLockState = 'UNLOCKING'
      try {
        const response = await fetchSimulation(this, `${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(runId)}/commands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify(command),
        })
        if (requestEpoch !== this.requestEpoch) return false
        this.capabilityState = 'VALIDATING'
        const payload = await readJson(response)
        if (requestEpoch !== this.requestEpoch) return false
        if (!response.ok) throw readApiFailure(payload) ?? new InvalidSimulationResponseError()
        const run = readRun(payload)
        if (run === undefined) throw new InvalidSimulationResponseError()
        this.applyRun(run)
        this.capabilityState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        const messages: Record<SimulationCommand['command'], string> = {
          START: '仿真已开始。',
          PAUSE: '仿真已暂停。',
          RESUME: '仿真已继续。',
          STEP: '仿真已单步推进。',
          STOP: '仿真已停止，场景配置已解锁。',
          SET_SPEED: '仿真倍速已更新。',
        }
        this.resultMessage = messages[command.command]
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.configurationLockState = this.run?.configLocked ? 'LOCKED' : 'UNLOCKED'
        this.showError(error, '仿真命令执行失败。')
        return false
      }
    },

    /**
     * 创建新运行并开始，或从暂停状态继续。
     * @returns 操作成功时返回 `true`，否则返回 `false`。
     * @sideEffects 可能依次创建运行、锁定场景并发送 START/RESUME 命令。
     */
    async start(): Promise<boolean> {
      if (this.run?.uiStatus === 'PAUSED') return this.resume()
      if (this.run === null || ['STOPPED', 'COMPLETED', 'ERROR'].includes(this.run.uiStatus)) {
        if (!await this.create()) return false
      }
      return this.sendCommand({ command: 'START', mode: this.mode })
    },

    /** 暂停当前运行。 */
    async pause(): Promise<boolean> {
      return this.sendCommand({ command: 'PAUSE' })
    },

    /** 继续当前暂停运行。 */
    async resume(): Promise<boolean> {
      return this.sendCommand({ command: 'RESUME' })
    },

    /** 按合同推进一个场景时间步。 */
    async step(): Promise<boolean> {
      return this.sendCommand({ command: 'STEP', stepCount: 1 })
    },

    /**
     * 更新倍速选择，并在运行期间同步到服务端。
     * @param speedMultiplier 用户选择的正数倍速。
     * @returns 更新成功时返回 `true`，输入或命令失败时返回 `false`。
     * @sideEffects 空闲时只更新本地选择；运行或暂停时发送 SET_SPEED 命令。
     */
    async setSpeed(speedMultiplier: number): Promise<boolean> {
      if (!Number.isFinite(speedMultiplier) || speedMultiplier <= 0) {
        this.showError(undefined, '仿真倍速必须大于 0。')
        this.resultCode = 'INVALID_TRANSITION'
        return false
      }
      if (this.run?.uiStatus === 'RUNNING' || this.run?.uiStatus === 'PAUSED') {
        if (!await this.sendCommand({ command: 'SET_SPEED', speedMultiplier })) return false
      }
      this.speedMultiplier = speedMultiplier
      return true
    },

    /**
     * 更新下次 START 使用的运行模式。
     * @param mode 合同定义的四种运行模式之一。
     * @returns 无返回值。
     * @sideEffects 只更新本地选择，不创建运行或发送命令。
     */
    setMode(mode: SimulationMode): void {
      this.mode = mode
    },

    /**
     * 创建并消费一次性确认后停止当前运行。
     * @returns 停止成功时返回 `true`，确认或命令失败时返回 `false`。
     * @sideEffects 依次写入确认上下文、运行状态和场景解锁投影。
     */
    async stop(): Promise<boolean> {
      const auth = useAuthStore()
      if (this.run === null || !auth.authorize('SIMULATION_CONTROL').allowed) {
        this.showError(undefined, this.run === null ? '当前没有可停止的仿真运行。' : '当前账号没有仿真控制权限。')
        this.resultCode = this.run === null ? 'EMPTY' : 'PERMISSION_DENIED'
        return false
      }
      if (this.run.uiStatus !== 'RUNNING' && this.run.uiStatus !== 'PAUSED') {
        this.showError(undefined, '只有运行中或已暂停的仿真可以停止。')
        this.resultCode = 'INVALID_TRANSITION'
        return false
      }
      const requestEpoch = this.requestEpoch
      const runId = this.run.runId
      try {
        this.capabilityState = 'EXECUTING'
        const createResponse = await fetchSimulation(this, `${resolveMockOrigin()}/api/v1/confirmations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ action: 'SIMULATION_STOP', objectId: runId }),
        })
        if (requestEpoch !== this.requestEpoch) return false
        const createPayload = await readJson(createResponse)
        if (requestEpoch !== this.requestEpoch) return false
        if (!createResponse.ok) throw readApiFailure(createPayload) ?? new InvalidSimulationResponseError()
        const awaiting = readConfirmation(createPayload, 'AWAITING_CONFIRMATION')
        if (awaiting === undefined) throw new InvalidSimulationResponseError()
        this.lastConfirmation = awaiting

        const confirmResponse = await fetchSimulation(this, `${resolveMockOrigin()}/api/v1/confirmations/${encodeURIComponent(awaiting.confirmationId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ confirm: true }),
        })
        if (requestEpoch !== this.requestEpoch) return false
        const confirmPayload = await readJson(confirmResponse)
        if (requestEpoch !== this.requestEpoch) return false
        if (!confirmResponse.ok) throw readApiFailure(confirmPayload) ?? new InvalidSimulationResponseError()
        const confirmed = readConfirmation(confirmPayload, 'CONFIRMED')
        if (confirmed === undefined) throw new InvalidSimulationResponseError()
        this.lastConfirmation = confirmed
        const stopped = await this.sendCommand({ command: 'STOP', confirmationId: confirmed.confirmationId })
        if (requestEpoch !== this.requestEpoch) return false
        if (stopped) this.lastConfirmation = { ...confirmed, state: 'CLOSED' }
        return stopped
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.showError(error, '停止仿真失败。')
        return false
      }
    },

    /** 取消当前 Store 的请求及超时计时器，使迟到响应失效。 */
    clearTimers(): void {
      this.requestEpoch += 1
      for (const [controller, timer] of pendingRequests.get(this) ?? []) {
        window.clearTimeout(timer)
        controller.abort()
      }
      pendingRequests.delete(this)
    },

    /**
     * 清空仿真数据并恢复安全空态。
     * @returns 无返回值。
     * @sideEffects 使在途加载失效，并清除运行、确认和场景锁投影。
     */
    resetToSafeEmpty(): void {
      this.clearTimers()
      this.runtimeSyncEpoch += 1
      if (this.run !== null) useScenarioStore().projectRuntimeLock(this.run.scenarioId, false)
      this.run = null
      this.mode = 'INTERACTIVE_SINGLE'
      this.speedMultiplier = 1
      this.capabilityState = 'EMPTY'
      this.configurationLockState = 'UNLOCKED'
      this.resultCode = 'EMPTY'
      this.resultMessage = '尚未创建仿真运行。'
      this.lastConfirmation = null
    },
  },
})
