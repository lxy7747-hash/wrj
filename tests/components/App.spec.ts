import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ApiSuccess, Batch, BatchRunResult, Replay, ScenarioConfig, ScenarioDraft, SimulationRun } from '../../src/contracts/domain-models'

const mapControllerMock = vi.hoisted(() => ({
  createSituationMapController: vi.fn(() => ({
    setFrame: vi.fn(),
    setLinks: vi.fn(),
    setFileLinks: vi.fn(),
    setFileDeviceStates: vi.fn(),
    setSelectedNodeId: vi.fn(),
    setLayerVisible: vi.fn(),
    setTheme: vi.fn(),
    setBasemap: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  })),
}))

vi.mock('../../src/components/situation/situation-map-controller', () => ({
  createSituationMapController: mapControllerMock.createSituationMapController,
}))

import App from '../../src/App.vue'
import { APP_CONFIG } from '../../src/config/app.config'
import { createAppRouter, routeRecords } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import { useBatchStore } from '../../src/stores/batch'
import { useDataExchangeStore } from '../../src/stores/data-exchange'
import { useReplayStore } from '../../src/stores/replay'
import { useScenarioStore } from '../../src/stores/scenario'
import { useSimulationStore } from '../../src/stores/simulation'
import { useTelemetryStore } from '../../src/stores/telemetry'

