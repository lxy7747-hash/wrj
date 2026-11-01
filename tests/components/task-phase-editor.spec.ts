import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDialog, ElInputNumber, ElInput, ElMessage } from 'element-plus'
import { afterEach, expect, it, vi } from 'vitest'
import TaskPhaseEditor from '../../src/components/scenarios/TaskPhaseEditor.vue'
import type { TaskPhase } from '../../src/contracts/domain-models'

enableAutoUnmount(afterEach)
afterEach(() => ElMessage.closeAll())

async function clickDialog(testId: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  expect(button).not.toBeNull()
  button!.click()
  await flushPromises()
}

it('通过弹框确认添加阶段，既有编辑区间和移除仍保留，错误计划原位提示', async () => {
  const wrapper: VueWrapper = mount(TaskPhaseEditor, { props: { duration: 10, modelValue: [] as TaskPhase[], disabled: false }, global: { plugins: [ElementPlus] } })
  const value = () => wrapper.emitted('update:modelValue')!.at(-1)![0] as TaskPhase[]
  await wrapper.findAll('button').find(button => button.text() === '添加任务阶段')!.trigger('click')
  await flushPromises()
  expect(wrapper.findComponent(ElDialog).props('modelValue')).toBe(true)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('添加任务阶段')
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  await clickDialog('confirm-task-phase')
  expect(value()).toEqual([{ id: 'PHASE-1', name: '阶段1', startTimeS: 0, endTimeS: 10 }])
  await wrapper.setProps({ modelValue: value() })
  wrapper.findAllComponents(ElInput)[0]!.vm.$emit('update:modelValue', 'TRANSIT')
  await wrapper.setProps({ modelValue: value() })
  wrapper.findAllComponents(ElInputNumber)[1]!.vm.$emit('update:modelValue', 5)
  await wrapper.setProps({ modelValue: value() })
  await wrapper.findAll('button').find(button => button.text() === '添加任务阶段')!.trigger('click')
  await flushPromises()
  expect(wrapper.emitted('update:modelValue')!.at(-1)![0]).toEqual([{ id: 'TRANSIT', name: '阶段1', startTimeS: 0, endTimeS: 5 }])
  await clickDialog('confirm-task-phase')
  await wrapper.setProps({ modelValue: value() })
  expect(value()[1]).toMatchObject({ id: 'PHASE-1', startTimeS: 5, endTimeS: 10 })
  wrapper.findAllComponents(ElInputNumber)[2]!.vm.$emit('update:modelValue', 4)
  await wrapper.setProps({ modelValue: value() }); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('不能重叠')
  await wrapper.findAll('button').find(button => button.text() === '移除')!.trigger('click')
  await wrapper.setProps({ modelValue: value() })
  expect(wrapper.findAll('.phase-row')).toHaveLength(1)
  await wrapper.setProps({ disabled: true })
  expect(wrapper.findAll('button').find(button => button.text() === '添加任务阶段')!.attributes('disabled')).toBeDefined()
  wrapper.unmount()
})

it('取消或关闭新增弹框不写入草稿，再次打开重新取得未占用编号', async () => {
  const phases: TaskPhase[] = [{ id: 'PHASE-1', name: '转场', startTimeS: 0, endTimeS: 5 }]
  const original = structuredClone(phases)
  const wrapper = mount(TaskPhaseEditor, { props: { duration: 10, modelValue: phases }, global: { plugins: [ElementPlus] } })
  const open = async () => {
    await wrapper.findAll('button').find(button => button.text() === '添加任务阶段')!.trigger('click')
    await flushPromises()
  }
  const name = () => wrapper.findAllComponents(ElInput).find(input => input.find('[data-testid="new-phase-name"]').exists())!
  await open()
  name().vm.$emit('update:modelValue', '尚未确认')
  await clickDialog('cancel-task-phase')
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  expect(phases).toEqual(original)
  await open()
  expect(name().props('modelValue')).toBe('阶段2')
  expect(wrapper.findAllComponents(ElInput).find(input => input.find('[data-testid="new-phase-id"]').exists())!.props('modelValue')).toBe('PHASE-2')
  wrapper.findComponent(ElDialog).vm.$emit('update:modelValue', false)
  await flushPromises()
  expect(wrapper.findComponent(ElDialog).props('modelValue')).toBe(false)
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  expect(phases).toEqual(original)
})

