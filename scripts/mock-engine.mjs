/**
 * 本地模拟外部引擎：把 tests/fixtures/engine-frame/websocket-new 的四份样例
 * 按 5 秒一帧循环推送，用于引擎不可达时联调 LINK_ENGINE_WS_URL。
 *
 *   node scripts/mock-engine.mjs                 # ws://127.0.0.1:9300/ws/v1
 *   MOCK_ENGINE_PORT=9301 node scripts/mock-engine.mjs
 *   MOCK_ENGINE_INTERVAL_MS=1000 node scripts/mock-engine.mjs
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const port = Number(process.env.MOCK_ENGINE_PORT ?? 9300)
const intervalMs = Number(process.env.MOCK_ENGINE_INTERVAL_MS ?? 5000)
const path = '/ws/v1'
const samples = ['fream001', 'fream_chenge1', 'fream_chenge2', 'fream_chenge3'].map(name =>
  JSON.parse(readFileSync(new URL(`../tests/fixtures/engine-frame/websocket-new/${name}.json`, import.meta.url), 'utf8')))

const http = createServer((_req, res) => res.writeHead(404).end())
const engine = new WebSocketServer({ server: http, path })

engine.on('connection', (socket, request) => {
  let tick = 0
  let paused = false
  console.log(`[mock-engine] 客户端已连接：${request.socket.remoteAddress}`)
  const sendNext = () => {
    if (paused) return
    tick += 1
    const { sim_time_s: _legacyTime, ...sample } = samples[(tick - 1) % samples.length]
    socket.send(JSON.stringify({ ...sample, frame_id: tick * 5, wall_time_ms: Date.now() }))
    console.log(`[mock-engine] 推送 frame_id=${tick * 5}`)
  }
  const timer = setInterval(sendNext, intervalMs)
  sendNext()
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString())
      console.log(`[mock-engine] 收到：${JSON.stringify(message)}`)
      if (message.msg_type === 'sim_control') {
        if (message.action === 'pause' || message.action === 'stop') paused = true
        else if (message.action === 'resume') paused = false
      }
    } catch { console.log(`[mock-engine] 非 JSON 消息`) }
  })
  socket.on('close', () => { clearInterval(timer); console.log('[mock-engine] 客户端已断开') })
  socket.on('error', () => clearInterval(timer))
})

http.listen(port, '127.0.0.1', () => console.log(`[mock-engine] 监听 ws://127.0.0.1:${port}${path}，每 ${intervalMs} ms 一帧`))
