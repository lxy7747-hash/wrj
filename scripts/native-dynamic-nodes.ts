import assert from 'node:assert/strict'
import { metersBetween } from '../src/features/scenarios/position-distance.js'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ScenarioProjection } from '../server/scenarios/projection.js'
import { buildMissionPackage } from '../server/scripts/mission-generator.js'
import type { Platform, ScenarioDraft } from '../src/contracts/domain-models.js'
import { inspectScenarioConfig } from '../src/features/scenarios/scenario-validation.js'
import { parseCsvLine } from '../src/features/data-exchange/csv-contract.js'

const executable = resolve(process.argv[2] ?? 'H:/Project/newWrj/Release/Release/mission.exe')
const root = resolve('output', 'local-remediation-20261027', 'dynamic', `run-${randomUUID()}`)
const packageRoot = join(root, 'package')
const DYNAMIC_TYPES = ['FORWARD_RELAY_NODE', 'AIRBORNE_MISSION_CLUSTER'] as const
const STATIC_TYPES = ['REAR_COMMAND_NODE', 'GROUND_CLUSTER_COMMAND_NODE'] as const
const timeoutMs = 120_000
const scenarioDurationS = 90

type PositionRow = { time: number; name: string; longitude: number; latitude: number; altitude: number; speed: number; heading: number }

function prototype(draft: ScenarioDraft, type: Platform['type']): Platform {
  const item = draft.config.platforms.find(platform => platform.type === type)
  assert(item, `missing platform prototype ${type}`)
  return structuredClone(item)
}

/** 四类信息节点共 50/51 个；仅飞行/中继节点带实际航点，地面/后方节点保持静态。 */
export function dynamicDraft(informationNodeCount = 50): ScenarioDraft {
  assert(informationNodeCount === 50 || informationNodeCount === 51, 'node count must be 50 or 51')
  const current = new ScenarioProjection().get('SCN-001')
  assert(current.ok)
  const draft = current.data
  const rear = prototype(draft, 'REAR_COMMAND_NODE')
  const ground = prototype(draft, 'GROUND_CLUSTER_COMMAND_NODE')
  const relay = prototype(draft, 'FORWARD_RELAY_NODE')
  const airborne = prototype(draft, 'AIRBORNE_MISSION_CLUSTER')
  rear.id = 'DYN-REAR-01'; rear.name = rear.id; rear.initialPosition = { longitude: 119.5, latitude: 24.9, altitude: 10 }
  ground.id = 'DYN-GROUND-01'; ground.name = ground.id; ground.initialPosition = { longitude: 119.51, latitude: 24.9, altitude: 10 }
  const moving = Array.from({ length: informationNodeCount - 2 }, (_, index) => {
    // 场景合同保留中继类型最多 2 个的资源保护；其余动态节点均为业务无人集群。
    const type = index < 2 ? 'FORWARD_RELAY_NODE' as const : 'AIRBORNE_MISSION_CLUSTER' as const
    const platform = structuredClone(type === 'FORWARD_RELAY_NODE' ? relay : airborne)
    platform.id = `DYN-${type === 'FORWARD_RELAY_NODE' ? 'RELAY' : 'AIR'}-${String(index + 1).padStart(2, '0')}`
    platform.name = platform.id
    const longitude = 119.52 + (index % 8) * 0.01
    const latitude = 24.92 + Math.floor(index / 8) * 0.01
    const altitude = type === 'FORWARD_RELAY_NODE' ? 2500 : 1800
    platform.initialPosition = { longitude, latitude, altitude }
    platform.waypoints = [{ longitude: longitude + 0.035, latitude: latitude + 0.02, altitude: altitude + (type === 'FORWARD_RELAY_NODE' ? 250 : 100), speed: type === 'FORWARD_RELAY_NODE' ? 120 : 110, arrivalTime: 0 }]
    return platform
  })
  draft.config.platforms = [rear, ground, ...moving]
  for (const platform of draft.config.platforms) { platform.linkIds = []; platform.sensorIds = []; platform.jammerIds = [] }
  const sourceLink = draft.config.links.find(item => item.type === 'FIBER') ?? draft.config.links[0]
  assert(sourceLink, 'missing link prototype')
  const link = structuredClone(sourceLink)
  link.id = 'DYN-LINK-01'; link.sourcePlatformId = rear.id; link.targetPlatformId = ground.id; link.enabled = true
  rear.linkIds = [link.id]; ground.linkIds = [link.id]
  const demand = structuredClone(draft.config.informationDemand[0]!)
  const reverse = link.direction === 'REVERSE'
  demand.id = 'DYN-INFO-01'; demand.linkId = link.id; demand.direction = link.direction
  demand.sourcePlatformId = reverse ? ground.id : rear.id; demand.destinationPlatformIds = [reverse ? rear.id : ground.id]; demand.enabled = false
  draft.config.links = [link]; draft.config.informationDemand = [demand]; draft.config.jammers = []; draft.config.sensors = []
  draft.config.jammingEnabled = false
  draft.config.scenario.id = 'SCN-NATIVE-DYNAMIC' as typeof draft.config.scenario.id
  draft.config.scenario.name = '动态信息节点本机原生验证'
  draft.config.scenario.duration = scenarioDurationS
  draft.config.scenario.realtime = false
  draft.config.scenario.timeStep = 1
  draft.config.output = { ...draft.config.output, directory: 'output', eventsEnabled: true, linkQualityEnabled: false, linkSwitchEnabled: false }
  draft.uiExtensions = { jammers: [], sensors: [] }
  delete draft.config.linkSettings
  const validation = inspectScenarioConfig(draft.config, 'write')
  assert(validation.result.valid, JSON.stringify(validation.result.errors))
  assert.equal(draft.config.platforms.length, informationNodeCount)
  for (const type of [...STATIC_TYPES, ...DYNAMIC_TYPES]) assert(draft.config.platforms.some(platform => platform.type === type), `missing ${type}`)
  assert.equal(draft.config.platforms.filter(platform => DYNAMIC_TYPES.includes(platform.type as typeof DYNAMIC_TYPES[number])).length, informationNodeCount - 2)
  assert.equal(draft.config.platforms.filter(platform => STATIC_TYPES.includes(platform.type as typeof STATIC_TYPES[number])).length, 2)
  return draft
}

