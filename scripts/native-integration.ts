import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { performance } from 'node:perf_hooks'
import { ScenarioProjection } from '../server/scenarios/projection.js'
import { LocalMissionPool } from '../server/local/mission-pool.js'
import { LocalMissionResults } from '../server/local/mission-results.js'
import { inspectScenarioConfig } from '../src/features/scenarios/scenario-validation.js'
import { parseCsvLine } from '../src/features/data-exchange/csv-contract.js'
import { buildMissionPackage } from '../server/scripts/mission-generator.js'
import type { ScenarioDraft, Link, Platform } from '../src/contracts/domain-models.js'

// Evidence-producing local check. It does not modify deployment configuration or claim quality-frame timing.
export function nativeWorkload(id: string, duration: number, phase = 'prepare'): ScenarioDraft {
  const initial = new ScenarioProjection().get('SCN-001')
  assert(initial.ok)
  const draft = initial.data
  const c = draft.config
  const prototype = (type: Platform['type']) => structuredClone(c.platforms.find(p => p.type === type)!)
  const rear = prototype('REAR_COMMAND_NODE'), ground = prototype('GROUND_CLUSTER_COMMAND_NODE')
  const relay = prototype('FORWARD_RELAY_NODE'), air = prototype('AIRBORNE_MISSION_CLUSTER')
  const satellite = prototype('COMMUNICATION_SATELLITE'), station = prototype('GROUND_JAMMER_DETECTION_STATION')
  rear.initialPosition = { longitude: 119.5, latitude: 24.9, altitude: 10 }
  ground.initialPosition = { longitude: 119.50001, latitude: 24.9, altitude: 10 }
  relay.initialPosition = { longitude: 119.5, latitude: 24.9, altitude: 1000 }
  const relay2 = { ...structuredClone(relay), id: 'UAV-LOAD-02', name: '负载中继02' }
  const aircraft = Array.from({ length: 46 }, (_, i) => ({ ...structuredClone(air), id: 'AIR-LOAD-' + String(i + 1).padStart(2, '0'),
    name: '负载机群' + (i + 1), initialPosition: { longitude: 119.501 + i % 8 * 0.001, latitude: 24.9 + Math.floor(i / 8) * 0.001, altitude: 1000 } }))
  const airborneJammer = { ...structuredClone(air), id: 'JAM-AIR-LOAD', name: '机载干扰平台', type: 'AIRBORNE_JAMMER_PLATFORM' as const }
  airborneJammer.initialPosition = { longitude: 121.5, latitude: 25, altitude: 1000 }
  station.initialPosition = { longitude: 121.5, latitude: 25, altitude: 10 }
  c.platforms = [rear, ground, relay, relay2, ...aircraft, satellite, station, airborneJammer]
  for (const p of c.platforms) { p.waypoints = []; p.linkIds = []; p.sensorIds = []; p.jammerIds = []; delete p.loiterWaypoints; delete p.returnPlan }
  // Distinct native subjects let the isolation check detect crossed output paths, even with identical geometry.
  if (phase === 'parallel') for (const platform of c.platforms) platform.id = `${id}-${platform.id}` as Platform['id']
  satellite.satelliteType = 'TIANTONG'
  const template = (type: Link['type']) => structuredClone(c.links.find(link => link.type === type)!)
  const optical = { ...template('LASER'), id: 'LOAD-LASER', sourcePlatformId: rear.id, targetPlatformId: ground.id, enabled: true }
  const sat = { ...template('SAT'), id: 'LOAD-SAT', sourcePlatformId: rear.id, targetPlatformId: relay.id, relayPlatformId: satellite.id, enabled: true }
  const rf = [...aircraft, relay2].map((target, i) => ({ ...template(i === 0 ? 'DATALINK' : 'MICROWAVE'),
    id: 'LOAD-RF-' + String(i + 1).padStart(2, '0'), sourcePlatformId: i === 0 ? ground.id : rear.id,
    targetPlatformId: target.id, direction: 'FORWARD' as const, enabled: true }))
  const fiber = { ...template('FIBER'), id: 'LOAD-FIBER', sourcePlatformId: rear.id, targetPlatformId: ground.id, direction: 'FORWARD' as const, enabled: true }
  c.links = [optical, sat, fiber, ...rf]
  for (const link of c.links) for (const p of c.platforms) if (p.id === link.sourcePlatformId || p.id === link.targetPlatformId || p.id === link.relayPlatformId) p.linkIds.push(link.id)
  const business = c.informationDemand[0]!
  c.informationDemand = c.links.map((link, i) => ({ ...structuredClone(business), id: 'LOAD-INFO-' + (i + 1), linkId: link.id,
    direction: 'FORWARD' as const, sourcePlatformId: link.sourcePlatformId, destinationPlatformIds: [link.targetPlatformId],
    informationType: '态势信息' as const, frequencyHz: 0.2, volumeMb: 0.000001, enabled: true }))
  const jammer = c.jammers[0]!
  c.jammers = [station, airborneJammer].map((p, i) => ({ ...structuredClone(jammer), id: 'LOAD-JAM-' + i, platformId: p.id,
    triggerTimeS: 5, frequency: 4500, bandwidth: 200, defaultPower: 1 }))
  c.jammers.forEach(j => c.platforms.find(p => p.id === j.platformId)!.jammerIds.push(j.id))
  c.sensors = []
  c.scenario.id = id as typeof c.scenario.id; c.scenario.name = '50节点真实联调 ' + phase
  c.scenario.duration = duration; c.scenario.realtime = false; c.scenario.timeStep = 0.25; c.scenario.environment.simClockSpeed = 2
  c.output = { ...c.output, eventsEnabled: true, linkQualityEnabled: false, linkSwitchEnabled: false }
  c.jammingEnabled = true
  delete c.linkSettings
  draft.uiExtensions = { sensors: [], jammers: c.jammers.map(j => ({ jammerId: j.id, direction: 0, enabled: true })) }
  const inspected = inspectScenarioConfig(c, 'write')
  assert(inspected.result.valid, JSON.stringify(inspected.result.errors))
  assert.equal(c.platforms.filter(p => ['REAR_COMMAND_NODE', 'GROUND_CLUSTER_COMMAND_NODE', 'FORWARD_RELAY_NODE', 'AIRBORNE_MISSION_CLUSTER'].includes(p.type)).length, 50)
  assert.equal(new Set(c.links.map(link => link.type)).size, 5)
  return draft
}

