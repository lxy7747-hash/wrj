// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { INITIAL_LOG } from '../fixtures/local-replay'
import type { ContractDescriptor } from '../../src/contracts/domain-models'
import { createCsvExample, inspectCsvText } from '../../src/features/data-exchange/csv-contract'
vi.mock('node:fs/promises', { spy: true })

const { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createHash } = await import('node:' + 'crypto')
const { ContinuousTimeSeriesWriter } = await import('../../server/local/' + 'continuous-time-series.js')
const { TIME_SERIES_CONTRACTS: timeSeriesContracts } = await import('../../server/local/' + 'time-series.js')
const TIME_SERIES_CONTRACTS: readonly ContractDescriptor[] = timeSeriesContracts

const directories: string[] = []
const context = { taskId: 'TASK-CONTINUOUS', runId: 'RUN-CONTINUOUS' }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wrj-continuous-series-'))
  directories.push(root)
  const output = join(root, 'mission-output')
  await mkdir(output)
  return { root, output }
}
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

describe('连续时序 CSV 留存', () => {
  it('连续归档将平台列映射为场景编号，保留原始文件摘要与设备编号', async () => {
    const { root, output } = await fixture()
    const events = REPORT_EVENT_CSV.replace(/\bA\b/g, 'rear_comm_vehicle').replace(/\bB\b/g, 'mission_uav_01') + '\n'
    const names = new Map([['rear_comm_vehicle', 'CMD-01'], ['mission_uav_01', 'AIR-01']])
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output, names)
    try {
      await writeFile(join(output, 'scenario_events.csv'), events)
      const contract = TIME_SERIES_CONTRACTS.find(item => item.name === 'link_state.csv')!
      const example = createCsvExample(contract).replaceAll('TASK-001', context.taskId)
      const { parseCsvLine } = await import('../../src/features/data-exchange/csv-contract')
      const lines = example.trimEnd().split(/\r?\n/)
      const cells = parseCsvLine(lines[1]!)!
      cells[contract.fields.indexOf('SourcePlatform')] = 'rear_comm_vehicle'
      cells[contract.fields.indexOf('DestPlatform')] = 'mission_uav_01'
      const quality = lines[0] + '\n' + cells.join(',') + '\n'
      await writeFile(join(output, 'link_state.csv'), quality)
      const archive = await writer.close('COMPLETED')
      const canonical = await readFile(join(archive, 'events.csv'), 'utf8')
      expect(canonical).toContain(',CMD-01,')
      expect(canonical).toContain(',AIR-01,')
      expect(canonical).not.toMatch(/rear_comm_vehicle|mission_uav_01/)
      expect(await readFile(join(archive, 'link_state.csv'), 'utf8')).toContain(',CMD-01,AIR-01,')
      const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))
      expect(manifest.files.find((file: { fileName: string }) => file.fileName === 'events.csv').sourceSha256).toBe(createHash('sha256').update(events).digest('hex'))
      expect(await readFile(join(output, 'scenario_events.csv'), 'utf8')).toBe(events)
      expect(await readFile(join(output, 'link_state.csv'), 'utf8')).toBe(quality)
    } finally { await writer.close('INCOMPLETE').catch(() => undefined) }
  })

  it('慢写入进入延迟溢出分档仍保持条数，分档不截断实测最大值', async () => {
    const { root, output } = await fixture()
    const { performance } = await import('node:' + 'perf_hooks')
    let clock = 0
    const clockSpy = vi.spyOn(performance, 'now').mockImplementation(() => { clock += 6000; return clock })
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
    try {
      await writeFile(join(output, 'scenario_events.csv'), REPORT_EVENT_CSV)
      const archive = await writer.close('COMPLETED')
      const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))
      const metrics = manifest.files[0].writeMetrics
      expect(manifest.files[0].rowCount).toBe(9)
      expect(metrics.writeCall.maximumMs).toBeGreaterThan(5000)
      expect(metrics.writeCall.histogram.at(-1)).toEqual({ upperBoundMs: null, count: metrics.writeCall.samples })
      expect(metrics.observedSnapshotToWrite.histogram.at(-1).count).toBe(metrics.observedSnapshotToWrite.samples)
    } finally {
      clockSpy.mockRestore()
      await writer.close('INCOMPLETE').catch(() => undefined)
    }
  })

  it('文件系统64位标识仅最低位变化时仍拒绝替换，不能用Number舍入后的值比较', async () => {
    const { root, output } = await fixture()
    const source = join(output, 'scenario_events.csv')
    const fs = await import('node:fs/' + 'promises')
    const original = (await vi.importActual<typeof fs>('node:fs/promises')).lstat
    let identity = 9007199254740992n
    expect(Number(identity)).toBe(Number(identity + 1n))
    const mocked = vi.spyOn(fs, 'lstat').mockImplementation((async (...args: unknown[]) => {
      const stats = await Reflect.apply(original, fs, args)
      if (String(args[0]) === source) Object.defineProperty(stats, 'ino', {
        value: (args[1] as { bigint?: boolean } | undefined)?.bigint ? identity : Number(identity),
      })
      return stats
    }) as typeof original)
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
    try {
      await writeFile(source, REPORT_EVENT_CSV)
      await writer.poll()
      identity += 1n
      await expect(writer.poll()).rejects.toThrow('被替换')
    } finally {
      await writer.close('INCOMPLETE').catch(() => undefined)
      mocked.mockRestore()
    }
  })

  it.each(['duplicate', 'undeclared'])('事件声明缓存仍拒绝%s声明或数据，不把错表头当作可写事件', async mode => {
    const { root, output } = await fixture()
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
    const declaration = REPORT_EVENT_CSV.split('\n')[0]!
    const invalid = mode === 'duplicate' ? declaration : '1,MESSAGE_RECEIVED,B,red,rx,1,0,CMD_ORDER,512,comment'
    await writeFile(join(output, 'scenario_events.csv'), declaration + '\n' + invalid + '\n')
    await expect(writer.poll()).rejects.toThrow()
    await expect(writer.close('INCOMPLETE')).rejects.toThrow()
  })

  it('跨多个读写块追加的真实事件保持顺序、中文和条数，末批在关闭时完整提交', async () => {
    const { root, output } = await fixture()
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
    const declarations = REPORT_EVENT_CSV.split('\n').filter(line => line.startsWith('!')).join('\n')
    const rows = Array.from({ length: 2000 }, (_, index) => `${index},MESSAGE_RECEIVED,B,red,rx,${index},0,CMD_ORDER,512,"序号${index},含""引号""",,,,`)
    const source = join(output, 'scenario_events.csv')
    await writeFile(source, declarations + '\n' + rows.slice(0, 1000).join('\n') + '\n')
    await writer.poll()
    await appendFile(source, rows.slice(1000).join('\n'))
    const archive = await writer.close('COMPLETED')
    const events = await readFile(join(archive, 'events.csv'), 'utf8')
    const lines = events.trimEnd().split('\r\n')
    expect(lines).toHaveLength(2001)
    expect(inspectCsvText(TIME_SERIES_CONTRACTS.find(c => c.name === 'events.csv')!, events)).toMatchObject({ valid: true, rowCount: 2000 })
    expect(lines[1]).toContain('序号0,含')
    expect(lines.at(-1)).toContain('序号1999,含')
    const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))
    expect(manifest.files[0]).toMatchObject({ fileName: 'events.csv', rowCount: 2000 })
    expect(manifest.files[0].sha256).toBe(createHash('sha256').update(events).digest('hex'))
    const metrics = manifest.files[0].writeMetrics
    expect(metrics.writtenBytes).toBe(new TextEncoder().encode(events).byteLength)
    expect(metrics.maxObservedBacklogBytes).toBeGreaterThan(0)
    expect(metrics.finalSyncMs).toBeGreaterThanOrEqual(0)
    expect(metrics.writeCall.samples).toBeGreaterThan(1)
    for (const measurement of [metrics.writeCall, metrics.observedSnapshotToWrite]) {
      expect(measurement.averageMs).toBeGreaterThanOrEqual(0)
      expect(measurement.maximumMs).toBeGreaterThanOrEqual(measurement.averageMs)
      expect(measurement.histogram).toHaveLength(11)
      expect(measurement.histogram.reduce((sum: number, bucket: { count: number }) => sum + bucket.count, 0)).toBe(measurement.samples)
    }
    expect(manifest.measurementNote).toContain('不是逐条引擎产生时刻')
  })

  it('长工作区加任务摘要和运行UUID时仍可建立独占归档', async () => {
    const { root, output } = await fixture()
    const deepRoot = join(root, 'native-long-workspace-'.repeat(4), 'parallel-tasks', 'TASK-' + 'a'.repeat(64))
    const longContext = { taskId: 'TASK-NATIVE-LONG', runId: 'RUN-NATIVE-19a4eed0-709f-4629-9c45-b81b368cef99' }
    const writer = await ContinuousTimeSeriesWriter.create(deepRoot, longContext, output)
    await writeFile(join(output, 'scenario_events.csv'), REPORT_EVENT_CSV)
    const archive = await writer.close('COMPLETED')
    expect(JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))).toMatchObject({ ...longContext, completed: true })
  })

  it.each(['removed', 'truncated', 'replaced'])('已取得的源文件%s时明确失败，不能将停更视为正常结束', async mode => {
    const { root, output } = await fixture()
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
    const source = join(output, 'scenario_events.csv')
    await writeFile(source, REPORT_EVENT_CSV)
    await writer.poll()
    if (mode === 'truncated') await writeFile(source, '')
    else {
      await rename(source, join(output, 'saved-original.csv'))
      if (mode === 'replaced') await writeFile(source, REPORT_EVENT_CSV)
    }
    await expect(writer.poll()).rejects.toThrow('运行中')
    await expect(writer.close('INCOMPLETE')).rejects.toThrow('运行中')
    const taskRoot = join(root, 'time-series', context.taskId)
    const archive = join(taskRoot, (await readdir(taskRoot))[0]!)
    expect(JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))).toMatchObject({ completed: false, status: 'FAILED', errorCode: 'CSV_STREAM_ERROR' })
  })

  it.each(['missing', 'declarations-only'])('没有真实事件记录时%s不发布空表，files与missing保持一致', async mode => {
    const { root, output } = await fixture()
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
    if (mode === 'declarations-only') await writeFile(join(output, 'scenario_events.csv'), REPORT_EVENT_CSV.split('\n').filter(line => line.startsWith('!')).join('\n') + '\n')
    const archive = await writer.close('INCOMPLETE')
    const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))
    expect(manifest.files).toEqual([])
    expect(manifest.missing.map((item: { fileName: string }) => item.fileName)).toContain('events.csv')
    expect(await readdir(archive)).toEqual(['manifest.json'])
  })

  it('带换行却一直未终结的原生多行块有总字节上限，失败保留来源并关闭文件', async () => {
    const { root, output } = await fixture()
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
    const raw = '0 MOVER_TURNED_ON A Mover: mover Type: WSF_AIR_MOVER\n' + '  LLA: 25:00:00n 119:00:00e 1000 m\n'.repeat(5000)
    await writeFile(join(output, 'scenario_events.csv'), raw)
    await expect(writer.poll()).rejects.toThrow('128KiB')
    await expect(writer.close('INCOMPLETE')).rejects.toThrow('128KiB')
    const taskRoot = join(root, 'time-series', context.taskId)
    const archive = join(taskRoot, (await readdir(taskRoot))[0]!)
    expect(JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))).toMatchObject({ status: 'FAILED', errorCode: 'CSV_STREAM_ERROR', completed: false })
    expect(await readFile(join(output, 'scenario_events.csv'), 'utf8')).toBe(raw)
  })

  it('只读取追加块，等待半行后复用原生事件解析器并镜像已有规范质量文件', async () => {
    const { root, output } = await fixture()
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
    const rawPath = join(output, 'scenario_events.csv')
    const bytes = new TextEncoder().encode(REPORT_EVENT_CSV)
    const split = Math.floor(bytes.length / 2)
    await writeFile(rawPath, bytes.subarray(0, split))
    await writer.poll()
    await appendFile(rawPath, bytes.subarray(split))
    const quality = TIME_SERIES_CONTRACTS.find(contract => contract.name === 'link_quality.csv')!
    const canonical = createCsvExample(quality).replaceAll('TASK-001', context.taskId)
    await writeFile(join(output, quality.name), canonical.slice(0, canonical.indexOf('\n') + 1))
    await writer.poll()
    await appendFile(join(output, quality.name), canonical.slice(canonical.indexOf('\n') + 1))
    await writer.poll()
    const published = await writer.close('COMPLETED')

    const manifest = JSON.parse(await readFile(join(published, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ mode: 'CONTINUOUS', status: 'COMPLETED', completed: true, contractsComplete: false, simulationTimeUnit: 's', ...context })
    expect(manifest.statusNote).toContain('不表示全部五类')
    expect(manifest.files.map((file: { fileName: string }) => file.fileName)).toEqual(expect.arrayContaining(['events.csv', 'link_quality.csv']))
    expect(manifest.missing.map((item: { fileName: string }) => item.fileName)).toEqual(expect.arrayContaining(['link_switch.csv', 'link_state.csv', 'link_loss.csv']))
    const events = await readFile(join(published, 'events.csv'), 'utf8')
    expect(inspectCsvText(TIME_SERIES_CONTRACTS.find(contract => contract.name === 'events.csv')!, events)).toMatchObject({ valid: true })
    expect(events).toContain(`${context.taskId},1.1,`)
    expect(await readFile(join(published, quality.name), 'utf8')).toBe(`${canonical.replaceAll('\n', '\r\n')}\r\n`)
    expect(await readdir(published)).not.toContain('link_switch.csv')
  })

  it('UTF-8 截断或半行在关闭时标记 FAILED，已写入数据和原始来源均保留', async () => {
    const { root, output } = await fixture()
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
    await writeFile(join(output, 'scenario_events.csv'), new Uint8Array([0xe4]))
    await writer.poll().catch(() => undefined)
    await expect(writer.close('INCOMPLETE')).rejects.toThrow()

    const taskRoot = join(root, 'time-series', context.taskId)
    const archive = join(taskRoot, (await readdir(taskRoot))[0]!)
    const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ mode: 'CONTINUOUS', status: 'FAILED', completed: false, errorCode: 'CSV_STREAM_ERROR' })
    expect(manifest.missing.every((item: { status: string }) => item.status === 'CAPTURE_FAILED')).toBe(true)
    expect(manifest.error).toContain('UTF-8')
    expect([...await readFile(join(output, 'scenario_events.csv'))]).toEqual([0xe4])
    // 解析失败同样关闭全部归档句柄，Windows 上目录可立即清理。
    await rm(archive, { recursive: true, force: true })
  })

  it('对原生多行事件块保留到下一个块或 close 才提交，不把半块当作完整记录', async () => {
    const { root, output } = await fixture()
    const writer = await ContinuousTimeSeriesWriter.create(root, context, output)
    const firstBlock = INITIAL_LOG.slice(0, INITIAL_LOG.indexOf('\n0 MOVER_TURNED_ON'))
    await writeFile(join(output, 'scenario_events.csv'), firstBlock)
    await writer.poll()
    await appendFile(join(output, 'scenario_events.csv'), INITIAL_LOG.slice(firstBlock.length))
    const published = await writer.close('COMPLETED')

    const events = await readFile(join(published, 'events.csv'), 'utf8')
    expect(events).toContain(',PLATFORM_ADDED,')
    expect(events).toContain(',MOVER_TURNED_ON,')
  })

  it('同一 task/run 标识重用时创建唯一归档目录，不覆盖重启前的未完成证据', async () => {
    const { root, output } = await fixture()
    const first = await ContinuousTimeSeriesWriter.create(root, context, output)
    const [firstPath, repeatedPath] = await Promise.all([first.close('INCOMPLETE'), first.close('COMPLETED')])
    expect(repeatedPath).toBe(firstPath)
    expect(JSON.parse(await readFile(join(firstPath, 'manifest.json'), 'utf8'))).toMatchObject({ status: 'INCOMPLETE', completed: false })
    const second = await ContinuousTimeSeriesWriter.create(root, context, output)
    const secondPath = await second.close('INCOMPLETE')

    expect(secondPath).not.toBe(firstPath)
    const taskRoot = join(root, 'time-series', context.taskId)
    expect(await readdir(taskRoot)).toHaveLength(2)
  })
})
