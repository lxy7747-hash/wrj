// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { REPORT_EVENT_CSV } from '../fixtures/local-report-csv'
import type { ContractDescriptor } from '../../src/contracts/domain-models'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
import { createCsvExample, inspectCsvText, parseCsvLine } from '../../src/features/data-exchange/csv-contract'
const { mkdtemp, readFile, writeFile, readdir, rm, mkdir } = await import('node:fs/' + 'promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createHash } = await import('node:' + 'crypto')
const { writeTimeSeries, TIME_SERIES_CONTRACTS: timeSeriesContracts } = await import('../../server/local/' + 'time-series.js')
const TIME_SERIES_CONTRACTS: readonly ContractDescriptor[] = timeSeriesContracts
const directories: string[] = []
const context = { taskId: 'TASK-EVENTS', runId: 'RUN-EVENTS' }
const log = parseAfsimEventLog(REPORT_EVENT_CSV)
const sourceSha = createHash('sha256').update(REPORT_EVENT_CSV).digest('hex')
async function directory() { const path = await mkdtemp(join(tmpdir(), 'wrj-time-series-')); directories.push(path); return path }
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })

describe('任务规范时序 CSV 实际文件留存', () => {
  it('从真实事件结构生成 UTF-8 CSV，保留任务与原始字段，缺少引擎质量不造空表', async () => {
    const root = await directory()
    const first = await writeTimeSeries(root, context, log, sourceSha)
    const manifest = JSON.parse(await readFile(join(first, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ schemaVersion: '1.1', ...context, encoding: 'UTF-8', sourceSha256: sourceSha, contractsComplete: false })
    expect(manifest.files).toHaveLength(1)
    expect(manifest.missing.map((item: { fileName: string }) => item.fileName)).toEqual(['link_quality.csv', 'link_switch.csv', 'link_state.csv', 'link_loss.csv'])
    expect(manifest.missing.every((item: { status: string }) => item.status === 'REQUIRES_ENGINE')).toBe(true)
    const csv: string = await readFile(join(first, 'events.csv'), 'utf8')
    const contract = TIME_SERIES_CONTRACTS.find(item => item.name === 'events.csv')!
    expect(inspectCsvText(contract, csv)).toMatchObject({ valid: true, rowCount: log.events.length })
    const rows = csv.trimEnd().split('\r\n').slice(1).map(line => parseCsvLine(line)!)
    expect(rows.every(row => row[0] === context.taskId && row[1] === '1.1')).toBe(true)
    const message = rows.find(row => row[contract.fields.indexOf('EventType')] === 'MESSAGE_RECEIVED')!
    const parameters = JSON.parse(message[contract.fields.indexOf('Parameters')]!)
    expect(parameters.fields.message_serial_number).toBe('9007199254740993')
    expect(parameters.fields.comment).toBe('含逗号,及"引号"')
    expect(manifest.files[0].sha256).toBe(createHash('sha256').update(csv).digest('hex'))
    expect(await readdir(first)).toEqual(expect.arrayContaining(['events.csv', 'manifest.json']))
    expect(await readdir(first)).toHaveLength(2)
    const second = await writeTimeSeries(root, { taskId: 'TASK-SECOND', runId: 'RUN-SECOND' }, log, sourceSha)
    expect(second).not.toBe(first)
    expect(await readFile(join(first, 'events.csv'), 'utf8')).toBe(csv)
    expect(await readFile(join(second, 'events.csv'), 'utf8')).toContain('TASK-SECOND,1.1,')
  })

  it('已有规范测量文件按原值留存，全部任务标识、字段和摘要闭合', async () => {
    const root = await directory()
    for (const contract of TIME_SERIES_CONTRACTS.filter(item => item.name !== 'events.csv')) {
      await writeFile(join(root, contract.name), createCsvExample(contract).replaceAll('TASK-001', context.taskId))
    }
    const output = await writeTimeSeries(root, context, log, sourceSha)
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    expect(manifest).toMatchObject({ contractsComplete: true, missing: [] })
    expect(manifest.files).toHaveLength(5)
    for (const contract of TIME_SERIES_CONTRACTS.filter(item => item.name !== 'events.csv')) {
      expect(await readFile(join(output, contract.name), 'utf8')).toBe(await readFile(join(root, contract.name), 'utf8'))
    }
  })

  it.each([['LASER', 'OOK'], ['FIBER', 'QPSK']])('保留已支持的%s/%s质量输入，不按RF枚举误拒绝', async (linkType, modulation) => {
    const root = await directory()
    const contract = TIME_SERIES_CONTRACTS[0]!
    const lines = createCsvExample(contract).replaceAll('TASK-001', context.taskId).split('\n')
    const cells = lines[1]!.split(',')
    cells[contract.fields.indexOf('LinkType')] = linkType!
    cells[contract.fields.indexOf('Modulation')] = modulation!
    const text = `${lines[0]}\n${cells.join(',')}`
    await writeFile(join(root, contract.name), text)
    const output = await writeTimeSeries(root, context, log, sourceSha)
    expect(await readFile(join(output, contract.name), 'utf8')).toBe(text)
  })

  it.each(['other-task', 'header', 'empty', 'utf8', 'directory'] as const)('拒绝%s来源，既有文件和历史归档不被覆盖，不发布半套数据', async mode => {
    const root = await directory()
    const previous = await writeTimeSeries(root, context, log, sourceSha)
    const contract = TIME_SERIES_CONTRACTS[0]!
    const source = join(root, contract.name)
    if (mode === 'directory') await mkdir(source)
    else if (mode === 'utf8') await writeFile(source, new Uint8Array([0xff]))
    else await writeFile(source, mode === 'header' ? 'bad\n1\n' : mode === 'empty' ? contract.fields.join(',') + '\n'
      : createCsvExample(contract).replaceAll('TASK-001', 'TASK-OTHER'))
    await expect(writeTimeSeries(root, context, log, sourceSha)).rejects.toThrow()
    expect((await readdir(root)).filter((name: string) => name.startsWith('time-series-'))).toHaveLength(1)
    expect((await readdir(root)).some((name: string) => name.startsWith('.time-series-'))).toBe(false)
    expect(await readFile(join(previous, 'events.csv'), 'utf8')).toContain(context.taskId)
  })

  it('非法任务、运行、来源摘要或无效日志不会创建目录', async () => {
    const root = await directory()
    await expect(writeTimeSeries(root, { ...context, taskId: '../TASK-EVENTS' }, log, sourceSha)).rejects.toThrow()
    await expect(writeTimeSeries(root, { ...context, runId: 'not-a-run' }, log, sourceSha)).rejects.toThrow()
    await expect(writeTimeSeries(root, context, log, 'invalid')).rejects.toThrow()
    await expect(writeTimeSeries(root, context, { ...log, valid: false }, sourceSha)).rejects.toThrow()
    expect(await readdir(root)).toEqual([])
  })
})
