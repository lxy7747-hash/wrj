import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'

const SAMPLE_NAMES = ['fream001', 'fream_chenge1', 'fream_chenge2', 'fream_chenge3'] as const

function loadSamples(): Array<Record<string, unknown>> {
  return SAMPLE_NAMES.map(name => JSON.parse(readFileSync(
    new URL(`../../tests/fixtures/engine-frame/websocket-new/${name}.json`, import.meta.url), 'utf8',
  )) as Record<string, unknown>)
}

export interface MockEngine {
  url: string
  close(): Promise<void>
}

/**
 * 进程内假引擎，仅用于开发联调，不是生产数据源。
 *
 * 行为与外部引擎对齐：
 * - 地址 ws://127.0.0.1:<随机端口>/ws/v1，端口由系统分配，避免与本机服务冲突；
 * - 连接即推送，不需要登录或订阅；
 * - 循环 tests/fixtures/engine-frame/websocket-new 四份样例，帧号重排为 5/10/15…；
 * - 不再发送 sim_time_s，帧号即仿真秒数，wall_time_ms 用当前墙钟；
 * - 接收 {"msg_type":"sim_control","action":"pause|resume|stop"}，暂停/恢复推送。
 */
export async function startMockEngine(intervalMs: number): Promise<MockEngine> {
  const samples = loadSamples()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws/v1' })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  server.on('connection', socket => {
    let tick = 0
    let paused = false
    const sendNext = (): void => {
      if (paused) return
      tick += 1
      const { sim_time_s: _legacyTime, ...sample } = samples[(tick - 1) % samples.length]!
      socket.send(JSON.stringify({ ...sample, frame_id: tick * 5, wall_time_ms: Date.now() }))
    }
    const timer = setInterval(sendNext, intervalMs)
    sendNext()
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString()) as { msg_type?: string; action?: string }
        if (message.msg_type !== 'sim_control') return
        if (message.action === 'pause' || message.action === 'stop') paused = true
        else if (message.action === 'resume') paused = false
      } catch { /* 非 JSON 控制消息忽略。 */ }
    })
    socket.on('close', () => clearInterval(timer))
    socket.on('error', () => clearInterval(timer))
  })
  return {
    url: `ws://127.0.0.1:${port}/ws/v1`,
    close: () => new Promise<void>(resolve => {
      for (const client of server.clients) client.terminate()
      server.close(() => resolve())
    }),
  }
}