function scenarioDraft(): ScenarioDraft {
  return {
    config: structuredClone(fixtureSource.scenario) as ScenarioConfig,
    uiExtensions: {
      jammers: [
        { jammerId: 'JAM-WB-01-TX', direction: 360, duration: 120, enabled: true },
      ],
      sensors: [{ sensorId: 'ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true }],
    },
    revision: 4,
    officialLibraryChanged: false,
    locked: false,
  }
}

function scenarioResponse(draft: ScenarioDraft): Response {
  const body: ApiSuccess<ScenarioDraft> = {
    ok: true,
    data: draft,
    meta: {
      requestId: 'REQ-P2-APP',
      generatedAt: '2026-08-06T08:00:00Z',
      page: 1,
      pageSize: 1,
      total: 1,
    },
  }
  return { ok: true, json: vi.fn().mockResolvedValue(body) } as unknown as Response
}

describe('App shell', () => {
  afterEach(() => {
    APP_CONFIG.showReports = false
    for (const key of Object.keys(APP_CONFIG.systemManagement) as Array<keyof typeof APP_CONFIG.systemManagement>) {
      APP_CONFIG.systemManagement[key] = false
    }
    vi.unstubAllGlobals()
  })

  it.each([
    ['ADMIN', false], ['ADMIN', true], ['OPERATOR', false], ['OPERATOR', true],
  ] as const)('报表入口按配置显隐，保留路由（%s，显示=%s）', async (role, visible) => {
    APP_CONFIG.showReports = visible
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore(pinia).$patch({
      principal: { userId: `USR-${role}`, username: role, role, permissions: ['BUSINESS_READ'] },
      role,
      permissions: ['BUSINESS_READ'],
    })
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push('/reports')
    await router.isReady()
    const wrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus], stubs: { RouterView: true } } })
    try {
      expect(router.currentRoute.value.path).toBe('/reports')
      expect(wrapper.find('nav a[href="/reports"]').exists()).toBe(visible)
      if (visible) expect(wrapper.get('nav a[href="/reports"]').text()).toBe('评估报表')
      expect(wrapper.find('nav a[href="/replays"]').exists()).toBe(true)
      expect(wrapper.find('nav a[href="/scenarios"]').exists()).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })

  it.each([
    ['showMasterData', '主数据管理'],
    ['showDatabaseBackup', '数据库备份 / 恢复'],
    ['showSimulationData', '仿真数据管理'],
    ['showRuntimeStatus', '系统运行状态'],
    ['showDataExchange', '数据交换与接口'],
  ] as const)('单独恢复 %s 入口，不改变其他显隐或角色权限', async (key, label) => {
    APP_CONFIG.systemManagement[key] = true
    for (const role of ['ADMIN', 'OPERATOR'] as const) {
      const pinia = createPinia()
      setActivePinia(pinia)
      useAuthStore(pinia).$patch({
        principal: { userId: `USR-${role}`, username: role, role, permissions: ['BUSINESS_READ'] },
        role,
        permissions: ['BUSINESS_READ'],
      })
      const router = createAppRouter(createMemoryHistory(), pinia)
      await router.push(role === 'ADMIN' ? '/admin' : '/admin/data-exchange')
      await router.isReady()
      const wrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus], stubs: { RouterView: true } } })
      try {
        const items = wrapper.findAll('[aria-label="系统管理导航"] .el-menu-item').map(item => item.text())
        const hasEntry = role === 'ADMIN' || key === 'showDataExchange'
        expect(wrapper.find('nav a[href^="/admin"]').exists()).toBe(hasEntry)
        if (role === 'ADMIN') {
          expect(items).toHaveLength(5)
          expect(items).toEqual(expect.arrayContaining(['装备参数库', '场景模板维护', '操作审计日志', '账号管理', label]))
          expect(wrapper.get('nav a[href="/admin"]').text()).toBe('系统管理')
        } else {
          expect(items).toEqual(hasEntry ? ['数据交换与接口'] : [])
          if (hasEntry) expect(wrapper.get('nav a[href="/admin/data-exchange"]').text()).toBe('系统管理')
        }
        const titles = wrapper.findAll('.el-menu-item-group__title').map(item => item.text())
        expect(titles.includes('数据与运行')).toBe(role === 'ADMIN' && ['showSimulationData', 'showRuntimeStatus'].includes(key))
        expect(titles.includes('数据交换')).toBe(key === 'showDataExchange')
      } finally {
        wrapper.unmount()
      }
    }
  })

  it('renders login independently and protected routes in the product shell', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchSpy = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
        const data = url.endsWith('/situation/initial-nodes') || url.endsWith('/replays/local-file') ? null : url.includes('/admin/audit')
        ? fixtureSource.audit
        : url.includes('/frames/')
        ? fixtureSource.frame
        : url.endsWith('/events')
          ? fixtureSource.events
          : []
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue({
          ok: true,
          data,
          meta: {
            requestId: 'REQ-APP',
            generatedAt: '2026-08-06T08:00:00Z',
            page: 1,
            pageSize: Array.isArray(data) ? Math.max(1, data.length) : 1,
            total: Array.isArray(data) ? data.length : 1,
          },
        }),
      } as unknown as Response)
    })
    class SilentWebSocket {
      static readonly OPEN = 1
      static readonly CONNECTING = 0
      readonly readyState = SilentWebSocket.CONNECTING
      addEventListener(): void {}
      send(): void {}
      close(): void {}
    }
    const webSocketSpy = vi.fn(function WebSocketMock() { return new SilentWebSocket() })
    Object.assign(webSocketSpy, { OPEN: 1, CONNECTING: 0 })
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open')
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('WebSocket', webSocketSpy)

    expect(routeRecords.map((record) => record.path)).toEqual([
      '/login',
      '/situation',
      '/scenarios',
      '/batches',
      '/reports',
      '/replays',
      '/admin',
      '/blueprint',
      '/admin/data-exchange',
      '/traceability',
      '/interactions',
    ])
    expect(routeRecords.filter((record) => record.meta?.layout === 'standalone'))
      .toEqual([routeRecords[0]])
    expect(routeRecords[0]?.meta?.title).toBe('登录')
    expect(routeRecords[8]?.meta?.title).toBe('数据交换与接口')
    expect(routeRecords[10]?.meta?.title).toBe('感知、干扰与选路')

    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push('/login')
    await router.isReady()

    const loginWrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus] } })

    expect(router.currentRoute.value.meta.layout).toBe('standalone')
    expect(loginWrapper.get('#login-title').text()).toBe('系统登录')
    expect((loginWrapper.get('input[data-testid="login-username"]').element as HTMLInputElement).value).toBe('')
    expect((loginWrapper.get('input[data-testid="login-password"]').element as HTMLInputElement).value).toBe('')
    expect(loginWrapper.find('select').exists()).toBe(false)
    expect(loginWrapper.text()).not.toMatch(/夹具|演示|P0|P1|Mock|页面外壳|shell/i)
    expect(loginWrapper.find('.app-shell').exists()).toBe(false)
    expect(loginWrapper.find('nav').exists()).toBe(false)
    expect(loginWrapper.find('#app-title').exists()).toBe(false)
    expect(loginWrapper.find('[data-testid="identity-panel"]').exists()).toBe(false)
    loginWrapper.unmount()

    const auth = useAuthStore(pinia)
    auth.$patch({
      principal: {
        userId: 'USR-OPERATOR',
        username: 'operator',
        role: 'OPERATOR',
        permissions: ['BUSINESS_READ'],
      },
      role: 'OPERATOR',
      permissions: ['BUSINESS_READ'],
    })
    await router.push('/situation')

    const operatorWrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus] } })
    await flushPromises()

    expect(router.currentRoute.value.meta.layout).toBe('workspace')
    expect(operatorWrapper.get('h1').text()).toBe('多手段集群通联仿真软件')
    expect(operatorWrapper.get('nav[aria-label="主导航"]')).toBeTruthy()
    expect(operatorWrapper.find('.app-shell__header > .app-shell__navigation').exists()).toBe(true)
    expect(operatorWrapper.html()).not.toContain('brand' + '__status')
    expect(operatorWrapper.html()).not.toContain('status' + '-indicator')
    expect(operatorWrapper.get('#situation-title').text()).toBe('态势主界面')
    expect(operatorWrapper.find('a[href="/login"]').exists()).toBe(false)
    expect(operatorWrapper.findAll('nav a').map((link) => link.text())).toEqual([
      '态势主界面',
      '场景配置',
      '历史回放',
    ])
    expect(operatorWrapper.find('a[href="/admin"]').exists()).toBe(false)
    expect(operatorWrapper.find('a[href="/admin/data-exchange"]').exists()).toBe(false)
    expect(operatorWrapper.find('nav a[href="/batches"]').exists()).toBe(false)
    expect(operatorWrapper.find('nav a[href="/blueprint"]').exists()).toBe(false)
    expect(operatorWrapper.get('nav').text()).not.toMatch(/需求追踪矩阵|弹窗交互|登录页|可追溯性|交互管理/)
    expect(operatorWrapper.get('[data-testid="identity-username"]').text()).toBe('用户：operator')
    expect(operatorWrapper.get('[data-testid="identity-role"]').text()).toBe('角色：操作员')
    expect(operatorWrapper.get('.app-shell__navigation').text())
      .not.toMatch(/夹具|演示|P0|P1|Mock|页面外壳|shell/)

    await router.push('/admin/data-exchange')
    await flushPromises()
    expect(operatorWrapper.find('[aria-label="系统管理导航"]').exists()).toBe(false)

    await router.push('/blueprint')
    await flushPromises()
    const capabilityNavigation = operatorWrapper.get('[aria-label="能力与接口导航"]')
    expect(capabilityNavigation.findAll('.el-menu-item').map((item) => item.text())).toEqual([
      '能力/接口蓝图',
      '需求追踪',
      '感知、干扰与选路',
    ])
    expect(capabilityNavigation.get('.el-menu-item.is-active').text()).toBe('能力/接口蓝图')

    await router.push('/traceability')
    await flushPromises()
    expect(capabilityNavigation.get('.el-menu-item.is-active').text()).toBe('需求追踪')
    expect(operatorWrapper.find('nav[aria-label="主导航"] a[href="/blueprint"]').exists()).toBe(false)

    await router.push('/interactions')
    await flushPromises()
    expect(operatorWrapper.findAll('main')).toHaveLength(1)
    expect(capabilityNavigation.get('.el-menu-item.is-active').text()).toBe('感知、干扰与选路')
    expect(operatorWrapper.get('#interactions-title').text()).toBe('感知、干扰与选路')
    expect(operatorWrapper.find('nav[aria-label="主导航"] a[href="/blueprint"]').exists()).toBe(false)

    operatorWrapper.unmount()
    auth.$patch({
      principal: {
        userId: 'USR-ADMIN',
        username: 'admin',
        role: 'ADMIN',
        permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'],
      },
      role: 'ADMIN',
      permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'],
    })

    const adminWrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus] } })
    expect(adminWrapper.findAll('nav a').map((link) => link.text())).toEqual([
      '态势主界面', '场景配置', '历史回放', '系统管理',
    ])
    expect(adminWrapper.get('a[href="/admin"]').text()).toBe('系统管理')
    expect(adminWrapper.find('a[href="/admin/data-exchange"]').exists()).toBe(false)
    expect(adminWrapper.get('[data-testid="identity-username"]').text()).toBe('用户：admin')
    expect(adminWrapper.get('[data-testid="identity-role"]').text()).toBe('角色：管理员')

    await router.push('/admin')
    await flushPromises()
    expect(adminWrapper.findAll('main')).toHaveLength(1)
    expect(adminWrapper.find('.system-management__header').exists()).toBe(false)
    expect(adminWrapper.get('.system-management-page').attributes('aria-label')).toBe('系统管理')
    expect(adminWrapper.get('.system-management-page').attributes('aria-labelledby')).toBeUndefined()
    const systemManagementNavigation = adminWrapper.get('[aria-label="系统管理导航"]')
    expect(systemManagementNavigation.findAll('.el-menu-item').map(item => item.text()))
      .toEqual(['装备参数库', '场景模板维护', '操作审计日志', '账号管理'])
    expect(systemManagementNavigation.text()).not.toMatch(/数据与运行|数据交换/)
    expect(systemManagementNavigation.find('small').exists()).toBe(false)
    expect(systemManagementNavigation.get('.el-menu-item.is-active').text()).toBe('账号管理')

    await router.push('/admin?section=equipment-library')
    await flushPromises()
    expect(systemManagementNavigation.get('.el-menu-item.is-active').text()).toBe('装备参数库')
    expect(adminWrapper.get('[data-testid="equipment-library"]').attributes('aria-label')).toBe('装备参数库')

    await router.push('/admin?section=audit-logs')
    await flushPromises()
    expect(systemManagementNavigation.get('.el-menu-item.is-active').text()).toBe('操作审计日志')
    expect(adminWrapper.find('[aria-label="操作审计日志"] [data-testid="audit-log-panel"]').exists()).toBe(true)
    expect(adminWrapper.get('.audit-log-card .el-table').text()).toContain('修改阈值')

    const scenario = useScenarioStore(pinia)
    const simulation = useSimulationStore(pinia)
    const batch = useBatchStore(pinia)
    const replay = useReplayStore(pinia)
    const dataExchange = useDataExchangeStore(pinia)
    scenario.$patch({ draft: scenarioDraft(), panelState: 'SUCCESS', dirty: true })
    simulation.applyRun(structuredClone(fixtureSource.run) as SimulationRun)
    dataExchange.$patch({
      csvState: 'SUCCESS',
      csvResult: {
        valid: true,
        contractName: 'link_quality.csv',
        rowCount: 1,
        encoding: 'UTF-8',
        headerMatched: true,
        atomicWrite: 'NOT_EXECUTED_BY_DESIGN',
        issues: [],
      },
      jsonState: 'SUCCESS',
      jsonResult: structuredClone(fixtureSource.scenario) as ScenarioConfig,
      processState: 'SUCCESS',
      processResult: {
        status: 'EXITED',
        processId: null,
        stdout: 'NOT_CAPTURED_BY_DESIGN',
        exitCode: 0,
        timeoutMs: 5_000,
        singleInstance: true,
        resourcesReleased: true,
      },
    })
    batch.$patch({
      batch: structuredClone(fixtureSource.batch) as Batch,
      runs: structuredClone(fixtureSource.batchRuns) as BatchRunResult[],
    })
    replay.$patch({ replay: structuredClone(fixtureSource.replay) as Replay, state: 'PAUSED' })

    await adminWrapper.get('[data-testid="logout"]').trigger('click')
    await flushPromises()
    expect(auth.principal).toBeNull()
    expect(auth.permissions).toEqual([])
    expect(scenario.$state).toMatchObject({ draft: null, panelState: 'EMPTY', dirty: false })
    expect(simulation.$state).toMatchObject({ run: null, capabilityState: 'EMPTY', lastConfirmation: null })
    expect(dataExchange.$state).toMatchObject({
      csvState: 'EMPTY', csvResult: null,
      jsonState: 'EMPTY', jsonResult: null,
      processState: 'EMPTY', processResult: null,
    })
    expect(batch.$state).toMatchObject({ batch: null, runs: [], capabilityState: 'EMPTY' })
    expect(replay.$state).toMatchObject({ replay: null, events: [], state: 'EMPTY' })
    auth.$patch({
      principal: { userId: 'USR-OPERATOR-2', username: 'operator-2', role: 'OPERATOR', permissions: ['BUSINESS_READ'] },
      role: 'OPERATOR',
      permissions: ['BUSINESS_READ'],
    })
    expect(dataExchange.$state).toMatchObject({ csvResult: null, jsonResult: null, processResult: null })
    expect(router.currentRoute.value.path).toBe('/login')
    expect(adminWrapper.find('.app-shell').exists()).toBe(false)
    expect(adminWrapper.find('[data-testid="identity-panel"]').exists()).toBe(false)
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/api/v1/simulations',
      expect.objectContaining({ headers: { 'X-Demo-Role': 'OPERATOR' } }),
    )
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/frames/F-00042'))).toBe(true)
    expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/events'))).toBe(true)
    expect(webSocketSpy).toHaveBeenCalled()
    expect(xhrOpen).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    expect(
      consoleWarn.mock.calls
        .map((call) => String(call[0]))
        .filter((message) => message.includes('Failed to resolve component')),
    ).toHaveLength(0)

    // Resource attributes are audited separately because they can bypass fetch/XHR.
    const externalResources = adminWrapper
      .findAll('[src], [href]')
      .filter((node) => /^(?:https?:)?\/\//i.test(node.attributes('src') ?? node.attributes('href') ?? ''))
    expect(externalResources).toHaveLength(0)
  })

  it('clears a dirty scenario synchronously when authentication is invalidated', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push('/login')
    await router.isReady()
    const wrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus] } })
    const auth = useAuthStore(pinia)
    const scenario = useScenarioStore(pinia)
    auth.$patch({
      principal: {
        userId: 'USR-OPERATOR',
        username: 'operator',
        role: 'OPERATOR',
        permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'],
      },
      role: 'OPERATOR',
      permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'],
    })
    scenario.$patch({ draft: scenarioDraft(), panelState: 'SUCCESS', dirty: true })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Permissions offline')))

    await expect(auth.refreshPermissions()).resolves.toBe(false)

    expect(auth.principal).toBeNull()
    expect(scenario.$state).toMatchObject({ draft: null, panelState: 'EMPTY', dirty: false })
    wrapper.unmount()
  })

  it.each(['logout', 'expired'] as const)('clears the remembered scene on %s and does not restore it for another account', async action => {
    sessionStorage.clear()
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore()
    auth.$patch({ principal: { userId: 'USR-A', username: 'A', role: 'OPERATOR', permissions: ['BUSINESS_READ'] }, role: 'OPERATOR', permissions: ['BUSINESS_READ'] })
    const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
    const scene = new ScenarioProjection().list()[0]!
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({ ok: true,
      data: url.endsWith('/simulations') ? [] : url.includes('/scenarios/') ? scene : null,
    }))))
    const simulation = useSimulationStore()
    expect(await simulation.selectScene(scene.config.scenario.id)).toBe(true)
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push('/situation')
    await router.isReady()
    const wrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus] } })
    try {
      await flushPromises()
      expect(simulation.readSelectedSceneId()).toBe(scene.config.scenario.id)
      if (action === 'logout') await wrapper.get('[data-testid="logout"]').trigger('click')
      else auth.resetToSafeEmpty()
      await flushPromises()
      expect(simulation.selectedScene).toBeNull()
      expect(sessionStorage.getItem('wrj.simulation.selectedScene')).toBeNull()
      auth.$patch({ principal: { userId: 'USR-B', username: 'B', role: 'OPERATOR', permissions: ['BUSINESS_READ'] }, role: 'OPERATOR', permissions: ['BUSINESS_READ'] })
      expect(simulation.readSelectedSceneId()).toBeNull()
    } finally { wrapper.unmount(); sessionStorage.clear() }
  })

  it('does not load telemetry or reconnect after logout during situation bootstrap', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({
      principal: {
        userId: 'USR-OPERATOR',
        username: 'operator',
        role: 'OPERATOR',
        permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
      },
      role: 'OPERATOR',
      permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
    })
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push('/situation')
    await router.isReady()
    let resolveSimulation!: (response: Response) => void
    const fetchSpy = vi.fn().mockReturnValueOnce(new Promise<Response>((resolve) => { resolveSimulation = resolve }))
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: { authenticated: false, sessionCreated: false } }) })
    const webSocketSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('WebSocket', webSocketSpy)
    const wrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus] } })
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())

    await wrapper.get('[data-testid="logout"]').trigger('click')
    resolveSimulation({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    } as unknown as Response)
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/login')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1]![0]).toBe('http://127.0.0.1:4173/api/v1/auth/logout')
    expect(webSocketSpy).not.toHaveBeenCalled()
    expect(useTelemetryStore(pinia)).toMatchObject({
      frame: null,
      events: [],
      connectionState: 'DISCONNECTED',
      capabilityState: 'EMPTY',
    })
    wrapper.unmount()
  })

  it.each(['load', 'save'] as const)('ignores a delayed scenario %s response after logout', async (operation) => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const auth = useAuthStore(pinia)
    auth.$patch({
      principal: {
        userId: 'USR-OPERATOR',
        username: 'operator',
        role: 'OPERATOR',
        permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'],
      },
      role: 'OPERATOR',
      permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'],
    })
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push('/situation')
    await router.isReady()
    const wrapper = mount(App, { global: { plugins: [pinia, router, ElementPlus] } })
    const scenario = useScenarioStore(pinia)
    if (operation === 'save') scenario.$patch({ draft: scenarioDraft(), panelState: 'SUCCESS', dirty: true })
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveResponse = resolve })))

    const pending = operation === 'load' ? scenario.loadScenario() : scenario.saveScenario()
    await wrapper.get('[data-testid="logout"]').trigger('click')
    expect(scenario.$state).toMatchObject({ draft: null, panelState: 'EMPTY', dirty: false })

    const lateDraft = scenarioDraft()
    lateDraft.revision = 5
    resolveResponse(scenarioResponse(lateDraft))
    await expect(pending).resolves.toBe(false)
    expect(scenario.$state).toMatchObject({ draft: null, panelState: 'EMPTY', dirty: false })
    wrapper.unmount()
  })
})
