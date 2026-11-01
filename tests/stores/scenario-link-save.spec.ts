import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ApiErrorCode, ApiFailure, ApiSuccess, InformationDemand, Link, Principal, ScenarioConfig, ScenarioDraft } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'

const META = { requestId: 'REQ-LINK-SAVE', generatedAt: '2026-10-29T00:00:00Z', page: 1, pageSize: 1, total: 1 }
const OPERATOR: Principal = { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'] }

function draft(revision = 4): ScenarioDraft {
  const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
  config.jammers.push({ ...config.jammers[0]!, id: 'JAM-SPOT-01-TX', type: 'SPOT', autoDetect: false })
  config.platforms.find(platform => platform.id === 'STN-01')!.jammerIds.push('JAM-SPOT-01-TX')
  return {
    config,
    uiExtensions: {
      jammers: [
        { jammerId: 'JAM-WB-01-TX', direction: 360, duration: 120, enabled: true },
        { jammerId: 'JAM-SPOT-01-TX', direction: 45, duration: 60, enabled: false },
      ],
      sensors: [{ sensorId: 'ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true }],
    },
    revision,
    officialLibraryChanged: false,
    locked: false,
  }
}

function success<T>(data: T): ApiSuccess<T> { return { ok: true, data, meta: META } }
function failure(code: ApiErrorCode, message = '保存失败。'): ApiFailure {
  return { ok: false, error: { code, message, retryable: false, correlationId: 'CORR-LINK-SAVE' }, meta: META }
}
function response(payload: unknown, ok = true, status = 200): Response {
  return { ok, status, json: vi.fn().mockResolvedValue(clone(payload)) } as unknown as Response
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function enableWrite(): void {
  useAuthStore().$patch({ principal: OPERATOR, role: OPERATOR.role, permissions: [...OPERATOR.permissions] })
}
async function loadSaved(store: ReturnType<typeof useScenarioStore>, fetchSpy: ReturnType<typeof vi.fn>, saved = draft()): Promise<ScenarioDraft> {
  fetchSpy.mockResolvedValueOnce(response(success(clone(saved))))
  expect(await store.loadScenario()).toBe(true)
  return clone(saved)
}

describe('场景链路独立保存', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    enableWrite()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStorage.clear()
  })

  it('只提交服务端快照中的目标链路和业务，并保留其他本地草稿修改', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const store = useScenarioStore()
    const saved = await loadSaved(store, fetchSpy)
    const target = store.draft!.config.links.find(link => link.id === 'L-MW-01')!
    const other = store.draft!.config.links.find(link => link.id === 'L-DL-03')!
    const demand = store.draft!.config.informationDemand[0]!
    store.draft!.config.scenario.name = '仅本地的场景名称'
    store.draft!.config.scenario.duration = NaN
    other.txPower = 987
    store.markDirty()
    const editedLink: Link = { ...target, frequency: target.frequency + 10, txPower: target.txPower + 1 }
    const editedDemand: InformationDemand = {
      ...demand, linkId: editedLink.id, volumeMb: demand.volumeMb + 1,
      sourcePlatformId: editedLink.sourcePlatformId, destinationPlatformIds: [editedLink.targetPlatformId], direction: editedLink.direction,
    }
    const savedResponse = draft(5)
    savedResponse.config.links = savedResponse.config.links.map(link => link.id === editedLink.id ? clone(editedLink) : link)
    savedResponse.config.informationDemand = savedResponse.config.informationDemand.map(item => item.id === editedDemand.id ? clone(editedDemand) : item)
    fetchSpy.mockResolvedValueOnce(response(success(clone(saved)))).mockResolvedValueOnce(response(success(savedResponse)))

    await expect(store.saveLink(editedLink, editedDemand)).resolves.toBe(true)

    expect(fetchSpy.mock.calls[1]![0]).toBe('http://127.0.0.1:4173/api/v1/scenarios/SCN-001')
    const submitted = JSON.parse(fetchSpy.mock.calls[2]![1].body as string)
    expect(submitted).toMatchObject({ expectedRevision: 4, config: { scenario: { name: saved.config.scenario.name } } })
    expect(submitted.config.links.find((link: Link) => link.id === editedLink.id)).toEqual(editedLink)
    expect(submitted.config.informationDemand.find((item: InformationDemand) => item.id === editedDemand.id)).toEqual(editedDemand)
    expect(submitted.config.links.find((link: Link) => link.id === other.id).txPower).toBe(saved.config.links.find(link => link.id === other.id)!.txPower)
    expect(store.draft!.config.scenario.name).toBe('仅本地的场景名称')
    expect(store.draft!.config.scenario.duration).toBeNaN()
    expect(submitted.config.scenario.duration).toBe(saved.config.scenario.duration)
    expect(store.draft!.config.links.find(link => link.id === other.id)!.txPower).toBe(987)
    expect(store.draft!.config.links.find(link => link.id === editedLink.id)).toEqual(editedLink)
    expect(store.draft!.config.informationDemand.find(item => item.id === editedDemand.id)).toEqual(editedDemand)
    expect(store).toMatchObject({ dirty: true, draft: { revision: 5 } })
  })

  it('新增链路时更新两端 linkIds，且仅有此改动时清除 dirty', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const store = useScenarioStore()
    const saved = await loadSaved(store, fetchSpy)
    const source = saved.config.links.find(link => link.id === 'L-MW-01')!
    const addedLink: Link = { ...source, id: 'L-DL-NEW' }
    const demand: InformationDemand = {
      ...saved.config.informationDemand[0]!, linkId: addedLink.id,
      sourcePlatformId: addedLink.sourcePlatformId, destinationPlatformIds: [addedLink.targetPlatformId], direction: addedLink.direction,
    }
    const savedResponse = draft(5)
    savedResponse.config.links.push(clone(addedLink))
    savedResponse.config.informationDemand = savedResponse.config.informationDemand.map(item => item.id === demand.id ? clone(demand) : item)
    for (const platformId of [addedLink.sourcePlatformId, addedLink.targetPlatformId]) {
      savedResponse.config.platforms.find(item => item.id === platformId)!.linkIds.push(addedLink.id)
    }
    fetchSpy.mockResolvedValueOnce(response(success(clone(saved)))).mockResolvedValueOnce(response(success(savedResponse)))

    expect(await store.saveLink(addedLink, demand), store.resultMessage).toBe(true)

    const submitted = JSON.parse(fetchSpy.mock.calls[2]![1].body as string)
    for (const platformId of [addedLink.sourcePlatformId, addedLink.targetPlatformId]) {
      expect(submitted.config.platforms.find((item: { id: string }) => item.id === platformId).linkIds).toContain(addedLink.id)
      expect(store.draft!.config.platforms.find(item => item.id === platformId)!.linkIds).toContain(addedLink.id)
    }
    expect(store).toMatchObject({ dirty: false, draft: { revision: 5 } })
  })

  it('新场景不访问网络；未保存节点经快照确认后不发 PUT；锁定和无权限均拒绝', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const store = useScenarioStore()
    expect(store.createScenario()).toBe(true)
    const sample = draft()
    expect(await store.saveLink(sample.config.links[0]!, sample.config.informationDemand[0]!)).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()

    store.resetToSafeEmpty()
    const saved = await loadSaved(store, fetchSpy)
    const newNodeLink = { ...saved.config.links[0]!, sourcePlatformId: 'PLATFORM-UNSAVED' }
    const newNodeDemand = { ...saved.config.informationDemand[0]!, sourcePlatformId: 'PLATFORM-UNSAVED' }
    fetchSpy.mockResolvedValueOnce(response(success(clone(saved))))
    await expect(store.saveLink(newNodeLink, newNodeDemand)).resolves.toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    store.projectRuntimeLock(saved.config.scenario.id, true)
    await expect(store.saveLink(saved.config.links[0]!, saved.config.informationDemand[0]!)).resolves.toBe(false)
    useAuthStore().$patch({ principal: null, permissions: [] })
    await expect(store.saveLink(saved.config.links[0]!, saved.config.informationDemand[0]!)).resolves.toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['服务端读取失败', 'read', 'INTERNAL_ERROR'],
    ['CAS 版本冲突', 'revision', 'VERSION_CONFLICT'],
    ['服务端写入失败', 'write', 'VERSION_CONFLICT'],
  ] as const)('%s不污染本地草稿', async (_name, phase, code) => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const store = useScenarioStore()
    const saved = await loadSaved(store, fetchSpy)
    const before = clone(store.draft!)
    const editedLink = { ...saved.config.links[0]!, txPower: saved.config.links[0]!.txPower + 1 }
    const editedDemand = {
      ...saved.config.informationDemand[0]!, linkId: editedLink.id,
      sourcePlatformId: editedLink.sourcePlatformId, destinationPlatformIds: [editedLink.targetPlatformId], direction: editedLink.direction,
    }
    if (phase === 'read') fetchSpy.mockResolvedValueOnce(response(failure(code), false, 500))
    else if (phase === 'revision') fetchSpy.mockResolvedValueOnce(response(success(draft(5))))
    else fetchSpy.mockResolvedValueOnce(response(success(clone(saved)))).mockResolvedValueOnce(response(failure(code), false, 409))

    await expect(store.saveLink(editedLink, editedDemand)).resolves.toBe(false)

    expect(store.draft).toEqual(before)
    expect(store.dirty).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(phase === 'write' ? 3 : 2)
  })

  it('中止在途 GET 后不发 PUT，也不接收迟到快照', async () => {
    const lateGet = deferred<Response>()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const store = useScenarioStore()
    const saved = await loadSaved(store, fetchSpy)
    const controller = new AbortController()
    const link = { ...saved.config.links[0]! }
    const demand = { ...saved.config.informationDemand[0]! }
    const before = clone(store.draft!)
    fetchSpy.mockReturnValueOnce(lateGet.promise)

    const pending = store.saveLink(link, demand, link.id, controller.signal)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    controller.abort()
    lateGet.resolve(response(success(clone(saved))))

    await expect(pending).resolves.toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(store.draft).toEqual(before)
  })

  it('全局重置后丢弃延迟 PUT 响应', async () => {
    const latePut = deferred<Response>()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const store = useScenarioStore()
    const saved = await loadSaved(store, fetchSpy)
    const editedLink = { ...saved.config.links[0]!, txPower: saved.config.links[0]!.txPower + 1 }
    const editedDemand = {
      ...saved.config.informationDemand[0]!, linkId: editedLink.id,
      sourcePlatformId: editedLink.sourcePlatformId, destinationPlatformIds: [editedLink.targetPlatformId], direction: editedLink.direction,
    }
    const savedResponse = draft(5)
    savedResponse.config.links = savedResponse.config.links.map(link => link.id === editedLink.id ? editedLink : link)
    savedResponse.config.informationDemand = savedResponse.config.informationDemand.map(item => item.id === editedDemand.id ? editedDemand : item)
    fetchSpy.mockResolvedValueOnce(response(success(clone(saved)))).mockReturnValueOnce(latePut.promise)

    const pending = store.saveLink(editedLink, editedDemand)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(3))
    store.resetToSafeEmpty()
    latePut.resolve(response(success(savedResponse)))

    await expect(pending).resolves.toBe(false)
    expect(store.$state).toMatchObject({ draft: null, currentScenarioId: null, dirty: false, panelState: 'EMPTY', resultCode: 'EMPTY' })
  })
})
