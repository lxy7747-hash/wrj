import { readLinkEngineWsUrl } from './engine-snapshot-client.js'

export interface EngineConfig {
  /** true 连接 realUrl；false 在进程内启动假引擎。 */
  useRealEngine: boolean
  /** 真实引擎的完整 WS 地址，仅 useRealEngine=true 时使用；LINK_ENGINE_WS_URL 可覆盖。 */
  realUrl: string
  /** 假引擎推送间隔（毫秒），仅 useRealEngine=false 时使用。 */
  mockIntervalMs: number
}

const DEFAULT: EngineConfig = {
  useRealEngine: true,
  realUrl: 'ws://192.168.1.48:8080/ws/v1',
  mockIntervalMs: 5000,
}

/** 由启动入口先加载 .env.local；缺省使用真实引擎，仅显式 false 启用模拟数据。 */
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
