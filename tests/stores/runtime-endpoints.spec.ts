import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadRuntimeEndpoints,
  parseRuntimeEndpoints,
  runtimeEndpoints,
  serviceOrigin,
  setRuntimeEndpoints,
} from '../../src/config/runtime-endpoints'
import { resolveMockOrigin } from '../../src/stores/auth'
import { resolveRealtimeUrl } from '../../src/stores/telemetry'
import { MAP_CONFIG } from '../../src/config/map.config'

afterEach(() => {
  setRuntimeEndpoints(undefined)
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
}

describe('运行时服务端口', () => {
  it('严格校验字段：只接受两个互不相同的有效端口', () => {
    expect(parseRuntimeEndpoints({ apiPort: 4173, mapPort: 4174 })).toEqual({ apiPort: 4173, mapPort: 4174 })
    for (const value of [
      null, [], 'x', {}, { apiPort: 4173 }, { apiPort: 4173, mapPort: 4173 }, { apiPort: 0, mapPort: 4174 },
      { apiPort: 65_536, mapPort: 4174 }, { apiPort: '4173', mapPort: 4174 }, { apiPort: 4173.5, mapPort: 4174 },
      { apiPort: 4173, mapPort: 4174, host: '192.168.1.18' }, { apiPort: 4173, mapPort: 4174, dbPath: 'C:/data' },
    ]) expect(() => parseRuntimeEndpoints(value)).toThrow()
  })

  it('读取同源配置时禁用缓存，并在成功后生效', async () => {
    const fetchImpl = vi.fn(async () => response('{"apiPort":5001,"mapPort":5002}'))
    await expect(loadRuntimeEndpoints(fetchImpl as unknown as typeof fetch)).resolves.toEqual({ apiPort: 5001, mapPort: 5002 })
    expect(fetchImpl).toHaveBeenCalledWith('/runtime-config.json', expect.objectContaining({ cache: 'no-store', credentials: 'omit' }))
    expect(runtimeEndpoints()).toEqual({ apiPort: 5001, mapPort: 5002 })
  })

  it.each([
    ['非 200', () => response('{}', 404), 'HTTP 404'],
    ['非 JSON', () => response('<html>'), '不是有效的 JSON'],
    ['字段非法', () => response('{"apiPort":4173,"mapPort":4174,"extra":1}'), 'apiPort、mapPort'],
    ['内容过大', () => response(`{"apiPort":4173,"mapPort":4174,"x":"${'a'.repeat(2000)}"}`), '过大'],
  ])('响应%s时失败且不保留旧端口', async (_label, make, message) => {
    setRuntimeEndpoints(undefined)
    await expect(loadRuntimeEndpoints((async () => make()) as unknown as typeof fetch)).rejects.toThrow(message)
    expect(runtimeEndpoints()).toBeUndefined()
  })

  it('请求或响应体读取超过时限时中止，不连接旧服务', async () => {
    const hanging = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    await expect(loadRuntimeEndpoints(hanging as unknown as typeof fetch, 20)).rejects.toThrow('超时')
    const slowBody = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    }) as unknown as Response)
    await expect(loadRuntimeEndpoints(slowBody as unknown as typeof fetch, 20)).rejects.toThrow('超时')
    expect(runtimeEndpoints()).toBeUndefined()
  })

  it('按页面主机名与协议生成地址：不同主机各自连接，HTTPS 对应 WSS', () => {
    expect(serviceOrigin(4173, { protocol: 'http:', hostname: '192.168.1.18' })).toBe('http://192.168.1.18:4173')
    expect(serviceOrigin(4173, { protocol: 'http:', hostname: '192.168.1.20' })).toBe('http://192.168.1.20:4173')
    expect(serviceOrigin(4173, { protocol: 'http:', hostname: '127.0.0.1' })).toBe('http://127.0.0.1:4173')
    expect(serviceOrigin(4173, { protocol: 'https:', hostname: '192.168.1.18' })).toBe('https://192.168.1.18:4173')
  })

  it('加载后 REST、WebSocket 与地图均使用当前页面主机名和配置端口', () => {
    setRuntimeEndpoints({ apiPort: 6001, mapPort: 6002 })
    const host = window.location.hostname
    expect(resolveMockOrigin()).toBe(`http://${host}:6001`)
    expect(resolveRealtimeUrl('ADMIN')).toBe(`ws://${host}:6001/ws/v1?role=ADMIN`)
    expect(MAP_CONFIG.resources.vector.tileUrl).toBe(`http://${host}:6002/tiles/china-taiwan-260823/{z}/{x}/{y}`)
    expect(MAP_CONFIG.resources.satellite.tileUrl).toBe(`http://${host}:6002/tiles/taiwan-strait-satellite/{z}/{x}/{y}`)
    expect(MAP_CONFIG.resources.vector.tileUrl).not.toContain('4174')
  })

  it('生产页面未加载运行配置时拒绝回退到默认 4173/4174', () => {
    vi.stubEnv('PROD', true)
    vi.stubEnv('MODE', 'production')
    expect(() => resolveMockOrigin()).toThrow('运行配置尚未加载')
    expect(() => MAP_CONFIG.resources.vector.tileUrl).toThrow('运行配置尚未加载')
  })

  it('开发入口未加载运行配置时保持原有本机地址', () => {
    vi.stubEnv('VITE_MOCK_ORIGIN', '')
    expect(resolveMockOrigin()).toBe('http://127.0.0.1:4173')
    expect(MAP_CONFIG.resources.vector.tileUrl).toBe('http://127.0.0.1:4174/tiles/china-taiwan-260823/{z}/{x}/{y}')
  })
})
