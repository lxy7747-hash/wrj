import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it } from 'vitest'
import type { CapabilityState, ValidationResult } from '../../src/contracts/domain-models'
import ValidationPanel from '../../src/components/scenarios/ValidationPanel.vue'
import PlatformEditorDialog from '../../src/components/scenarios/PlatformEditorDialog.vue'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { Platform } from '../../src/contracts/domain-models'

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
  it.each([[false, 47], [false, 46], [true, 47]] as const)('数量额度：编辑=%s，已有=%s', async (editing, count) => {
    const wrapper = mount(PlatformEditorDialog, {
      props: {
        modelValue: true, platform: structuredClone(fixtureSource.scenario.platforms[3]) as Platform,
        editing, error: '', pending: false, locked: false,
        businessTypeOptions: [{ value: 'AIRBORNE_MISSION_CLUSTER', label: '空中无人作业集群' }],
        supportingTypeOptions: [{ value: 'COMMUNICATION_SATELLITE', label: '通信卫星' }],
        satelliteTypeOptions: [{ value: 'TIANTONG', label: '天通卫星' }, { value: 'SHENTONG', label: '神通卫星' }],
        businessTypeCounts: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: count },
        businessTypeLimits: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: 47 },
        deploymentDomainLabels: { ground: '地面', air: '空中', space: '空间' },
      },
      global: { plugins: [ElementPlus], stubs: { ElDialog: { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' } } },
    })
    await flushPromises()
    const number = wrapper.findAllComponents({ name: 'ElInputNumber' }).find((item) => item.attributes('data-testid') === 'platform-quantity')
    const disabled = !editing && count === 47
    if (editing) expect(number).toBeUndefined()
    else {
      expect(number!.props('max')).toBe(47 - count)
      expect(number!.props('disabled')).toBe(disabled)
    }
    expect(wrapper.get('[data-testid="apply-platform"]').attributes('disabled') !== undefined).toBe(disabled)
    expect(wrapper.findAllComponents({ name: 'ElOptionGroup' }).map((group) => group.props('label'))).toEqual(['信息节点', '支撑实体（不计入50个信息节点）'])
    await wrapper.get('[data-testid="apply-platform"]').trigger('click')
    expect(wrapper.emitted('apply')?.length ?? 0).toBe(disabled ? 0 : 1)
    wrapper.unmount()
  })

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
