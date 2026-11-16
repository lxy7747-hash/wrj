import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { readMockFrames } from '../../scripts/websocketData/read-frames.mjs'

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
 * - 顺序读取 scripts/websocketData/frame_snap.txt，保留原始报文及帧号，文件末尾停发；
 * - 每次新连接从文件第一帧开始，不用日志前缀改写仿真时间或补造计时字段；
 * - 接收 {"msg_type":"sim_control","action":"pause|resume|stop"}，暂停/恢复推送。
 */
export async function startMockEngine(intervalMs: number): Promise<MockEngine> {
  const samples = readMockFrames()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws/v1' })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  server.on('connection', socket => {
    let tick = 0
    let paused = false
    let stopped = false
    const sendNext = (): void => {
      if (paused || stopped || tick >= samples.length) return
      socket.send(JSON.stringify(samples[tick++]!))
      if (tick === samples.length) clearInterval(timer)
    }
    const timer = setInterval(sendNext, intervalMs)
    sendNext()
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString()) as { msg_type?: string; action?: string }
        if (message.msg_type !== 'sim_control') return
        if (stopped) return
        if (message.action === 'stop') { stopped = true; clearInterval(timer) }
        else if (message.action === 'pause') paused = true
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
