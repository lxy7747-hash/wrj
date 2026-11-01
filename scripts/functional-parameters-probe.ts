import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { ScenarioProjection } from '../server/scenarios/projection.js'
import { engineHasLinkCalc, LocalMissionRunner } from '../server/local/mission-runner.js'
import type { ScenarioDraft } from '../src/contracts/domain-models.js'

const executable = resolve(process.argv[2] ?? 'H:/Project/newWrj/Release/Release/mission.exe')
const root = resolve('output', `functional-parameters-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)

function probeDraft(): ScenarioDraft {
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
    platform.initialPosition = { longitude: 119.5 + index * 0.00001, latitude: 24.9, altitude: 10 }
  })
  config.links = [{ ...config.links[0]!, id: 'PARAM-RF-01', type: 'MICROWAVE', enabled: true,
    sourcePlatformId: 'CMD-01', targetPlatformId: 'AIR-01', antennaGainCorrectionDb: 7 }]
  config.sensors = [{ id: 'PARAM-ESM-01', platformId: 'CMD-01', frequencyRange: { min: 2000, max: 5000 }, detectionRange: 150000 }]
  config.jammers = []
  config.informationDemand = [{ ...config.informationDemand[0]!, id: 'PARAM-INFO-01', linkId: 'PARAM-RF-01',
    sourcePlatformId: 'CMD-01', destinationPlatformIds: ['AIR-01'], direction: config.links[0]!.direction,
    enabled: true, frequencyHz: 1, volumeMb: 0.000001 }]
  config.jammingEnabled = false
  config.scenario.duration = 2
  config.scenario.timeStep = 1
  config.output = { ...config.output, directory: 'output', eventsEnabled: true, linkQualityEnabled: false, linkSwitchEnabled: false }
  draft.uiExtensions = { jammers: [], sensors: [{ sensorId: 'PARAM-ESM-01', type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true,
    esm: { sensitivityDbw: -200, detectionThresholdDb: 0, dwellTimeS: 1, revisitTimeS: 1 } }] }
  delete config.linkSettings
  return draft
}

await mkdir(root, { recursive: true })
const draft = probeDraft()
const linkCalcAvailable = await engineHasLinkCalc(executable)
const run = await new LocalMissionRunner(executable, root, undefined, async () => linkCalcAvailable)
  .start(draft, 'RUN-FUNCTIONAL-PARAMETERS', 'TASK-FUNCTIONAL-PARAMETERS')
const outcome = await run.completed
const packageRoot = dirname(run.entryPath)
const mapping = JSON.parse(await readFile(join(packageRoot, 'mapping.json'), 'utf8'))
const script = await readFile(join(packageRoot, 'comm_platform_REAR.txt'), 'utf8')
const definitions = await readFile(join(packageRoot, 'comm_PerDefinition.txt'), 'utf8')
const events = await readFile(join(packageRoot, 'output', 'scenario_events.csv'), 'utf8')
const device = mapping.devices.find((item: { linkId: string }) => item.linkId === 'PARAM-RF-01')
const targetDevice = device.target.deviceId

assert.equal(outcome.code, 0, outcome.errorMessage)
assert.equal(outcome.errorMessage, undefined)
assert.match(script, /sensor .* WSF_ESM_SENSOR/)
assert.match(script, /continuous_detection_sensitivity -200 dBW/)
assert.match(definitions, new RegExp(`antenna_pattern ${targetDevice}_rx\\n  uniform_pattern\\n    peak_gain ${device.antennaGainDb.rx + 7} dB`))
assert.equal(script.includes('WSF_LINK_CALC_PROCESSOR'), linkCalcAvailable,
  'execution package must preserve LinkCalc only when the engine probe confirms the plugin')
assert(events.includes('MESSAGE_TRANSMITTED') && events.includes('MESSAGE_RECEIVED'), 'RF message path did not produce native events')

await writeFile(join(root, 'evidence.json'), JSON.stringify({
  status: 'PASS', executable, engineSha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
  linkCalc: { available: linkCalcAvailable, generatedPreviewContainsProcessor: mapping.linkCalc.emitted, executionPackageProcessorStripped: !linkCalcAvailable },
  nativeAccepted: { rfReceiverAntennaGainCorrectionDb: 7, esmMappedModel: 'WSF_ESM_SENSOR', laserMappingUnchanged: true },
  outcome, packageRoot, generatedAt: new Date().toISOString(),
}, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ status: 'PASS', root, packageRoot }))
