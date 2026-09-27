import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRaw } from 'vue'
import LocalSceneImport from '../../src/components/scenarios/LocalSceneImport.vue'
import { buildLocalSceneImport, localImportLinks, type LocalSceneImport as ImportInput } from '../../src/features/scenarios/local-scene-import'
import type { ScenarioConfig, ScenarioDraft } from '../../src/contracts/domain-models'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'

type ProjectionResult = { ok: true; data: ScenarioDraft } | { ok: false; message: string }
let ScenarioProjection: new () => { get(id: string): ProjectionResult; save(id: string, value: unknown): ProjectionResult }
beforeAll(async () => {
  // 与现有服务端测试一致，动态加载 Node 模块，不把它纳入浏览器 TS 工程。
  const modulePath = '../../server/scenarios/projection.ts'
  ;({ ScenarioProjection } = await import(modulePath))
})

function source(): ImportInput {
  const node = { name: '文件无人机', type: 'Drone_MISSION_AIRCRAFT', longitude: 118.7, latitude: 25.1, altitude: 4000, speed: 12, time: 0, sourceEventId: 'LOG-1' }
  const initial = { fileName: 'j_1.csv', sha256: 'a'.repeat(64), nodes: [
    { ...node, platformId: 'FILE-A' }, { ...node, platformId: 'FILE-B', sourceEventId: 'LOG-2' },
  ], connections: [{ sourceEventId: 'LOG-3', time: 0, scope: 'INTER_PLATFORM' as const,
    source: { platformName: 'FILE-A', communicationName: 'MW-A', address: '1.1' },
    target: { platformName: 'FILE-B', communicationName: 'MW-B', address: '1.2' }, sourceType: 'microwave', targetType: 'microwave' }] }
  return { initial,
    positions: { fileName: 'platform_positions.csv', generation: 1, nodes: [{ ...node, platformId: 'FILE-A', time: 5, longitude: 118.9, heading: 90 }], recordCount: 1, issueCount: 0, issues: [], waitingForLine: false, hasMore: false },
    nodes: initial.nodes.map(n => ({ sourceId: n.platformId, targetId: n.platformId, type: 'AIRBORNE_MISSION_CLUSTER', selected: true, useLatest: false })),
    links: [{ sourceId: localImportLinks(initial, null)[0]!.id, selected: false, id: 'FILE-MW', reverseEndpoints: false, parameters: {}, demand: {} }],
  }
}
function config(): ScenarioConfig {
  const result = new ScenarioProjection().get('SCN-001')
  if (!result.ok) throw new Error('missing fixture')
  return result.data.config
}
function completeLink(input: ImportInput): void {
  input.links[0]!.selected = true
  input.links[0]!.parameters = { frequency: 2000, bandwidth: 2, txPower: 5, antennaGain: { tx: 1, rx: 2 },
    modulation: 'QPSK', berThreshold: 0.001, dataRate: 5, direction: 'FORWARD' }
  input.links[0]!.demand = { informationType: '态势信息' as const, volumeMb: 1, frequencyHz: 1, maxLatencyMs: 100, minDataRateMbps: 1 }
}

