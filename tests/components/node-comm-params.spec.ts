import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineFrameSnapshot, Link, ScenarioConfig } from '../../src/contracts/domain-models'
import type { SituationMapNode } from '../../src/features/situation/initial-nodes'
import { buildNodeLinkParameterRows, slantDistanceMeters } from '../../src/features/situation/node-comm-params'

const controllerState = vi.hoisted(() => ({
  onSelectNode: null as ((platformId: string) => void) | null,
}))

vi.mock('../../src/components/situation/situation-map-controller', () => ({
  createSituationMapController: vi.fn((options: { onSelectNode: (platformId: string) => void }) => {
    controllerState.onSelectNode = options.onSelectNode
    return {
      setNodes: vi.fn(),
      setFrame: vi.fn(),
      setEngineFrame: vi.fn(),
      setNodeTrails: vi.fn(),
      setFileLinks: vi.fn(),
      setFileMessageLinks: vi.fn(),
      setFileDeviceStates: vi.fn(),
      setFilePlayback: vi.fn(),
      setConfiguredLinks: vi.fn(),
      setFocusLinks: vi.fn(),
      setConfiguredLinkStatuses: vi.fn(),
      setConfiguredLinkSwitches: vi.fn(),
      setConfiguredJammers: vi.fn(),
      setConfiguredEnvironment: vi.fn(),
      setLiveMessageFlows: vi.fn(),
      setLiveFlowPlayback: vi.fn(),
      setLinks: vi.fn(),
      setSelectedNodeId: vi.fn(),
      setLayerVisible: vi.fn(),
      setTheme: vi.fn(),
      setBasemap: vi.fn(),
      setZoom: vi.fn(),
      resetView: vi.fn(),
      focusTarget: vi.fn(),
      resize: vi.fn(),
      destroy: vi.fn(),
    }
  }),
}))

import OfflineSituationMap from '../../src/components/situation/OfflineSituationMap.vue'

enableAutoUnmount(afterEach)
afterEach(() => {
  controllerState.onSelectNode = null
  document.body.innerHTML = ''
})

const NODES: SituationMapNode[] = [
  { platformId: 'CMD-01', name: '地面指挥车', type: 'GROUND_CLUSTER_COMMAND_NODE', longitude: 120.0, latitude: 25.0, altitude: 50, speed: 0 },
  { platformId: 'RELAY-01', name: '前出中继', type: 'FORWARD_RELAY_NODE', longitude: 120.5, latitude: 25.0, altitude: 8000, speed: 60 },
  { platformId: 'UAV-01', name: '任务无人机01', type: 'AIRBORNE_MISSION_CLUSTER', longitude: 121.0, latitude: 25.0, altitude: 5000, speed: 70 },
  { platformId: 'SAT-01', name: '神通卫星', type: 'COMM_SATELLITE', satelliteType: 'SHENTONG', longitude: 120.0, latitude: 0.0, altitude: 35_786_000, speed: 0 },
  { platformId: 'REAR-01', name: '后方指挥节点', type: 'REAR_COMMAND_NODE', longitude: 119.5, latitude: 25.0, altitude: 20, speed: 0 },
]

function makeLink(overrides: Partial<Link> & Pick<Link, 'id' | 'type' | 'sourcePlatformId' | 'targetPlatformId'>): Link {
  return {
    frequency: 2300,
    bandwidth: 10,
    txPower: 20,
    antennaGain: { tx: 5, rx: 6 },
    modulation: 'QPSK',
    berThreshold: 1e-5,
    dataRate: 8,
    direction: 'FORWARD',
    antiJammingGainDb: 12,
    spatialIsolationDb: 8,
    ...overrides,
  }
}

