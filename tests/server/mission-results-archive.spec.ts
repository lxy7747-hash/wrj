// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
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

const { mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createHash } = await import('node:' + 'crypto')
const { EVENTS_CSV_HEADER } = await import('../../src/contracts/' + 'domain-models.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { LocalMissionResults } = await import('../../server/local/' + 'mission-results.js')
const { readLocalFileSnapshot } = await import('../../server/local/' + 'afsim-log-reader.js')

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
  const source = (await readLocalFileSnapshot(sourcePath)).source
  const row = Array.from({ length: EVENTS_CSV_HEADER.split(',').length }, (_, index) => index === 0 ? context.taskId : '').join(',')
  const events = `${EVENTS_CSV_HEADER}\r\n${Array(9).fill(row).join('\r\n')}\r\n`
  await writeFile(join(archive, 'events.csv'), events)
  const manifest = { schemaVersion: '1.1', mode: 'CONTINUOUS', status: 'COMPLETED', completed: true, ...context,
    files: [{ fileName: 'events.csv', version: '1.1', encoding: 'UTF-8', sourceFile: 'scenario_events.csv',
      sourceBytes: source.bytes, sourceSha256: source.sha256, rowCount: 9,
      sha256: createHash('sha256').update(events).digest('hex') }] }
  await writeFile(join(archive, 'manifest.json'), JSON.stringify(manifest))
  return { entry, archive, draft, results: new LocalMissionResults(join(root, 'results')), manifest, events }
}

describe('大型结果连续归档核验', () => {
  it('缺少归档、任务/来源/行数不符或 canonical 内容被篡改时不发布结果', async () => {
    const { entry, archive, draft, results, manifest, events } = await fixture()
    await expect(results.capture(entry, draft, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', () => true, context)).rejects.toThrow('缺少')
    for (const change of [
      { taskId: 'TASK-OTHER' },
      { files: [{ ...manifest.files[0], sourceSha256: 'a'.repeat(64) }] },
      { files: [{ ...manifest.files[0], rowCount: 8 }] },
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
    expect(await results.list()).toEqual([])
  })
})