function bearingDegrees(left: PositionRow, right: PositionRow): number {
  const radians = Math.PI / 180
  const longitude = (right.longitude - left.longitude) * radians
  const y = Math.sin(longitude) * Math.cos(right.latitude * radians)
  const x = Math.cos(left.latitude * radians) * Math.sin(right.latitude * radians)
    - Math.sin(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.cos(longitude)
  return (Math.atan2(y, x) / radians + 360) % 360
}

function angleDifference(left: number, right: number): number {
  return Math.abs(((left - right + 540) % 360) - 180)
}

function assertTrackBaseline(platform: Platform, rows: PositionRow[]): void {
  assert(rows.length >= 2, `${platform.id} needs multiple position samples`)
  assert(rows.every((row, index) => index === 0 || row.time > rows[index - 1]!.time), `${platform.id} sample time is not strictly increasing`)
  assert(rows[0]!.time <= 0.001 && rows.at(-1)!.time >= scenarioDurationS - 0.1, `${platform.id} does not cover the run time`)
  const initial = { time: 0, name: platform.id, ...platform.initialPosition, speed: 0, heading: 0 }
  assert(metersBetween(rows[0]!, initial) <= 2 && Math.abs(rows[0]!.altitude - initial.altitude) <= 2, `${platform.id} first position differs from configured initial position`)
}

async function readPositions(path: string): Promise<Map<string, PositionRow[]>> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean)
  assert.equal(lines.shift(), 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING')
  const tracks = new Map<string, PositionRow[]>()
  for (const line of lines) {
    const cells = parseCsvLine(line)
    assert(cells && cells.length === 7, `invalid position row: ${line}`)
    const [time, name, longitude, latitude, altitude, speed, heading] = cells
    const row = { time: Number(time), name, longitude: Number(longitude), latitude: Number(latitude), altitude: Number(altitude), speed: Number(speed), heading: Number(heading) }
    assert(Object.values(row).filter(value => typeof value === 'number').every(Number.isFinite), `non-finite position row: ${line}`)
    const values = tracks.get(name) ?? []
    values.push(row); tracks.set(name, values)
  }
  return tracks
}