describe('本地场景导入候选', () => {
  it.each([
    [117, 21, true], [122, 26, true], [119.5, 24, true],
    [116.999999, 24, false], [122.000001, 24, false],
    [119.5, 20.999999, false], [119.5, 26.000001, false],
  ])('无人机集群保存边界 %s/%s，通过=%s，拒绝时服务端草稿不变', (longitude, latitude, accepted) => {
    const projection = new ScenarioProjection()
    const loaded = projection.get('SCN-001')
    if (!loaded.ok) throw new Error('missing fixture')
    const before = structuredClone(loaded.data)
    const candidate = structuredClone(before)
    Object.assign(candidate.config.platforms.find(p => p.type === 'AIRBORNE_MISSION_CLUSTER')!.initialPosition, { longitude, latitude })
    const result = projection.save('SCN-001', { config: candidate.config, uiExtensions: candidate.uiExtensions, expectedRevision: before.revision })
    expect(result.ok).toBe(accepted)
    const reloaded = projection.get('SCN-001')
    if (!reloaded.ok) throw new Error('missing fixture')
    if (accepted) {
      expect(reloaded.data.config.platforms.find(p => p.type === 'AIRBORNE_MISSION_CLUSTER')!.initialPosition).toMatchObject({ longitude, latitude })
    } else {
      expect(reloaded.data).toEqual(before)
    }
  })

  it('新增、显式映射已有节点和最新位置选择均保留其他配置，源数据不变', () => {
    const base = config()
    const original = structuredClone(base)
    const input = source()
    input.nodes[0]!.targetId = 'AIR-01'
    input.nodes[0]!.useLatest = true
    const before = structuredClone(input)
    const result = buildLocalSceneImport(base, input)
    expect(result.errors).toEqual([])
    expect(result.config!.platforms).toHaveLength(base.platforms.length + 1)
    const previous = base.platforms.find(p => p.id === 'AIR-01')!
    expect(result.config!.platforms.find(p => p.id === 'AIR-01')).toEqual({ ...previous, initialPosition: { longitude: 118.9, latitude: 25.1, altitude: 4000 } })
    expect(result.config!.platforms.find(p => p.id === 'FILE-B')).toMatchObject({ type: 'AIRBORNE_MISSION_CLUSTER', category: 'air', waypoints: [] })
    for (const key of ['links', 'jammers', 'sensors', 'informationDemand', 'scenario', 'output'] as const) expect(result.config![key]).toEqual(base[key])
    expect(base).toEqual(original)
    expect(input).toEqual(before)
  })

  it('关联补齐参数后保持端点、反向引用、业务一致并可经投影保存回读', () => {
    const projection = new ScenarioProjection()
    const draft = projection.get('SCN-001')
    if (!draft.ok) throw new Error('missing fixture')
    const input = source()
    completeLink(input)
    input.links[0]!.reverseEndpoints = true
    const result = buildLocalSceneImport(draft.data.config, input)
    expect(result.errors).toEqual([])
    expect(result.config!.links.at(-1)).toMatchObject({ id: 'FILE-MW', type: 'MICROWAVE', sourcePlatformId: 'FILE-B', targetPlatformId: 'FILE-A', frequency: 2000 })
    expect(result.config!.informationDemand.at(-1)).toMatchObject({ linkId: 'FILE-MW', sourcePlatformId: 'FILE-B', destinationPlatformIds: ['FILE-A'] })
    expect(result.config!.platforms.find(p => p.id === 'FILE-A')!.linkIds).toEqual(['FILE-MW'])
    expect(projection.save('SCN-001', { config: result.config, uiExtensions: draft.data.uiExtensions }).ok).toBe(true)
    const loaded = projection.get('SCN-001')
    expect(loaded.ok && loaded.data.config).toEqual(result.config)
    expect(buildLocalSceneImport(result.config!, input).errors[0]!.message).toContain('已占用')
  })

  it.each([
    ['未选择', (s: ImportInput) => { s.nodes.forEach(n => { n.selected = false }) }, 'nodes'],
    ['类型未选择', (s: ImportInput) => { delete s.nodes[0]!.type }, '.type'],
    ['映射重复', (s: ImportInput) => { s.nodes[1]!.targetId = s.nodes[0]!.targetId }, 'nodes'],
    ['来源重复', (s: ImportInput) => { s.nodes.push({ ...s.nodes[0]! }) }, 'nodes'],
    ['来源不存在', (s: ImportInput) => { s.nodes[0]!.sourceId = 'MISSING' }, 'nodes'],
    ['无最新位置', (s: ImportInput) => { s.nodes[1]!.useLatest = true }, '.position'],
    ['最新位置倒退', (s: ImportInput) => { s.nodes[0]!.useLatest = true; s.initial.nodes[0]!.time = 10 }, '.position'],
    ['最新位置未读完整', (s: ImportInput) => { s.nodes[0]!.useLatest = true; s.positions!.hasMore = true }, '.position'],
    ['后方指挥坐标越界', (s: ImportInput) => { s.nodes[0]!.type = 'REAR_COMMAND_NODE' }, '.position'],
    ['中继坐标越界', (s: ImportInput) => { s.nodes[0]!.type = 'FORWARD_RELAY_NODE' }, '.position'],
    ['干扰站坐标越界', (s: ImportInput) => { s.nodes[0]!.type = 'GROUND_JAMMER_DETECTION_STATION' }, '.position'],
    ['负高度不静默截断', (s: ImportInput) => { s.initial.nodes[0]!.altitude = -0.0001 }, 'altitude'],
    ['卫星子类型缺失', (s: ImportInput) => { s.nodes[0]!.type = 'COMMUNICATION_SATELLITE' }, 'satelliteType'],
    ['缺少链路参数', (s: ImportInput) => { s.links[0]!.selected = true }, 'links'],
    ['缺少端点映射', (s: ImportInput) => { completeLink(s); s.nodes[1]!.selected = false }, 'endpoints'],
    ['非法来源快照', (s: ImportInput) => { s.initial.sha256 = '' }, 'source'],
  ] as const)('%s 时整批拒绝，不修改原草稿', (_name, mutate, path) => {
    const base = config()
    const before = structuredClone(base)
    const input = source()
    mutate(input)
    const result = buildLocalSceneImport(base, input)
    expect(result.config).toBeUndefined()
    expect(result.errors.some(e => e.fieldPath.includes(path))).toBe(true)
    expect(base).toEqual(before)
  })

  it.each([
    ['REAR_COMMAND_NODE', 118.5, 120, 24, 25, 0],
    ['AIRBORNE_MISSION_CLUSTER', 117, 122, 21, 26, 4000],
    ['FORWARD_RELAY_NODE', 120.8, 120.8, 25.3, 25.7, 8000],
    ['GROUND_JAMMER_DETECTION_STATION', 121.2, 121.8, 24.8, 25.4, 0],
  ] as const)('%s 边界可导入，越界拒绝且原配置不变', (type, minLon, maxLon, minLat, maxLat, altitude) => {
    const base = config()
    const before = structuredClone(base)
    const input = source()
    input.nodes[0]!.targetId = base.platforms.find(p => p.type === type)!.id
    input.nodes[1]!.selected = false
    for (const [longitude, latitude] of [[minLon, minLat], [maxLon, maxLat]]) {
      Object.assign(input.initial.nodes[0]!, { longitude, latitude, altitude })
      const result = buildLocalSceneImport(base, input)
      expect(result.errors).toEqual([])
      expect(result.config!.platforms.find(p => p.type === type)!.initialPosition).toEqual({ longitude, latitude, altitude })
      expect(base).toEqual(before)
    }
    const invalid: Array<{ longitude: number; latitude: number; altitude: number }> = [
      { longitude: minLon - 0.000001, latitude: minLat, altitude },
      { longitude: maxLon + 0.000001, latitude: maxLat, altitude },
      { longitude: minLon, latitude: minLat - 0.000001, altitude },
      { longitude: maxLon, latitude: maxLat + 0.000001, altitude },
    ]
    if (type === 'FORWARD_RELAY_NODE') invalid.push({ longitude: minLon, latitude: minLat, altitude: altitude + 0.000001 })
    for (const position of invalid) {
      Object.assign(input.initial.nodes[0]!, position)
      const result = buildLocalSceneImport(base, input)
      expect(result.config).toBeUndefined()
      expect(result.errors).toContainEqual(expect.objectContaining({ fieldPath: 'nodes[0].position' }))
      expect(base).toEqual(before)
    }
  })

  it('类型数量上限与50节点上限继续生效，不显示未来关联', () => {
    const input = source()
    const base = config()
    for (let i = 0; i < 50; i++) base.platforms.push({ ...structuredClone(base.platforms.find(p => p.id === 'UAV-01')!), id: `LIMIT-${i}`, linkIds: [], sensorIds: [], jammerIds: [] })
    expect(buildLocalSceneImport(base, input).errors.map(e => e.code)).toContain('NODE_LIMIT_EXCEEDED')
    input.initial.connections![0]!.time = 500
    expect(localImportLinks(input.initial, input.positions)).toEqual([])
  })
})

