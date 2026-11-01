import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { ContinuousTimeSeriesWriter } from '../server/local/continuous-time-series.js'
import { parseCsvLine } from '../src/features/data-exchange/csv-contract.js'

// Controlled I/O evidence, not native quality measurements or an acceptance latency threshold.
const producer = process.argv[2] === '--producer'
const rate = Number(process.argv[producer ? 4 : 2] ?? 5000)
const seconds = Number(process.argv[producer ? 5 : 3] ?? 10)
assert(Number.isInteger(rate) && rate >= 10 && rate <= 10000)
assert(Number.isInteger(seconds) && seconds >= 1 && seconds <= 30 && rate * seconds <= 100000)
const count = rate * seconds
if (producer) {
  const file = await open(resolve(process.argv[3]!), 'wx')
  const hash = createHash('sha256')
  const write = async (text: string) => { await file.writeFile(text); hash.update(text) }
  const started = performance.now()
  let emitted = 0, firstGeneratedAt = 0, lastGeneratedAt = 0
  try {
    await write('! MESSAGE_RECEIVED,time<time>,event<string>,platform<string>,side<string>,comm<string>,message_serial_number<int>,data_tag<double>,message_type<string>,message_size<int>,comment<string>\n'
      + '! SIMULATION_COMPLETE,time<time>,event<string>,year<int>,month<int>,day<int>,hour<int>,minute<int>,second<int>\n')
    while (emitted < count) {
      await delay(Math.max(0, started + emitted / rate * 1000 - performance.now()))
      const generatedAt = Date.now()
      firstGeneratedAt ||= generatedAt; lastGeneratedAt = generatedAt
      const n = Math.min(Math.max(1, Math.floor(rate / 10)), count - emitted)
      const rows = Array.from({ length: n }, (_, i) => `${(emitted + i) / rate},MESSAGE_RECEIVED,NODE-LATENCY,blue,rx,${emitted + i},0,TEST,512,latency_ms=${generatedAt};${'本机受控负载'.repeat(30)}\n`)
      await write(rows.join('')); emitted += n
    }
    await write(`${seconds},SIMULATION_COMPLETE,2026,10,27,0,0,${seconds}\n`)
    await file.sync()
  } finally { await file.close() }
  console.log(JSON.stringify({ count: emitted, rate, seconds, firstGeneratedAt, lastGeneratedAt, elapsedMs: performance.now() - started, sourceSha256: hash.digest('hex') }))
} else {
  const base = resolve('output/local-remediation-20261027/latency')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'run-')), output = join(root, 'source')
  await mkdir(output)
  const context = { taskId: 'TASK-LATENCY', runId: `RUN-${randomUUID()}` }
  const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
  const archives = join(root, 'time-series', context.taskId)
  const archive = join(archives, (await readdir(archives))[0]!)
  const canonical = join(archive, 'events.csv')
  const limits = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000]
  const histogram = Array(limits.length + 1).fill(0) as number[]
  const decoder = new TextDecoder('utf8', { fatal: true })
  const canonicalHash = createHash('sha256')
  let offset = 0, pending = '', header: string[] | undefined
  let observed = 0, totalMs = 0, maxMs = 0, firstGeneratedAt = 0, lastGeneratedAt = 0, lastObservedAt = 0
  const scan = async () => {
    const handle = await open(canonical, 'r')
    try {
      const size = (await handle.stat()).size
      while (offset < size) {
        const bytes = Buffer.alloc(Math.min(65536, size - offset))
        const result = await handle.read(bytes, 0, bytes.length, offset)
        assert(result.bytesRead > 0, 'archive shrank while measuring')
        offset += result.bytesRead
        canonicalHash.update(bytes.subarray(0, result.bytesRead))
        pending += decoder.decode(bytes.subarray(0, result.bytesRead), { stream: true })
        const lines = pending.split('\n'); pending = lines.pop()!
        assert(Buffer.byteLength(pending) <= 128 * 1024, 'unbounded incomplete canonical record')
        for (const line of lines) {
          const cells = parseCsvLine(line.replace(/\r$/, '')); assert(cells)
          if (!header) { header = cells; continue }
          assert.equal(cells[header.indexOf('task_id')], context.taskId)
          if (cells[header.indexOf('EventType')] !== 'MESSAGE_RECEIVED') continue
          const { fields } = JSON.parse(cells[header.indexOf('Parameters')]!)
          assert.equal(fields.message_serial_number, String(observed), 'dropped, duplicated or reordered event')
          const generatedAt = Number(/^latency_ms=(\d+);/.exec(fields.comment)?.[1])
          assert(Number.isFinite(generatedAt))
          const now = Date.now(), ms = now - generatedAt
          assert(ms >= 0, 'host clock changed; latency measurement must be repeated')
          firstGeneratedAt ||= generatedAt; lastGeneratedAt = generatedAt; lastObservedAt = now
          observed++; totalMs += ms; maxMs = Math.max(maxMs, ms)
          const bucket = limits.findIndex(upper => ms <= upper)
          histogram[bucket < 0 ? limits.length : bucket]!++
        }
      }
    } finally { await handle.close() }
  }
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--producer', join(output, 'scenario_events.csv'), String(rate), String(seconds)],
    { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', failure: unknown, polling: Promise<void> | undefined
  child.stdout.on('data', data => { stdout = (stdout + data).slice(-65536) })
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-65536) })
  const completed = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done) })
  const timeout = setTimeout(() => { failure = new Error('owned latency producer exceeded its time limit'); child.kill() }, seconds * 1000 + 30000)
  const timer = setInterval(() => {
    if (!polling && !failure) polling = scan().catch(error => { failure = error }).finally(() => { polling = undefined })
  }, 10)
  let closed = false
  try {
    assert.equal(await completed, 0, stderr)
    const produced = JSON.parse(stdout.trim())
    await writer.close('COMPLETED'); closed = true
    const publishedAt = Date.now()
    clearInterval(timer); await polling; await scan()
    if (failure) throw failure
    assert.equal(observed, count); assert.equal(produced.count, count)
    const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))
    const events = manifest.files.find((file: { fileName: string }) => file.fileName === 'events.csv')
    assert.equal(manifest.status, 'COMPLETED'); assert.equal(events.rowCount, count + 1)
    assert.equal(events.sourceSha256, produced.sourceSha256)
    assert.equal(events.sha256, canonicalHash.digest('hex'))
    assert.equal(events.writeMetrics.writtenBytes, (await stat(canonical)).size)
    const evidence = { status: 'PASS_WITH_LIMITATIONS', root, kind: 'CONTROLLED_SYNTHETIC_IO_LOAD', producerPid: child.pid,
      produced, observed, missingOrDuplicateRecords: 0, achievedVisibleRecordsPerSecond: count / ((lastObservedAt - firstGeneratedAt) / 1000),
      producerTimestampToArchiveVisibleMs: { samples: observed, averageMs: totalMs / observed, maximumMs: maxMs,
        histogram: histogram.map((n, i) => ({ upperBoundMs: limits[i] ?? null, count: n })) },
      lastGeneratedToSyncedManifestPublishedMs: publishedAt - lastGeneratedAt, writeMetrics: events.writeMetrics,
      missing: manifest.missing,
      limits: ['Producer and observer use the same host millisecond wall clock; observer polls at 10ms.',
        'Per-record observations end at filesystem visibility, not physical-media durability. Final sync is measured separately.',
        'Controlled fixture data proves I/O handling only; native engine generation timestamps and quality streams remain unavailable.',
        'No latency pass threshold is invented from the test outline; histogram boundaries are measurement bins.'] }
    await writeFile(join(root, 'summary.json'), JSON.stringify(evidence, null, 2))
    console.log(JSON.stringify({ status: evidence.status, summary: join(root, 'summary.json') }))
  } catch (error) {
    await writeFile(join(root, 'failure.json'), JSON.stringify({ error: String(error), observed, stderr }, null, 2))
    throw error
  } finally {
    clearTimeout(timeout); clearInterval(timer); await polling
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await completed.catch(() => undefined)
    if (!closed) await writer.close('INCOMPLETE').catch(() => undefined)
  }
}
