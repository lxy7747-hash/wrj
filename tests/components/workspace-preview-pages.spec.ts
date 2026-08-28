import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/components/WorkspacePreview.vue', () => ({
  default: {
    name: 'WorkspacePreview',
    template: '<div data-testid="workspace-preview-delegate" />',
  },
}))

import WorkspacePreview from '../../src/components/WorkspacePreview.vue'
import BatchesPage from '../../src/pages/batches.vue'
import ReportsPage from '../../src/pages/reports.vue'
import ReplaysPage from '../../src/pages/replays.vue'
import ScenariosPage from '../../src/pages/scenarios.vue'
import TraceabilityPage from '../../src/pages/traceability.vue'

describe('工作区预览页面', () => {
  it('将五个薄页面统一委托给 WorkspacePreview', () => {
    const pages = [
      BatchesPage,
      ReportsPage,
      ReplaysPage,
      ScenariosPage,
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
