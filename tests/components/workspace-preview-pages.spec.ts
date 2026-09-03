import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/WorkspacePreview.vue', () => ({
  default: {
    name: 'WorkspacePreview',
    template: '<div data-testid="workspace-preview-delegate" />',
  },
}))

import WorkspacePreview from '../../src/components/WorkspacePreview.vue'
import BatchesPage from '../../src/pages/batches/batches.vue'
import ReplaysPage from '../../src/pages/replays/replays.vue'
import TraceabilityPage from '../../src/pages/traceability/traceability.vue'

describe('工作区预览页面', () => {
  it('将三个薄页面统一委托给 WorkspacePreview', () => {
    const pages = [
      BatchesPage,
      ReplaysPage,
      TraceabilityPage,
    ]

    pages.forEach((page) => {
      const wrapper = mount(page)

      expect(wrapper.findComponent(WorkspacePreview).exists()).toBe(true)
      expect(wrapper.findAll('[data-testid="workspace-preview-delegate"]')).toHaveLength(1)
      wrapper.unmount()
    })
  })
})
