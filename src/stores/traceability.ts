import { apiFetch } from '../features/shared/api-fetch'
import { defineStore } from 'pinia'
import type { CapabilityState, FixtureMetadata } from '../contracts/domain-models'
import { isAdminObject, isAdminText } from '../features/admin/admin-contract'
import { resolveMockOrigin, useAuthStore } from './auth'

export const CAPABILITY_LABELS: Record<CapabilityState, string> = {
  LOADING: '加载中', VALIDATING: '校验中', EXECUTING: '执行中', SUCCESS: '成功', EMPTY: '暂无数据', ERROR: '失败',
}

/** 验证目录条目结构及安全锚点；页面只使用本地固定路由，不接受接口提供外部 URL。 */
function validItem(section: keyof FixtureMetadata, value: unknown): boolean {
  const keys = {
    capabilities: ['id', 'module', 'name', 'coverage', 'destination', 'states'],
    interfaces: ['id', 'kind', 'name', 'destination'],
    decisions: ['id', 'conflict', 'adopted', 'effect'],
    routes: ['path', 'page', 'stores', 'guard'],
  }[section]
  if (!isAdminObject(value, keys)) return false
  if (!keys.filter((key) => key !== 'states' && key !== 'stores').every((key) => isAdminText(value[key]))) return false
  if (section === 'routes') return /^\/[a-z/-]+$/.test(String(value.path)) && Array.isArray(value.stores) && value.stores.every(isAdminText)
  if (section === 'decisions') return /^DEC-\d+$/.test(String(value.id))
  if (!/^(cap-|de-cap-|de-if-)[a-z-]+$/.test(String(value.destination))) return false
  if (section === 'interfaces') return value.kind === '外部' || value.kind === '内部'
  return (value.coverage === 'INTERACTIVE_UI' || value.coverage === 'VISIBLE_CONTRACT')
    && Array.isArray(value.states) && value.states.length > 0
    && new Set(value.states).size === value.states.length
    && value.states.every((state) => typeof state === 'string' && Object.hasOwn(CAPABILITY_LABELS, state))
}

export const useTraceabilityStore = defineStore('traceability', {
  state: () => ({
    metadata: null as FixtureMetadata | null,
    state: 'EMPTY' as CapabilityState,
    message: '尚未加载需求目录。',
    query: '',
    requestEpoch: 0,
  }),
  getters: {
    /** 将需求和接口合为可筛选的追踪目录，编号、名称和模块均可检索。 */
    rows(state) {
      const rows = [
        ...(state.metadata?.capabilities ?? []).map((item) => ({ ...item, kind: '需求', group: item.module })),
        ...(state.metadata?.interfaces ?? []).map((item) => ({ ...item, kind: '接口', group: item.kind })),
      ]
      const query = state.query.trim().toLocaleLowerCase()
      return rows.filter((item) => `${item.id} ${item.name} ${item.group}`.toLocaleLowerCase().includes(query))
    },
  },
  actions: {
    /** 加载四类目录并原子替换；数量、唯一编号或结构不符时不保留部分结果。 */
    async loadMetadata(): Promise<boolean> {
      const epoch = this.requestEpoch
      this.state = 'LOADING'
      try {
        const metadata = {} as FixtureMetadata
        for (const [section, count] of Object.entries({ capabilities: 29, interfaces: 7, decisions: 8, routes: 11 })) {
          const response = await apiFetch(`${resolveMockOrigin()}/api/v1/meta/${section}`, { headers: { 'X-Demo-Role': useAuthStore().role } })
          const payload = await response.json()
          if (epoch !== this.requestEpoch) return false
          this.state = 'VALIDATING'
          if (!response.ok || payload?.ok !== true || !Array.isArray(payload.data) || payload.data.length !== count
            || !payload.data.every((item: unknown) => validItem(section as keyof FixtureMetadata, item))
            || new Set(payload.data.map((item: { id?: string; path?: string }) => item.id ?? item.path)).size !== count) {
            throw new Error('需求目录数量、编号或结构不符合合同，请重试。')
          }
          Object.assign(metadata, { [section]: payload.data })
        }
        this.metadata = metadata
        this.state = 'SUCCESS'
        this.message = '需求与接口目录已加载。'
        return true
      } catch (error) {
        if (epoch !== this.requestEpoch) return false
        this.metadata = null
        this.state = 'ERROR'
        this.message = error instanceof Error ? error.message : '需求目录加载失败，请重试。'
        return false
      }
    },
    /** 将已加载条目定位到蓝图中的对应说明，拒绝未知锚点。 */
    resolveDestination(destination: string): string | null {
      return [...(this.metadata?.capabilities ?? []), ...(this.metadata?.interfaces ?? [])].some((item) => item.destination === destination)
        ? `/blueprint#${destination}` : null
    },
    /** 取消在途加载并清空目录与筛选条件。 */
    resetToSafeEmpty(): void {
      this.requestEpoch += 1
      this.metadata = null
      this.state = 'EMPTY'
      this.message = '尚未加载需求目录。'
      this.query = ''
    },
  },
})
