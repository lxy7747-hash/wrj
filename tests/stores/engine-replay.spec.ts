import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useReplayStore } from '../../src/stores/replay'
import { useRuntimeQualityStore } from '../../src/stores/runtime-quality'
import { isEngineReplaySnapshot } from '../../src/features/replays/engine-replay'
import { isMissionResultSnapshot } from '../../src/features/results/mission-result'
import { ENGINE_RESULT, ENGINE_RESULT_ID, engineReplayAt } from '../fixtures/engine-frame/replay'
const success = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response
beforeEach(() => { setActivePinia(createPinia()); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })
afterEach(() => { useReplayStore().resetToSafeEmpty(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function source() {
  const fetch = vi.fn(async (url: string) => url.includes('/engine-replay?') ? success(engineReplayAt(Number(new URL(url).searchParams.get('time')))) : success(structuredClone(ENGINE_RESULT)))
  vi.stubGlobal('fetch', fetch); return fetch
}

it('历史质量、选路、告警随时间推进和回退，暂停冻结，不连接实时引擎', async () => {
  const fetch = source(), store = useReplayStore(), live = useRuntimeQualityStore()
  expect(isMissionResultSnapshot(ENGINE_RESULT)).toBe(true)
  expect(isEngineReplaySnapshot(engineReplayAt(10))).toBe(true)
  live.engineFrame = engineReplayAt(10).engineFrame
  const liveBefore = JSON.stringify(live.engineFrame)
  expect(await store.loadLocalFile(undefined, ENGINE_RESULT_ID)).toBe(true)
  expect(store.replay?.durationS).toBe(10)
  expect(store.engineHistory?.engineFrame).toBeNull()
  await store.play(); await vi.advanceTimersByTimeAsync(4000)
  expect(store.replay?.currentTimeS).toBe(4)
  expect(fetch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1000)
  expect(store.engineHistory?.engineFrame?.frameId).toBe(5)
  expect(fetch).toHaveBeenCalledTimes(3)
  await store.pause(); await vi.advanceTimersByTimeAsync(5000)
  expect(store.replay?.currentTimeS).toBe(5)
  await store.seek(10)
  expect(store.engineHistory?.engineAlarms[0]?.alarm.message).toBe('历史链路告警')
  expect(store.engineHistory?.engineSwitches.length).toBeGreaterThan(0)
  await store.seek(7)
  expect(store.engineHistory).toMatchObject({ engineFrame: { frameId: 5 }, engineAlarms: [], engineSwitches: [], engineEvents: [] })
  await store.seek(0)
  expect(store.engineHistory?.engineFrame).toBeNull()
  expect(JSON.stringify(live.engineFrame)).toBe(liveBefore)
  expect(fetch.mock.calls.every(([url]) => url.includes('/mission-results/'))).toBe(true)
})

it('拖动回退或暂停时迟到的历史请求不覆盖游标和当前帧', async () => {
  const fetch = source(), store = useReplayStore()
  await store.loadLocalFile(undefined, ENGINE_RESULT_ID); await store.seek(5)
  let finish!: (response: Response) => void
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const future = store.seek(10)
  await Promise.resolve()
  await store.seek(6)
  finish(success(engineReplayAt(10)))
  expect(await future).toBe(false)
  expect(store.replay?.currentTimeS).toBe(6)
  expect(store.engineHistory?.engineFrame?.frameId).toBe(5)
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = store.seek(10)
  await Promise.resolve(); await store.pause()
  finish(success(engineReplayAt(10)))
  expect(await pending).toBe(false)
  expect(store).toMatchObject({ state: 'PAUSED', replay: { currentTimeS: 6 } })
})

it('切换运行时清空旧历史，旧运行响应不能混入新运行', async () => {
  const fetch = source(), store = useReplayStore()
  await store.loadLocalFile(undefined, ENGINE_RESULT_ID)
  let finish!: (response: Response) => void
  fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = store.seek(10); await Promise.resolve()
  const nextId = 'RESULT-22222222-2222-4222-8222-222222222222', next = structuredClone(ENGINE_RESULT)
  Object.assign(next.record, { resultId: nextId, runId: 'RUN-SECOND' })
  fetch.mockResolvedValueOnce(success(next)).mockResolvedValueOnce(success(engineReplayAt(0, 'RUN-SECOND')))
  await store.loadLocalFile(undefined, nextId)
  finish(success(engineReplayAt(10))); await pending
  expect(store.engineHistory).toMatchObject({ runId: 'RUN-SECOND', engineFrame: null })
  expect(store.replay?.currentTimeS).toBe(0)
})

it('切换引擎轮次时暂停并归零，不沿用前一轮的质量和告警', async () => {
  const fetch = source(), store = useReplayStore()
  fetch.mockImplementation(async (url: string) => {
    if (!url.includes('/engine-replay?')) return success(structuredClone(ENGINE_RESULT))
    const params = new URL(url).searchParams, data = engineReplayAt(Number(params.get('time')))
    data.epochs.push({ engineEpoch: 1, frameCount: 2, firstTime: 5, lastTime: 10 }); data.frameCount = 4
    data.engineEpoch = Number(params.get('epoch') ?? 0)
    if (data.engineFrame) data.engineFrame.engineEpoch = data.engineEpoch
    return success(data)
  })
  await store.loadLocalFile(undefined, ENGINE_RESULT_ID); await store.seek(10); await store.play()
  expect(await store.selectEngineEpoch(1)).toBe(true)
  expect(store).toMatchObject({ state: 'PAUSED', replay: { currentTimeS: 0 }, engineHistory: { engineEpoch: 1, engineFrame: null, engineAlarms: [] } })
  await store.seek(5)
  expect(store.engineHistory!.engineFrame).toMatchObject({ engineEpoch: 1, frameId: 5 })
  expect(await store.selectEngineEpoch(99)).toBe(false)
})

it('历史查询错误或运行串线时清空旧质量并停止播放，旧文件无帧仍可回放', async () => {
  const fetch = source(), store = useReplayStore()
  await store.loadLocalFile(undefined, ENGINE_RESULT_ID)
  fetch.mockResolvedValueOnce(success(engineReplayAt(5, 'RUN-OTHER')))
  expect(await store.seek(5)).toBe(false)
  expect(store.engineHistory).toBeNull()
  expect(store.state).toBe('CORRUPT')
  fetch.mockResolvedValueOnce(success(ENGINE_RESULT)).mockResolvedValueOnce(success(null))
  expect(await store.loadLocalFile(undefined, ENGINE_RESULT_ID)).toBe(true)
  expect(store.engineResultId).toBeNull()
  expect(await store.play()).toBe(true)
  expect(store.replay?.durationS).toBe(3)
})
