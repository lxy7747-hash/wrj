// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
const { readEngineConfig } = await import('../../server/local/' + 'engine-config.js')

afterEach(() => vi.unstubAllEnvs())

it('未配置时默认使用真实引擎，不意外启用模拟数据', () => {
  expect(readEngineConfig({})).toEqual({ useRealEngine: true, realUrl: 'ws://192.168.1.48:8080/ws/v1', mockIntervalMs: 5000 })
})

it('从已加载的环境变量读取原三个字段，false 字符串不被当成 true', () => {
  vi.stubEnv('useRealEngine', ' false ')
  vi.stubEnv('realUrl', ' wss://example.test/ws/v1 ')
  vi.stubEnv('mockIntervalMs', ' 2000 ')
  expect(readEngineConfig()).toEqual({ useRealEngine: false, realUrl: 'wss://example.test/ws/v1', mockIntervalMs: 2000 })
  expect(readEngineConfig({ useRealEngine: 'true' }).useRealEngine).toBe(true)
})

it.each(['yes', '0', 'flase'])('拒绝错误开关 %s', value => {
  expect(() => readEngineConfig({ useRealEngine: value })).toThrow('useRealEngine')
})

it.each(['99', '-1', 'abc', 'Infinity', '2147483648'])('拒绝无效推送间隔 %s', value => {
  expect(() => readEngineConfig({ mockIntervalMs: value })).toThrow('mockIntervalMs')
})

it.each(['http://example.test/ws', 'ws://', 'ws://user:password@example.test/ws'])('保留 WebSocket 地址校验 %s', value => {
  expect(() => readEngineConfig({ realUrl: value })).toThrow('realUrl')
})
