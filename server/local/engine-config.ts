import { readLinkEngineWsUrl } from './engine-snapshot-client.js'

export interface EngineConfig {
  /** true 连接 realUrl；false 不建立外部 WS 连接（本机 mission 照常执行）。 */
  useRealEngine: boolean
  /** 真实数据源的完整 WS 地址，仅 useRealEngine=true 时使用；LINK_ENGINE_WS_URL 可覆盖。 */
  realUrl: string
  /** 历史字段：进程内模拟引擎推送间隔；仅供旧配置兼容，当前入口不使用。 */
  mockIntervalMs: number
}

const DEFAULT: EngineConfig = {
  useRealEngine: true,
  realUrl: 'ws://127.0.0.1:8080/ws/v1',
  mockIntervalMs: 5000,
}

/** 部署启动器传入的 realUrl 优先于 .env.local；缺省连接本机，仅显式 false 关闭外部连接。 */
export function readEngineConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const useRealEngine = env.useRealEngine?.trim().toLowerCase()
  if (useRealEngine && useRealEngine !== 'true' && useRealEngine !== 'false') throw new Error('useRealEngine 必须为 true 或 false。')
  const interval = env.mockIntervalMs?.trim() ? Number(env.mockIntervalMs) : DEFAULT.mockIntervalMs
  if (!Number.isFinite(interval) || interval < 100 || interval > 2_147_483_647) throw new Error('mockIntervalMs 必须为 100～2147483647 毫秒。')
  let realUrl: string
  try { realUrl = readLinkEngineWsUrl(env.realUrl) ?? DEFAULT.realUrl }
  catch { throw new Error('realUrl 必须为不含账号密码或片段的完整 ws:// 或 wss:// 地址。') }
  return {
    useRealEngine: useRealEngine ? useRealEngine === 'true' : DEFAULT.useRealEngine,
    realUrl,
    mockIntervalMs: interval,
  }
}
