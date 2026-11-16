// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import type { QualityScope } from '../../src/contracts/domain-models'
import type { QualityConfig } from '../../src/features/data-exchange/quality-records'
import { EVIDENCE_KIND_FILE, EvidenceImportError } from '../../src/features/data-exchange/evidence-contract'
import { buildFileSetSource, seriesContinuityReliable } from '../../src/features/reports/report-evidence'

const { mkdtemp, readFile, readdir, rm, writeFile } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createRunEvidenceStore } = await import('../../server/local/' + 'run-evidence.js')

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'wrj-evidence-')); roots.push(directory)
  return createRunEvidenceStore(directory, () => '2026-01-01T00:01:00.000Z')
}
const scope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-1', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
const config = {
  scenario: { id: 'SCN-1', timeStep: 1 }, platforms: [{ id: 'A' }, { id: 'B' }],
  links: [{ id: 'L-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', enabled: true }], linkSettings: {},
} as unknown as QualityConfig
const QUALITY_CSV = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,Frequency,Bandwidth,Distance,TxPower,TxAntennaGain,RxAntennaGain,PathLoss,JammingPower,ReceivedPower,SNR,GXB,Modulation,BER,LinkStatus,BERThreshold,DataRate'}\nTASK-1,1.1,0,A,B,MICROWAVE,8000,20,1000,10,1,1,100,-90,-70,12,12,QPSK,0.0001,UP,0.01,10`
const STATE_CSV = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,12,0.0001,-70`
const file = (kind: keyof typeof EVIDENCE_KIND_FILE, text: string) => ({ fileName: EVIDENCE_KIND_FILE[kind], text })

describe('D2 文件集导入存储与原子发布', () => {
  it('D2-01 已发布批次可按最新与固定摘要重新读取，原文摘要稳定', async () => {
    const target = await store()
    const first = await target.import({ files: [file('quality', QUALITY_CSV), file('state', STATE_CSV)] }, scope, config)
    const latest = await target.load('RUN-1')
    const fixed = await target.load('RUN-1', first.bundleSha256)
    expect(latest?.result.bundleSha256).toBe(first.bundleSha256)
    expect(fixed?.result.bundleSha256).toBe(first.bundleSha256)
    expect(fixed?.state).toHaveLength(1)
    expect(fixed?.quality?.samples).toHaveLength(1)
    const reordered = await target.import({ files: [file('state', STATE_CSV), file('quality', QUALITY_CSV)] }, scope, config)
    expect(reordered.bundleSha256).toBe(first.bundleSha256)
    expect((await target.load('RUN-1', first.bundleSha256))?.result.association).toBe('USER_SELECTED_RUN')
  })

  it('D2-05 失败批次不替换已发布批次，发布前取消不留下半批指针', async () => {
    const target = await store()
    const first = await target.import({ files: [file('state', STATE_CSV)] }, scope, config)
    const conflicting = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,999,0.0001,-70`
    await expect(target.import({ files: [file('quality', QUALITY_CSV), { fileName: 'link_state.csv', text: conflicting }] }, scope, config)).rejects.toBeInstanceOf(EvidenceImportError)
    expect((await target.load('RUN-1'))?.result.bundleSha256).toBe(first.bundleSha256)
    await expect(target.import({ files: [file('state', STATE_CSV)] }, scope, config, () => false)).rejects.toBeInstanceOf(EvidenceImportError)
    expect((await target.load('RUN-1'))?.result.bundleSha256).toBe(first.bundleSha256)
  })

  it('D2-03 超出 8MB、未知文件名与空文件在合同层拒绝', async () => {
    const target = await store()
    await expect(target.import({ files: [{ fileName: 'link_state.csv', text: 'x'.repeat(8 * 1024 * 1024 + 1) }] }, scope, config)).rejects.toBeInstanceOf(EvidenceImportError)
    await expect(target.import({ files: [{ fileName: 'other.csv', text: '' }] }, scope, config)).rejects.toBeInstanceOf(EvidenceImportError)
    await expect(target.import({ files: [] }, scope, config)).rejects.toBeInstanceOf(EvidenceImportError)
    expect(await target.load('RUN-1')).toBeNull()
  })
})

