// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('node:fs/promises', { spy: true })
import { LINK_QUALITY_CSV_HEADER, type QualitySample } from '../../src/contracts/domain-models'
import { parseQualityImport, type QualityConfig } from '../../src/features/data-exchange/quality-records'
const { mkdtemp, readFile, readdir, rename, rm, writeFile } = await import('node:' + 'fs/promises')
const { createHash } = await import('node:' + 'crypto')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createRunQualityStore, QualityImportError } = await import('../../server/local/' + 'run-quality.js')

const scope = { taskId: 'TASK-QUALITY', runId: 'RUN-QUALITY', scenarioId: 'SCN-QUALITY', revision: 3, startedAt: '2026-10-31T00:00:00.000Z' }
const config = {
  scenario: { id: scope.scenarioId, timeStep: 5 }, platforms: [{ id: 'UAV-1' }, { id: 'GCC-1' }],
  links: [
    { id: 'LINK-MW', type: 'MICROWAVE', sourcePlatformId: 'UAV-1', targetPlatformId: 'GCC-1', enabled: true },
    { id: 'LINK-LASER', type: 'LASER', sourcePlatformId: 'UAV-1', targetPlatformId: 'GCC-1', enabled: true },
  ],
} as unknown as QualityConfig
const source = { sha256: 'a'.repeat(64), importedAt: '2026-10-31T00:01:00.000Z' }
const sample = (overrides: Partial<QualitySample> = {}): QualitySample => ({
  time: 1, sourcePlatform: 'UAV-1', destPlatform: 'GCC-1', linkType: 'MICROWAVE', frequency: 1000, bandwidth: 2,
  distance: 100, txPower: 10, txAntennaGain: 3, rxAntennaGain: 4, pathLoss: 9, jammingPower: -90, receivedPower: -80,
  snr: 11, jsrDb: 8, modulation: 'QPSK', ber: 0.001, linkStatus: 'UP', berThreshold: 0.01, dataRate: 2,
  linkId: 'LINK-MW', frameId: 7, ...overrides,
})
const document = (samples: QualitySample[] = [sample()], switchEvents?: unknown[]) => ({ format: 'wrj.quality.v1', scope, samples,
  ...(switchEvents === undefined ? {} : { switchEvents }) })
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function store() { const root = await mkdtemp(join(tmpdir(), 'wrj-quality-')); roots.push(root); return createRunQualityStore(root, () => '2026-10-31T00:02:00.000Z') }