it('新增弹框复用阶段校验，缺名称、重复编号、重叠或无效时间均阻止确认', async () => {
  const message = vi.spyOn(ElMessage, 'error').mockReturnValue({ close: vi.fn() })
  const phases: TaskPhase[] = [{ id: 'PHASE-1', name: '转场', startTimeS: 0, endTimeS: 5 }]
  const wrapper = mount(TaskPhaseEditor, { props: { duration: 10, modelValue: phases }, global: { plugins: [ElementPlus] } })
  await wrapper.findAll('button').find(button => button.text() === '添加任务阶段')!.trigger('click')
  await flushPromises()
  const input = (id: string) => wrapper.findAllComponents(ElInput).find(field => field.find(`[data-testid="${id}"]`).exists())!
  const number = (id: string) => wrapper.findAllComponents(ElInputNumber).find(field => field.attributes('data-testid') === id)!
  const rejected = async (text: string) => {
    await clickDialog('confirm-task-phase')
    expect(message).toHaveBeenLastCalledWith(expect.stringContaining(text))
    expect(wrapper.findComponent(ElDialog).props('modelValue')).toBe(true)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(phases).toEqual([{ id: 'PHASE-1', name: '转场', startTimeS: 0, endTimeS: 5 }])
  }
  input('new-phase-name').vm.$emit('update:modelValue', ' ')
  await rejected('阶段名称')
  input('new-phase-name').vm.$emit('update:modelValue', '任务执行')
  input('new-phase-id').vm.$emit('update:modelValue', 'PHASE-1')
  await rejected('阶段编号须唯一')
  input('new-phase-id').vm.$emit('update:modelValue', 'PHASE-2')
  number('new-phase-start').vm.$emit('update:modelValue', 4)
  await rejected('不能重叠')
  number('new-phase-start').vm.$emit('update:modelValue', 5)
  number('new-phase-end').vm.$emit('update:modelValue', 5)
  await rejected('结束时刻须晚于开始时刻')
  number('new-phase-end').vm.$emit('update:modelValue', undefined)
  await rejected('阶段时间')
  number('new-phase-end').vm.$emit('update:modelValue', 10)
  await clickDialog('confirm-task-phase')
  expect(wrapper.emitted('update:modelValue')).toHaveLength(1)
  expect(wrapper.emitted('update:modelValue')![0]![0]).toEqual([...phases, { id: 'PHASE-2', name: '任务执行', startTimeS: 5, endTimeS: 10 }])
})

it('锁定、阶段数据或时长改变后关闭未确认的副本，不允许旧输入继续添加', async () => {
  const wrapper: VueWrapper = mount(TaskPhaseEditor, { props: { duration: 10, modelValue: [] as TaskPhase[], disabled: false }, global: { plugins: [ElementPlus] } })
  const open = async () => {
    await wrapper.findAll('button').find(button => button.text() === '添加任务阶段')!.trigger('click')
    await flushPromises()
    expect(wrapper.findComponent(ElDialog).props('modelValue')).toBe(true)
  }
  await open()
  await wrapper.setProps({ disabled: true })
  await wrapper.setProps({ disabled: false })
  expect(wrapper.findComponent(ElDialog).props('modelValue')).toBe(false)
  await open()
  await wrapper.setProps({ modelValue: [{ id: 'PHASE-1', name: '已更新计划', startTimeS: 0, endTimeS: 5 }] })
  expect(wrapper.findComponent(ElDialog).props('modelValue')).toBe(false)
  await open()
  await wrapper.setProps({ duration: 8 })
  expect(wrapper.findComponent(ElDialog).props('modelValue')).toBe(false)
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
})

it.each([0, NaN])('无效任务时长 %s 不可添加阶段', async duration => {
  const wrapper = mount(TaskPhaseEditor, { props: { duration }, global: { plugins: [ElementPlus] } })
  const add = wrapper.findAll('button').find(button => button.text() === '添加任务阶段')!
  expect(add.attributes('disabled')).toBeDefined()
  await add.trigger('click')
  expect(wrapper.findComponent(ElDialog).props('modelValue')).toBe(false)
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
})

it('达到64阶段上限后不可添加', async () => {
  const phases = Array.from({ length: 64 }, (_, index) => ({ id: `PHASE-${index + 1}`, name: `阶段${index + 1}`, startTimeS: index, endTimeS: index + 1 }))
  const wrapper = mount(TaskPhaseEditor, { props: { duration: 64, modelValue: phases }, global: { plugins: [ElementPlus] } })
  expect(wrapper.findAll('button').find(button => button.text() === '添加任务阶段')!.attributes('disabled')).toBeDefined()
})
