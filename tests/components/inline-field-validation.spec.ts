import { nextTick, ref } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElFormItem } from 'element-plus'
import { afterEach, expect, it } from 'vitest'
import LinkSettingsPanel from '../../src/components/scenarios/LinkSettingsPanel.vue'
import TaskPhaseEditor from '../../src/components/scenarios/TaskPhaseEditor.vue'
import { readLinkSettings } from '../../src/features/scenarios/link-settings'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ScenarioConfig, TaskPhase } from '../../src/contracts/domain-models'

enableAutoUnmount(afterEach)

const dialogStub = { props: ['modelValue'], template: '<section v-if="modelValue"><slot /><slot name="footer" /></section>' }

function formItemFor(wrapper: ReturnType<typeof mount>, testId: string) {
  return wrapper.findAllComponents(ElFormItem).find(item => item.find(`[data-testid="${testId}"]`).exists())!
}

it('链路设置把父级实时校验文字显示在字段下方，修正后立即消失', async () => {
  const config = structuredClone(fixtureSource.scenario) as ScenarioConfig
  const message = ref('干扰圈半径必须在 1～100 km 之间。')
  const wrapper = mount(LinkSettingsPanel, {
    props: {
      modelValue: readLinkSettings(config), dialogVisible: true, platforms: config.platforms, links: config.links,
      jammers: config.jammers, disabled: false,
      typeOptions: [{ value: 'SAT', label: '卫星' }],
      fieldMessage: (path: string) => path === 'linkCalc.jammingRangeKm' ? message.value : '',
    },
    global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
  })

  const range = formItemFor(wrapper, 'link-calc-jammingRangeKm')
  expect(range.props('error')).toBe('干扰圈半径必须在 1～100 km 之间。')

  message.value = ''
  await nextTick()
  expect(range.props('error')).toBe('')
})

it('既有任务阶段字段在编辑后即时提示并在修正后清除', async () => {
  const phases: TaskPhase[] = [{ id: 'PHASE-1', name: ' ', startTimeS: 0, endTimeS: 10 }]
  const wrapper = mount(TaskPhaseEditor, { props: { duration: 10, modelValue: phases, disabled: false }, global: { plugins: [ElementPlus] } })
  const nameItem = wrapper.findAllComponents(ElFormItem).find(item => item.find('[aria-label="阶段1名称"]').exists())!
  expect(nameItem.props('error')).toContain('阶段名称')

  await wrapper.get('[aria-label="阶段1名称"]').setValue('任务执行')
  const corrected = wrapper.emitted('update:modelValue')!.at(-1)![0] as TaskPhase[]
  await (wrapper as any).setProps({ modelValue: corrected })
  expect(nameItem.props('error')).toBe('')
})

it('新增任务阶段草稿也会在输入时显示字段下错误，取消前不会写入', async () => {
  const wrapper = mount(TaskPhaseEditor, {
    props: { duration: 10, modelValue: [] as TaskPhase[], disabled: false },
    global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
  })
  await wrapper.findAll('button').find(button => button.text() === '添加任务阶段')!.trigger('click')
  await flushPromises()
  const name = wrapper.get('[data-testid="new-phase-name"]')
  await name.setValue(' ')
  await nextTick()
  const item = formItemFor(wrapper, 'new-phase-name')
  expect(item.props('error')).toContain('阶段名称')

  await name.setValue('任务执行')
  await nextTick()
  expect(item.props('error')).toBe('')
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
})

it('新增阶段的数值输入保留非法值并在输入时即时显示字段错误', async () => {
  const wrapper = mount(TaskPhaseEditor, {
    props: { duration: 10, modelValue: [] as TaskPhase[], disabled: false },
    global: { plugins: [ElementPlus], stubs: { ElDialog: dialogStub } },
  })
  await wrapper.findAll('button').find(button => button.text() === '添加任务阶段')!.trigger('click')
  await flushPromises()

  await wrapper.get('[data-testid="new-phase-end"] input').setValue('0')
  await nextTick()
  const end = formItemFor(wrapper, 'new-phase-end')
  expect(end.props('error')).toContain('结束时刻须晚于开始时刻')
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
})
