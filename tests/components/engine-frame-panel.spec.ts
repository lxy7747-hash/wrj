import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElSelect } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineFrameSnapshot, EngineLinkSegment, EngineRouteSwitch, LinkType } from '../../src/contracts/domain-models'
import EngineFramePanel from '../../src/components/situation/EngineFramePanel.vue'
import LinkQualityDialog from '../../src/components/situation/LinkQualityDialog.vue'
import initial from '../fixtures/engine-frame/websocket-new/fream001.json'
import detected from '../fixtures/engine-frame/websocket-new/fream_chenge2.json'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
import { useRuntimeQualityStore } from '../../src/stores/runtime-quality'
import { useSimulationStore } from '../../src/stores/simulation'

const losses = { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: null }
const quality = { gxbDb: null, ber: null, rxPowerDbw: null, rxPowerDbm: null }
const inputTrace = { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] }
const segment = (linkId: string, scenarioLinkId: string, type: LinkType, sourcePlatformId: string, sourcePort: string, targetPlatformId: string, targetPort: string, status: EngineLinkSegment['status'] = 'UP', error: string | null = null): EngineLinkSegment => ({
  linkId, linkIds: [scenarioLinkId], sourceName: sourcePlatformId, sourcePlatformId, sourcePort, targetName: targetPlatformId, targetPlatformId, targetPort,
  status, engineStatus: status === 'UP' ? 'AVAILABLE' : 'RISK', error, distanceM: null, losses, quality, inputTrace,
})
const node = (platformId: string, inPort: string, outPort: string) => ({ platformName: platformId, platformId, inPort, outPort })
const switchRoute = (oldNodes: EngineRouteSwitch['oldNodes'], nodes: EngineRouteSwitch['nodes']): EngineRouteSwitch => ({
  pathId: 'new-path', direction: 'FORWARD', sourceName: 'N1', targetName: 'N3', sourcePlatformId: 'N1', targetPlatformId: 'N3', transTypes: [], nodes,
  oldPathId: 'old-path', oldNodes, reasons: [],
})

let pinia: Pinia
let wrapper: VueWrapper | undefined

function configureStore(): void {
  const frame: EngineFrameSnapshot = {
    kind: 'ENGINE_FRAME', runId: 'RUN-1', engineEpoch: 0, frameId: 7, simulationTime: 12.5, modelVersion: null, modulation: null,
    links: [
      segment('seg-old', 'L-OLD', 'MICROWAVE', 'N1', 'old-out', 'N2', 'old-in'),
      segment('seg-new', 'L-NEW', 'LASER', 'N1', 'new-out', 'N3', 'new-in', 'DEGRADED'),
      segment('seg-error', 'L-ERROR', 'DATALINK', 'N4', 'error-out', 'N5', 'error-in', 'UP', '引擎计算输入缺失'),
    ],
    jammers: [], routing: { switches: [], alarms: [] }, events: [], initRouting: null,
  }
  const oldNodes = [node('N1', '', 'old-out'), node('N2', 'old-in', '')]
  const newNodes = [node('N1', '', 'new-out'), node('N3', 'new-in', '')]
  const runtime = useRuntimeQualityStore()
  runtime.engineFrame = frame
  runtime.engineSwitches = [
    { frameId: 7, simulationTime: 12.5, route: switchRoute(oldNodes, newNodes) },
    { frameId: 6, simulationTime: 11.5, route: switchRoute(oldNodes, newNodes) },
  ]
  useSimulationStore().$patch({ selectedScene: {
    config: {
      scenario: { id: 'SCN-ENGINE' },
      links: [
        { id: 'L-OLD', type: 'MICROWAVE' }, { id: 'L-NEW', type: 'LASER' }, { id: 'L-ERROR', type: 'DATALINK' },
      ],
      platforms: ['N1', 'N2', 'N3', 'N4', 'N5'].map(id => ({ id, name: `节点-${id}` })),
    },
    revision: 1,
  } as never })
}

function qualityRows(): DOMWrapper<HTMLTableRowElement>[] { return wrapper!.get('table[aria-label="引擎链路质量"] tbody').findAll('tr') }

beforeEach(() => {
  pinia = createPinia(); setActivePinia(pinia); configureStore()
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; disposePinia(pinia) })

