import { apiFetch } from '../features/shared/api-fetch'
import { nextTick } from 'vue'
import { defineStore } from 'pinia'
import { isRfc3339DateTime } from '../features/scenarios/scenario-validation'
import { resolveMockOrigin, useAuthStore } from './auth'
import { useAdminStore } from './admin'
import { useBatchStore } from './batch'
import { useDataExchangeStore } from './data-exchange'
import { useReplayStore } from './replay'
import { useReportStore } from './report'
import { useScenarioStore } from './scenario'
import { useSimulationStore } from './simulation'
import { useTelemetryStore } from './telemetry'
import { useTraceabilityStore } from './traceability'

export const useUiStore = defineStore('ui', {
  state: () => ({
    resetState: 'EMPTY' as 'EMPTY' | 'EXECUTING' | 'SUCCESS' | 'ERROR',
    resetMessage: '',
    correlationId: '',
    resetEpoch: 0,
  }),
  actions: {
    /** 清空九个业务投影，并关闭实时连接和回放、仿真请求计时器。 */
    clearBusinessProjections(): void {
      useTelemetryStore().disconnectAndReset()
      useSimulationStore().resetToSafeEmpty()
      useScenarioStore().resetToSafeEmpty()
      useBatchStore().resetToSafeEmpty()
      useReportStore().resetToSafeEmpty()
      useReplayStore().resetToSafeEmpty()
      useAdminStore().resetToSafeEmpty()
      useDataExchangeStore().resetToSafeEmpty()
      useTraceabilityStore().resetToSafeEmpty()
    },

    /** 登出时取消协调流程；新会话必须重新加载，旧响应不能恢复数据。 */
    cancelReset(): void {
      this.resetEpoch += 1
      this.resetState = 'EMPTY'
      this.resetMessage = ''
      this.correlationId = ''
      this.clearBusinessProjections()
      useTelemetryStore().connectionBlocked = false
    },

    /**
     * 唯一全局重置入口：每轮只请求一次 reset，再按依赖顺序加载投影。
     * @returns 全部加载成功为 true；失败、重复点击或会话失效为 false。
     * @remarks 仅重置本机 Mock 内存，不是场景撤销，也不操作数据库或真实文件。
     */
    async resetAllProjections(): Promise<boolean> {
      const auth = useAuthStore()
      if (this.resetState === 'EXECUTING' || auth.role !== 'ADMIN' || auth.principal === null
        || !auth.permissions.includes('USER_ROLE_MAINTAIN')) return false
      const epoch = ++this.resetEpoch
      const telemetry = useTelemetryStore()
      this.resetState = 'EXECUTING'
      this.resetMessage = '正在重置本机模拟数据，请勿关闭页面。'
      this.correlationId = ''
      telemetry.connectionBlocked = true
      // 先卸载页面的交互面板，避免卸载清理晚于新投影加载。
      await nextTick()
      if (epoch !== this.resetEpoch) return false
      let step = '清理旧数据'
      try {
        telemetry.disconnectAndReset()
        useSimulationStore().clearTimers()
        useReplayStore().stopPlaybackTimer()
        useReportStore().invalidateConfirmation()
        useAdminStore().invalidateConfirmation()
        this.clearBusinessProjections()
        step = '重置服务'
        const response = await apiFetch(`${resolveMockOrigin()}/api/v1/reset`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Demo-Role': auth.role },
          body: JSON.stringify({ confirm: true }),
        })
        const payload = await response.json()
        if (epoch !== this.resetEpoch) return false
        this.correlationId = typeof payload?.error?.correlationId === 'string' ? payload.error.correlationId : 'REQ-RESET-001'
        if (!response.ok || payload?.ok !== true || payload.data?.requestId !== 'REQ-RESET-001'
          || payload.data.nextSequence !== 1 || !isRfc3339DateTime(payload.data.generatedAt)) throw new Error()
        const loads: [string, () => Promise<boolean>][] = [
          ['权限', () => auth.refreshPermissions()],
          ['场景列表', () => useScenarioStore().loadScenes()],
          ['仿真运行', () => useSimulationStore().resetProjection()],
          ['态势帧', () => telemetry.loadFrame()],
          ['批次', () => useBatchStore().loadComparison()],
          ['报告', () => useReportStore().load()],
          ['回放', () => useReplayStore().load()],
          ['系统管理', () => useAdminStore().loadAll()],
          ['需求目录', () => useTraceabilityStore().loadMetadata()],
        ]
        for (const [label, load] of loads) {
          step = label
          const loaded = await load()
          if (epoch !== this.resetEpoch) return false
          if (!loaded) throw new Error()
        }
        auth.lastDenial = null
        this.resetState = 'SUCCESS'
        this.resetMessage = '模拟数据已恢复基线，场景草稿和未完成的确认已清除。'
        telemetry.connectionBlocked = false
        return true
      } catch {
        if (epoch !== this.resetEpoch) return false
        this.clearBusinessProjections()
        this.resetState = 'ERROR'
        this.resetMessage = `${step}失败，已清空全部业务投影；请重试。`
        this.correlationId ||= 'P8-RESET-LOCAL'
        return false
      }
    },
  },
})