describe('节点详情通信参数汇总与展示', () => {
  it('三维斜距计算兼顾近距平台与高轨卫星海拔', () => {
    const uavToCmd = slantDistanceMeters(NODES[0]!, NODES[2]!)!
    expect(uavToCmd / 1000).toBeGreaterThan(95)
    expect(uavToCmd / 1000).toBeLessThan(105)

    const satToCmd = slantDistanceMeters(NODES[0]!, NODES[3]!)!
    expect(satToCmd / 1000).toBeGreaterThan(36_000)
    expect(satToCmd / 1000).toBeLessThan(37_000)
  })

  it('未启动仿真时自动按两端坐标算出参考通信距离，并展示功率、增益、抗干扰与空域隔离', () => {
    const links: Link[] = [
      makeLink({
        id: 'L-DL-01', type: 'DATALINK', sourcePlatformId: 'CMD-01', targetPlatformId: 'UAV-01',
        relayPlatformId: 'RELAY-01', txPower: 30, antennaGain: { tx: 5, rx: 4 }, antennaGainCorrectionDb: 1.5,
        antiJammingGainDb: 15, spatialIsolationDb: 10,
      }),
      makeLink({
        id: 'L-LASER-01', type: 'LASER', sourcePlatformId: 'RELAY-01', targetPlatformId: 'UAV-01',
        txPower: 0.1, antennaGain: { tx: 45, rx: 45 }, direction: 'REVERSE',
      }),
      makeLink({
        id: 'L-FIBER-01', type: 'FIBER', sourcePlatformId: 'REAR-01', targetPlatformId: 'CMD-01',
      }),
      makeLink({
        id: 'L-DISABLED', type: 'MICROWAVE', sourcePlatformId: 'CMD-01', targetPlatformId: 'UAV-01', enabled: false,
      }),
    ]

    const cmdRows = buildNodeLinkParameterRows({
      platformId: 'CMD-01',
      nodes: NODES,
      configuredLinks: [],
      focusLinks: links,
    })
    expect(cmdRows).toHaveLength(2)

    const dl = cmdRows.find(row => row.linkId === 'L-DL-01')!
    expect(dl.roleLabel).toBe('发送端')
    expect(dl.peerLabel).toBe('任务无人机01（经 前出中继）')
    expect(dl.txPowerText).toBe('30 W')
    expect(dl.antennaGainText).toBe('发 5 / 收 4 dBi（修正 +1.5 dB）')
    expect(dl.distanceSource).toBe('COORDINATES')
    expect(dl.distanceText).toMatch(/km（参考）$/)
    expect(dl.antiJammingGainText).toBe('15 dB')
    expect(dl.spatialIsolationText).toBe('10 dB')

    const fiber = cmdRows.find(row => row.linkId === 'L-FIBER-01')!
    expect(fiber.txPowerText).toBe('—')
    expect(fiber.antennaGainText).toBe('—')
    expect(fiber.antiJammingGainText).toBe('—')
    expect(fiber.spatialIsolationText).toBe('—')

    const uavRows = buildNodeLinkParameterRows({
      platformId: 'UAV-01',
      nodes: NODES,
      configuredLinks: [],
      focusLinks: links,
    })
    const laser = uavRows.find(row => row.linkId === 'L-LASER-01')!
    expect(laser.txPowerText).toBe('0.1 W')
    expect(laser.antennaGainText).toBe('发 45 / 收 45 dBi')
    expect(laser.antiJammingGainText).toBe('—')
    expect(laser.spatialIsolationText).toBe('—')
  })

  it('有引擎实时距离时优先显示实时距离，并支持端口参数投影', () => {
    const link = makeLink({
      id: 'L-MW-01', type: 'MICROWAVE', sourcePlatformId: 'UAV-01', targetPlatformId: 'RELAY-01',
      txPower: 20, antennaGain: { tx: 3, rx: 3 }, antiJammingGainDb: 9, spatialIsolationDb: 6,
    })
    const configuredScenario: Pick<ScenarioConfig, 'platforms' | 'deviceParameters'> = {
      platforms: [
        { id: 'UAV-01', name: '任务无人机01', type: 'AIRBORNE_MISSION_CLUSTER', category: 'air', initialPosition: { longitude: 121, latitude: 25, altitude: 5000 }, waypoints: [], linkIds: ['L-MW-01'], sensorIds: [], jammerIds: [] },
        { id: 'RELAY-01', name: '前出中继', type: 'FORWARD_RELAY_NODE', category: 'air', initialPosition: { longitude: 120.5, latitude: 25, altitude: 8000 }, waypoints: [], linkIds: ['L-MW-01'], sensorIds: [], jammerIds: [] },
      ],
      deviceParameters: {
        ports: {
          MISSION_UAV_PLATFORM: {
            microwave_link: { txFrequency: 8200, txBandwidth: 50, txPower: 42, rxFrequency: 8200, rxBandwidth: 50, noiseFigureDb: 3, transferRate: 80 },
          },
        },
      },
    }
    const engineFrame = {
      frameId: 5,
      simulationTime: 25,
      links: [{
        segmentId: 'seg-1',
        linkIds: ['L-MW-01'],
        sourcePlatformId: 'UAV-01',
        targetPlatformId: 'RELAY-01',
        sourceName: 'UAV-01',
        targetName: 'RELAY-01',
        sourcePort: 'microwave_link',
        targetPort: 'microwave_link',
        status: 'UP',
        error: null,
        distanceM: 51_230,
        losses: { freeSpaceDb: null, seaMultipathDb: null, atmosphericDb: null, cloudRainDb: null, jammingDb: null, totalDb: null, rainDb: null, cloudDb: null },
        quality: { gxbDb: 12, ber: 1e-7, rxPowerDbw: -90, rxPowerDbm: -60, delay: null },
        inputTrace: { eirpDbw: null, gtDbk: null, dataRateMbps: null, frequencyGHz: null, jammers: [] },
      }],
      jammers: [],
      events: [],
    } as unknown as EngineFrameSnapshot

    const rows = buildNodeLinkParameterRows({
      platformId: 'UAV-01',
      nodes: NODES,
      configuredLinks: [{ ...link, distanceM: 51_230 }],
      focusLinks: [link],
      engineFrame,
      configuredScenario,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.txPowerText).toBe('42 W')
    expect(rows[0]!.distanceSource).toBe('ENGINE')
    expect(rows[0]!.distanceText).toBe('51.23 km（实时）')
  })

  it('在地图节点详情弹框中展示通信节点参数表格', async () => {
    const link = makeLink({
      id: 'L-DL-01', type: 'DATALINK', sourcePlatformId: 'CMD-01', targetPlatformId: 'UAV-01',
      txPower: 25, antennaGain: { tx: 6, rx: 5 }, antiJammingGainDb: 14, spatialIsolationDb: 11,
    })
    const wrapper = mount(OfflineSituationMap, {
      props: {
        frame: null,
        initialNodes: NODES,
        configuredLinks: [],
        focusLinks: [link],
        links: [],
        selectedNodeId: 'CMD-01',
        focusTarget: null,
      },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    controllerState.onSelectNode!('CMD-01')
    await flushPromises()

    const dialog = wrapper.find('[data-testid="selected-node-dialog"]')
    expect(dialog.exists()).toBe(true)
    const section = dialog.find('[data-testid="node-comm-params"]')
    expect(section.exists()).toBe(true)
    const text = section.text()
    expect(text).toContain('通信节点参数')
    expect(text).toContain('25 W')
    expect(text).toContain('发 6 / 收 5 dBi')
    expect(text).toContain('km（参考）')
    expect(text).toContain('14 dB')
    expect(text).toContain('11 dB')
  })
})