describe('缺陷3 固定旧摘要可持续读取（不跟 current、重算摘要、损坏不回退）', () => {
  const STATE_B = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,7,A,B,MICROWAVE,UP,55,0.0002,-60`
  it('A→导入B→按 A/B 摘要精确读取，重建 store 后仍可读；篡改 A 不影响 B', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wrj-defect3-')); roots.push(directory)
    const target = createRunEvidenceStore(directory, () => '2026-01-01T00:01:00.000Z')
    const a = await target.import({ files: [file('state', STATE_CSV)] }, scope, config)
    const b = await target.import({ files: [{ fileName: 'link_state.csv', text: STATE_B }] }, scope, config)
    expect(a.bundleSha256).not.toBe(b.bundleSha256)
    expect((await target.load('RUN-1'))?.result.bundleSha256).toBe(b.bundleSha256)
    expect((await target.load('RUN-1', a.bundleSha256))?.state[0]!.gxbDb).toBe(12)
    expect((await target.load('RUN-1', b.bundleSha256))?.state[0]!.gxbDb).toBe(55)
    // 重建 store（同目录）后仍可按旧摘要读取
    const reopened = createRunEvidenceStore(directory, () => '2026-01-01T00:03:00.000Z')
    expect((await reopened.load('RUN-1', a.bundleSha256))?.state[0]!.gxbDb).toBe(12)
    // 篡改 A 的原文：A 摘要读取失败，但不阻止 B 合法摘要读取
    const runDir = join(directory, 'RUN-1')
    const generations = (await readdir(runDir)).filter((name: string) => name.startsWith('evidence-')).sort()
    let tampered = false
    for (const generation of generations) {
      const bundlePath = join(runDir, generation, 'bundle.json')
      const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as { result: { bundleSha256: string } }
      if (bundle.result.bundleSha256 === a.bundleSha256) {
        await writeFile(join(runDir, generation, 'files', 'link_state.csv'), STATE_B, 'utf8'); tampered = true; break
      }
    }
    expect(tampered).toBe(true)
    await expect(target.load('RUN-1', a.bundleSha256)).rejects.toThrow()
    expect((await target.load('RUN-1', b.bundleSha256))?.state[0]!.gxbDb).toBe(55)
  })

  it('作用域不符明确失败；不存在的摘要返回 null 且不回退 current', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wrj-defect3b-')); roots.push(directory)
    const target = createRunEvidenceStore(directory, () => '2026-01-01T00:01:00.000Z')
    const a = await target.import({ files: [file('state', STATE_CSV)] }, scope, config)
    await expect(target.load('RUN-1', a.bundleSha256, { ...scope, revision: 9 })).rejects.toThrow(/SCOPE/)
    expect(await target.load('RUN-1', 'f'.repeat(64))).toBeNull()
  })
})

describe('T6 文件集派生值重建与缺步长/损坏/作用域/缺映射', () => {
  const HEADER = 'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'
  async function publishState(gxb = 12) {
    const directory = await mkdtemp(join(tmpdir(), 'wrj-t6-')); roots.push(directory)
    const target = createRunEvidenceStore(directory, () => '2026-01-01T00:01:00.000Z')
    const result = await target.import({ files: [{ fileName: 'link_state.csv', text: `${HEADER}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,${gxb},0.0001,-70` }] }, scope, config)
    return { directory, target, result }
  }
  async function findGeneration(directory: string, bundleSha: string): Promise<string> {
    const runDir = join(directory, 'RUN-1')
    for (const name of (await readdir(runDir)).filter((entry: string) => entry.startsWith('evidence-'))) {
      const bundle = JSON.parse(await readFile(join(runDir, name, 'bundle.json'), 'utf8')) as { result?: { bundleSha256?: string } }
      if (bundle.result?.bundleSha256 === bundleSha) return join(runDir, name)
    }
    throw new Error('generation not found')
  }
  const sourceOf = (loaded: { state: never[]; loss: never[]; switch: never[]; expectedStepS?: number; result: { bundleSha256: string; capabilities: unknown } }) => buildFileSetSource({
    state: loaded.state, loss: loaded.loss, switch: loaded.switch, bundleSha256: loaded.result.bundleSha256,
    capabilities: loaded.result.capabilities as never, ...(loaded.expectedStepS ? { expectedStepS: loaded.expectedStepS } : {}),
  })

  it('伪造 bundle.json 派生值不生效：原文 12 覆盖 state[0].gxbDb=999，load 与报告投影均为 12', async () => {
    const { directory, target, result } = await publishState(12)
    const bundlePath = join(await findGeneration(directory, result.bundleSha256), 'bundle.json')
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as Record<string, unknown>
    bundle.state = [{ gxbDb: 999 }]
    await writeFile(bundlePath, JSON.stringify(bundle))
    const loaded = await target.load('RUN-1', result.bundleSha256)
    expect(loaded?.state[0]!.gxbDb).toBe(12)
    expect(sourceOf(loaded!).rowsByKind.state[0]!.gxbDb).toBe(12)
  })

  it('原文损坏、作用域错误、缺冻结 mapping 均拒绝读取', async () => {
    const { directory, target, result } = await publishState(12)
    await expect(target.load('RUN-1', result.bundleSha256, { ...scope, revision: 9 })).rejects.toThrow(/EVIDENCE_SCOPE_MISMATCH/)
    const generation = await findGeneration(directory, result.bundleSha256)
    const bundlePath = join(generation, 'bundle.json')
    const original = await readFile(bundlePath, 'utf8')
    const withoutConfig = JSON.parse(original) as Record<string, unknown>
    delete withoutConfig.config
    await writeFile(bundlePath, JSON.stringify(withoutConfig))
    await expect(target.load('RUN-1', result.bundleSha256)).rejects.toThrow(/EVIDENCE_ARCHIVE_EVIDENCE_INSUFFICIENT|EVIDENCE_ARCHIVE_CORRUPT/)
    await writeFile(bundlePath, original)
    await writeFile(join(generation, 'files', 'link_state.csv'), `${HEADER}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,77,0.0001,-70`)
    await expect(target.load('RUN-1', result.bundleSha256)).rejects.toThrow(/EVIDENCE_ARCHIVE_CORRUPT|摘要校验失败|摘要与原文/)
  })

  it('仅缺 expectedStepS 且其余证据可信的历史批次允许读取并标连续未知，不借当前 config 补步长', async () => {
    const { directory, target, result } = await publishState(12)
    const bundlePath = join(await findGeneration(directory, result.bundleSha256), 'bundle.json')
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as Record<string, unknown>
    delete bundle.expectedStepS
    await writeFile(bundlePath, JSON.stringify(bundle))
    const loaded = await target.load('RUN-1', result.bundleSha256)
    expect(loaded).not.toBeNull()
    expect(loaded!.expectedStepS).toBeUndefined()
    expect(loaded!.state[0]!.gxbDb).toBe(12)
    const stateSeries = sourceOf(loaded!).series.find(item => item.seriesId.startsWith('state:'))!
    expect(stateSeries.timeStepS).toBeUndefined()
    expect(seriesContinuityReliable(stateSeries)).toBe(false)
  })
})
