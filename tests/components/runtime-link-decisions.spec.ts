import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RuntimeLinkDecisionPanel from '../../src/components/situation/RuntimeLinkDecisionPanel.vue'
import type { RuntimeLinkStatus, RuntimeRouteCandidate, RuntimeRouteDecision } from '../../src/features/data-exchange/runtime-link-decisions'
import { adaptRuntimeLinkQuality } from '../../src/features/data-exchange/runtime-link-quality'
import { selectRuntimeQualityViews } from '../../src/features/situation/runtime-quality-view'

enableAutoUnmount(afterEach)
const assessment: RuntimeLinkStatus = { linkId: 'L-A', frameId: 12, simulationTime: 3, status: 'UP', available: true,
  reason: 'AVAILABLE', stableFrames: 3, thresholdVersion: 'LOCAL-V1.2', gxbDb: 12, ber: 1e-6, receivedPowerDbm: -80 }
const candidate: RuntimeRouteCandidate = { routeKey: 'route', linkId: 'L-A', direction: 'FORWARD', type: 'SAT', rank: 1,
  eligible: false, eliminationReason: 'INTERFERENCE_POWER_MISSING', gxbDb: 12, ber: 1e-6, interferencePowerDbm: null, stableFrames: 3 }
const decision: RuntimeRouteDecision = { routeKey: 'route', direction: 'REVERSE', frameId: 12, simulationTime: 3,
  previousLinkId: 'L-B', selectedLinkId: 'L-A', state: 'SWITCHED', reason: 'QUALITY_IMPROVEMENT_THRESHOLD_MET', execution: 'LOCAL_DECISION', gxbDb: 12, ber: 1e-6 }

describe('质量判定与选路依据展示', () => {
  it('显示缺测剔除原因、真实输入指标与前后决策，明确尚未确认引擎执行', async () => {
    const wrapper = mount(RuntimeLinkDecisionPanel, { props: {
      statuses: new Map([['L-A', assessment]]), candidates: [candidate], decisions: [decision], events: [decision],
    } })
    const text = wrapper.text()
    expect(text).toContain('引擎尚未确认执行')
    expect(text).toContain('L-A · 正常')
    expect(text).toContain('缺少接收干扰功率测量')
    expect(text).toContain('L-B → L-A')
    expect(text).toContain('帧 12')
    expect(text).toContain('GXB 12 dB · BER 1.0e-6')
    expect(wrapper.get('tbody tr').text()).toContain('暂无数据')
    await wrapper.setProps({ statuses: new Map(), candidates: [], decisions: [], events: [] } as never)
    expect(wrapper.find('tbody tr').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('L-B → L-A')
    expect(wrapper.text()).toContain('尚无决策变更')
  })

  it('详情投影只附加同链路、同帧、同时刻的状态判定', () => {
    const result = adaptRuntimeLinkQuality({ links: [{ link_id: 'E-A', tx_platform: 'TX', rx_platform: 'RX', tx_port: 'TP', rx_port: 'RP', quality: { gxb_db: 12, ber: 1e-6 } }] })
    if (!result.data) throw new Error('测试输入必须能通过质量合同校验')
    const snapshot = { frameId: 12, simulationTime: 3, data: result.data }
    const bindings = [{ linkId: 'L-A', sourceLinkId: 'E-A', sourcePlatformId: 'TX', destinationPlatformId: 'RX', sourcePortId: 'TP', destinationPortId: 'RP' }]
    const links = [{ linkId: 'L-A', sourceName: '发送节点', destinationName: '接收节点' }]
    expect(selectRuntimeQualityViews(snapshot, bindings, links, 3, new Map([['L-A', assessment]])).get('L-A')!.assessment).toEqual(assessment)
    for (const stale of [{ ...assessment, frameId: 11 }, { ...assessment, simulationTime: 2.75 }, { ...assessment, linkId: 'L-B' }]) {
      expect(selectRuntimeQualityViews(snapshot, bindings, links, 3, new Map([['L-A', stale]])).get('L-A')!.assessment).toBeUndefined()
    }
  })
})
