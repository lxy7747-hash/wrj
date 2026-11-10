import { readFileSync } from 'node:fs'

export interface EngineConfig {
  /** true 连接 realUrl；false 在进程内启动假引擎。 */
  useRealEngine: boolean
  /** 真实引擎的完整 WS 地址，仅 useRealEngine=true 时使用；LINK_ENGINE_WS_URL 可覆盖。 */
  realUrl: string
  /** 假引擎推送间隔（毫秒），仅 useRealEngine=false 时使用。 */
  mockIntervalMs: number
}

/**
 * 文件缺失时按真实引擎处理，避免生产环境意外进入假数据模式；
 * 开发机用 config/engine.json 显式置 false 才启用假引擎。
 */

const DEFAULT: EngineConfig = {
  useRealEngine: true,
  realUrl: 'ws://192.168.1.48:8080/ws/v1',
  mockIntervalMs: 5000,
}

/** 读取 config/engine.json；文件缺失或字段无效时回退默认值。 */
export function readEngineConfig(path = new URL('../../config/engine.json', import.meta.url)): EngineConfig {
  let input: unknown
  try {
    input = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { ...DEFAULT }
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ...DEFAULT }
  const value = input as Record<string, unknown>
  const realUrl = typeof value.realUrl === 'string' && /^wss?:\/\//.test(value.realUrl.trim())
    ? value.realUrl.trim()
    : DEFAULT.realUrl
  const interval = typeof value.mockIntervalMs === 'number' && Number.isFinite(value.mockIntervalMs) && value.mockIntervalMs >= 100
    ? value.mockIntervalMs
    : DEFAULT.mockIntervalMs
  return {
    useRealEngine: value.useRealEngine === true,
    realUrl,
    mockIntervalMs: interval,
  }
}
