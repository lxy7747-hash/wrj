// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
import type { FileDeviceEvent } from '../../src/features/situation/file-device-events'

// 真实数据冒烟：读取 .env.local 的 AFSIM_EVENT_LOG_PATH，只验证跨版本应保持的不变量，
// 不硬编码绝对路径、不断言具体消息计数；其他机器无配置时整体跳过。
// 模块路径用拼接变量，避免 tsc 把服务端 node 代码拉进浏览器 app 项目编译图（与既有服务端测试一致）。
const fsModule = 'node:fs/' + 'promises'
const readerModule = '../../server/local/' + 'afsim-log-reader.js'
const eventPath = await (async () => {
  try {
    const { readFile } = await import(fsModule)
    return (await readFile('.env.local', 'utf8')).match(/^AFSIM_EVENT_LOG_PATH=(.+)$/m)?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
})()

async function loadReal() {
  const { readFile } = await import(fsModule)
  const { readInitialNodes } = await import(readerModule)
  const text = await readFile(eventPath, 'utf8')
  return { parsed: parseAfsimEventLog(text), snapshot: await readInitialNodes(eventPath) }
}

describe('真实数据冒烟（需 .env.local 配置 AFSIM_EVENT_LOG_PATH）', () => {
  it.skipIf(!eventPath)('事件日志解析有效、初始快照结构不变量成立', async () => {
    const { parsed, snapshot } = await loadReal()
    expect(parsed.valid).toBe(true)
    expect(parsed.nodes.length).toBeGreaterThan(0)
    for (const node of parsed.nodes) {
      expect(node.initialState, `节点 ${node.name} 缺少初始位置`).not.toBeNull()
    }
    expect(snapshot.nodes).toHaveLength(parsed.nodes.length)
    const connections = snapshot.connections ?? []
    expect(connections.length).toBeGreaterThan(0)
    for (const connection of connections) {
      expect(connection.source.platformName).not.toBe(connection.target.platformName)
      expect(connection.sourceType.trim()).not.toBe('')
      expect(connection.targetType.trim()).not.toBe('')
    }
  })

  it.skipIf(!eventPath)('WEAPON_TURNED_OFF 必须提取为 JAMMING 关闭，不继承频率/带宽', async () => {
    const { parsed, snapshot } = await loadReal()
    const deviceEvents: FileDeviceEvent[] = snapshot.deviceEvents ?? []
    const stops = parsed.events.filter(event => event.type === 'WEAPON_TURNED_OFF'
      && event.fields.system_type === 'WSF_RF_JAMMER')
    for (const stop of stops) {
      const state = deviceEvents.find(event => event.kind === 'JAMMING' && !event.active
        && event.platformId === stop.subject && event.time === stop.time)
      expect(state, `WEAPON_TURNED_OFF ${stop.subject}@${stop.time} 未提取为 JAMMING 关闭`).toBeDefined()
      expect(state?.frequencyHz).toBeUndefined()
      expect(state?.bandwidthHz).toBeUndefined()
    }
  })
})
