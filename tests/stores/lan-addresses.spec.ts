import { afterEach, expect, it, vi } from 'vitest'
import { resolveMockOrigin } from '../../src/stores/auth'
import { resolveRealtimeUrl } from '../../src/stores/telemetry'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

it('内网发布使用页面同源地址，不被开发机的 VITE_MOCK_ORIGIN 覆盖', () => {
  vi.stubEnv('MODE', 'lan')
  vi.stubEnv('VITE_MOCK_ORIGIN', 'http://127.0.0.1:4173')
  expect(resolveMockOrigin()).toBe(window.location.origin)
})

it('内网地图地址不包含客户端 localhost，开发模式继续使用原地图服务', async () => {
  vi.stubEnv('MODE', 'lan')
  const deployed = (await import('../../src/config/map.config')).MAP_CONFIG
  expect(deployed.resources.vector.tileUrl).toBe('/tiles/china-taiwan-260823/{z}/{x}/{y}')
  expect(deployed.resources.satellite.tileUrl).toBe('/tiles/taiwan-strait-satellite/{z}/{x}/{y}')
  vi.resetModules()
  vi.stubEnv('MODE', 'development')
  const local = (await import('../../src/config/map.config')).MAP_CONFIG
  expect(local.resources.vector.tileUrl).toContain('http://127.0.0.1:4174/')
  expect(resolveMockOrigin()).toBe('http://127.0.0.1:4173')
})

it('开发模式使用本机 REST、WS 和地图服务', async () => {
  vi.stubEnv('MODE', 'development')
  vi.stubEnv('VITE_MOCK_ORIGIN', '')
  expect(resolveMockOrigin()).toBe('http://127.0.0.1:4173')
  expect(resolveRealtimeUrl('OPERATOR')).toBe('ws://127.0.0.1:4173/ws/v1?role=OPERATOR')
  const map = (await import('../../src/config/map.config')).MAP_CONFIG
  expect(map.resources.vector.tileUrl).toContain('http://127.0.0.1:4174/tiles/')
  expect(map.resources.satellite.tileUrl).toContain('http://127.0.0.1:4174/tiles/')
})
