import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/WorkspacePreview.vue', () => ({
  default: {
    name: 'WorkspacePreview',
    template: '<div data-testid="workspace-preview-delegate" />',
  },
}))

import WorkspacePreview from '../../src/components/WorkspacePreview.vue'
import TraceabilityPage from '../../src/pages/traceability/traceability.vue'

describe('工作区预览页面', () => {
  it('将尚未实施的追踪页面委托给 WorkspacePreview', () => {
    const wrapper = mount(TraceabilityPage)

    expect(wrapper.findComponent(WorkspacePreview).exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="workspace-preview-delegate"]')).toHaveLength(1)
    wrapper.unmount()
  })
})
