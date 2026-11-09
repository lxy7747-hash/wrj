import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MissionConsoleLog from '../../src/components/situation/MissionConsoleLog.vue'
import { useTelemetryStore } from '../../src/stores/telemetry'
import type { RunId } from '../../src/contracts/domain-models'

const response = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response
const update = (text: string, startByteOffset: number, endByteOffset: number, chunkIndex = 0, chunkCount = 1, replace = false) => ({
  kind: 'MISSION_LOG' as const, runId: 'RUN-LOG' as RunId, text, replace, bytes: endByteOffset, truncated: false,
  startByteOffset, endByteOffset, chunkIndex, chunkCount,
})

beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

async function openWithSnapshots(...snapshots: Array<{ text: string; bytes: number; truncated: boolean; timeoutMs: null }>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(response(snapshots.shift()!))))
  const wrapper = mount(MissionConsoleLog, { props: { runId: 'RUN-LOG', running: true }, attachTo: document.body, global: { plugins: [ElementPlus] } })
  await wrapper.get('[data-testid="mission-console-open"]').trigger('click')
  await flushPromises()
  return wrapper
}

it('同步消费同一日志更新的所有 UTF-8 安全分块', async () => {
  const wrapper = await openWithSnapshots({ text: '前缀\n', bytes: 7, truncated: false, timeoutMs: null })
  const telemetry = useTelemetryStore()
  telemetry.missionLogUpdates = [update('第一', 7, 17, 0, 2)]
  telemetry.missionLogUpdates = [...telemetry.missionLogUpdates, update('🙂\n', 7, 17, 1, 2)]
  await flushPromises()
  expect(document.body.querySelector('[data-testid="mission-console-text"]')?.textContent).toBe('前缀\n第一🙂\n')
  wrapper.unmount()
})

it('HTTP与增量部分重叠时用新快照补偿而不重复附加；短日志 replace 始终生效', async () => {
  const wrapper = await openWithSnapshots(
    { text: '0123456789', bytes: 10, truncated: false, timeoutMs: null },
    { text: '0123456789ABCDEF', bytes: 16, truncated: false, timeoutMs: null },
  )
  const telemetry = useTelemetryStore()
  telemetry.missionLogUpdates = [update('89ABCDEF', 8, 16)]
  await new Promise(resolve => setTimeout(resolve, 80)); await flushPromises()
  expect(document.body.querySelector('[data-testid="mission-console-text"]')?.textContent).toBe('0123456789ABCDEF')
  telemetry.missionLogUpdates = [...telemetry.missionLogUpdates, update('新文件\n', 0, 10, 0, 1, true)]
  await flushPromises()
  expect(document.body.querySelector('[data-testid="mission-console-text"]')?.textContent).toBe('新文件\n')
  wrapper.unmount()
})

it('运行轮转后的 replace 会作废在途旧 HTTP 快照', async () => {
  let resolveOld!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { resolveOld = resolve })))
  const wrapper = mount(MissionConsoleLog, { props: { runId: 'RUN-LOG', running: true }, attachTo: document.body, global: { plugins: [ElementPlus] } })
  await wrapper.get('[data-testid="mission-console-open"]').trigger('click')
  const telemetry = useTelemetryStore()
  telemetry.missionLogUpdates = [update('新轮转日志\n', 0, 16, 0, 1, true)]
  await flushPromises()
  resolveOld(response({ text: '过期大文件', bytes: 999, truncated: true, timeoutMs: null }))
  await flushPromises()
  expect(document.body.querySelector('[data-testid="mission-console-text"]')?.textContent).toBe('新轮转日志\n')
  wrapper.unmount()
})

it('首次HTTP尚无基线时，带缺口的WS增量等待一次完整快照而不冒充全量日志', async () => {
  let resolveOld!: (value: Response) => void
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve }))
    .mockResolvedValueOnce(response({ text: '初始\n追加\n', bytes: 14, truncated: false, timeoutMs: null }))
  vi.stubGlobal('fetch', fetcher)
  const wrapper = mount(MissionConsoleLog, { props: { runId: 'RUN-LOG', running: true }, attachTo: document.body, global: { plugins: [ElementPlus] } })
  await wrapper.get('[data-testid="mission-console-open"]').trigger('click')
  const telemetry = useTelemetryStore()
  telemetry.missionLogUpdates = [update('追加\n', 7, 14)]
  await flushPromises()
  expect(document.body.querySelector('[data-testid="mission-console-text"]')?.textContent).toBe('初始\n追加\n')
  resolveOld(response({ text: '过期\n', bytes: 7, truncated: false, timeoutMs: null }))
  await flushPromises()
  expect(document.body.querySelector('[data-testid="mission-console-text"]')?.textContent).toBe('初始\n追加\n')
  wrapper.unmount()
})
