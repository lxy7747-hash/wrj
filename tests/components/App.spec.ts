import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App.vue'

describe('App shell', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the local P0 shell without errors or external requests', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetchSpy = vi.fn()
    const webSocketSpy = vi.fn()
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open')
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('WebSocket', webSocketSpy)

    const wrapper = mount(App)

    expect(wrapper.get('h1').text()).toBe('多手段集群通联仿真软件')
    expect(wrapper.get('[role="status"]').text()).toContain('P0 基础设施已启用')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(webSocketSpy).not.toHaveBeenCalled()
    expect(xhrOpen).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()

    // Resource attributes are audited separately because they can bypass fetch/XHR.
    const externalResources = wrapper
      .findAll('[src], [href]')
      .filter((node) => /^(?:https?:)?\/\//i.test(node.attributes('src') ?? node.attributes('href') ?? ''))
    expect(externalResources).toHaveLength(0)
  })
})
