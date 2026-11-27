import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { describe, expect, it, vi } from 'vitest'
import ScriptPreviewDialog from '../../src/components/scenarios/ScriptPreviewDialog.vue'
import type { ScenarioDraft, ScriptContract } from '../../src/contracts/domain-models'
import { createTemplateScenario } from '../fixtures/template-scenario'
import { annotateScriptSectionLines } from '../../src/features/scenarios/script-inline-comments'

describe('脚本预览前端中文注释（仅视觉展示）', () => {
  it('按六大验收类别准确注释平台、运动、通信、传感器、干扰与时序，并区分上下文', () => {
    const draft = createTemplateScenario()
    const firstUav = draft.config.platforms.find(p => p.type === 'FORWARD_RELAY_NODE' || p.type === 'AIRBORNE_MISSION_CLUSTER')!
    firstUav.name = '高空前出中继'

    const insLines = [
      'platform mission_uav_01 MISSION_UAV_PLATFORM',
      '  side blue',
      '  route',
      '    position 24.66n 119.55e altitude 3200 m speed 150 m/s',
      '    position 24.30n 119.50e altitude 8000 m speed 150 m/s',
      '    label LOITER',
      '    position 24.30n 119.53e altitude 8000 m speed 120 m/s',
      '    goto LOITER',
      '  end_route',
      '  execute at_time 1200 sec absolute',
      '    PLATFORM.FollowRoute("return_mission_uav_01");',
      '  end_execute',
      'end_platform',
      'platform jammer_station_01 GROUND_JAMMER_STATION',
      '  side red',
      '  double detection_range_nm = 30;',
      'end_platform',
    ]
    const ins = annotateScriptSectionLines('comm_platform_INS.txt', insLines, draft.config)
    expect(ins[0]).toMatchObject({ category: 'platform', placement: 'after' })
    expect(ins[0]!.comment).toContain('ID=mission_uav_01（高空前出中继）')
    expect(ins[0]!.comment).toContain('任务无人机平台')
    expect(ins[1]).toMatchObject({ category: 'platform', comment: '  // 阵营：蓝方' })
    expect(ins[2]).toMatchObject({ category: 'motion' })
    expect(ins[3]).toMatchObject({ category: 'platform' })
    expect(ins[3]!.comment).toContain('北纬 24.66°，东经 119.55°，高度 3200 m，速度 150 m/s')
    expect(ins[4]).toMatchObject({ category: 'motion' })
    expect(ins[4]!.comment).toContain('航点 2')
    expect(ins[5]).toMatchObject({ category: 'motion' })
    expect(ins[5]!.comment).toContain('盘旋循环起点')
    expect(ins[6]!.comment).toContain('盘旋航点 3')
    expect(ins[7]).toMatchObject({ category: 'motion' })
    expect(ins[9]).toMatchObject({ category: 'motion' })
    expect(ins[9]!.comment).toContain('1200 sec')
    expect(ins[14]).toMatchObject({ category: 'platform', comment: '  // 阵营：红方' })
    expect(ins[15]).toMatchObject({ category: 'sensor' })
    expect(ins[15]!.comment).toContain('30 海里')

    const mixedLines = [
      'sensor detection_radar WSF_RADAR_SENSOR',
      '  transmitter',
      '    frequency 2.4 GHz',
      '  end_transmitter',
      'end_sensor',
      'weapon alq99_jammer WSF_RF_JAMMER',
      '  transmitter',
      '    frequency 2.4 GHz',
      '  end_transmitter',
      'end_weapon',
      'comm sat_link_a WSF_RADIO_TRANSCEIVER',
      '  transmitter',
      '    frequency 14.2 GHz',
      '  end_transmitter',
      'end_comm',
      'add processor link_calc WSF_LINK_CALC_PROCESSOR',
      `  hot_link_fw ${'{"x":1}'.repeat(30)}`,
      `  jammer_param ${'{"j":1}'.repeat(30)}`,
      'end_processor',
    ]
    const mixed = annotateScriptSectionLines('comm_platform_REAR.txt', mixedLines, draft.config)
    expect(mixed[2]).toMatchObject({ category: 'sensor', placement: 'after' })
    expect(mixed[7]).toMatchObject({ category: 'jammer', placement: 'after' })
    expect(mixed[12]).toMatchObject({ category: 'communication', placement: 'after' })
    expect(mixed[16]).toMatchObject({ category: 'communication', placement: 'before', comment: '[通信·前向热链路由]' })
    expect(mixed[17]).toMatchObject({ category: 'jammer', placement: 'before', comment: '[干扰·干扰参数配置]' })

    expect(annotateScriptSectionLines('mapping.json', ['// {', '//   "entry": "comm_SimSetup.txt"']).every(v => v === null)).toBe(true)
  })

  it('脚本预览弹框默认开启中文注释、支持按类筛选且不改变原始脚本文本内容', async () => {
    const draft: ScenarioDraft = createTemplateScenario()
    const rawText = [
      '// ===== comm_platform_INS.txt =====',
      'platform rear_comm_vehicle REAR_COMM_PLATFORM',
      '  side blue',
      '  position 24.80n 118.50e',
      '  altitude 0 m',
      '  route',
      '    position 24.90n 118.60e altitude 100 m speed 20 m/s',
      '  end_route',
      'end_platform',
    ].join('\n')
    const script: ScriptContract = {
      scriptId: 'SCRIPT-COMMENT',
      taskId: 'TASK-001',
      scenarioId: draft.config.scenario.id,
      configVersion: `${draft.config.scenario.id}-v${draft.revision}`,
      target: 'AFSIM 2.9.0',
      checksum: 'FNV1A-MOCK-00000001',
      preview: rawText,
      generatedTime: '2026-11-25T01:00:00Z',
    }
    const wrapper = mount(ScriptPreviewDialog, {
      props: { modelValue: true, script, draft },
      global: { plugins: [ElementPlus], stubs: { teleport: true } },
    })
    await flushPromises()
    try {
      const code = wrapper.get('[data-testid="standalone-script-preview"]')
      // 关键保障：虚拟注释通过 data-comment + CSS 渲染，绝不污染 DOM textContent（复制原文与单测均零影响）
      expect(code.element.textContent).toBe(rawText)
      const select = wrapper.get('[data-testid="script-comment-mode"]')
      expect((select.element as HTMLSelectElement).value).toBe('all')

      const allComments = wrapper.findAll('[data-testid="script-inline-comment"]').map(el => el.attributes('data-comment'))
      expect(allComments.some(text => text?.includes('平台实例'))).toBe(true)
      expect(allComments.some(text => text?.includes('阵营：蓝方'))).toBe(true)
      expect(allComments.some(text => text?.includes('初始位置'))).toBe(true)
      expect(allComments.some(text => text?.includes('平台主运动航线'))).toBe(true)

      await select.setValue('platform')
      await flushPromises()
      const platformComments = wrapper.findAll('[data-testid="script-inline-comment"]').map(el => el.attributes('data-comment'))
      expect(platformComments.some(text => text?.includes('平台实例'))).toBe(true)
      expect(platformComments.some(text => text?.includes('初始位置'))).toBe(true)
      expect(platformComments.some(text => text?.includes('平台主运动航线'))).toBe(false)
      expect(code.element.textContent).toBe(rawText)

      await select.setValue('off')
      await flushPromises()
      expect(wrapper.findAll('[data-testid="script-inline-comment"]')).toHaveLength(0)
      expect(code.element.textContent).toBe(rawText)
    } finally {
      wrapper.unmount()
    }
  })

  it('按需展开五类参数及中文注释，对齐原始行号并复制原文', async () => {
    const draft = createTemplateScenario()
    const parameters = {
      hot_link_ret: { link1: [
        { platform: 'U1', inPort: '', outPort: 'sat_link' },
        { platform: 'REAR', inPort: 'sat_link_a', outPort: '' },
      ] },
      hot_link_fw: { link1: [
        { platform: 'REAR', inPort: '', outPort: 'microwave_link' },
        { platform: 'U1', inPort: 'microwave_link', outPort: '' },
      ] },
      port_params: [{
        platform_type: 'COMMAND_VEHICLE_PLATFORM',
        comm_params: [
          { comm_name: 'c_band_downlink', transmitter: { frequency_ghz: 5 } },
          { comm_name: 'unknown_port' },
        ],
      }],
      natural_environment: { rain: { rain_rate_mm_hr: 25 } },
      jammer_param: { jammers: [{ weapon_band_params: [{ sweep_duty_cycle: 0.5 }] }] },
    }
    const malformed = '  port_params {"invalid":}'
    const currentFile = [
      '// ===== comm_platform_REAR.txt =====',
      ...Object.entries(parameters).map(([name, value]) => `  ${name} ${JSON.stringify(value)}`),
      malformed,
      'end_processor',
    ].join('\r\n')
    const preview = currentFile + '\r\n// ===== observers.txt =====\r\nend_observer'
    const script: ScriptContract = {
      scriptId: 'SCRIPT-PARAMETERS',
      taskId: 'TASK-001',
      scenarioId: draft.config.scenario.id,
      configVersion: `${draft.config.scenario.id}-v${draft.revision}`,
      target: 'AFSIM 2.9.0',
      checksum: 'FNV1A-MOCK-00000001',
      preview,
      generatedTime: '2026-11-25T01:00:00Z',
    }
    const wrapper = mount(ScriptPreviewDialog, {
      props: { modelValue: true, script, draft },
      global: { plugins: [ElementPlus], stubs: { teleport: true } },
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      await flushPromises()
      const select = wrapper.get('[data-testid="script-comment-mode"]')
      const buttons = wrapper.findAll('[data-script-parameters]')
      expect(buttons.map(button => button.attributes('data-script-parameters'))).toEqual(Object.keys(parameters))
      const code = wrapper.get('[data-testid="standalone-script-preview"]')
      const gutter = wrapper.get('.script-preview-gutter')
      expect(code.element.textContent).toBe(currentFile)
      expect(gutter.text()).toBe('1\n2\n3\n4\n5\n6\n7\n8')
      const parameterComments = () => wrapper.findAll('[data-testid="script-parameter-comment"]')
        .map(comment => comment.attributes('data-comment'))

      const portToggle = wrapper.get('[data-script-parameters="port_params"]')
      expect(portToggle.element.previousElementSibling?.hasAttribute('hidden')).toBe(true)
      await portToggle.trigger('click')
      expect(portToggle.attributes('aria-expanded')).toBe('true')
      const formatted = wrapper.get('[data-testid="script-parameters-body"]').element.textContent ?? ''
      expect(formatted).toBe('\n' + JSON.stringify(parameters.port_params, null, 2).replace(/^/gmu, '    '))
      expect(parameterComments()).toEqual([
        '  // 平台类型 · 地面集群指挥车平台',
        '  // 通信端口列表',
        '  // 通信端口名称 · C 波段下行端口',
        '  // 发射参数',
        '  // 频率（GHz）',
        '  // 通信端口名称',
      ])
      expect(gutter.text()).toBe(`1\n2\n3\n4${'\n'.repeat(formatted.split('\n').length)}5\n6\n7\n8`)
      expect(code.element.textContent).toContain(malformed)

      await select.setValue('off')
      expect(parameterComments()).toEqual([])
      expect(wrapper.get('[data-testid="script-parameters-body"]').element.textContent).toBe(formatted)
      await select.setValue('communication')
      expect(parameterComments()).toContain('  // 频率（GHz）')

      await wrapper.get('[data-testid="copy-current-script"]').trigger('click')
      await wrapper.get('[data-testid="copy-all-script"]').trigger('click')
      expect(writeText.mock.calls).toEqual([[currentFile], [preview]])

      await portToggle.trigger('click')
      expect(portToggle.attributes('aria-expanded')).toBe('false')
      expect(wrapper.find('[data-testid="script-parameters-body"]').exists()).toBe(false)
      expect(code.element.textContent).toBe(currentFile)
      expect(gutter.text()).toBe('1\n2\n3\n4\n5\n6\n7\n8')

      for (const [name, labels] of [
        ['hot_link_ret', ['  // 接收端口', '  // 发送端口 · 卫星链路端口', '  // 接收端口 · 卫星链路端口 A', '  // 发送端口']],
        ['hot_link_fw', ['  // 接收端口', '  // 发送端口 · 微波链路端口', '  // 接收端口 · 微波链路端口', '  // 发送端口']],
      ] as const) {
        await wrapper.get(`[data-script-parameters="${name}"]`).trigger('click')
        expect(parameterComments().filter(comment => /^  \/\/ (接收|发送)端口/u.test(comment ?? ''))).toEqual(labels)
      }
      await wrapper.get('[data-script-parameters="natural_environment"]').trigger('click')
      expect(parameterComments()).toContain('  // 降雨强度（mm/h）')
      await wrapper.get('[data-script-parameters="jammer_param"]').trigger('click')
      expect(parameterComments()).toEqual([])
      await select.setValue('jammer')
      expect(parameterComments()).toContain('  // 扫频占空比（0～1）')
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
      ElMessage.closeAll()
      wrapper.unmount()
    }
  })
})