describe('EngineFramePanel', () => {
  it('新帧在页面显示秒、GHz、分离损耗与原始时延，并能按秒筛选', async () => {
    const frame = { ...adaptEngineFrameSnapshot(detected).data!, runId: 'RUN-1' }
    useRuntimeQualityStore().engineFrame = frame
    wrapper = mount(EngineFramePanel, { props: { section: 'quality' }, global: { plugins: [pinia, ElementPlus] } })
    expect(wrapper.text()).toContain('350.625 s')
    expect(wrapper.text()).toContain('雨衰损耗（dB）'); expect(wrapper.text()).toContain('云衰损耗（dB）')
    expect(wrapper.text()).toContain('总复合（原值）损耗（dB）'); expect(wrapper.text()).toContain('时延（原值，单位待确认）')
    expect(qualityRows()[0]!.text()).toContain('8.2'); expect(qualityRows()[0]!.text()).toContain('5.9199462')
    const inputs = wrapper.findAllComponents(ElInputNumber)
    await inputs[0]!.vm.$emit('update:modelValue', 350); await inputs[1]!.vm.$emit('update:modelValue', 351); await flushPromises()
    expect(qualityRows()).toHaveLength(5)
    await wrapper.setProps({ section: 'jammers' })
    expect(wrapper.text()).toContain('探测频率 2400000000 Hz')
    expect(wrapper.text()).toContain('频率 2400000000 Hz')
    expect(wrapper.text()).toContain('经度 121.55°'); expect(wrapper.text()).toContain('纬度 25.15°')
    expect(wrapper.text()).toContain('设备模式 宽带压制'); expect(wrapper.text()).toContain('探测概率 暂无数据')
    expect(useRuntimeQualityStore().engineEvents).toHaveLength(0)
  })
  it('初始路径展示嵌套的业务与原值参数', () => {
    useRuntimeQualityStore().engineFrame = { ...adaptEngineFrameSnapshot(initial).data!, runId: 'RUN-1' }
    useRuntimeQualityStore().engineSwitches = []
    wrapper = mount(EngineFramePanel, { props: { section: 'decisions' }, global: { plugins: [pinia, ElementPlus] } })
    expect(wrapper.text()).toContain('kForwardSituation、kForwardTarget')
    expect(wrapper.text()).toContain('传输频次 10'); expect(wrapper.text()).toContain('信息量 102')
  })
  it('链路详情弹窗显示新字段且保留缺测值', () => {
    const frame = { ...adaptEngineFrameSnapshot(detected).data!, runId: 'RUN-1' }
    wrapper = mount(LinkQualityDialog, { props: { modelValue: true, link: null, engineFrame: frame, engineSegments: [frame.links[0]!] },
      global: { plugins: [pinia, ElementPlus], stubs: { ElDialog: { template: '<div><slot name="header" /><slot /></div>' } } } })
    expect(wrapper.text()).toContain('8.200 GHz'); expect(wrapper.text()).toContain('雨衰损耗'); expect(wrapper.text()).toContain('2.06 dB')
    expect(wrapper.text()).toContain('总复合损耗（引擎原值）'); expect(wrapper.text()).toContain('5.92 dB')
    expect(wrapper.text()).toContain('时延（原值，单位待确认）'); expect(wrapper.text()).toContain('0.823583')
    expect(wrapper.text()).toContain('接收功率暂无数据')
  })
  it('将节点、体制和链路筛选实际作用于引擎段，并把错误优先显示为未知', async () => {
    wrapper = mount(EngineFramePanel, { props: { section: 'quality' }, global: { plugins: [pinia, ElementPlus] } })
    expect(qualityRows()).toHaveLength(3)
    expect(wrapper.text()).toContain('异常（状态未知）')
    expect(qualityRows().find(row => row.text().includes('节点-N4'))!.find('.el-tag--info').exists()).toBe(true)

    const selects = wrapper.findAllComponents(ElSelect)
    await selects[0]!.vm.$emit('update:modelValue', 'N1'); await flushPromises()
    expect(qualityRows()).toHaveLength(2)
    await selects[2]!.vm.$emit('update:modelValue', 'LASER'); await flushPromises()
    expect(qualityRows()).toHaveLength(1)
    expect(qualityRows()[0]!.text()).toContain('节点-N3')
    await selects[2]!.vm.$emit('update:modelValue', '')
    await selects[1]!.vm.$emit('update:modelValue', 'L-OLD'); await flushPromises()
    expect(qualityRows()).toHaveLength(1)
    expect(qualityRows()[0]!.text()).toContain('节点-N2')
  })

  it('按当前源仿真时刻执行起止范围筛选，反向与范围外均为空', async () => {
    wrapper = mount(EngineFramePanel, { props: { section: 'quality' }, global: { plugins: [pinia, ElementPlus] } })
    const inputs = wrapper.findAllComponents(ElInputNumber)
    await inputs[0]!.vm.$emit('update:modelValue', 12)
    await inputs[1]!.vm.$emit('update:modelValue', 13); await flushPromises()
    expect(qualityRows()).toHaveLength(3)
    await inputs[0]!.vm.$emit('update:modelValue', 13); await flushPromises()
    expect(wrapper.text()).toContain('当前帧暂无符合筛选条件的引擎链路段。')
    await inputs[1]!.vm.$emit('update:modelValue', 12); await flushPromises()
    expect(wrapper.text()).toContain('当前帧暂无符合筛选条件的引擎链路段。')
  })

  it('只对同帧切换解析高亮，历史项明确不使用当前帧推断', () => {
    wrapper = mount(EngineFramePanel, { props: { section: 'decisions' }, global: { plugins: [pinia, ElementPlus] } })
    const text = wrapper.text()
    expect(text).toContain('切换前高亮：已唯一关联 L-OLD（1/1 段）')
    expect(text).toContain('切换后高亮：已唯一关联 L-NEW（1/1 段）')
    expect(text).toContain('历史切换：未保留该帧的设备段关联证据，未使用当前帧推断或高亮。')
  })
})
