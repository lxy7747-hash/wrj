import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WsConnectionIndicator from '../../src/components/situation/WsConnectionIndicator.vue'
import { useTelemetryStore } from '../../src/stores/telemetry'

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  private listeners = new Map<string, Array<(event?: unknown) => void>>()
  constructor(public url: string) { FakeWebSocket.instances.push(this) }
  addEventListener(type: string, cb: (event?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
  }
  send(data: string) { this.sent.push(data) }
  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close')
  }
  emit(type: string, event?: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(event)
  }
  openAndSubscribe(lastSequence = 1) {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open')
    const sub = JSON.parse(this.sent[0]!)
    this.emit('message', {
      data: JSON.stringify({
        type: 'subscribed',
        schemaVersion: '1.0',
        taskId: sub.taskId,
        topics: sub.topics,
        lastSequence,
        nextSequence: lastSequence + 1,
      }),
    })
  }
}

describe('WebSocket 连接状态指示与断连恢复面板', () => {
  afterEach(() => {
    FakeWebSocket.instances = []
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('区分待连接与运行中断开，展示最近业务消息头流水、一键重连与续传序号记录', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
    const warnSpy = vi.spyOn(ElMessage, 'warning').mockImplementation(() => ({ close() {} }) as never)
    const errorSpy = vi.spyOn(ElMessage, 'error').mockImplementation(() => ({ close() {} }) as never)
    const successSpy = vi.spyOn(ElMessage, 'success').mockImplementation(() => ({ close() {} }) as never)

    const telemetry = useTelemetryStore()
    const wrapper = mount(WsConnectionIndicator, {
      props: { simulationActive: false },
      global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } },
    })
    try {
      const pill = () => wrapper.get('[data-testid="ws-connection-pill"]')
      // 未启动仿真前显示“待连接”，不出现快捷重连按钮
      expect(pill().text()).toBe('WS 待连接')
      expect(pill().classes()).toContain('ws-pill--muted')
      expect(wrapper.find('[data-testid="ws-quick-reconnect"]').exists()).toBe(false)

      // 启动仿真并首次连接，不触发恢复提示
      await wrapper.setProps({ simulationActive: true } as never)
      telemetry.connect()
      await flushPromises()
      expect(pill().text()).toBe('WS 连接中')
      FakeWebSocket.instances[0]!.openAndSubscribe(5)
      await flushPromises()
      expect(pill().text()).toBe('WS 已连接')
      expect(pill().classes()).toContain('ws-pill--success')
      expect(successSpy).not.toHaveBeenCalled()

      // 模拟收到连续 3 条业务消息头
      telemetry.topicSequences['link.metric'] = 12
      telemetry.recentMessageHeaders = [
        { topic: 'link.metric', type: 'event', schemaVersion: '1.0', taskId: 'TASK-001', sequence: 12, simulationTime: 45, receivedAt: '13:45:02' },
        { topic: 'link.metric', type: 'event', schemaVersion: '1.0', taskId: 'TASK-001', sequence: 11, simulationTime: 44, receivedAt: '13:45:01' },
        { topic: 'link.metric', type: 'event', schemaVersion: '1.0', taskId: 'TASK-001', sequence: 10, simulationTime: 43, receivedAt: '13:45:00' },
      ]
      await flushPromises()
      const stream = wrapper.get('[data-testid="ws-recent-headers"]')
      expect(wrapper.get('[data-testid="ws-connection-panel"]').text()).not.toContain('ws://')
      expect(stream.text()).toContain('link.metric')
      expect(stream.text()).toContain('#10')
      expect(stream.text()).toContain('#11')
      expect(stream.text()).toContain('#12')
      expect(stream.text()).toContain('v1.0')
      expect(wrapper.get('[data-testid="ws-topic-sequences"]').text()).toContain('#12')

      // 手动断开连接：运行中断开变红、露出顶栏快捷“重连”按钮、保留序号与记录
      await wrapper.get('[data-testid="ws-disconnect-btn"]').trigger('click')
      await flushPromises()
      expect(pill().text()).toBe('WS 已断开')
      expect(pill().classes()).toContain('ws-pill--danger')
      expect(wrapper.find('[data-testid="ws-quick-reconnect"]').exists()).toBe(true)
      expect(telemetry.topicSequences['link.metric']).toBe(12)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(wrapper.get('[data-testid="ws-connection-history"]').text()).toContain('停在序号 #12')

      // 直接点顶栏快捷“重连”按钮恢复：携带原序号续传并在记录里体现断前→当前序号
      await wrapper.get('[data-testid="ws-quick-reconnect"]').trigger('click')
      await flushPromises()
      expect(FakeWebSocket.instances).toHaveLength(2)
      FakeWebSocket.instances[1]!.openAndSubscribe(15)
      await flushPromises()
      const resumeMsg = JSON.parse(FakeWebSocket.instances[1]!.sent[0]!)
      expect(resumeMsg.lastSequences['link.metric']).toBe(12)
      expect(pill().text()).toBe('WS 已连接')
      expect(wrapper.find('[data-testid="ws-quick-reconnect"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="ws-connection-history"]').text()).toContain('断前序号 #12 → 当前 #15')
      expect(successSpy).toHaveBeenCalledTimes(1)

      // 模拟被动中断 -> 重连中 -> 重连失败
      telemetry.retryAttemptCount = 2
      telemetry.connectionState = 'RETRYING'
      await flushPromises()
      expect(pill().text()).toBe('WS 重连中 #2')
      expect(pill().classes()).toContain('ws-pill--warning')
      expect(warnSpy).toHaveBeenCalledTimes(2)

      telemetry.connectionState = 'FAILED'
      await flushPromises()
      expect(pill().text()).toBe('WS 连接中断')
      expect(pill().classes()).toContain('ws-pill--danger')
      expect(wrapper.find('[data-testid="ws-quick-reconnect"]').exists()).toBe(true)
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      wrapper.unmount()
      telemetry.disconnectAndReset()
    }
  })

  it('切换订阅不弹断开和恢复提示，真实掉线仍提示并在重连后关闭旧警告', async () => {
    vi.useFakeTimers()
    const pinia = createPinia()
    setActivePinia(pinia)
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
    const dismissWarning = vi.fn()
    const warnSpy = vi.spyOn(ElMessage, 'warning').mockReturnValue({ close: dismissWarning })
    const successSpy = vi.spyOn(ElMessage, 'success').mockReturnValue({ close: vi.fn() })
    const telemetry = useTelemetryStore()
    const wrapper = mount(WsConnectionIndicator, {
      props: { simulationActive: true },
      global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } },
    })
    try {
      const latestSocket = () => FakeWebSocket.instances.at(-1)!
      const pill = () => wrapper.get('[data-testid="ws-connection-pill"]')
      telemetry.connect()
      latestSocket().openAndSubscribe()
      await flushPromises()
      expect(pill().text()).toBe('WS 已连接')

      telemetry.disconnectAndReset()
      await flushPromises()
      expect(pill().text()).toBe('WS 已断开')
      expect(warnSpy).not.toHaveBeenCalled()
      telemetry.connect()
      await flushPromises()
      expect(pill().text()).toBe('WS 连接中')
      latestSocket().openAndSubscribe()
      await flushPromises()
      expect(pill().text()).toBe('WS 已连接')
      expect(successSpy).not.toHaveBeenCalled()

      latestSocket().close()
      await flushPromises()
      expect(pill().text()).toBe('WS 重连中 #1')
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(dismissWarning).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(250)
      latestSocket().openAndSubscribe()
      await flushPromises()
      expect(pill().text()).toBe('WS 已连接')
      expect(successSpy).toHaveBeenCalledTimes(1)
      expect(dismissWarning).toHaveBeenCalledTimes(1)

      latestSocket().close()
      await flushPromises()
      expect(warnSpy).toHaveBeenCalledTimes(2)
      telemetry.disconnectAndReset()
      telemetry.connect()
      await flushPromises()
      latestSocket().openAndSubscribe()
      await flushPromises()
      expect(pill().text()).toBe('WS 已连接')
      expect(warnSpy).toHaveBeenCalledTimes(2)
      expect(successSpy).toHaveBeenCalledTimes(1)
      expect(dismissWarning).toHaveBeenCalledTimes(2)
    } finally {
      wrapper.unmount()
      telemetry.disconnectAndReset()
      vi.useRealTimers()
    }
  })
})
