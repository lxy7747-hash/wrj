// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AfsimLogEvent } from '../../src/features/data-exchange/afsim-event-log'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { POSITION_CSV } from '../fixtures/local-replay'

// 模拟的是大文件读取器已验证的“只保留消息汇总”返回值；来源文件本身仍使用真实小 CSV，避免为每个篡改分支重复写 32 MiB。
vi.mock('../../server/local/afsim-log-reader.js', async importOriginal => {
  const actual = await importOriginal<{ readAfsimLogFile(path: string): Promise<{ summary: { eventCount: number } }> }>()
  return {
    ...actual,
    readAfsimLogFile: async (path: string) => {
      const parsed = await actual.readAfsimLogFile(path)
      return { ...parsed, messageDetailsComplete: false as const, messageDetailEventCount: parsed.summary.eventCount }
    },
  }
})

const { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createHash } = await import('node:' + 'crypto')
const { EVENTS_CSV_HEADER } = await import('../../src/contracts/' + 'domain-models.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { LocalMissionResults } = await import('../../server/local/' + 'mission-results.js')
const { readAfsimLogFile, readStableUtf8Lines } = await import('../../server/local/' + 'afsim-log-reader.js')
const { eventCsvRow } = await import('../../server/local/' + 'time-series.js')

const cleanup: string[] = []
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }) })
const context = { taskId: 'TASK-ARCHIVE', runId: 'RUN-ARCHIVE' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wrj-result-archive-')); cleanup.push(root)
  const entry = join(root, 'entry'), output = join(entry, 'output'), archive = join(root, 'continuous')
  await mkdir(output, { recursive: true }); await mkdir(archive)
  const draft = new ScenarioProjection().get('SCN-001').data
  await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: draft.config.scenario.id, revision: draft.revision, output: { resolvedDirectory: 'output' } }))
  const sourcePath = join(output, 'scenario_events.csv')
  await writeFile(sourcePath, REPORT_EVENT_CSV + '\n'); await writeFile(join(output, 'position.csv'), POSITION_CSV)
  const { source, events: records } = await readAfsimLogFile(sourcePath)
  const events = [EVENTS_CSV_HEADER, ...records.map((event: AfsimLogEvent) => eventCsvRow(event, context.taskId))].join('\r\n') + '\r\n'
  await writeFile(join(archive, 'events.csv'), events)
  const manifest = { schemaVersion: '1.1', mode: 'CONTINUOUS', status: 'COMPLETED', completed: true, ...context,
    files: [{ fileName: 'events.csv', version: '1.1', encoding: 'UTF-8', sourceFile: 'scenario_events.csv',
      sourceBytes: source.bytes, sourceSha256: source.sha256, rowCount: 9,
      sha256: createHash('sha256').update(events).digest('hex') }] }
  await writeFile(join(archive, 'manifest.json'), JSON.stringify(manifest))
  const resultsPath = join(root, 'results')
  return { entry, archive, draft, results: new LocalMissionResults(resultsPath), resultsPath, manifest, events }
}

describe('大型结果连续归档核验', () => {
  it.each([true, false])('按来源记录数发布可回读的报表与回放（清单包含写入字节数：%s）', async hasBytes => {
    const { entry, archive, draft, results, manifest, events } = await fixture()
    if (hasBytes) await writeFile(join(archive, 'manifest.json'), JSON.stringify({ ...manifest, files: [
      { ...manifest.files[0], writeMetrics: { writtenBytes: new TextEncoder().encode(events).length } },
    ] }))
    await results.capture(entry, draft, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', () => true, context, archive)
    const [record] = await results.list()
    expect(record).toMatchObject(context)
    const view = await results.getReportView(record.resultId)
    expect(view.initialFilter.timelineTotal).toBe(9)
    expect((await results.get(record.resultId)).replay.recordCount).toBeGreaterThan(0)
  })

  it('超过 2 GiB 时普通读取仍拒绝，受来源行数约束的归档进入逐行校验', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-archive-size-')); cleanup.push(root)
    const path = join(root, 'events.csv'), originalLimit = 2 ** 31
    const file = await open(path, 'wx')
    // 只写首行；无需为这项边界回归生成或读取 2 GiB 内容。
    try { await file.writeFile('bad-header\n'); await file.truncate(originalLimit + 1) } finally { await file.close() }
    const firstRow = vi.fn(() => { throw new Error('无效表头') })
    await expect(readStableUtf8Lines(path, firstRow, originalLimit)).rejects.toThrow('2048 MiB')
    await expect(readStableUtf8Lines(path, firstRow, { maxLines: 9 })).rejects.toThrow('文件大小超过来源行数')
    expect(firstRow).not.toHaveBeenCalled()
    await expect(readStableUtf8Lines(path, firstRow, { maxLines: 20_000 })).rejects.toThrow('无效表头')
    expect(firstRow).toHaveBeenCalledExactlyOnceWith('bad-header', 1)
  })

  it('缺少归档、任务/来源/行数不符或 canonical 内容被篡改时不发布结果', async () => {
    const { entry, archive, draft, results, resultsPath, manifest, events } = await fixture()
    await expect(results.capture(entry, draft, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', () => true, context)).rejects.toThrow('缺少')
    for (const change of [
      { taskId: 'TASK-OTHER' },
      { files: [{ ...manifest.files[0], sourceSha256: 'a'.repeat(64) }] },
      { files: [{ ...manifest.files[0], rowCount: 8 }] },
      { files: [{ ...manifest.files[0], writeMetrics: { writtenBytes: new TextEncoder().encode(events).length + 1 } }] },
    ]) {
      await writeFile(join(archive, 'manifest.json'), JSON.stringify({ ...manifest, ...change }))
      await expect(results.capture(entry, draft, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', () => true, context, archive)).rejects.toThrow('连续时序')
    }
    await writeFile(join(archive, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(archive, 'events.csv'), (await readFile(join(archive, 'events.csv'), 'utf8')).replace(EVENTS_CSV_HEADER, 'bad-header'))
    await expect(results.capture(entry, draft, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', () => true, context, archive)).rejects.toThrow('events.csv')
    await writeFile(join(archive, 'events.csv'), events)
    await writeFile(join(archive, 'manifest.json'), JSON.stringify({ ...manifest, files: [{ ...manifest.files[0], sha256: 'b'.repeat(64) }] }))
    await expect(results.capture(entry, draft, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', () => true, context, archive)).rejects.toThrow('实际行数')
    for (const [contents, error] of [
      [events.replace(context.taskId, 'TASK-OTHER'), '其他任务'],
      [events + events.split('\r\n')[1] + '\r\n', '归档行数超过'],
      [events.trimEnd(), '尾行'],
    ] as const) {
      await writeFile(join(archive, 'events.csv'), contents)
      await writeFile(join(archive, 'manifest.json'), JSON.stringify({ ...manifest, files: [
        { ...manifest.files[0], sha256: createHash('sha256').update(contents).digest('hex') },
      ] }))
      await expect(results.capture(entry, draft, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', () => true, context, archive)).rejects.toThrow(error)
    }
    expect(await results.list()).toEqual([])
    expect(await readdir(resultsPath)).toEqual([])
  })
})