describe('规范质量导入和留存', () => {
  it('严格保留 JSON 实测字段、完整损耗和显式切换事件', () => {
    const microwave = sample({ losses: { freeSpaceLossDb: 1, seaMultipathLossDb: 2, atmosphericLossDb: 3, cloudRainLossDb: 4, jammingLossDb: 5, totalLossDb: 6 } })
    const laser = sample({ linkId: 'LINK-LASER', linkType: 'LASER', modulation: 'OOK', ber: 0.0001 })
    const event = { eventId: 'SW-1', frameId: 'engine/frame:7', time: 1, type: 'LINK_SWITCH', direction: 'FORWARD', oldLinkId: 'LINK-MW', newLinkId: 'LINK-LASER',
      oldBer: microwave.ber, newBer: laser.ber, stabilityFrames: 3, minimumStableFrames: 3, hysteresisSatisfied: true, cooldownRemainingS: 0, decision: 'ACCEPTED', reason: 'MEASURED', dedupeKey: 'SW-1' }
    const result = parseQualityImport({ scope, fileName: 'quality.json', format: 'JSON', text: JSON.stringify(document([microwave, laser], [event])) }, scope, config, source)
    expect(result.errors).toEqual([])
    expect(result.data?.source.frameIdKind).toBe('PROVIDED')
    expect(result.data?.samples[0]).toMatchObject({ jsrDb: 8, losses: microwave.losses })
    expect(result.data?.switchEvents).toEqual([event])
  })

  it('CSV 按端点和类型唯一映射，按时间创建诚实的导入序号帧', () => {
    const headers = LINK_QUALITY_CSV_HEADER.split(',')
    const row = (time: string) => headers.map(field => ({ task_id: scope.taskId, SchemaVersion: '1.1', Time: time, SourcePlatform: 'UAV-1', DestPlatform: 'GCC-1', LinkType: 'MICROWAVE',
      Frequency: '1000', Bandwidth: '2', Distance: '100', TxPower: '10', TxAntennaGain: '3', RxAntennaGain: '4', PathLoss: '9', JammingPower: '-90', ReceivedPower: '-80', SNR: '11', GXB: '8', Modulation: 'QPSK', BER: '0.001', LinkStatus: 'UP', BERThreshold: '0.01', DataRate: '2' } as Record<string, string>)[field]!).join(',')
    const result = parseQualityImport({ scope, fileName: 'quality.csv', format: 'CSV', text: `${LINK_QUALITY_CSV_HEADER}\n${row('2')}\n${row('102')}` }, scope, config, source)
    expect(result.data).toMatchObject({ source: { frameIdKind: 'IMPORT_SEQUENCE' }, expectedStepS: 5, samples: [expect.objectContaining({ linkId: 'LINK-MW', frameId: 0, jsrDb: 8 }), expect.objectContaining({ frameId: 1 })] })
    const missingReceivedPower = row('2').replace(',-80,11,', ',,11,')
    expect(parseQualityImport({ scope, fileName: 'quality.csv', format: 'CSV', text: `${LINK_QUALITY_CSV_HEADER}\n${missingReceivedPower}` }, scope, config, source).data).toBeNull()
  })

  it('拒绝作用域、未知字段、歧义链路和没有实测 BER 闭合的切换', () => {
    expect(parseQualityImport({ scope: { ...scope, revision: 4 }, fileName: 'x.json', format: 'JSON', text: JSON.stringify(document()) }, scope, config, source).data).toBeNull()
    const invalid = { ...sample(), fabricated: 1 }
    expect(parseQualityImport({ scope, fileName: 'x.json', format: 'JSON', text: JSON.stringify(document([invalid as QualitySample])) }, scope, config, source).data).toBeNull()
    const badEvent = { eventId: 'SW', frameId: 'F-any', time: 1, type: 'LINK_SWITCH', direction: 'FORWARD', oldLinkId: 'LINK-MW', newLinkId: 'LINK-LASER', oldBer: 0.99, newBer: 0.01, stabilityFrames: 1, minimumStableFrames: 1, hysteresisSatisfied: true, cooldownRemainingS: 0, decision: 'ACCEPTED', reason: 'x', dedupeKey: 'x' }
    expect(parseQualityImport({ scope, fileName: 'x.json', format: 'JSON', text: JSON.stringify(document([sample(), sample({ linkId: 'LINK-LASER', linkType: 'LASER', modulation: 'OOK' })], [badEvent])) }, scope, config, source).data).toBeNull()
  })

  it('原子写入、重新加载和规范 CSV 只保留来源真正提供的合同', async () => {
    const quality = await store()
    const raw = `\uFEFF${JSON.stringify(document())}`
    const request = { scope, fileName: 'quality.json', format: 'JSON' as const, text: raw }
    const saved = await quality.import(request, scope, config)
    expect(await quality.load(scope.runId)).toEqual(saved)
    expect(await quality.getFile(scope.runId, 'link_quality.csv')).not.toBeNull()
    expect(await quality.getFile(scope.runId, 'link_loss.csv')).toBeNull()
    expect(await readFile((await quality.getFile(scope.runId, 'source.json'))!.filePath, 'utf8')).toBe(raw)
    expect(await quality.getFile(scope.runId, '../quality.json')).toBeNull()
    const manifestFile = await quality.getFile(scope.runId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestFile!.filePath, 'utf8'))
    expect(manifest).toMatchObject({ contractsComplete: false })
    expect(manifest.missing.map((item: { fileName: string }) => item.fileName)).toEqual(expect.arrayContaining(['events.csv', 'link_loss.csv', 'link_switch.csv']))
    await expect(quality.import(request, scope, config, () => false)).rejects.toBeInstanceOf(QualityImportError)
    let checks = 0
    await expect(quality.import({ ...request, fileName: 'stale.json' }, scope, config, () => { checks += 1; return checks < 3 })).rejects.toBeInstanceOf(QualityImportError)
    expect(await quality.load(scope.runId)).toEqual(saved)
  })

  it('拒绝的切换决策保留在质量明细中，显式集合写零条成功切换 CSV', async () => {
    const quality = await store()
    const old = sample()
    const next = sample({ linkId: 'LINK-LASER', linkType: 'LASER', modulation: 'OOK', ber: 0.0001 })
    const rejected = { eventId: 'SW-REJECTED', frameId: 'F-source-7', time: 1, type: 'LINK_SWITCH', direction: 'FORWARD', oldLinkId: 'LINK-MW', newLinkId: 'LINK-LASER',
      oldBer: old.ber, newBer: next.ber, stabilityFrames: 1, minimumStableFrames: 3, hysteresisSatisfied: false, cooldownRemainingS: 0, decision: 'REJECTED', reason: 'NOT_STABLE', dedupeKey: 'SW-REJECTED' }
    await quality.import({ scope, fileName: 'rejected.json', format: 'JSON', text: JSON.stringify(document([old, next], [rejected])) }, scope, config)
    expect((await quality.load(scope.runId))?.switchEvents).toEqual([rejected])
    expect(await readFile((await quality.getFile(scope.runId, 'link_switch.csv'))!.filePath, 'utf8')).toContain('SwitchReason')
    const manifest = JSON.parse(await readFile((await quality.getFile(scope.runId, 'manifest.json'))!.filePath, 'utf8'))
    expect(manifest.missing).not.toEqual(expect.arrayContaining([expect.objectContaining({ fileName: 'link_switch.csv' })]))
  })

  it('显式空切换集合表示已记录的零次成功切换，写入规范空表', async () => {
    const quality = await store()
    const saved = await quality.import({ scope, fileName: 'empty.json', format: 'JSON', text: JSON.stringify(document([sample()], [])) }, scope, config)
    expect(saved.source.switchEventsProvided).toBe(true)
    const switchFile = await quality.getFile(scope.runId, 'link_switch.csv')
    expect(await readFile(switchFile!.filePath, 'utf8')).toContain('SwitchReason')
  })

  it('current 指针写入失败时撤销本次 generation，不让失败来源成为历史版本', async () => {
    const quality = await store()
    const original = { scope, fileName: 'old.json', format: 'JSON' as const, text: JSON.stringify(document()) }
    const old = await quality.import(original, scope, config)
    const failed = { scope, fileName: 'failed.json', format: 'JSON' as const, text: JSON.stringify(document([sample({ time: 2, frameId: 8 })])) }
    const failedSha = createHash('sha256').update(failed.text).digest('hex')
    const realFs = await vi.importActual<{ rename: (from: string, to: string) => Promise<void> }>('node:fs/promises')
    vi.mocked(rename).mockImplementation(async (from: string, to: string) => {
      if (String(to).endsWith('current.json')) throw new Error('controlled pointer rename failure')
      return realFs.rename(from, to)
    })
    try { await expect(quality.import(failed, scope, config)).rejects.toThrow('controlled pointer rename failure') }
    finally { vi.mocked(rename).mockRestore() }
    expect(await quality.load(scope.runId)).toEqual(old)
    expect(await quality.load(scope.runId, failedSha)).toBeNull()
    const names: string[] = await readdir(join(roots.at(-1)!, scope.runId))
    expect(names.filter(name => name.startsWith('.quality-') || name.startsWith('.current-'))).toEqual([])
    expect(names.filter(name => name.startsWith('quality-'))).toHaveLength(1)
  })

  it('最新归档损坏时不回退旧版本；同一运行的并发导入保持可核验发布', async () => {
    const quality = await store()
    const first = { scope, fileName: 'first.json', format: 'JSON' as const, text: JSON.stringify(document()) }
    const second = { scope, fileName: 'second.json', format: 'JSON' as const, text: JSON.stringify(document([sample({ time: 2, frameId: 8 })])) }
    const [savedFirst, savedSecond] = await Promise.all([quality.import(first, scope, config), quality.import(second, scope, config)])
    const loaded = await quality.load(scope.runId)
    expect([savedFirst.source.sha256, savedSecond.source.sha256]).toContain(loaded?.source.sha256)
    expect((await quality.load(scope.runId, savedFirst.source.sha256))?.source.sha256).toBe(savedFirst.source.sha256)
    expect(await quality.load(scope.runId, 'b'.repeat(64))).toBeNull()
    const latest = await quality.getFile(scope.runId, 'source.json')
    await writeFile(latest!.filePath, '{not-json', 'utf8')
    await expect(quality.load(scope.runId)).rejects.toThrow('最新质量归档')
  })
})