describe('本地场景导入正式 Store / 组件流程', () => {
  let wrapper: VueWrapper | undefined
  let fetchMock: ReturnType<typeof vi.fn>
  const envelope = (data: unknown) => ({ ok: true, json: async () => ({ ok: true, data, meta: { requestId: 'REQ-IMPORT', generatedAt: '2026-08-06T08:00:00Z', page: 1, pageSize: 1, total: 1 } }) }) as Response
  beforeEach(async () => {
    sessionStorage.clear()
    setActivePinia(createPinia())
    const projection = new ScenarioProjection()
    fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/auth/login')) return envelope({ authenticated: true, sessionCreated: false,
        principal: { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'] } })
      if (url.endsWith('/initial-nodes')) return envelope(source().initial)
      if (url.endsWith('/positions')) return envelope(source().positions)
      const result = options?.method === 'PUT' ? projection.save('SCN-001', JSON.parse(options.body as string)) : projection.get('SCN-001')
      if (!result.ok) throw new Error(result.message)
      return envelope(result.data)
    })
    vi.stubGlobal('fetch', fetchMock)
    expect((await useAuthStore().login({ username: 'operator', password: '123456' })).authenticated).toBe(true)
    expect(await useScenarioStore().loadScenario()).toBe(true)
  })
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; ElMessage.closeAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear() })
  async function open() {
    wrapper = mount(LocalSceneImport, { global: { plugins: [ElementPlus] }, attachTo: document.body })
    await wrapper.get('[data-testid="open-local-scene-import"]').trigger('click')
    await flushPromises()
  }
  function dialog() { return new DOMWrapper(document.querySelector('[data-testid="local-scene-import"]')!) }

  it('应用只改草稿；PUT保存并重载才更新服务端，取消不触发写入', async () => {
    const store = useScenarioStore()
    const base = structuredClone(toRaw(store.draft!))
    const count = fetchMock.mock.calls.length
    expect(store.applyLocalFileImport(source(), store.requestEpoch, store.scriptEpoch, store.localImportEpoch)).toEqual([])
    expect(store.dirty).toBe(true)
    expect(store.draft!.revision).toBe(base.revision)
    expect(fetchMock).toHaveBeenCalledTimes(count)
    expect(await store.saveScenario()).toBe(true)
    expect(await store.loadScenario()).toBe(true)
    expect(store.draft!.config.platforms.some(n => n.id === 'FILE-A')).toBe(true)
    expect(store.dirty).toBe(false)
  })

  it.each(['dirty', 'reset', 'logout', 'locked', 'lock-unlock', 'clear', 'pending'] as const)('%s 后 Store 拒绝旧预览且不发写请求', (kind) => {
    const store = useScenarioStore()
    const epoch = store.requestEpoch
    const script = store.scriptEpoch
    const localImport = store.localImportEpoch
    if (kind === 'dirty') store.markDirty()
    if (kind === 'reset') store.resetToSafeEmpty()
    if (kind === 'logout') useAuthStore().resetToSafeEmpty()
    if (kind === 'locked') store.projectRuntimeLock('SCN-001', true)
    if (kind === 'lock-unlock') {
      store.projectRuntimeLock('SCN-001', true)
      store.projectRuntimeLock('SCN-001', false)
      expect(store.scriptEpoch).toBe(script)
      expect(store.requestEpoch).toBe(epoch)
    }
    if (kind === 'clear') store.invalidateLocalFileImport()
    if (kind === 'pending') store.panelState = 'LOADING'
    const before = store.draft ? structuredClone(toRaw(store.draft)) : null
    const count = fetchMock.mock.calls.length
    expect(store.applyLocalFileImport(source(), epoch, script, localImport)[0]!.code).toBe('LOCAL_IMPORT_STALE')
    expect(store.draft).toEqual(before)
    expect(fetchMock).toHaveBeenCalledTimes(count)
  })

  it('自动匹配明确类型，只导入初始位置；取消不写入，确认仍需手动保存', async () => {
    const store = useScenarioStore()
    await open()
    expect(dialog().text()).toContain('j_1.csv')
    expect(dialog().get('[data-testid="local-import-summary"]').text()).toContain('新增 2 个 · 更新 0 个 · 未导入 0 个')
    expect(wrapper!.findAllComponents({ name: 'ElSelect' })).toHaveLength(0)
    expect(wrapper!.findAllComponents({ name: 'ElInputNumber' })).toHaveLength(0)
    expect(dialog().text()).not.toContain('频率（MHz）')
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/positions'))).toBe(false)
    const before = structuredClone(toRaw(store.draft!))
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValueOnce('confirm' as never)
    await dialog().get('[data-testid="apply-local-scene-import"]').trigger('click')
    await flushPromises()
    expect(store.draft).toEqual(before)
    const count = fetchMock.mock.calls.length
    await dialog().get('[data-testid="apply-local-scene-import"]').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(store.dirty).toBe(true)
    expect(store.draft!.config.platforms.find(p => p.id === 'FILE-A')).toMatchObject({
      type: 'AIRBORNE_MISSION_CLUSTER', category: 'air', initialPosition: { longitude: 118.7, latitude: 25.1, altitude: 4000 },
    })
    expect(store.draft!.config.links).toEqual(before.config.links)
    expect(store.draft!.config.informationDemand).toEqual(before.config.informationDemand)
    expect(fetchMock).toHaveBeenCalledTimes(count)
  })

  it.each(['error', 'malformed', 'empty'] as const)('%s 来源无旧预览，提供重读入口', async kind => {
    if (kind === 'error') fetchMock.mockRejectedValueOnce(new Error('offline'))
    else fetchMock.mockResolvedValueOnce(envelope(kind === 'empty' ? null : {}))
    await open()
    expect(dialog().find('[data-testid="local-import-nodes"]').exists()).toBe(false)
    expect(dialog().find('[data-testid="local-import-message"]').exists()).toBe(true)
    expect(dialog().text()).toContain('重新读取')
    expect(useScenarioStore().dirty).toBe(false)
  })

  it('未知类型只显示待选项，越界节点明确不导入，取消全选后不能导入', async () => {
    const initial = source().initial
    initial.nodes[0]!.type = 'UNKNOWN'
    initial.nodes[1]!.type = 'Command_Vehicle_PLATFORM'
    fetchMock.mockResolvedValueOnce(envelope(initial))
    await open()
    expect(dialog().get('[data-testid="local-import-summary"]').text()).toContain('未导入 2 个')
    expect(dialog().text()).toContain('位置约束')
    expect(dialog().get('[data-testid="apply-local-scene-import"]').attributes('disabled')).toBeDefined()
    const select = wrapper!.findAllComponents({ name: 'ElSelect' }).find(c => c.props('ariaLabel') === '场景类型 FILE-A')!
    select.vm.$emit('update:modelValue', 'AIRBORNE_MISSION_CLUSTER')
    await flushPromises()
    expect(dialog().get('[data-testid="local-import-summary"]').text()).toContain('新增 1 个')
    expect(wrapper!.findAllComponents({ name: 'ElCheckbox' })[1]!.props('disabled')).toBe(true)
    wrapper!.findAllComponents({ name: 'ElCheckbox' })[0]!.vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(dialog().get('[data-testid="apply-local-scene-import"]').attributes('disabled')).toBeDefined()
  })

  it('未知卫星需主动补子类型才能导入', async () => {
    const initial = source().initial
    initial.nodes[0]!.type = 'UNKNOWN'
    fetchMock.mockResolvedValueOnce(envelope(initial))
    await open()
    wrapper!.findAllComponents({ name: 'ElSelect' })[0]!.vm.$emit('update:modelValue', 'COMMUNICATION_SATELLITE')
    await flushPromises()
    expect(wrapper!.findAllComponents({ name: 'ElCheckbox' })[0]!.props('modelValue')).toBe(false)
    wrapper!.findAllComponents({ name: 'ElSelect' }).find(c => c.props('ariaLabel') === '卫星类型 FILE-A')!.vm.$emit('update:modelValue', 'SHENTONG')
    await flushPromises()
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    await dialog().get('[data-testid="apply-local-scene-import"]').trigger('click')
    await flushPromises()
    expect(useScenarioStore().draft!.config.platforms.find(p => p.id === 'FILE-A')).toMatchObject({ type: 'COMMUNICATION_SATELLITE', category: 'space', satelliteType: 'SHENTONG' })
  })

  it('同 ID 自动更新且保留原类型和关联，不新增重复实体', async () => {
    const initial = source().initial
    initial.nodes[0]!.platformId = 'AIR-01'
    initial.connections![0]!.source.platformName = 'AIR-01'
    initial.nodes[0]!.type = 'UNKNOWN'
    fetchMock.mockResolvedValueOnce(envelope(initial))
    const original = structuredClone(toRaw(useScenarioStore().draft!.config.platforms.find(p => p.id === 'AIR-01')!))
    await open()
    expect(dialog().get('[data-testid="local-import-summary"]').text()).toContain('新增 1 个 · 更新 1 个')
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    await dialog().get('[data-testid="apply-local-scene-import"]').trigger('click')
    await flushPromises()
    const platforms = useScenarioStore().draft!.config.platforms
    expect(platforms.filter(p => p.id === 'AIR-01')).toHaveLength(1)
    expect(platforms.find(p => p.id === 'AIR-01')).toEqual({ ...original, initialPosition: { longitude: 118.7, latitude: 25.1, altitude: 4000 } })
  })

  it.each(['close', 'logout', 'dirty'] as const)('%s 淘汰在途读取，响应不得恢复预览', async kind => {
    let finish!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    await open()
    expect(dialog().text()).toContain('正在读取')
    if (kind === 'close') wrapper!.findComponent({ name: 'ElDialog' }).vm.$emit('update:modelValue', false)
    if (kind === 'logout') useAuthStore().resetToSafeEmpty()
    if (kind === 'dirty') useScenarioStore().markDirty()
    await flushPromises()
    finish(envelope(source().initial))
    await flushPromises()
    expect(dialog().find('[data-testid="local-import-nodes"]').exists()).toBe(false)
    expect(useScenarioStore().draft!.config.platforms.some(p => p.id === 'FILE-A')).toBe(false)
  })

  it.each(['lock-unlock', 'close', 'unmount', 'dirty', 'logout', 'reset'] as const)('%s 后迟到确认不得应用旧内容', async kind => {
    await open()
    await flushPromises()
    let finish!: () => void
    vi.spyOn(ElMessageBox, 'confirm').mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve('confirm' as never) }))
    await dialog().get('[data-testid="apply-local-scene-import"]').trigger('click')
    await flushPromises()
    const store = useScenarioStore()
    const success = vi.spyOn(ElMessage, 'success')
    if (kind === 'lock-unlock') {
      store.projectRuntimeLock('SCN-001', true)
      store.projectRuntimeLock('SCN-001', false)
    }
    if (kind === 'close') wrapper!.findComponent({ name: 'ElDialog' }).vm.$emit('update:modelValue', false)
    if (kind === 'unmount') { wrapper!.unmount(); wrapper = undefined }
    if (kind === 'dirty') store.markDirty()
    if (kind === 'logout') useAuthStore().resetToSafeEmpty()
    if (kind === 'reset') store.resetToSafeEmpty()
    const before = structuredClone(toRaw(store.draft))
    const dirty = store.dirty
    const requests = fetchMock.mock.calls.length
    finish()
    await flushPromises()
    expect(store.draft).toEqual(before)
    expect(store.dirty).toBe(dirty)
    expect(fetchMock).toHaveBeenCalledTimes(requests)
    expect(success).not.toHaveBeenCalled()
  })
})
