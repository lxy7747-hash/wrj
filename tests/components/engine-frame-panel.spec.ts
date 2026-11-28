import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElInputNumber, ElRadioGroup, ElSelect, ElTooltip } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineFrameSnapshot, EngineLinkSegment, EngineRouteSwitch, Link, LinkType } from '../../src/contracts/domain-models'
import EngineFramePanel from '../../src/components/situation/EngineFramePanel.vue'
import LinkQualityDialog from '../../src/components/situation/LinkQualityDialog.vue'
import initial from '../fixtures/engine-frame/websocket-new/fream001.json'
import detected from '../fixtures/engine-frame/websocket-new/fream_chenge2.json'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'
import { useRuntimeQualityStore } from '../../src/stores/runtime-quality'
import { useSimulationStore } from '../../src/stores/simulation'
import { setJammerPowerUnit } from '../../src/features/scenarios/jammer-power-unit'
import { LATEST_FRAMES } from '../fixtures/engine-frame/latest-report'

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

function qualityCards(): DOMWrapper<HTMLElement>[] { return wrapper!.findAll<HTMLElement>('.quality-card') }

beforeEach(() => {
  pinia = createPinia(); setActivePinia(pinia); configureStore()
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; disposePinia(pinia) })

describe('EngineFramePanel', () => {
  it('质量卡在场景 BER 恰好达到阈值时更新标签，原始引擎状态可核对', async () => {
    const runtime = useRuntimeQualityStore()
    const frame = runtime.engineFrame!
    const first = frame.links[0]!
    const linkWithBer = (ber: number) => ({ ...first, quality: { ...first.quality, ber } })
    runtime.engineFrame = { ...frame, links: [linkWithBer(0.1)] }
    wrapper = mount(EngineFramePanel, { props: { section: 'quality', berThresholds: { warningThreshold: 0.1, emergencyThreshold: 0.9 } },
      global: { plugins: [pinia, ElementPlus] } })
    const heading = () => wrapper!.get('[data-link-id="seg-old"] .quality-card-heading')
    expect(heading().get('.el-tag').text()).toBe('劣化')
    expect(heading().attributes('title')).toBe('引擎上报：正常')
    runtime.engineFrame = { ...frame, frameId: frame.frameId + 1, links: [linkWithBer(0.9)] }
    await flushPromises()
    expect(heading().get('.el-tag').text()).toBe('中断')
  })

  it.each([
    ['引擎实时数据', '实时更新'],
    ['最后收到的引擎数据（等待新帧）', '等待更新'],
    ['最后收到的引擎数据（连接中断）', '连接中断'],
    ['暂停展示的引擎数据', '已暂停'],
    ['历史引擎数据（运行已结束）', '已结束'],
    ['历史引擎数据', '历史回放'],
    ['引擎数据（状态未确认）', '状态未确认'],
  ])('质量顶部只显示数据时刻及%s，帧号与说明收进悬浮提示', (sourceLabel, status) => {
    useRuntimeQualityStore().engineFrame = { ...useRuntimeQualityStore().engineFrame!, frameId: 175.25, simulationTime: 175.25 }
    wrapper = mount(EngineFramePanel, { props: { section: 'quality', sourceLabel }, global: { plugins: [pinia, ElementPlus] } })
    expect(wrapper.findAll('[data-testid="quality-source"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="quality-source"]').text()).toBe('数据时刻：00:02:55.25 · ' + status)
    expect(wrapper.get('.quality-card-source').text()).not.toContain('帧 175.25')
    expect(wrapper.get('.quality-card-source').text()).not.toContain('数据说明')
    expect(wrapper.getComponent(ElTooltip).props('content')).toContain('帧 175.25')
    expect(wrapper.getComponent(ElTooltip).props('content')).toContain('时间范围只筛选当前帧。')
    expect(wrapper.getComponent(ElTooltip).props('content')).not.toContain('单位待确认')
    expect(wrapper.getComponent(ElTooltip).props('trigger')).toEqual(['hover', 'focus'])
  })
  it('分别展示链路段与整条热链的测量值，旧帧不会沿用新增指标', async () => {
    const runtime = useRuntimeQualityStore()
    const raw = {
      ...detected,
      link_calc: {
        ...detected.link_calc,
        links: detected.link_calc.links.map((link, index) => index === 0
          ? { ...link, quality: { ...link.quality, margin_db: 0, delay_ms: 1.369 } }
          : link),
        path_quality: [
          { path_id: 'PATH-1', gxb_db: 9.5, ber: 1.2e-7, margin_db: 26.3, delay_ms: 1.26, rate_bps: 2356 },
          { path_id: '', rate_bps: 0 },
        ],
      },
    }
    const metrics = (card: DOMWrapper<HTMLElement>) => Object.fromEntries(
      card.findAll('.quality-card-metrics > div').map(row => [row.get('dt').text(), row.get('dd').text()]),
    )
    runtime.engineFrame = { ...adaptEngineFrameSnapshot(raw).data!, runId: 'RUN-1' }
    wrapper = mount(EngineFramePanel, { props: { section: 'quality' }, global: { plugins: [pinia, ElementPlus] } })
    expect(metrics(qualityCards()[0]!)).toMatchObject({ '抗干扰余量（dB）': '0', '时延（ms）': '1.369' })

    await wrapper.get('input[value="paths"]').setValue(true)
    const paths = wrapper.get('[aria-label="整条热链质量"]')
    const pathCards = paths.findAll<HTMLElement>('.quality-card')
    expect(pathCards).toHaveLength(2)
    expect(paths.find('.quality-card-details').exists()).toBe(false)
    expect(pathCards[0]!.get('header').text()).toContain('PATH-1')
    expect(metrics(pathCards[0]!)).toEqual({
      '干信比(GXB)（dB）': '9.5', '误码率(BER)': '1.2e-7', '抗干扰余量（dB）': '26.3',
      '时延（ms）': '1.26', '速率（Mbit/s）': '0.002356',
    })
    expect(pathCards[1]!.get('header').text()).toContain('暂无数据')
    expect(metrics(pathCards[1]!)).toMatchObject({ '时延（ms）': '暂无数据', '速率（Mbit/s）': '0' })

    runtime.engineFrame = { ...adaptEngineFrameSnapshot({ ...detected, frame_id: 380 }).data!, runId: 'RUN-1' }
    await flushPromises()
    expect(wrapper.find('[aria-label="整条热链质量"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂无数据')
    await wrapper.get('input[value="segments"]').setValue(true)
    expect(metrics(qualityCards()[0]!)).toMatchObject({ '抗干扰余量（dB）': '暂无数据', '时延（ms）': '暂无数据' })
  })
  it('最新报文的未关联链路可按原始段编号筛选，零值和极小 BER 正常显示', async () => {
    useRuntimeQualityStore().engineFrame = structuredClone(LATEST_FRAMES[0]!)
    wrapper = mount(EngineFramePanel, { props: { section: 'quality' }, global: { plugins: [pinia, ElementPlus] } })
    expect(qualityCards()).toHaveLength(5)
    const filter = wrapper.findAllComponents(ElSelect)[2]!
    expect(filter.findAllComponents({ name: 'ElOption' }).map(option => option.props('value'))).toContain(LATEST_FRAMES[0]!.links[0]!.linkId)
    await filter.vm.$emit('update:modelValue', LATEST_FRAMES[0]!.links[0]!.linkId); await flushPromises()
    expect(qualityCards()).toHaveLength(1)
    expect(qualityCards()[0]!.text()).toContain('4.4076422e-85')
    expect(qualityCards()[0]!.findAll('.quality-card-metrics dd')[0]!.text()).toBe('0')
    useRuntimeQualityStore().engineFrame = structuredClone(LATEST_FRAMES[1]!)
    await flushPromises()
    expect(qualityCards()).toHaveLength(1)
    expect(qualityCards()[0]!.text()).toContain('2.7755125e-85')
  })
  it('链路下拉框复用节点下拉框的名称，选择后仍按原始编号筛选', async () => {
    const configured = [
      { id: 'fiber_forward', type: 'FIBER', sourcePlatformId: 'N1', targetPlatformId: 'relay' },
      { id: 'mw_forward_relay_mission_uav_02', type: 'MICROWAVE', sourcePlatformId: 'relay', targetPlatformId: 'mission_uav_02' },
    ] as const
    const fiberSegment = segment('seg-fiber', configured[0].id, 'FIBER', 'N1', 'out', 'relay', 'in')
    const microwaveSegment = segment('seg-microwave', configured[1].id, 'MICROWAVE', 'relay', 'out', 'mission_uav_02', 'in')
    const unbound = { ...segment('seg-unbound', '', 'DATALINK', 'N4', 'out', 'N5', 'in'), linkIds: [] }
    const runtime = useRuntimeQualityStore()
    runtime.engineFrame = { ...runtime.engineFrame!, links: [fiberSegment, microwaveSegment, unbound] }
    useSimulationStore().$patch({ selectedScene: { config: { platforms: [
      { id: 'N1', name: '场景节点 A' },
    ] } } } as never)

    wrapper = mount(EngineFramePanel, { props: { section: 'quality', links: [...configured] }, global: { plugins: [pinia, ElementPlus] } })
    const selects = wrapper.findAllComponents(ElSelect)
    const nodeFilter = selects.find(select => select.props('placeholder') === '全部节点')!
    expect(nodeFilter.findAllComponents({ name: 'ElOption' }).map(option => option.props('label'))).toEqual([
      '场景节点 A', '中继节点', '作业无人机 02', '节点 4', '节点 5',
    ])
    const filter = selects.find(select => select.props('placeholder') === '全部链路 / 引擎段')!
    const options = filter.findAllComponents({ name: 'ElOption' }).map(option => [option.props('value'), option.props('label')])
    expect(options).toEqual([
      [configured[0].id, '光纤链路 · 前向 · 场景节点 A → 中继节点'],
      [configured[1].id, '微波链路 · 前向 · 中继节点 → 作业无人机 02'],
      [unbound.linkId, '引擎段 · 链路 1 · 节点 4 → 节点 5'],
    ])

    filter.vm.$emit('update:modelValue', configured[0].id)
    await flushPromises()
    expect(qualityCards().map(card => card.attributes('data-link-id'))).toEqual([fiberSegment.linkId])
    filter.vm.$emit('update:modelValue', unbound.linkId)
    await flushPromises()
    expect(qualityCards().map(card => card.attributes('data-link-id'))).toEqual([unbound.linkId])
  })
  it('节点下拉优先使用场景名称，无名称时按类型和编号显示并保留筛选', async () => {
    const runtime = useRuntimeQualityStore()
    runtime.engineFrame = { ...runtime.engineFrame!, links: [
      segment('seg-named', 'L-OLD', 'MICROWAVE', 'mission_uav_01', 'out', 'relay', 'in'),
      segment('seg-numbered', 'L-NEW', 'LASER', 'mission_uav_02', 'out', 'outside_07', 'in'),
      segment('seg-unknown', 'L-ERROR', 'DATALINK', 'relay', 'out', 'unknown_external', 'in'),
    ] }
    useSimulationStore().$patch({ selectedScene: { config: { platforms: [
      { id: 'mission_uav_01', name: '场景节点甲', type: 'AIRBORNE_MISSION_CLUSTER' },
      { id: 'outside_07', name: '', type: 'FORWARD_RELAY_NODE' },
    ] } } } as never)
    wrapper = mount(EngineFramePanel, { props: { section: 'quality' }, global: { plugins: [pinia, ElementPlus] } })

    const filter = wrapper.findAllComponents(ElSelect).find(select => select.props('placeholder') === '全部节点')!
    const options = () => filter.findAllComponents({ name: 'ElOption' }).map(option => [option.props('value'), option.props('label')])
    expect(options()).toEqual([
      ['mission_uav_01', '场景节点甲'],
      ['relay', '中继节点'],
      ['mission_uav_02', '作业无人机 02'],
      ['outside_07', '中继节点 07'],
      ['unknown_external', '节点 5'],
    ])

    await wrapper.setProps({ nodePlatforms: [{ platformId: 'unknown_external', name: '', type: 'Drone_MISSION_AIRCRAFT' }] })
    expect(options().at(-1)).toEqual(['unknown_external', '作业无人机 05'])

    filter.vm.$emit('update:modelValue', 'mission_uav_02')
    await flushPromises()
    expect(qualityCards().map(card => card.attributes('data-link-id'))).toEqual(['seg-numbered'])
  })
  it('质量页显示仿真时刻，并能按秒筛选，卡片的分项损耗默认折叠', async () => {
    const frame = { ...adaptEngineFrameSnapshot(detected).data!, runId: 'RUN-1' }
    useRuntimeQualityStore().engineFrame = frame
    wrapper = mount(EngineFramePanel, { props: { section: 'quality' }, global: { plugins: [pinia, ElementPlus] } })
    expect(wrapper.get('.engine-evidence__source').text()).toContain('00:06:15')
    expect(wrapper.getComponent(ElTooltip).props('content')).toContain('时间范围只筛选当前帧')
    expect(wrapper.getComponent(ElTooltip).props('content')).not.toContain('单位待确认')
    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.get('details.quality-card-details > summary').text()).toBe('分项损耗')
    expect(wrapper.find('details.quality-card-details[open]').exists()).toBe(false)
    expect(qualityCards()[0]!.text()).not.toContain('时延（原值，单位待确认）')
    const inputs = wrapper.findAllComponents(ElInputNumber)
    await inputs[0]!.vm.$emit('update:modelValue', 375); await inputs[1]!.vm.$emit('update:modelValue', 376); await flushPromises()
    expect(qualityCards()).toHaveLength(5)
    await wrapper.setProps({ section: 'jammers' })
    expect(wrapper.text()).toContain('探测频率 2.4 GHz')
    expect(wrapper.text()).toContain('干扰频率 2.4 GHz')
    expect(wrapper.get('[data-testid="detection-frequency-value"]').attributes('title')).toBe('2400000000 Hz')
    expect(wrapper.get('[data-testid="jammer-frequency-value"]').attributes('title')).toBe('2400000000 Hz')
    expect(wrapper.text()).toContain('经度 121.55°'); expect(wrapper.text()).toContain('纬度 25.15°')
    expect(wrapper.text()).toContain('设备模式 宽带压制'); expect(wrapper.text()).toContain('探测概率 暂无数据')
    expect(wrapper.get('[data-testid="detection-platform-type"]').text()).toBe('无人机')
    expect(wrapper.text()).toContain('经度 121.3824°'); expect(wrapper.text()).toContain('纬度 25.0897°'); expect(wrapper.text()).toContain('高度 3689.1 m')
    expect(useRuntimeQualityStore().engineEvents).toHaveLength(0)
  })
  it('干扰侦测卡片在未侦测到目标时统一展示中文状态与提示', async () => {
    const runtime = useRuntimeQualityStore()
    const baseJammer = adaptEngineFrameSnapshot(detected).data!.jammers[0]!
    runtime.engineFrame = {
      ...runtime.engineFrame!,
      jammers: [
        { ...baseJammer, platformId: 'J-1', detectStatus: 'NOT_DETECTED', detections: [], actions: [] },
        { ...baseJammer, platformId: 'J-2', detectStatus: null, detections: [], actions: [] },
      ],
    }
    wrapper = mount(EngineFramePanel, { props: { section: 'jammers' }, global: { plugins: [pinia, ElementPlus] } })
    expect(wrapper.findAll('[data-testid="jammer-detect-status"]').map(tag => tag.text())).toEqual(['未侦测到目标', '未侦测到目标'])
    expect(wrapper.findAll('[data-testid="jammer-no-detection"]').map(el => el.text())).toEqual(['未侦测到目标', '未侦测到目标'])
  })
  it('干扰侦测卡片按 W 展示干扰功率，并记录该干扰机启停事件', async () => {
    const runtime = useRuntimeQualityStore()
    const baseJammer = adaptEngineFrameSnapshot(detected).data!.jammers[0]!
    runtime.engineFrame = {
      ...runtime.engineFrame!,
      jammers: [
        { ...baseJammer, platformId: 'jammer_station_01', name: 'jammer_station_01', powerW: 0.1 },
        { ...baseJammer, platformId: 'jammer_airborne_01', name: 'jammer_airborne_01', powerW: 0.0001 },
      ],
    }
    runtime.engineEvents = [
      { frameId: 120, simulationTime: 120, event: { type: 'into_jamm', pathId: null, uavNames: ['mission_uav_01', 'mission_uav_02', 'mission_uav_03'], jammerNames: ['jammer_station_01'], uavIds: ['mission_uav_01', 'mission_uav_02', 'mission_uav_03'], jammerIds: ['jammer_station_01'] } },
      { frameId: 185, simulationTime: 185, event: { type: 'release_jamm', pathId: null, uavNames: ['mission_uav_01'], jammerNames: ['jammer_station_01'], uavIds: ['mission_uav_01'], jammerIds: ['jammer_station_01'] } },
    ]
    wrapper = mount(EngineFramePanel, { props: { section: 'jammers' }, global: { plugins: [pinia, ElementPlus] } })
    expect(wrapper.findAll('[data-testid="jammer-power-value"]').map(el => el.text())).toEqual([
      '0.1 W',
      '0.0001 W',
    ])
    const eventBlocks = wrapper.findAll('[data-testid="jammer-lifecycle-events"]')
    expect(eventBlocks[0]!.text()).toContain('进入干扰圈')
    expect(eventBlocks[0]!.text()).toContain('离开干扰圈')
    expect(eventBlocks[1]!.text()).toContain('暂无启停事件')
    const targetSpans = eventBlocks[0]!.findAll('[data-testid="jammer-event-targets"]')
    expect(targetSpans[1]!.attributes('title')).toBe('mission_uav_01、mission_uav_02、mission_uav_03')
    const toggle = eventBlocks[0]!.get('[data-testid="jammer-event-toggle"]')
    expect(toggle.text()).toBe('共3架')
    await toggle.trigger('click')
    await flushPromises()
    expect(toggle.text()).toBe('收起')
    expect(targetSpans[1]!.element.closest('.jammer-card__event-row')?.classList.contains('is-expanded')).toBe(true)
  })
  it('实时链路卡片展开后随当前帧更新分项损耗，保留零值和缺测', async () => {
    const runtime = useRuntimeQualityStore()
    const source = runtime.engineFrame!
    const first = source.links[0]!
    const otherLinks = source.links.slice(1)
    const withLosses = {
      ...first,
      quality: { ...first.quality, gxbDb: 1 },
      losses: { ...losses, freeSpaceDb: 0, rainDb: 1, totalDb: 2 },
      inputTrace: { ...inputTrace, eirpDbw: 1, jammers: [
        { jammerName: '占位输入来源', platformId: null, distanceM: null, eirpDbw: null, lossDb: null },
      ] },
    }
    runtime.engineFrame = { ...source, links: [withLosses, ...otherLinks] }
    wrapper = mount(EngineFramePanel, { props: { section: 'quality' }, global: { plugins: [pinia, ElementPlus] } })
    const card = wrapper.get('[data-link-id="seg-old"]')
    const details = card.get('details.quality-card-details')
    const lossRows = () => Object.fromEntries(details.findAll('.quality-card-losses > div')
      .map(row => [row.get('dt').text(), row.get('dd').text()]))
    expect(details.attributes('open')).toBeUndefined()
    expect(card.get('.quality-card-heading').text()).toContain('正常')
    expect(card.get('.quality-card-metrics dd').text()).toBe('1')
    expect(Object.fromEntries(card.findAll('.quality-card-metrics > div').map(row => [row.get('dt').text(), row.get('dd').text()]))).toMatchObject({
      '发射辐射功率（dBW）': '1',
    })
    await details.get('summary').trigger('click')
    expect(details.attributes('open')).toBeDefined()
    expect(lossRows()).toMatchObject({
      '自由空间损耗（dB）': '0', '海面多径损耗（dB）': '暂无数据', '雨衰损耗（dB）': '1',
      '云雨合并损耗（dB）': '暂无数据', '总复合损耗（dB）': '2',
    })
    expect(card.text()).not.toContain('old-out')
    expect(card.text()).not.toContain('old-in')
    expect(card.text()).not.toContain('EIRP')
    expect(card.text()).not.toContain('占位输入来源')

    const nextLink = { ...withLosses, quality: { ...withLosses.quality, gxbDb: 0 }, losses: { ...losses, cloudRainDb: 0 } }
    const nextFrame = { ...source, frameId: 8, simulationTime: 13.5, links: [nextLink, ...otherLinks] }
    runtime.engineFrame = nextFrame
    await flushPromises()
    expect(wrapper.get('[data-link-id="seg-old"]').element).toBe(card.element)
    expect(details.attributes('open')).toBeDefined()
    expect(card.get('.quality-card-metrics dd').text()).toBe('0')
    expect(lossRows()).toMatchObject({
      '自由空间损耗（dB）': '暂无数据', '雨衰损耗（dB）': '暂无数据', '云雨合并损耗（dB）': '0',
      '总复合损耗（dB）': '暂无数据',
    })
    await wrapper.setProps({ evidence: { engineFrame: nextFrame, engineEvents: [], engineSwitches: [], engineAlarms: [] } })
    expect(qualityCards()).toHaveLength(nextFrame.links.length)
    expect(wrapper.find('.quality-card-details').exists()).toBe(false)
  })
  it('初始路径以中文跳点与去重业务标签展示，并格式化原值参数', () => {
    const base = adaptEngineFrameSnapshot(initial).data!
    const firstRoute = base.initRouting![0]!
    useRuntimeQualityStore().engineFrame = {
      ...base,
      runId: 'RUN-1',
      initRouting: [
        { ...firstRoute, transTypes: ['kForwardSituation', 'kForwardTarget', 'kForwardSituation'] },
        ...base.initRouting!.slice(1),
      ],
    }
    useRuntimeQualityStore().engineSwitches = []
    wrapper = mount(EngineFramePanel, { props: { section: 'decisions' }, global: { plugins: [pinia, ElementPlus] } })
    const text = wrapper.text()
    expect(text).toContain('前向态势')
    expect(text).toContain('前向目标')
    expect(text).not.toContain('kForwardSituation')
    expect(text).not.toContain('入：暂无数据')
    expect(wrapper.findAll('.decision-business__tags .el-tag').map(tag => tag.text()).slice(0, 2)).toEqual(['前向态势', '前向目标'])
    expect(text).toContain('传输频次'); expect(text).toContain('10')
    expect(text).toContain('信息量'); expect(text).toContain('102')
  })
  it('链路详情保留异常状态和损耗结果，并隐藏诊断明细', () => {
    const frame = { ...adaptEngineFrameSnapshot(detected).data!, runId: 'RUN-1' }
    const original = frame.links[0]!
    const link = { ...original, error: '示例错误明细', losses: { ...original.losses, jammingDb: 0 } }
    wrapper = mount(LinkQualityDialog, { props: { modelValue: true, link: null, engineFrame: frame, engineSegments: [link] },
      global: { plugins: [pinia, ElementPlus], stubs: { ElDialog: { template: '<div><slot name="header" /><slot /></div>' } } } })
    expect(wrapper.text()).toContain('8.200 GHz'); expect(wrapper.text()).toContain('雨衰损耗'); expect(wrapper.text()).toContain('2.06 dB')
    expect(wrapper.text()).toContain('总复合损耗（引擎原值）'); expect(wrapper.text()).toContain('5.92 dB')
    expect(wrapper.text()).toContain('时延（原值，单位待确认）'); expect(wrapper.text()).toContain('0.823583')
    expect(wrapper.text()).toContain('干扰损耗0.00 dB')
    expect(wrapper.text()).not.toContain('接收功率')
    expect(wrapper.text()).toContain('异常（状态未知）')
    expect(wrapper.get('details').text()).toContain('干扰损耗（dB）0')
    expect(wrapper.findAll('dt').filter(item => item.text() === '传输距离')).toHaveLength(1)
    expect(wrapper.get('details').findAll('h4').map(item => item.text())).toEqual(['损耗明细', '通信参数'])
    expect(wrapper.text()).not.toContain('干扰来源（计算输入）')
    expect(wrapper.text()).not.toContain('错误信息')
    expect(wrapper.text()).not.toContain('示例错误明细')
  })
  it('链路详情显示易读链路和端点名称，并保留引擎来源与指标', async () => {
    const configuredLink: Link = {
      id: 'c_forward_command_relay', type: 'DATALINK', direction: 'FORWARD',
      sourcePlatformId: 'P-COMMAND', targetPlatformId: 'P-RELAY',
      frequency: 0, bandwidth: 0, txPower: 0, antennaGain: { tx: 0, rx: 0 },
      modulation: 'BPSK', berThreshold: 0, dataRate: 0,
    }
    const first = segment('SEG-SAMPLE', configuredLink.id, 'DATALINK', 'P-COMMAND', 'c_band_uplink', 'P-RELAY', 'c_band_uplink')
    const link = {
      ...first, sourceName: 'command_vehicle', targetName: 'mission_uav_01',
      quality: { ...first.quality, gxbDb: 0 },
    }
    const frame = { ...useRuntimeQualityStore().engineFrame!, links: [link] }
    wrapper = mount(LinkQualityDialog, {
      props: { modelValue: true, link: null, configuredLink, engineFrame: frame, engineSegments: frame.links, engineSourceLabel: '引擎实时数据' },
      global: { plugins: [pinia, ElementPlus], stubs: { ElDialog: { template: '<div><slot name="header" /><slot /></div>' } } },
    })

    expect(wrapper.get('.link-quality-dialog__header strong').text()).toBe('C 波段数传链路 · 前向 · 指挥车与中继节点 · 引擎实时数据')
    const details = wrapper.get('[data-testid="link-detail-engine-segments"]')
    const endpoint = () => details.get('.engine-segment > strong').text()
    expect(endpoint()).toBe('无人集群指挥车节点（C 波段上行） → 任务无人机 01（C 波段上行）')
    expect(details.text()).not.toContain('引擎段编号')
    expect(details.text()).toContain('来源帧 7 · 源仿真时刻 0分12.5秒')
    expect(details.text()).toContain('干信比(GXB)0.00 dB')

    await wrapper.setProps({ platforms: [
      { id: 'P-COMMAND', name: '场景节点甲' }, { id: 'P-RELAY', name: '场景节点乙' },
    ] })
    expect(endpoint()).toBe('场景节点甲（C 波段上行） → 场景节点乙（C 波段上行）')
  })
  it('同帧核对展示回传输入，并提示节点记录缺失或时刻不一致', async () => {
    const base = useRuntimeQualityStore().engineFrame!
    const link = { ...base.links[0]!, inputTrace: { ...inputTrace, frequencyGHz: 2.75 } }
    const frame = { ...base, links: [link] }
    const position = {
      platformId: 'N1', time: frame.simulationTime, longitude: 1, latitude: 2, altitude: 0, speed: 0, heading: 0,
    }
    wrapper = mount(LinkQualityDialog, {
      props: { modelValue: true, link: null, engineFrame: frame, engineSegments: frame.links },
      global: { plugins: [pinia, ElementPlus], stubs: { ElDialog: { template: '<div><slot name="header" /><slot /></div>' } } },
    })

    const comparison = wrapper.get('[data-testid="link-frame-check"]')
    const actual = comparison.get('[aria-label="收发节点实际状态"]')
    const inputs = comparison.get('[aria-label="计算器回传输入"]')
    expect(comparison.get('summary').text()).toContain('同帧核对')
    expect(actual.text().match(/暂无运行位置记录/g)).toHaveLength(2)
    expect(inputs.text()).toMatch(/来源帧\s*7/)
    expect(inputs.text()).toContain('仿真时刻')
    expect(inputs.text()).toContain(`模型版本${frame.modelVersion ?? '未提供'}`)
    expect(inputs.text()).toContain(`调制方式${frame.modulation ?? '未提供'}`)
    expect(inputs.text()).toContain('2.75')
    expect(comparison.text()).not.toContain('收发端状态输入未回传')

    const receiver = { ...position, platformId: 'N2', time: 11 }
    await wrapper.setProps({ nodePositions: [position, receiver] })
    expect(actual.text()).toContain('12.5 秒')
    expect(actual.text()).toContain('11 秒')
    expect(actual.text()).not.toContain('数据来源')
    expect(actual.text()).not.toContain('位置来源帧')
    expect(actual.text()).toContain('仿真时刻与链路帧不一致')

    await wrapper.setProps({ nodePositions: [position, { ...receiver, time: position.time }] })
    expect(actual.text()).not.toContain('仿真时刻与链路帧不一致')
    expect(comparison.text()).not.toContain('核对通过')
  })
  it('链路详情弹窗优先展示 delay_ms 与 margin_db 含零值，缺失时如实显示暂无数据', async () => {
    const first = detected.link_calc.links[0]!
    const { delay: _omitDelay, ...qualityWithoutLegacyDelay } = first.quality
    const raw = {
      ...detected,
      link_calc: {
        ...detected.link_calc,
        links: [
          { ...first, quality: { ...qualityWithoutLegacyDelay, margin_db: 26.3, delay_ms: 1.369 } },
          { ...first, link_id: 'SEG-ZERO', quality: { ...qualityWithoutLegacyDelay, margin_db: 0, delay_ms: 0 } },
          { ...first, link_id: 'SEG-NULL', quality: { ...qualityWithoutLegacyDelay, margin_db: null, delay_ms: null } },
        ],
      },
    }
    const frame = { ...adaptEngineFrameSnapshot(raw).data!, runId: 'RUN-1' }
    wrapper = mount(LinkQualityDialog, {
      props: { modelValue: true, link: null, engineFrame: frame, engineSegments: frame.links },
      global: { plugins: [pinia, ElementPlus], stubs: { ElDialog: { template: '<div><slot name="header" /><slot /></div>' } } },
    })
    const cards = wrapper.findAll('.engine-segment')
    const mainRows = (card: DOMWrapper<Element>) => Object.fromEntries(
      card.findAll(':scope > .link-quality-dialog__grid > div').map(row => [row.get('dt').text(), row.get('dd').text()]),
    )
    expect(mainRows(cards[0]!)).toMatchObject({
      '干信比(GXB)': '0.00 dB',
      '发射辐射功率': '30.00 dBW',
      '抗干扰余量': '26.30 dB',
      '时延': '1.369 ms',
    })
    expect(mainRows(cards[0]!)).toHaveProperty('干扰损耗')
    expect(cards[0]!.text()).not.toContain('接收功率')
    expect(cards[0]!.text()).not.toContain('信噪比 SNR')
    expect(mainRows(cards[1]!)).toMatchObject({
      '抗干扰余量': '0.00 dB',
      '时延': '0.000 ms',
    })
    expect(mainRows(cards[2]!)).toMatchObject({
      '抗干扰余量': '暂无数据',
      '时延': '暂无数据',
    })
    await cards[0]!.get('details summary').trigger('click')
    const detailRows = Object.fromEntries(
      cards[0]!.findAll('details dl > div').map(row => [row.get('dt').text(), row.get('dd').text()]),
    )
    expect(detailRows).toMatchObject({
      '抗干扰余量（dB）': '26.3',
      '时延（ms）': '1.369',
    })
    expect(detailRows).not.toHaveProperty('云雨合并损耗（dB）')
    expect(detailRows).not.toHaveProperty('时延（原值，单位待确认）')
  })
  it('质量卡片和详情保留断线来源说明及源时刻，历史回放明确标记历史', async () => {
    const frame = useRuntimeQualityStore().engineFrame!
    wrapper = mount(LinkQualityDialog, { props: { modelValue: true, link: null, engineFrame: frame, engineSegments: frame.links,
      engineSourceLabel: '最后收到的引擎数据（连接中断）' },
      global: { plugins: [pinia, ElementPlus], stubs: { ElDialog: { template: '<div><slot name="header" /><slot /></div>' } } } })
    expect(wrapper.text()).toContain('连接中断')
    expect(wrapper.text()).toContain('来源帧 7')
    expect(wrapper.text()).not.toContain('实时')
    await wrapper.setProps({ engineSourceLabel: '暂停展示的引擎数据' })
    expect(wrapper.text()).toContain('暂停展示')
    expect(wrapper.text()).not.toContain('过期')
    wrapper.unmount()
    wrapper = mount(EngineFramePanel, { props: { section: 'quality', sourceLabel: '最后收到的引擎数据（连接中断）' }, global: { plugins: [pinia, ElementPlus] } })
    expect(wrapper.get('.engine-evidence__source').text()).toContain('连接中断')
    await wrapper.setProps({ sourceLabel: '历史引擎数据（运行已结束）' })
    expect(wrapper.get('.engine-evidence__source').text()).toContain('已结束')
  })
  it('将节点、体制和链路筛选实际作用于引擎段，并把错误优先显示为未知', async () => {
    wrapper = mount(EngineFramePanel, { props: { section: 'quality' }, global: { plugins: [pinia, ElementPlus] } })
    expect(qualityCards()).toHaveLength(3)
    expect(wrapper.text()).toContain('异常（状态未知）')
    expect(qualityCards().find(row => row.text().includes('节点-N4'))!.find('.el-tag--info').exists()).toBe(true)

    const selects = wrapper.findAllComponents(ElSelect)
    await selects[0]!.vm.$emit('update:modelValue', 'N1'); await flushPromises()
    expect(qualityCards()).toHaveLength(2)
    await selects[1]!.vm.$emit('update:modelValue', 'LASER'); await flushPromises()
    expect(qualityCards()).toHaveLength(1)
    expect(qualityCards()[0]!.text()).toContain('节点-N3')
    await selects[1]!.vm.$emit('update:modelValue', '')
    await selects[2]!.vm.$emit('update:modelValue', 'L-OLD'); await flushPromises()
    expect(qualityCards()).toHaveLength(1)
    expect(qualityCards()[0]!.text()).toContain('节点-N2')
  })

  it('按当前源仿真时刻执行起止范围筛选，反向与范围外均为空', async () => {
    wrapper = mount(EngineFramePanel, { props: { section: 'quality' }, global: { plugins: [pinia, ElementPlus] } })
    const inputs = wrapper.findAllComponents(ElInputNumber)
    await inputs[0]!.vm.$emit('update:modelValue', 12)
    await inputs[1]!.vm.$emit('update:modelValue', 13); await flushPromises()
    expect(qualityCards()).toHaveLength(3)
    await inputs[0]!.vm.$emit('update:modelValue', 13); await flushPromises()
    expect(wrapper.text()).toContain('当前帧暂无符合筛选条件的引擎链路段。')
    await inputs[1]!.vm.$emit('update:modelValue', 12); await flushPromises()
    expect(wrapper.text()).toContain('当前帧暂无符合筛选条件的引擎链路段。')
  })

  it('只对同帧切换解析高亮，历史项明确不使用当前帧推断', () => {
    wrapper = mount(EngineFramePanel, { props: { section: 'decisions' }, global: { plugins: [pinia, ElementPlus] } })
    const text = wrapper.text()
    expect(text).toContain('切换前链路（已匹配 1/1 段）：微波链路（节点-N1 → 节点-N2）')
    expect(text).toContain('切换后链路（已匹配 1/1 段）：激光链路（节点-N1 → 节点-N3）')
    expect(text).toContain('该次历史切换暂无可高亮的链路。')
    expect(text).not.toContain('上游计时')
  })

  it('接收切换事件帧时冻结的历史解析结果，即使非当前帧也显示前后高亮（整改10）', () => {
    const runtime = useRuntimeQualityStore()
    const oldNodes = [node('N1', '', 'old-out'), node('N2', 'old-in', '')]
    const newNodes = [node('N1', '', 'new-out'), node('N3', 'new-in', '')]
    runtime.engineSwitches = [{
      frameId: 6, simulationTime: 11.5, route: switchRoute(oldNodes, newNodes),
      resolution: { before: { linkIds: ['L-OLD'], totalHops: 1, resolvedHops: 1 }, after: { linkIds: ['L-NEW'], totalHops: 1, resolvedHops: 1 } },
    }]
    wrapper = mount(EngineFramePanel, { props: { section: 'decisions' }, global: { plugins: [pinia, ElementPlus] } })
    const text = wrapper.text()
    expect(text).toContain('切换前链路（已匹配 1/1 段）：微波链路（节点-N1 → 节点-N2）')
    expect(text).toContain('切换后链路（已匹配 1/1 段）：激光链路（节点-N1 → 节点-N3）')
    expect(text).not.toContain('该次历史切换暂无可高亮的链路。')
  })

  it('告警合并重复条目并把缺失 message 解析为中文告警与路径链路名称', () => {
    const runtime = useRuntimeQualityStore()
    runtime.engineAlarms = [
      {
        frameId: 5, simulationTime: 10,
        alarm: { pathId: 'P-1', linkId: 'seg-gone', message: null },
        context: {
          link: { linkIds: ['L-OLD'], sourcePlatformId: 'N1', targetPlatformId: 'N2', sourcePort: 'old-out', targetPort: 'old-in', status: 'DEGRADED', ber: 0.002 },
          path: { direction: 'FORWARD', sourcePlatformId: 'N1', targetPlatformId: 'N2' },
        },
      },
      {
        frameId: 5, simulationTime: 10,
        alarm: { pathId: 'P-2', linkId: 'seg-new', message: '自定义引擎告警' },
      },
      {
        frameId: 6, simulationTime: 11,
        alarm: { pathId: 'P-1', linkId: 'seg-gone', message: null },
      },
      {
        frameId: 7, simulationTime: 12.5,
        alarm: { pathId: 'P-1', linkId: 'seg-gone', message: null },
      },
    ]
    wrapper = mount(EngineFramePanel, { props: { section: 'decisions' }, global: { plugins: [pinia, ElementPlus] } })
    const alarmSection = wrapper.get('[aria-label="告警"]')
    expect(alarmSection.get('[data-testid="alarm-summary-tag"]').text()).toBe('2 项 · 共 4 次')
    const cards = alarmSection.findAll('.decision-card--alarm')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.text()).toContain('T+ 00:00:10 ～ T+ 00:00:12')
    expect(cards[0]!.get('[data-testid="alarm-repeat-count"]').text()).toBe('重复 3 次')
    expect(cards[0]!.text()).toContain('微波链路（节点-N1 → 节点-N2）')
    expect(cards[0]!.text()).toContain('链路劣化告警（链路质量触发告警门限）')
    expect(cards[0]!.text()).toContain('所属前向路径：节点-N1 → 节点-N2')
    expect(cards[0]!.text()).not.toContain('暂无数据')
    expect(cards[1]!.text()).toContain('激光链路（节点-N1 → 节点-N3）')
    expect(cards[1]!.text()).toContain('自定义引擎告警')
  })

  it('干扰侦测卡片完整展示第 5 版多频段、辐射功率、天线增益、分目标探测概率及起扰频率', () => {
    const runtime = useRuntimeQualityStore()
    runtime.engineFrame = {
      ...runtime.engineFrame!,
      jammers: [{
        name: 'jammer_station_01', platformId: 'jammer_station_01',
        detectStatus: 'DETECTED', deviceStatus: 'ON',
        powerW: 200, frequencyHz: 4.5e9, rangeM: 111120,
        antennaGainDbi: 25, eirpDbw: 30, engineMode: 'broadband',
        freqBands: [
          { frequencyGHz: 4.5, bandwidthMHz: 10, mode: 'BARRAGE', engineMode: 'broadband' },
          { frequencyGHz: 2.5, bandwidthMHz: 20, mode: 'SWEEP', engineMode: 'sweep' },
        ],
        position: { longitude: 121.55, latitude: 25.15, altitudeM: 500 },
        detections: [{
          targetNames: ['N1', 'N2'], targetIds: ['N1', 'N2'],
          platformType: 'UAV', frequencyHz: 2.3e9, probability: null, rangeM: 111120,
          targets: [
            { name: 'N1', platformId: 'N1', longitude: 118.5, latitude: 21.3, altitudeM: 5000, probability: 0.92 },
            { name: 'N2', platformId: 'N2', longitude: 119.1, latitude: 21.5, altitudeM: 5000, probability: 0.85 },
          ],
        }],
        actions: [
          { action: 'JAM_ON', targetName: 'N1', targetPlatformId: 'N1', mode: 'BARRAGE', engineMode: 'broadband', jamFreqHz: 4.5 },
          { action: 'JAM_ON', targetName: 'N2', targetPlatformId: 'N2', mode: 'SWEEP', engineMode: 'sweep', jamFreqHz: 2.5e9 },
        ],
      }],
    }
    wrapper = mount(EngineFramePanel, { props: { section: 'jammers' }, global: { plugins: [pinia, ElementPlus] } })
    expect(wrapper.get('[data-testid="jammer-eirp-value"]').text()).toBe('30 dBW')
    expect(wrapper.get('[data-testid="jammer-gain-value"]').text()).toBe('25 dBi')
    const bandsText = wrapper.get('[data-testid="jammer-freq-bands"]').text()
    expect(bandsText).toContain('4.5 GHz · 带宽 10 MHz')
    expect(bandsText).toContain('宽带压制')
    expect(bandsText).toContain('2.5 GHz · 带宽 20 MHz')
    expect(bandsText).toContain('扫频')
    expect(wrapper.get('[data-testid="detection-probability"]').text()).toBe('85% ～ 92%')
    expect(wrapper.findAll('[data-testid="target-detect-prob"]').map(el => el.text())).toEqual(['探测概率 92%', '探测概率 85%'])
    expect(wrapper.findAll('[data-testid="jammer-action-freq"]').map(el => el.text())).toEqual(['4.5 GHz', '2.5 GHz'])
  })

  it('干扰侦测卡片支持通过开关在 W 与 dBm 之间切换显示干扰功率', async () => {
    setJammerPowerUnit('W')
    try {
      const runtime = useRuntimeQualityStore()
      runtime.engineFrame = {
        ...runtime.engineFrame!,
        jammers: [
          {
            name: 'jammer_station_01', platformId: 'jammer_station_01',
            detectStatus: 'DETECTED', deviceStatus: 'ON',
            powerW: 200, frequencyHz: 4.5e9, rangeM: 111120,
            detections: [], actions: [],
          },
          {
            name: 'jammer_station_02', platformId: 'jammer_station_02',
            detectStatus: 'DETECTED', deviceStatus: 'ON',
            powerW: 0.1, frequencyHz: 4.5e9, rangeM: 111120,
            detections: [], actions: [],
          },
        ],
      }
      const mounted = mount(EngineFramePanel, { props: { section: 'jammers' }, global: { plugins: [pinia, ElementPlus] } })
      wrapper = mounted
      const powerValues = () => mounted.findAll('[data-testid="jammer-power-value"]').map(el => el.text())
      expect(powerValues()).toEqual(['200 W', '0.1 W'])

      const toggle = mounted.findAllComponents(ElRadioGroup)
        .find(item => item.attributes('data-testid') === 'jammer-power-unit-toggle')!
      toggle.vm.$emit('update:modelValue', 'dBm')
      await flushPromises()
      expect(powerValues()).toEqual(['53.01 dBm', '20 dBm'])

      toggle.vm.$emit('update:modelValue', 'W')
      await flushPromises()
      expect(powerValues()).toEqual(['200 W', '0.1 W'])
    } finally {
      setJammerPowerUnit('W')
    }
  })
})
