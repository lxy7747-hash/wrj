import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import type { CapabilityState, ValidationResult } from '../../src/contracts/domain-models'
import ValidationPanel from '../../src/components/scenarios/ValidationPanel.vue'

const emptyValidation: ValidationResult = { valid: true, errors: [], warnings: [] }

function mountValidationPanel(overrides: Partial<{
  pending: boolean
  panelState: CapabilityState
  resultMessage: string
  validation: ValidationResult
  completed: boolean
}> = {}) {
  return mount(ValidationPanel, {
    props: {
      pending: false,
      panelState: 'SUCCESS',
      resultMessage: '',
      validation: emptyValidation,
      completed: false,
      ...overrides,
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('场景拆分面板', () => {
  it('覆盖整体校验的等待、请求失败、空态和成功态', () => {
    const pending = mountValidationPanel({ pending: true })
    expect(pending.text()).toContain('正在校验当前完整场景')
    pending.unmount()

    const failed = mountValidationPanel({ panelState: 'ERROR', resultMessage: '校验服务不可用。' })
    expect(failed.get('[data-testid="validation-request-error"]').text()).toContain('校验服务不可用')
    failed.unmount()

    const empty = mountValidationPanel()
    expect(empty.text()).toContain('可单独执行整体校验')
    expect(empty.text()).toContain('校验并保存')
    empty.unmount()

    const success = mountValidationPanel({ completed: true })
    expect(success.text()).toContain('整体校验通过')
    success.unmount()
  })

  it('展示错误和警告并向父级发送定位问题', async () => {
    const warning = {
      severity: 'WARNING' as const,
      code: 'RAIN_LOSS_DEFAULT',
      message: '雨衰参数需要确认。',
      fieldPath: 'scenario.environment.rainLossDbPerKm',
    }
    const wrapper = mountValidationPanel({
      completed: true,
      resultMessage: '发现 1 个警告。',
      validation: { valid: true, errors: [], warnings: [warning] },
    })
    expect(wrapper.text()).toContain('警告不阻断保存')
    await wrapper.get('[data-testid="locate-validation-issue-0"]').trigger('click')
    expect(wrapper.emitted('locate')).toEqual([[warning]])
    wrapper.unmount()

    const error = mountValidationPanel({
      completed: true,
      resultMessage: '发现 1 个错误。',
      validation: {
        valid: false,
        errors: [{ ...warning, severity: 'ERROR', code: 'INVALID_TIME_STEP' }],
        warnings: [],
      },
    })
    expect(error.text()).toContain('错误')
    expect(error.text()).not.toContain('警告不阻断保存')
    error.unmount()
  })
})
