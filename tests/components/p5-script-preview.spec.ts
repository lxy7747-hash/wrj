import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { expect, it } from 'vitest'
import ScriptPreview from '../../src/components/scenarios/ScriptPreview.vue'

it('脚本预览区分可追溯预览入口与新模板执行入口', () => {
  const wrapper = mount(ScriptPreview, { props: {
    state: 'SUCCESS', resultMessage: '', script: {
      scriptId: 'SCRIPT-P5', taskId: 'TASK-001', scenarioId: 'SCN-001', configVersion: 'SCN-001-v1', target: 'AFSIM 2.9.0',
      checksum: 'P5', preview: '// ===== scenario.txt =====\ninclude_once comm_SimSetup.txt', generatedTime: '2026-11-01T00:00:00Z',
    }, preflight: { valid: true, errors: [], warnings: [] }, locked: false, dirty: false, preflightPassed: true,
  }, global: { plugins: [ElementPlus] } })
  try {
    expect(wrapper.text()).toContain('预览入口scenario.txt')
    expect(wrapper.text()).toContain('执行入口comm_SimSetup.txt')
    expect(wrapper.get('[data-testid="script-next-step"]').text()).toContain('预览未执行引擎校验')
  } finally { wrapper.unmount() }
})
