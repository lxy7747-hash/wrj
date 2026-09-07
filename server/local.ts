import { loadEnvFile } from 'node:process'
import { createMockServer } from './app.js'
import { readInitialNodes } from './local/afsim-log-reader.js'
import { createPositionReader } from './local/afsim-position-reader.js'
import { readLocalReplay } from './local/afsim-replay-reader.js'

// 本机文件配置与纯 Mock 入口分离；路径只存于忽略的 .env.local，不写入共享代码。
try {
  loadEnvFile('.env.local')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
const port = Number(process.env.MOCK_PORT ?? '4173')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError('MOCK_PORT 必须为有效端口号。')
const logPath = process.env.AFSIM_EVENT_LOG_PATH?.trim()
const positionPath = process.env.AFSIM_POSITION_LOG_PATH?.trim()
const server = createMockServer({
  port,
  loadInitialNodes: logPath ? () => readInitialNodes(logPath) : undefined,
  loadPositions: logPath && positionPath ? createPositionReader(positionPath) : undefined,
  loadLocalReplay: logPath ? () => readLocalReplay(logPath, positionPath) : undefined,
})
server.httpServer.once('listening', () => {
  console.log(`本机接口已启动：http://127.0.0.1:${port}；初始位置来源：${logPath ? '真实日志' : 'Mock'}`)
})
