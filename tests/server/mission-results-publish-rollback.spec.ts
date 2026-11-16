// @vitest-environment node
// B1 / L02：真实 LocalMissionResults.capture 的发布与补偿链路，接真实 AdminProjection + 临时 EquipmentSqliteStorage。
// onPublished 用实际 record.resultId 登记 ARCHIVE 引用；最终结果 rename 失败必须 onDiscarded 撤销本次新增引用、
// 保留旧引用、不发布半结果；恢复后重试成功且完整引用真实存在。
import { afterEach, describe, expect, it } from 'vitest'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import { POSITION_CSV } from '../fixtures/local-replay'
import { EQUIPMENT } from '../fixtures/equipment'

const { mkdtemp, mkdir, readdir, rm, writeFile } = await import('node:' + 'fs/promises')
const { mkdirSync, rmSync } = await import('node:' + 'fs')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { LocalMissionResults } = await import('../../server/local/' + 'mission-results.js')
const { AdminProjection } = await import('../../server/admin/' + 'projection.js')
const { EquipmentSqliteStorage } = await import('../../server/local/' + 'equipment-sqlite.js')

const cleanup: Array<() => void | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const context = { taskId: 'TASK-ARCHIVE', runId: 'RUN-ARCHIVE' }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wrj-result-publish-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const entry = join(root, 'entry'), output = join(entry, 'output')
  await mkdir(output, { recursive: true })
  const draft = new ScenarioProjection().get('SCN-001').data
  // 两条链路各带一条装备来源：一次归档发布产生两条 ARCHIVE 引用
  for (const link of draft.config.links.filter((item: { type: string }) => item.type === 'MICROWAVE').slice(0, 2)) {
    Object.assign(link, { parameterSource: { kind: 'EQUIPMENT', sourceId: EQUIPMENT.equipmentId, sourceVersion: 1, fields: ['modulation'] } })
  }
  await writeFile(join(entry, 'mapping.json'), JSON.stringify({ scenarioId: draft.config.scenario.id, revision: draft.revision, output: { resolvedDirectory: 'output' } }))
  await writeFile(join(output, 'scenario_events.csv'), `${REPORT_EVENT_CSV}\n`)
  await writeFile(join(output, 'position.csv'), POSITION_CSV)
  const equipment = new EquipmentSqliteStorage(join(root, 'equipment.db'))
  cleanup.push(() => equipment.close())
  expect(equipment.save(structuredClone(EQUIPMENT))).toBe(true)
  const admin = new AdminProjection(undefined, equipment)
  // 预置一条其他目标的既有引用（本次失败必须保留）
  admin.capturePublishedParameterSources(draft.config, { targetType: 'TEMPLATE', targetId: 'TPL-SEED', targetVersion: '1' }, 'admin')
  return { entry, draft, resultsDir: join(root, 'results'), equipment, admin }
}
const archiveRefs = (equipment: InstanceType<typeof EquipmentSqliteStorage>) => equipment.publishedReferences(EQUIPMENT.equipmentId)

describe('B1 真实归档发布补偿（真实装备引用存储）', () => {
  it('onPublished 用实际 resultId 登记 ARCHIVE 引用；最终 rename 失败后真实存储撤销本次新增、旧引用保留、无半结果，重试成功', async () => {
    const { entry, draft, resultsDir, equipment, admin } = await fixture()
    const seed = archiveRefs(equipment)
    expect(seed.filter((row: { targetType: string; targetId: string }) => row.targetType === 'TEMPLATE' && row.targetId === 'TPL-SEED')).toHaveLength(2)
    let armDirectory = true, createdId = ''
    const discarded: unknown[] = []
    const results = new LocalMissionResults(resultsDir,
      (_draft: unknown, record: { resultId: string; revision: number }) => {
        createdId = record.resultId
        // 在目标最终文件名处制造目录，使随后 rename(临时 → 结果.json) 确定性失败（最终提交失败）
        if (armDirectory) mkdirSync(join(resultsDir, `${record.resultId}.json`))
        return admin.capturePublishedParameterSources(draft.config, { targetType: 'ARCHIVE', targetId: record.resultId, targetVersion: String(record.revision) }, 'admin')
      },
      (removed: unknown[]) => { discarded.push(...removed); admin.discardPublishedReferences(removed as never) })
    await expect(results.capture(entry, draft, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', () => true, context)).rejects.toThrow()
    expect(createdId).not.toBe('')
    // 本次登记的 2 条 ARCHIVE 引用已从真实存储撤销；旧 TPL-SEED 引用完整保留
    expect(discarded).toHaveLength(2)
    expect(archiveRefs(equipment)).toEqual(seed)
    expect(archiveRefs(equipment).some((row: { targetType: string }) => row.targetType === 'ARCHIVE')).toBe(false)
    // 无可见半结果、无 pending 残留
    expect((await readdir(resultsDir)).some((name: string) => name.endsWith('.pending'))).toBe(false)
    rmSync(join(resultsDir, `${createdId}.json`), { recursive: true, force: true })
    expect(await results.list()).toEqual([])
    // 恢复后重试：结果可读，ARCHIVE 引用真实存在且 targetId 为实际 resultId
    armDirectory = false
    await results.capture(entry, draft, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', () => true, context)
    const published = await results.list()
    expect(published).toHaveLength(1)
    const archived = archiveRefs(equipment).filter((row: { targetType: string }) => row.targetType === 'ARCHIVE')
    expect(archived).toHaveLength(2)
    expect(archived.every((row: { targetId: string }) => row.targetId === createdId)).toBe(true)
    expect(archived.every((row: { sourceSummary: string }) => row.sourceSummary.includes('parameterSource'))).toBe(true)
  })

  it('onPublished 登记抛错：不调用 onDiscarded、不发布、无残留 pending', async () => {
    const { entry, draft, resultsDir } = await fixture()
    let discardedCalled = false
    const results = new LocalMissionResults(resultsDir,
      () => { throw new Error('AUDIT registration failure') },
      () => { discardedCalled = true })
    await expect(results.capture(entry, draft, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', () => true, context)).rejects.toThrow('registration failure')
    expect(discardedCalled).toBe(false)
    expect(await results.list()).toEqual([])
    expect((await readdir(resultsDir)).some((name: string) => name.endsWith('.pending'))).toBe(false)
  })
})

