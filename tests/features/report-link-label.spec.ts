// @vitest-environment node
import { expect, it } from 'vitest'
import { reportLinkLabel } from '../../src/features/reports/report-link-label'

it.each([
  ['c_forward_command_relay', 'C 波段数传链路 · 前向 · 指挥车与中继节点'],
  ['c_forward_relay_mission_uav_02', 'C 波段数传链路 · 前向 · 中继节点与任务无人机 02'],
  ['c_return_mission_uav_04_relay', 'C 波段数传链路 · 返向 · 任务无人机 04与中继节点'],
  ['fiber_return', '光纤链路 · 返向'],
  ['mw_forward_relay_mission_uav_02', '微波链路 · 前向 · 中继节点与任务无人机 02'],
  ['EXTERNAL-9', '链路 1'],
])('归档编号 %s 显示中文链路名', (id, label) => {
  expect(reportLinkLabel(id, 0)).toBe(label)
})

it('使用快照保留的类型为未知编号提供中文名称', () => {
  expect(reportLinkLabel('EXTERNAL-9', 2, 'MICROWAVE')).toBe('微波链路 3')
})

it('下拉链路名优先使用中文端点名称，无中文名称时使用链路别名', () => {
  const id = 'c_forward_command_relay'
  expect(reportLinkLabel(id, 0, 'DATALINK', ['节点甲A', '节点乙'])).toBe('C 波段数传链路 · 前向 · 节点甲A → 节点乙')
  expect(reportLinkLabel(id, 0, 'DATALINK', ['节点 N1', 'relay_uav'])).toBe('C 波段数传链路 · 前向 · 指挥车与中继节点')
})
