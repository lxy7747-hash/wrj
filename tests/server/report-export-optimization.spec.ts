// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { LATEST_FRAMES } from '../fixtures/engine-frame/latest-report'
import type { EngineFrameSnapshot } from '../../src/contracts/domain-models'

const { createHash } = await import('node:' + 'crypto')
const { existsSync } = await import('node:' + 'fs')
const { mkdtemp, readFile, rm, stat } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { env } = await import('node:' + 'process')
const {
  downsampleCurveRows,
  EXPORT_CURVE_MAX_MARKERS,
  EXPORT_CURVE_MAX_POINTS,
  StreamingCurveReservoir,
} = await import('../../server/local/' + 'report-curve-downsample.js')
const { exportEvidenceReport, reportCurveSvg } = await import('../../server/local/' + 'report-file.js')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wrj-report-opt-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const pdfFont = [env.WRJ_PDF_FONT_PATH, 'C:\\Windows\\Fonts\\Deng.ttf', 'C:\\Windows\\Fonts\\simhei.ttf']
  .find(path => !!path && existsSync(path) && !/\.ttc$/i.test(path))

describe('评估报表导出体积与内存优化（P0 + P1）', () => {
  it('downsampleCurveRows 对小序列原样保留，对 50,000 点高频断帧严格控点并保留极值与首末', () => {
    const small = Array.from({ length: 12 }, (_, i) => ({ label: `${i}s`, time: i, value: i * 2 }))
    expect(downsampleCurveRows(small)).toBe(small)

    const dense = Array.from({ length: 50_000 }, (_, i) => ({
      label: `${i}s`,
      time: i,
      value: i === 12_345 ? -999 : i === 34_567 ? 8888 : Math.sin(i / 50) * 10,
      breakBefore: i % 2 === 1,
    }))
    const sampled = downsampleCurveRows(dense, EXPORT_CURVE_MAX_POINTS)
    expect(sampled.length).toBeLessThanOrEqual(EXPORT_CURVE_MAX_POINTS + 4)
    expect(sampled[0]!.time).toBe(0)
    expect(sampled.at(-1)!.time).toBe(49_999)
    expect(sampled.some((p: { value: number }) => p.value === -999)).toBe(true)
    expect(sampled.some((p: { value: number }) => p.value === 8888)).toBe(true)
  })

  it('StreamingCurveReservoir 单遍流式处理 50,000 点严格有界且保留精确计数与极值', () => {
    const reservoir = new StreamingCurveReservoir(EXPORT_CURVE_MAX_POINTS)
    for (let i = 0; i < 50_000; i += 1) {
      const value = i === 111 ? -500 : i === 42_000 ? 1234 : (i % 100)
      reservoir.push(i, value, i % 5 === 0)
    }
    const result = reservoir.finalize()
    expect(result.rawCount).toBe(50_000)
    expect(result.sampling).toBe('DOWNSAMPLED')
    expect(result.points.length).toBeLessThanOrEqual(EXPORT_CURVE_MAX_POINTS + 4)
    expect(result.points[0]!.time).toBe(0)
    expect(result.points.at(-1)!.time).toBe(49_999)
    expect(result.points.some((p: { value: number }) => p.value === -500)).toBe(true)
    expect(result.points.some((p: { value: number }) => p.value === 1234)).toBe(true)
  })

  it('reportCurveSvg 对 20,000 点高频断帧压缩至 < 25 KB 且合并为单条 path + 有界圆点', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({
      label: `${i}s`,
      time: i,
      value: i === 5000 ? -42 : i === 15000 ? 987 : Math.cos(i / 20) * 15,
      breakBefore: i % 3 === 0,
    }))
    const svg = reportCurveSvg({ title: '高压折线', unit: 'dB', rows }, '压测范围')
    expect(new TextEncoder().encode(svg).length).toBeLessThan(25 * 1024)
    expect(svg).toContain('横轴：0～19999 秒；纵轴：-42～987 dB')
    expect(svg).toContain('<path d="')
    expect((svg.match(/<circle/g) ?? []).length).toBeLessThanOrEqual(EXPORT_CURVE_MAX_MARKERS + 4)
  })

  it('exportEvidenceReport 70 条曲线 × 5,000 点（共 35 万点）流式导出 HTML/PDF 体积大幅受控且哈希一致', async () => {
    const dir = await tempDir()
    const baseRows = Array.from({ length: 5_000 }, (_, i) => ({
      label: `${Math.floor(i / 60)}分${i % 60}秒`,
      time: i,
      value: i === 2500 ? 99.5 : Number((10 + Math.sin(i / 30) * 5).toFixed(3)),
    }))
    const charts = Array.from({ length: 70 }, (_, idx) => ({
      title: `segments:link-${idx}:${idx % 2 === 0 ? 'gxb' : 'ber'}`,
      kind: 'LINE' as const,
      unit: idx % 2 === 0 ? 'dB' : 'BER',
      rows: baseRows,
      sourceRange: '压测归档',
    }))
    const htmlRes = await exportEvidenceReport(dir, {
      reportId: 'RPT-LOCAL-STRESS',
      format: 'HTML',
      sourceLabel: '原生帧归档',
      sourceSha256: 'a'.repeat(64),
      filterLabel: '全部',
      generatedTime: '2026-11-25T00:00:00.000Z',
      charts,
      sections: [{ title: '摘要', columns: ['指标', '值'], rows: [['链路数', '35']] }],
    })
    const htmlBytes = await readFile(htmlRes.filePath)
    expect(htmlRes.sha256).toBe(createHash('sha256').update(htmlBytes).digest('hex'))
    // 此前 70 × 5,000 点 HTML 约 40～60 MB，降采样 + 流式精简后应控制在 1.5 MB 以内。
    expect(htmlBytes.length).toBeLessThan(1.5 * 1024 * 1024)

    if (pdfFont) {
      const pdfRes = await exportEvidenceReport(dir, {
        reportId: 'RPT-LOCAL-STRESS',
        format: 'PDF',
        sourceLabel: '原生帧归档',
        sourceSha256: 'a'.repeat(64),
        filterLabel: '全部',
        generatedTime: '2026-11-25T00:00:00.000Z',
        charts,
        sections: [{ title: '摘要', columns: ['指标', '值'], rows: [['链路数', '35']] }],
      })
      const pdfBytes = await readFile(pdfRes.filePath)
      expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-')
      expect(pdfBytes.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true)
      expect(pdfRes.sha256).toBe(createHash('sha256').update(pdfBytes).digest('hex'))
      expect((await stat(pdfRes.filePath)).size).toBeLessThan(5 * 1024 * 1024)
    }
  }, 30_000)

  it('engineFrameArchive.queryAllSeriesDownsampled 单遍流式返回全部链路曲线且保留极值与原始计数', async () => {
    const dir = await tempDir()
    const archive = createEngineFrameArchive(dir, () => '2026-11-25T00:00:00.000Z')
    const scope = {
      taskId: 'TASK-OPT-1',
      runId: 'RUN-OPT-1',
      scenarioId: 'SCN-OPT-1',
      revision: 1,
      startedAt: '2026-11-25T00:00:00.000Z',
    }
    const session = await archive.begin(scope)
    const templateFrame = LATEST_FRAMES[0]!
    const templateLink = templateFrame.links[0]!
    for (let frameIdx = 0; frameIdx < 800; frameIdx += 1) {
      const frame: EngineFrameSnapshot = {
        ...structuredClone(templateFrame),
        runId: scope.runId,
        engineEpoch: 0,
        frameId: frameIdx * 5,
        simulationTime: frameIdx,
        links: Array.from({ length: 4 }, (_, linkIdx) => ({
          ...structuredClone(templateLink),
          linkId: `SEG-${linkIdx}`,
          linkIds: [`L-${linkIdx}`],
          sourceName: `uav_${linkIdx}`,
          sourcePort: 'tx',
          targetName: 'cmd',
          targetPort: 'rx',
          sourcePlatformId: `PLAT-${linkIdx}`,
          targetPlatformId: 'PLAT-CMD',
          quality: {
            ...templateLink.quality,
            gxbDb: frameIdx === 400 ? 77.7 : 10 + linkIdx + (frameIdx % 5),
            ber: frameIdx === 600 ? 0.25 : 1e-5,
          },
        })),
        routing: { ...structuredClone(templateFrame.routing), switches: [] },
        events: [],
      }
      await session.append(frame)
    }
    await session.close()

    const series = await archive.queryAllSeriesDownsampled!(scope.runId, scope, undefined, EXPORT_CURVE_MAX_POINTS)
    expect(series).not.toBeNull()
    expect(series!).toHaveLength(8) // 4 links × (gxb + ber)
    for (const item of series!) {
      expect(item.rawCount).toBe(800)
      expect(item.sampling).toBe('DOWNSAMPLED')
      expect(item.points.length).toBeLessThanOrEqual(EXPORT_CURVE_MAX_POINTS + 4)
      if (item.meta.unit === 'dB') expect(item.points.some((p: { value: number }) => p.value === 77.7)).toBe(true)
      if (item.meta.unit === 'BER') expect(item.points.some((p: { value: number }) => p.value === 0.25)).toBe(true)
    }
  }, 30_000)
})