async function csvStats(path: string, taskId?: string) {
  const types: Record<string, number> = {}, subjects = new Set<string>()
  const messageEndpoints: Record<string, number> = {}
  const previousTime = new Map<string, number>()
  let intervals = 0, intervalSum = 0, minInterval = Infinity, maxInterval = 0
  let records = 0, header: string[] = []
  const input = createReadStream(path, { encoding: 'utf8' })
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line) continue
      if (!header.length) { header = line.split(','); continue }
      const cells = parseCsvLine(line); assert(cells)
      if (taskId) assert.equal(cells[header.indexOf('task_id')], taskId)
      const type = cells[header.indexOf('EventType')]
      if (type) types[type] = (types[type] ?? 0) + 1
      const subject = cells[header.indexOf(taskId ? 'SourcePlatform' : 'NAME')]
      if (subject) subjects.add(subject)
      if (taskId && type?.startsWith('MESSAGE_')) {
        const parameters = JSON.parse(cells[header.indexOf('Parameters')]!)
        const device = parameters.fields.comm ?? parameters.fields.System ?? parameters.fields.Comm ?? ''
        const key = type + '|' + subject + '|' + device
        messageEndpoints[key] = (messageEndpoints[key] ?? 0) + 1
      } else if (!taskId && subject) {
        const time = Number(cells[header.indexOf('TIME')]), previous = previousTime.get(subject)
        if (previous !== undefined && time > previous) {
          const delta = time - previous; intervalSum += delta; intervals++; minInterval = Math.min(minInterval, delta); maxInterval = Math.max(maxInterval, delta)
        }
        previousTime.set(subject, time)
      }
      records++
    }
  } finally { input.destroy() }
  return { records, types, subjects: [...subjects], bytes: (await stat(path)).size, messageEndpoints,
    positionOutputInterval: intervals ? { samples: intervals, minimumS: minInterval, maximumS: maxInterval, averageS: intervalSum / intervals, note: 'position output cadence, not quality calculation frame time' } : null }
}