async function runNative(entry: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(executable, ['-es', entry], { cwd: packageRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
  return new Promise((resolveRun, rejectRun) => {
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 仅终止本脚本创建的进程。 */ }
      rejectRun(new Error(`native dynamic validation exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); rejectRun(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr }) })
  })
}

async function hashFiles(directory: string): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const output: Array<{ path: string; bytes: number; sha256: string }> = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await hashFiles(path))
    else if (entry.isFile()) {
      const content = await readFile(path)
      output.push({ path: relative(root, path), bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
    }
  }
  return output
}

async function main(): Promise<void> {
  const informationNodeCount = Number(process.argv[3] ?? '50')
  await mkdir(packageRoot, { recursive: true })
  const draft = dynamicDraft(informationNodeCount)
  const generated = buildMissionPackage(draft, draft.config.output, { linkCalc: 'STUB' })
  await mkdir(join(packageRoot, generated.manifest.output.resolvedDirectory), { recursive: true })
  for (const [name, content] of Object.entries(generated.files)) {
    const path = join(packageRoot, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' })
  }
  await writeFile(join(root, 'execution-adaptation.json'), JSON.stringify(JSON.parse(generated.files['mapping.json']!).localRuntime, null, 2) + '\n', 'utf8')

  const startedAt = new Date().toISOString()
  let report: Record<string, unknown>
  try {
    const run = await runNative(generated.manifest.entry)
    await writeFile(join(root, 'mission-console.log'), `${run.stdout}${run.stderr}`, 'utf8')
    assert.equal(run.code, 0, `native exit ${run.code}; see mission-console.log`)
    assert((run.stdout + run.stderr).includes('Simulation complete'), 'native completion marker missing')
    const outputRoot = join(packageRoot, generated.manifest.output.resolvedDirectory)
    const positions = await readPositions(join(outputRoot, 'position.csv'))
    const expected = new Set(draft.config.platforms.map(platform => platform.id))
    assert.deepEqual(new Set(positions.keys()), expected, `position output must cover exactly the ${informationNodeCount} information nodes`)
    const dynamics = draft.config.platforms.filter(platform => DYNAMIC_TYPES.includes(platform.type as typeof DYNAMIC_TYPES[number]))
    const statics = draft.config.platforms.filter(platform => STATIC_TYPES.includes(platform.type as typeof STATIC_TYPES[number]))
    const dynamicEvidence = dynamics.map(platform => {
      const rows = positions.get(platform.id)!
      assertTrackBaseline(platform, rows)
      const waypoint = platform.waypoints[0]
      assert(waypoint, `${platform.id} has no configured route target`)
      const displacementM = metersBetween(rows[0]!, rows.at(-1)!)
      assert(displacementM > 50, `${platform.id} did not move enough: ${displacementM}m`)
      const maximumSpeedMps = Math.max(...rows.map(row => Math.abs(row.speed)))
      assert(Math.abs(maximumSpeedMps - waypoint.speed) <= 0.5, `${platform.id} route speed differs from configured waypoint speed`)
      const expectedBearing = bearingDegrees(rows[0]!, { time: 0, name: platform.id, ...waypoint, heading: 0 })
      const actualBearing = bearingDegrees(rows[0]!, rows.at(-1)!)
      const bearingDifferenceDegrees = angleDifference(actualBearing, expectedBearing)
      assert(bearingDifferenceDegrees <= 5, `${platform.id} trajectory direction differs from configured waypoint`)
      return { platformId: platform.id, samples: rows.length, startTime: rows[0]!.time, endTime: rows.at(-1)!.time, displacementM,
        configuredSpeedMps: waypoint.speed, maximumSpeedMps, expectedBearing, actualBearing, bearingDifferenceDegrees }
    })
    const staticEvidence = statics.map(platform => {
      const rows = positions.get(platform.id)!
      assertTrackBaseline(platform, rows)
      const displacementM = metersBetween(rows[0]!, rows.at(-1)!)
      const maximumSpeedMps = Math.max(...rows.map(row => Math.abs(row.speed)))
      assert(rows.every(row => metersBetween(rows[0]!, row) <= 2 && Math.abs(row.altitude - rows[0]!.altitude) <= 2 && Math.abs(row.speed) <= 0.01), `${platform.id} unexpectedly moved`)
      return { platformId: platform.id, samples: rows.length, displacementM, maximumSpeedMps }
    })
    const events = await readFile(join(outputRoot, 'scenario_events.csv'), 'utf8')
    assert(events.includes('SIMULATION_COMPLETE'), 'native event completion missing')
    report = { status: 'PASS', startedAt, finishedAt: new Date().toISOString(), executable,
      engineSha256: createHash('sha256').update(await readFile(executable)).digest('hex'), scenarioDurationS: draft.config.scenario.duration,
      nodeCount: draft.config.platforms.length, categories: Object.fromEntries([...STATIC_TYPES, ...DYNAMIC_TYPES].map(type => [type, draft.config.platforms.filter(platform => platform.type === type).length])),
      dynamicNodes: dynamicEvidence, staticNodes: staticEvidence,
      positionCadence: 'MOVER_UPDATED position samples only; not a 0.25 s quality frame or quality-performance claim.',
      linkQuality: 'REQUIRES_ENGINE: no verified quality source or WSF_LINK_CALC_PROCESSOR.',
      output: generated.manifest.output.resolvedDirectory }
  } catch (error) {
    report = { status: 'FAILED', startedAt, finishedAt: new Date().toISOString(), executable, error: error instanceof Error ? error.stack : String(error) }
    process.exitCode = 1
  }
  await writeFile(join(root, 'summary.json'), JSON.stringify({ ...report, files: await hashFiles(root) }, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ root, status: report.status, summary: join(root, 'summary.json') }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
