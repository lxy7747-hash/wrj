/**
 * 本地模拟外部引擎：读取 scripts/websocketData/frame_snap.txt，
 * 按 5 秒一帧顺序推送原始报文，播完停发，用于引擎不可达时联调 LINK_ENGINE_WS_URL。
 *
 *   node scripts/mock-engine.mjs                 # ws://127.0.0.1:9300/ws/v1
 *   MOCK_ENGINE_PORT=9301 node scripts/mock-engine.mjs
 *   MOCK_ENGINE_INTERVAL_MS=1000 node scripts/mock-engine.mjs
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { readMockFrames } from './websocketData/read-frames.mjs'

const port = Number(process.env.MOCK_ENGINE_PORT ?? 9300)
const intervalMs = Number(process.env.MOCK_ENGINE_INTERVAL_MS ?? 5000)
const path = '/ws/v1'
const samples = readMockFrames()

const http = createServer((_req, res) => res.writeHead(404).end())
const engine = new WebSocketServer({ server: http, path })

engine.on('connection', (socket, request) => {
  let tick = 0
  let paused = false
  let stopped = false
  console.log(`[mock-engine] 客户端已连接：${request.socket.remoteAddress}`)
  const sendNext = () => {
    if (paused || stopped || tick >= samples.length) return
    const sample = samples[tick++]
    socket.send(JSON.stringify(sample))
    console.log(`[mock-engine] 推送 frame_id=${sample.frame_id}`)
    if (tick === samples.length) clearInterval(timer)
  }
  const timer = setInterval(sendNext, intervalMs)
  sendNext()
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString())
      console.log(`[mock-engine] 收到：${JSON.stringify(message)}`)
      if (message.msg_type === 'sim_control') {
        if (stopped) return
        if (message.action === 'stop') { stopped = true; clearInterval(timer) }
        else if (message.action === 'pause') paused = true
        else if (message.action === 'resume') paused = false
      }
    } catch { console.log(`[mock-engine] 非 JSON 消息`) }
  })
  socket.on('close', () => { clearInterval(timer); console.log('[mock-engine] 客户端已断开') })
  socket.on('error', () => clearInterval(timer))
})

http.listen(port, '127.0.0.1', () => console.log(`[mock-engine] 监听 ws://127.0.0.1:${port}${path}，每 ${intervalMs} ms 一帧`))