async function main(): Promise<void> {
  const phase = process.argv[2] ?? 'prepare'
  assert(['prepare', 'parallel', 'load', 'large-report'].includes(phase), 'phase must be prepare, parallel, load or large-report')
  const executable = resolve(process.argv[3] ?? process.env.MISSION_SMOKE_EXECUTABLE ?? '')
  const root = resolve('output', 'native-integration-20261027', phase + '-' + randomUUID())
  await mkdir(root, { recursive: true })
  console.log(JSON.stringify({ phase, executable, root }))
  const durations = phase === 'large-report' ? [9600] : phase === 'load' ? [5400] : [300, 300]
  const drafts = durations.map((duration, i) => nativeWorkload('SCN-NATIVE-' + phase.toUpperCase() + '-' + i, duration, phase))
  for (const [i, draft] of drafts.entries()) {
    const generated = buildMissionPackage(draft)
    await writeFile(join(root, 'input-' + i + '.json'), JSON.stringify(draft, null, 2))
    await writeFile(join(root, 'plan-' + i + '.json'), JSON.stringify(generated.manifest, null, 2))
  }
  if (phase === 'prepare') { console.log('PREPARED'); process.exitCode = 0 }
  else {
    assert(executable.endsWith('.exe'), 'pass the real mission executable')
    const results = new LocalMissionResults(join(root, 'results'))
    const pool = new LocalMissionPool(executable, join(root, 'runs'), results, 2)
    const jobs: Array<{ run: Awaited<ReturnType<typeof pool.start>>; taskId: string; launchedAt: number }> = []
    const start = performance.now()
    const report: Record<string, unknown> = { phase, root, executable, engineSha256: createHash('sha256').update(await readFile(executable)).digest('hex'), inputNodeCount: 50,
      scenarioDurationS: durations, requestedTimeStepS: 0.25, configuredClockRate: 2, timingMode: 'mission -es, non-realtime',
      frameComputeTiming: 'UNAVAILABLE: no verified quality-frame timing source', tasks: [] }
    const liveSamples: Array<{ at: string; pids: number[] }> = []
    const sampler = setInterval(() => {
      const pids = jobs.flatMap(job => { try { process.kill(job.run.pid, 0); return [job.run.pid] } catch { return [] } })
      if (pids.length > 1 && liveSamples.length < 10) liveSamples.push({ at: new Date().toISOString(), pids })
    }, 50)
    try {
      const outcomes = await Promise.allSettled(drafts.map(async (draft, i) => {
        const taskId = 'TASK-NATIVE-' + i, runId = 'RUN-NATIVE-' + randomUUID()
        const run = await pool.start(draft, runId, taskId)
        jobs.push({ run, taskId, launchedAt: performance.now() })
        console.log(JSON.stringify({ event: 'spawn', taskId, runId, pid: run.pid, entryPath: run.entryPath }))
        let timeout: ReturnType<typeof setTimeout> | undefined
        const outcome = await Promise.race([run.completed, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('native run exceeded ten-minute wall-clock limit')), 600_000)
        })]).finally(() => { if (timeout) clearTimeout(timeout) })
        const completedAt = performance.now()
        const settledAt = new Date().toISOString()
        const mapping = JSON.parse(await readFile(join(dirname(run.entryPath), 'mapping.json'), 'utf8'))
        const execution = JSON.parse(await readFile(join(dirname(run.entryPath), 'execution.json'), 'utf8'))
        const consoleLog = await readFile(join(dirname(run.entryPath), 'mission-console.log'), 'utf8')
        // 引擎还会打印加载、初始化阶段的耗时；只有最后一组出现在完成之后。
        assert(consoleLog.includes('Simulation complete'), 'native completion marker missing')
        const nativeTiming = { wallClockS: Number([...consoleLog.matchAll(/Elapsed Wall Clock Time:\s*([\d.e+-]+)/g)].at(-1)?.[1]),
          processorS: Number([...consoleLog.matchAll(/Elapsed Processor Time\s*:\s*([\d.e+-]+)/g)].at(-1)?.[1]) }
        assert(Number.isFinite(nativeTiming.wallClockS) && Number.isFinite(nativeTiming.processorS), 'native completion timing missing')
        const archiveRoot = join(dirname(dirname(run.entryPath)), 'time-series', taskId)
        const archive = join(archiveRoot, (await readdir(archiveRoot))[0]!)
        const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))
        const archivePublishedAt = (await stat(join(archive, 'manifest.json'))).mtime.toISOString()
        const events = await csvStats(join(archive, 'events.csv'), taskId)
        const position = await csvStats(join(dirname(run.entryPath), mapping.output.resolvedDirectory, 'position.csv'))
        const task = { taskId, runId, pid: run.pid, startedAt: run.startedAt, completedAt: outcome.completedAt,
          settledAt, archivePublishedAt, continuousArchiveLagAfterExitMs: Date.parse(archivePublishedAt) - Date.parse(outcome.completedAt!),
          outcome, receipt: execution, archive, manifest, events, position, nativeTiming, completedWallMs: completedAt - start }
        ;(report.tasks as unknown[]).push(task)
        assert.equal(outcome.code, 0, JSON.stringify(outcome)); assert.equal(outcome.errorMessage, undefined)
        assert.equal(manifest.status, 'COMPLETED'); assert.equal(events.records, manifest.files.find((f: { fileName: string }) => f.fileName === 'events.csv').rowCount)
        assert.equal(events.types.SIMULATION_COMPLETE, 1)
        if (phase === 'large-report') assert(manifest.files.find((file: { fileName: string }) => file.fileName === 'events.csv').sourceBytes > 32 * 1024 * 1024,
          'large-report verification must use a genuinely larger than 32 MiB native event file')
        assert(events.subjects.every(subject => draft.config.platforms.some(platform => platform.id === subject)), 'events contain subjects from another task')
        const informationNodes = draft.config.platforms.filter(p => ['REAR_COMMAND_NODE', 'GROUND_CLUSTER_COMMAND_NODE', 'FORWARD_RELAY_NODE', 'AIRBORNE_MISSION_CLUSTER'].includes(p.type))
        assert(informationNodes.every(node => position.subjects.includes(node.id)), 'position output does not cover all 50 information nodes')
        return task
      }))
      report.wallClockMs = performance.now() - start
      report.outcomes = outcomes.map(result => result.status === 'fulfilled' ? { status: 'fulfilled', taskId: result.value.taskId } : { status: 'rejected', reason: String(result.reason) })
      report.spawnCount = jobs.length
      assert(outcomes.every(result => result.status === 'fulfilled'), JSON.stringify(report.outcomes))
      report.results = await results.list()
      assert.equal((report.results as unknown[]).length, drafts.length, 'completed result snapshots missing')
      if (phase === 'parallel') {
        const tasks = report.tasks as Array<{ startedAt: string; completedAt: string }>
        report.overlapMs = Math.min(...tasks.map(task => Date.parse(task.completedAt))) - Math.max(...tasks.map(task => Date.parse(task.startedAt)))
        assert((report.overlapMs as number) > 0, 'runs did not actually overlap')
        assert(liveSamples.length > 0, 'did not observe two owned native PIDs alive simultaneously')
      }
      report.status = 'PASS_WITH_LIMITATIONS'
    } catch (error) { report.status = 'FAILED'; report.error = error instanceof Error ? error.stack : String(error); process.exitCode = 1 }
    finally {
      clearInterval(sampler)
      report.simultaneousLivePidSamples = liveSamples
      await Promise.allSettled(jobs.map(job => job.run.stop()))
      report.finalGuard = pool.safetyStatus()
      await writeFile(join(root, 'summary.json'), JSON.stringify(report, null, 2))
      console.log(JSON.stringify({ status: report.status, summary: join(root, 'summary.json'), wallClockMs: report.wallClockMs }))
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
