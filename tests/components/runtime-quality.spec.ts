import { computed, defineComponent } from 'vue'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElSelect } from 'element-plus'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineFrameSnapshot, Principal, ScenarioConfig, SimulationRun } from '../../src/contracts/domain-models'
import QualityMetricPanel from '../../src/components/situation/QualityMetricPanel.vue'
import LinkQualityDialog from '../../src/components/situation/LinkQualityDialog.vue'
import { useRuntimeQualityStore, type RuntimeQualityScope } from '../../src/stores/runtime-quality'
import { useAuthStore } from '../../src/stores/auth'
import { useSimulationStore } from '../../src/stores/simulation'
import { useUiStore } from '../../src/stores/ui'
import { selectRuntimeQualityViews } from '../../src/features/situation/runtime-quality-view'
import fixture from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'

// 只用于验证公开接收动作；不作为实际发送端或界面中的默认运行数据。
function qualityInput() {
  return { model_version: 'global-model', modulation: 'BPSK', links: [{
    link_id: 'engine-link', tx_platform: 'TX', rx_platform: 'RX', tx_port: 'TX-PORT', rx_port: 'RX-PORT', distance_km: 12.5,
    losses: { free_space_db: 100, sea_multipath_db: 2, atmospheric_db: 1, cloud_rain_db: 0, jamming_loss_db: 4, total_composite_db: 107 },
    quality: { ber: 1.2e-4, gxb_db: -7.5, rx_power_dbw: -110, model_version: 'engine-model', modulation: 'QPSK',
      input_trace: { data_rate_bps: 1.6e6, eirp_dbw: 20, g_over_t_dbk: -5, jammers: [] }, error_msg: '' },
  }] }
}
const binding = { linkId: 'L-MW-01', sourceLinkId: 'engine-link', sourcePlatformId: 'TX', destinationPlatformId: 'RX', sourcePortId: 'TX-PORT', destinationPortId: 'RX-PORT' }
const principal: Principal = { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'] }
const scene = structuredClone(fixture.scenario) as ScenarioConfig
const configured = scene.links.find(link => link.id === binding.linkId)!
const scope: RuntimeQualityScope = { taskId: 'TASK-001', runId: 'RUN-001', scenarioId: scene.scenario.id, revision: 4, startedAt: '2026-10-31T01:00:00Z' }
const links = [{ linkId: binding.linkId, type: configured.type, sourceName: '发送节点', destinationName: '接收节点' }]
const dialogStub = { props: ['modelValue'], template: '<section v-if="modelValue"><header><slot name="header" /></header><slot /></section>' }
let pinia: Pinia
let wrapper: VueWrapper | undefined

function bindRun(): number {
  const store = useRuntimeQualityStore()
  const epoch = store.activate(scope, scene.links.map(link => link.id))
  expect(store.bindLinks(epoch, [binding])).toBe(true)
  return store.epoch
}
function mountViews() {
  const host = defineComponent({
    components: { QualityMetricPanel, LinkQualityDialog },
    setup() {
      const quality = useRuntimeQualityStore()
      const simulation = useSimulationStore()
      const views = computed(() => selectRuntimeQualityViews(quality.snapshot, quality.bindings, links, simulation.currentTime))
      return {
        configured,
        selected: computed(() => views.value.get(binding.linkId) ?? null),
        rows: computed(() => links.map(link => ({ ...link, runtimeQuality: views.value.get(link.linkId) ?? null }))),
      }
    },
    template: '<QualityMetricPanel :links="rows" :nodes="[\'发送节点\', \'接收节点\']" source-key="run" /><LinkQualityDialog :model-value="true" :link="null" :configured-link="configured" :runtime-quality="selected" />',
  })
  wrapper = mount(host, { global: { plugins: [pinia, ElementPlus], stubs: { ElDialog: dialogStub } } })
  return wrapper
}
function detail(label: string): string {
  const row = wrapper!.findAll('dl div').find(item => item.find('dt').text() === label)
  expect(row, label).toBeDefined()
  return row!.get('dd').text()
}
function cardValues(): string[] {
  const card = wrapper!.get('.quality-card')
  const metrics = Object.fromEntries(card.findAll('dl > div').map(row => [row.get('dt').text(), row.get('dd').text()]))
  return [card.get('.quality-card-heading strong').text(), ...['源时刻', 'SNR（dB）', 'BER', '接收功率（dBm）', '路径损耗（dB）', '干信比 GXB（dB）', '时延（ms）', '可用率（%）'].map(label => metrics[label]!)]
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  // 建立测试的已认证运行环境；质量结果只能通过 activate/bindLinks/acceptFrame 写入。
  useAuthStore().$patch({ principal, role: principal.role, permissions: [...principal.permissions], runtimeMode: 'LOCAL' })
  useSimulationStore().$patch({ run: { ...structuredClone(fixture.run), runId: scope.runId, taskId: scope.taskId, scenarioId: scope.scenarioId,
    uiStatus: 'RUNNING', startedAt: scope.startedAt, configLocked: true,
    canonical: { status: 'RUNNING', currentTime: 65.5, totalDuration: 7200, processId: 123, progress: 1 },
  } as SimulationRun, selectedScene: { config: structuredClone(scene), revision: scope.revision, locked: true, officialLibraryChanged: false, uiExtensions: { sensors: [], jammers: [] } } })
})
afterEach(() => { wrapper?.unmount(); wrapper = undefined; disposePinia(pinia) })

