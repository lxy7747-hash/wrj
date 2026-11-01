import { mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it, vi } from 'vitest'
import type { Platform, ValidationIssue } from '../../src/contracts/domain-models'
import PlatformEditorDialog from '../../src/components/scenarios/PlatformEditorDialog.vue'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'

function validatePlatform(platform: Platform): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!platform.name.trim()) issues.push({ severity: 'ERROR', code: 'PLATFORM_NAME_REQUIRED', message: '平台名称不能为空。', fieldPath: 'name' })
  if (platform.initialPosition.longitude > 180) issues.push({ severity: 'WARNING', code: 'PLATFORM_LONGITUDE_RANGE', message: '经度超出建议范围。', fieldPath: 'initialPosition.longitude' })
  return issues
}

function mountEditor(platform: Platform) {
  return mount(PlatformEditorDialog, {
    props: {
      modelValue: true,
      platform,
      editing: true,
      error: '',
      pending: false,
      locked: false,
      validate: validatePlatform,
      businessTypeOptions: [{ value: 'AIRBORNE_MISSION_CLUSTER', label: '空中无人作业集群' }],
      supportingTypeOptions: [],
      satelliteTypeOptions: [],
      businessTypeCounts: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: 3 },
      businessTypeLimits: { REAR_COMMAND_NODE: 1, FORWARD_RELAY_NODE: 1, GROUND_CLUSTER_COMMAND_NODE: 1, AIRBORNE_MISSION_CLUSTER: 47 },
      deploymentDomainLabels: { ground: '地面', air: '空中', space: '空间' },
    },
    global: {
      plugins: [ElementPlus],
      stubs: { ElDialog: { template: '<section><slot /><slot name="footer" /></section>' } },
    },
  })
}

describe('PlatformEditorDialog 即时字段校验', () => {
  it('未确认时编辑后显示字段错误，修正后立即清除', async () => {
    const platform = structuredClone(fixtureSource.scenario.platforms[3]) as Platform
    const wrapper = mountEditor(platform)

    const name = wrapper.get('[data-testid="platform-name"]')
    await name.setValue('')
    await vi.waitFor(() => expect(wrapper.text()).toContain('平台名称不能为空。'))
    expect(wrapper.emitted('invalid')).toBeUndefined()

    await name.setValue('空中无人作业节点 U01')
    await vi.waitFor(() => expect(wrapper.text()).not.toContain('平台名称不能为空。'))
    wrapper.unmount()
  })

  it('取消编辑不会改动传入的平台对象', async () => {
    const platform = structuredClone(fixtureSource.scenario.platforms[3]) as Platform
    const original = structuredClone(platform)
    const wrapper = mountEditor(platform)

    await wrapper.get('[data-testid="platform-name"]').setValue('仅在本地副本中修改')
    await wrapper.get('[data-testid="cancel-platform"]').trigger('click')

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
    expect(platform).toEqual(original)
    wrapper.unmount()
  })

  it('数值字段保留输入值并在字段下展示警告', async () => {
    const platform = structuredClone(fixtureSource.scenario.platforms[3]) as Platform
    const wrapper = mountEditor(platform)

    const longitude = wrapper.get('[data-testid="platform-longitude"]').find('input')
    await longitude.setValue('181')
    await vi.waitFor(() => expect(wrapper.text()).toContain('警告：经度超出建议范围。'))

    await longitude.setValue('120')
    await vi.waitFor(() => expect(wrapper.text()).not.toContain('经度超出建议范围。'))
    wrapper.unmount()
  })
})
