import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ScenarioProjection } from '../server/scenarios/projection.js'
import { engineHasLinkCalc, LocalMissionRunner } from '../server/local/mission-runner.js'
import { readDeviceParameters } from '../src/features/scenarios/template-defaults.js'
import type { ScenarioDraft } from '../src/contracts/domain-models.js'

/** 探针配置只操作内存快照，端口参数才是新模板实际使用的通信参数。 */
export function functionalParameterDraft(): ScenarioDraft {
  const loaded = new ScenarioProjection().get('SCN-001')
  if (!loaded.ok) throw new Error(loaded.message)
  const draft = loaded.data
  const config = draft.config
  config.platforms = config.platforms.filter(platform => ['CMD-01', 'AIR-01'].includes(platform.id))
  config.platforms.forEach((platform, index) => {
    platform.linkIds = ['PARAM-RF-01']
    platform.jammerIds = []
    platform.sensorIds = platform.id === 'CMD-01' ? ['PARAM-ESM-01'] : []
    platform.waypoints = []
    delete platform.loiterWaypoints
    delete platform.returnPlan
    // 后方定向微波朝北；本探针明确布置接收端，不假定天线自动对准。
    platform.initialPosition = { longitude: 119.5, latitude: 24.9 + index * 0.00001, altitude: 10 }
  })
  config.links = [{ ...config.links[0]!, id: 'PARAM-RF-01', type: 'MICROWAVE', enabled: true,
    sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', direction: 'FORWARD', antennaGainCorrectionDb: 7 }]
  config.sensors = [{ id: 'PARAM-ESM-01', platformId: 'CMD-01', frequencyRange: { min: 2000, max: 5000 }, detectionRange: 150000 }]
  config.jammers = []
  config.informationDemand = [{ ...config.informationDemand[0]!, id: 'PARAM-INFO-01', linkId: 'PARAM-RF-01',
    sourcePlatformId: 'CMD-01', destinationPlatformIds: ['AIR-01'], direction: 'FORWARD', informationType: '态势信息',
    enabled: true, frequencyHz: 1, volumeMb: 0.000001 }]
  config.deviceParameters = readDeviceParameters(config)
  for (const type of ['REAR_COMM_PLATFORM', 'MISSION_UAV_PLATFORM'] as const) {
    const port = config.deviceParameters.ports![type]!.microwave_link!
    Object.assign(port, { txFrequency: 8210, rxFrequency: 8210, txBandwidth: 40, rxBandwidth: 40,
      txPower: 25, transferRate: 96, noiseFigureDb: 4 })
  }
  config.deviceParameters.antennaGains!.MICRO_UAV_OMNI_ANTENNA = 4
  config.jammingEnabled = false
  config.scenario.duration = 8
  config.scenario.realtime = false
  config.scenario.timeStep = 1
  config.output = { ...config.output, directory: 'output', eventsEnabled: true, linkQualityEnabled: false, linkSwitchEnabled: false }
  draft.uiExtensions = { jammers: [], sensors: [{ sensorId: 'PARAM-ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true,
    esm: { sensitivityDbw: -200, detectionThresholdDb: 0, dwellTimeS: 1, revisitTimeS: 1 } }] }
  delete config.linkSettings
  return draft
}

async function main(): Promise<void> {
  const executable = resolve(process.argv[2] ?? 'H:/Project/newWrj/Release/Release/mission.exe')
  const root = resolve('output', `functional-parameters-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
  await mkdir(root, { recursive: true })
  const draft = functionalParameterDraft()
  const linkCalcAvailable = await engineHasLinkCalc(executable)
  const run = await new LocalMissionRunner(executable, root, undefined, async () => linkCalcAvailable)
    .start(draft, 'RUN-FUNCTIONAL-PARAMETERS', 'TASK-FUNCTIONAL-PARAMETERS')
  const outcome = await run.completed
  const packageRoot = dirname(run.entryPath)
  const mapping = JSON.parse(await readFile(join(packageRoot, 'mapping.json'), 'utf8'))
  const script = await readFile(join(packageRoot, 'comm_platform_REAR.txt'), 'utf8')
  const uav = await readFile(join(packageRoot, 'comm_platform_MISSION_UAV.txt'), 'utf8')
  const definitions = await readFile(join(packageRoot, 'comm_PerDefinition.txt'), 'utf8')
  const events = await readFile(join(packageRoot, 'output', 'scenario_events.csv'), 'utf8')
  const device = mapping.devices.find((item: { linkId: string }) => item.linkId === 'PARAM-RF-01')
  assert.equal(outcome.code, 0, outcome.errorMessage)
  assert.equal(outcome.errorMessage, undefined)
  assert.equal(device.source.platformId, 'CMD-01')
  assert.equal(device.target.platformId, 'AIR-01')
  assert.equal(device.source.deviceId, 'microwave_link')
  assert.equal(device.target.deviceId, 'microwave_link')
  assert.match(script, /frequency 8\.21 GHz/)
  assert.match(uav, /transfer_rate constant 96 mbits\/sec/)
  assert.match(definitions, /antenna_pattern MICRO_UAV_OMNI_ANTENNA\n  uniform_pattern\n    peak_gain 4 dB/)
  assert(!script.includes('WSF_ESM_SENSOR') && !uav.includes('WSF_ESM_SENSOR'), 'ESM属于D1保留项，不能冒称引擎接入')
  assert.equal(script.includes('WSF_LINK_CALC_PROCESSOR'), linkCalcAvailable)
  assert.equal(script.includes('local_link_stub'), !linkCalcAvailable)
  assert(events.split(/\r?\n/u).some(line => /^\d[^,]*,MESSAGE_RECEIVED,/u.test(line)), '本探针未获得实际接收事件')
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ status: 'PASS', executable,
    engineSha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
    linkCalc: { available: linkCalcAvailable, compatibility: mapping.localRuntime.linkCalc },
    nativeAccepted: { port: 'microwave_link', frequencyMHz: 8210, transferRateMbps: 96, sharedUavGainDb: 4 },
    retainedNotExecuted: ['ESM扩展', '链路增益修正'], outcome, packageRoot, generatedAt: new Date().toISOString(),
  }, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ status: 'PASS', root, packageRoot }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