describe('统一运行质量投影与展示', () => {
  it('通过公开动作接收后，面板与详情同步 BER、功率、GXB 和损耗，缺 SNR 不补造', async () => {
    const store = useRuntimeQualityStore()
    const epoch = bindRun()
    mountViews()
    expect(store.acceptFrame(epoch, { frameId: 10, simulationTime: 65.5 }, qualityInput())).toBe(true)
    await flushPromises()
    expect(cardValues()).toEqual(['发送节点 → 接收节点', '1分5.5秒', '暂无数据', '1.2e-4', '-80', '107.00', '-7.50', '暂无数据', '暂无数据'])
    expect(detail('质量测量时刻')).toBe('1分5.5秒')
    expect(detail('误码率 BER')).toBe(cardValues()[3])
    expect(detail('接收功率')).toBe('-80.00 dBm')
    expect(detail('路径损耗')).toBe('107.00 dB')
    expect(detail('干信比 GXB')).toBe('-7.50 dB')
    expect(detail('传输距离')).toBe('12.50 km')
    expect(detail('计算输入速率')).toBe('1.60 Mbps')
    expect(detail('模型版本')).toBe('engine-model')
    expect(detail('调制方式')).toBe('QPSK')
    for (const label of ['信噪比 SNR', '规范状态', '界面状态', '稳定帧数']) expect(detail(label)).toBe('暂无数据')
    expect(wrapper!.get('[data-testid="link-detail-runtime"]').attributes('data-frame-id')).toBe('10')
  })

  it('引擎分段详情展示同一来源帧号和仿真时刻，且错误优先于上游正常状态', async () => {
    const engineFrame: EngineFrameSnapshot = {
      kind: 'ENGINE_FRAME', runId: scope.runId, engineEpoch: 0, frameId: 18, simulationTime: 72.25, modelVersion: null, modulation: null,
      links: [], jammers: [], routing: { switches: [], alarms: [] }, events: [], initRouting: null,
    }
    wrapper = mount(LinkQualityDialog, { props: {
      modelValue: true, link: null, configuredLink: configured, engineFrame,
      engineSegments: [{
        linkId: 'segment-a', linkIds: [configured.id], sourceName: 'TX', sourcePlatformId: 'TX', sourcePort: 'TX-PORT', targetName: 'RX', targetPlatformId: 'RX', targetPort: 'RX-PORT',
        status: 'DEGRADED', engineStatus: 'RISK', error: null, distanceM: 12500,
        losses: { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: 107 },
        quality: { gxbDb: -7.5, ber: 1.2e-4, rxPowerDbw: -110, rxPowerDbm: -80 },
        inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] },
      }],
    }, global: { plugins: [pinia, ElementPlus], stubs: { ElDialog: dialogStub } } })
    expect(wrapper.get('[data-testid="link-detail-engine-segments"]').text()).toContain('来源帧 18 · 源仿真时刻 1分12.25秒')
    expect(detail('引擎状态')).toBe('劣化')
    expect(detail('信噪比 SNR')).toBe('暂无数据（上游未提供）')
    await wrapper.setProps({ engineSegments: [{
      linkId: 'segment-error', linkIds: [configured.id], sourceName: 'TX', sourcePlatformId: 'TX', sourcePort: 'TX-PORT', targetName: 'RX', targetPlatformId: 'RX', targetPort: 'RX-PORT',
      status: 'UP', engineStatus: 'AVAILABLE', error: '计算输入缺失', distanceM: null,
      losses: { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: null },
      quality: { gxbDb: null, ber: null, rxPowerDbw: null, rxPowerDbm: null },
      inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] },
    }] })
    expect(detail('引擎状态')).toBe('异常（状态未知）')
  })

  it('下一帧缺失指标覆盖前值为暂无数据，不从上一帧或全局默认值补齐', async () => {
    const store = useRuntimeQualityStore()
    const epoch = bindRun()
    store.acceptFrame(epoch, { frameId: 10, simulationTime: 65.5 }, qualityInput())
    mountViews()
    const source = qualityInput()
    expect(store.acceptFrame(epoch, { frameId: 11, simulationTime: 66 }, { model_version: 'global-only', modulation: 'BPSK', links: [{
      link_id: source.links[0]!.link_id, tx_platform: 'TX', rx_platform: 'RX', tx_port: 'TX-PORT', rx_port: 'RX-PORT',
    }] })).toBe(true)
    await flushPromises()
    expect(cardValues().slice(2)).toEqual(Array(7).fill('暂无数据'))
    for (const label of ['误码率 BER', '接收功率', '干信比 GXB', '路径损耗', '模型版本', '调制方式']) expect(detail(label)).toBe('暂无数据')
  })

  it('非法新帧使两处旧值消失，后续合法帧恢复，重复和迟到帧不回写', async () => {
    const store = useRuntimeQualityStore()
    const epoch = bindRun()
    store.acceptFrame(epoch, { frameId: 10, simulationTime: 65.5 }, qualityInput())
    mountViews()
    const invalid = qualityInput()
    invalid.links[0]!.quality.ber = 2
    expect(store.acceptFrame(epoch, { frameId: 11, simulationTime: 66 }, invalid)).toBe(false)
    await flushPromises()
    expect(cardValues().slice(2)).toEqual(Array(7).fill('暂无数据'))
    expect(wrapper!.find('[data-testid="link-detail-runtime"]').exists()).toBe(false)
    expect(detail('误码率 BER')).toBe('暂无数据')
    expect(store.acceptFrame(epoch, { frameId: 10, simulationTime: 65.5 }, qualityInput())).toBe(false)
    expect(store.state).toBe('ERROR')
    expect(store.acceptFrame(epoch, { frameId: 12, simulationTime: 67 }, qualityInput())).toBe(true)
    await flushPromises()
    expect(detail('误码率 BER')).toBe('1.2e-4')
  })

  it.each(['重置', '登出', '换运行'] as const)('%s后清空两处旧测量，旧接收令牌不能恢复', async action => {
    const store = useRuntimeQualityStore()
    const epoch = bindRun()
    store.acceptFrame(epoch, { frameId: 10, simulationTime: 65.5 }, qualityInput())
    mountViews()
    await flushPromises()
    expect(detail('误码率 BER')).toBe('1.2e-4')
    if (action === '重置') useUiStore().clearBusinessProjections()
    else if (action === '登出') useAuthStore().resetToSafeEmpty()
    else useSimulationStore().run = { ...useSimulationStore().run!, runId: 'RUN-NEW' }
    await flushPromises()
    expect(store.snapshot).toBeNull()
    expect(cardValues().slice(2)).toEqual(Array(7).fill('暂无数据'))
    expect(detail('误码率 BER')).toBe('暂无数据')
    expect(store.acceptFrame(epoch, { frameId: 11, simulationTime: 66 }, qualityInput())).toBe(false)
    expect(wrapper!.find('[data-testid="link-detail-runtime"]').exists()).toBe(false)
  })

  it('运行时钟落后时不标为新鲜；时钟前进后按统一年龄筛选，最近窗口仍可查看源时刻', async () => {
    const store = useRuntimeQualityStore()
    const epoch = bindRun()
    store.acceptFrame(epoch, { frameId: 10, simulationTime: 66 }, qualityInput())
    mountViews()
    await flushPromises()
    expect(detail('数据年龄')).toBe('暂无数据')
    useSimulationStore().run!.canonical.currentTime = 67
    await flushPromises()
    expect(wrapper!.findAll('.quality-card')).toHaveLength(0)
    expect(detail('数据年龄')).toBe('1000 ms')
    wrapper!.findAllComponents(ElSelect)[3]!.vm.$emit('update:modelValue', 1000)
    await flushPromises()
    expect(cardValues()[1]).toBe('1分6秒')
    expect(detail('误码率 BER')).toBe(cardValues()[3])
  })

  it('统一投影精确匹配端点和端口，不按同名或相同 BER 错套，清空帧返回空映射', () => {
    const store = useRuntimeQualityStore()
    const epoch = bindRun()
    store.acceptFrame(epoch, { frameId: 10, simulationTime: 65.5 }, qualityInput())
    expect(selectRuntimeQualityViews(store.snapshot, [{ ...binding, sourcePortId: 'OTHER' }], links, 65.5).size).toBe(0)
    expect(selectRuntimeQualityViews(store.snapshot, [{ ...binding, sourcePlatformId: 'OTHER' }], links, 65.5).size).toBe(0)
    expect(selectRuntimeQualityViews(store.snapshot, [], links, 65.5).size).toBe(0)
    expect(selectRuntimeQualityViews(store.snapshot, [binding], [], 65.5).size).toBe(0)
    expect(store.acceptFrame(epoch, { frameId: 11, simulationTime: 66 }, { links: [] })).toBe(true)
    expect(selectRuntimeQualityViews(store.snapshot, [binding], links, 66).size).toBe(0)
    store.resetToSafeEmpty()
    expect(selectRuntimeQualityViews(store.snapshot, [binding], links, 66).size).toBe(0)
  })
})
