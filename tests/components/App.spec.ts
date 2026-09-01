import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ApiSuccess, ScenarioConfig, ScenarioDraft } from '../../src/contracts/domain-models'

const mapControllerMock = vi.hoisted(() => ({
  createSituationMapController: vi.fn(() => ({
    setLinks: vi.fn(),
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
import { createAppRouter, routeRecords } from '../../src/router'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'

function scenarioDraft(): ScenarioDraft {
  return {
    config: structuredClone(fixtureSource.scenario) as ScenarioConfig,
    uiExtensions: {
      jammers: [
        { jammerId: 'JAM-WB-01-TX', direction: 360, duration: 120, enabled: true },
        { jammerId: 'JAM-SPOT-01-TX', direction: 45, duration: 60, enabled: false },
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
    vi.unstubAllGlobals()
  })

  it('renders login independently and protected routes in the product shell', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchSpy = vi.fn()
    const webSocketSpy = vi.fn()
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
    expect(routeRecords[10]?.meta?.title).toBe('交互管理')

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

    expect(router.currentRoute.value.meta.layout).toBe('workspace')
    expect(operatorWrapper.get('h1').text()).toBe('多手段集群通联仿真软件')
    expect(operatorWrapper.get('nav[aria-label="主导航"]')).toBeTruthy()
    expect(operatorWrapper.find('.app-shell__header > .app-shell__navigation').exists()).toBe(true)
    expect(operatorWrapper.html()).not.toContain('brand' + '__status')
    expect(operatorWrapper.html()).not.toContain('status' + '-indicator')
    expect(operatorWrapper.findAll('nav .nav-group')).toHaveLength(3)
    expect(operatorWrapper.findAll('nav .nav-group').map((group) => group.attributes('aria-label')))
      .toEqual(['仿真作业', '能力治理', '系统管理'])
    expect(operatorWrapper.get('#situation-title').text()).toBe('态势主界面')
    expect(operatorWrapper.find('a[href="/login"]').exists()).toBe(false)
    expect(operatorWrapper.findAll('nav a')).toHaveLength(9)
    expect(operatorWrapper.find('a[href="/admin"]').exists()).toBe(false)
    expect(operatorWrapper.find('a[href="/admin/data-exchange"]').exists()).toBe(true)
    const operatorSystemGroup = operatorWrapper.get('[aria-label="系统管理"]')
    expect(operatorSystemGroup.find('a[href="/admin/data-exchange"]').exists()).toBe(true)
    expect(operatorSystemGroup.find('a[href="/admin"]').exists()).toBe(false)
    expect(operatorWrapper.get('[data-testid="identity-username"]').text()).toBe('用户：operator')
    expect(operatorWrapper.get('[data-testid="identity-role"]').text()).toBe('角色：操作员')
    expect(operatorWrapper.get('.app-shell__navigation').text())
      .not.toMatch(/夹具|演示|P0|P1|Mock|页面外壳|shell/)

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
    expect(adminWrapper.findAll('nav a')).toHaveLength(10)
    const adminSystemGroup = adminWrapper.get('[aria-label="系统管理"]')
    expect(adminSystemGroup.find('a[href="/admin/data-exchange"]').exists()).toBe(true)
    expect(adminSystemGroup.find('a[href="/admin"]').exists()).toBe(true)
    expect(adminSystemGroup.findAll('a')).toHaveLength(2)
    expect(adminWrapper.get('[data-testid="identity-username"]').text()).toBe('用户：admin')
    expect(adminWrapper.get('[data-testid="identity-role"]').text()).toBe('角色：管理员')

    const scenario = useScenarioStore(pinia)
    scenario.$patch({ draft: scenarioDraft(), panelState: 'SUCCESS', dirty: true })

    await adminWrapper.get('[data-testid="logout"]').trigger('click')
    await flushPromises()
    expect(auth.principal).toBeNull()
    expect(auth.permissions).toEqual([])
    expect(scenario.$state).toMatchObject({ draft: null, panelState: 'EMPTY', dirty: false })
    expect(router.currentRoute.value.path).toBe('/login')
    expect(adminWrapper.find('.app-shell').exists()).toBe(false)
    expect(adminWrapper.find('[data-testid="identity-panel"]').exists()).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(webSocketSpy).not.toHaveBeenCalled()
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
