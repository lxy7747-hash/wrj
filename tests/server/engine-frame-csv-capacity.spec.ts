// @vitest-environment node
// L01 / GNZB 23/28：派生 CSV 单文件 256MiB 上限（A2）。
// 覆盖：真实 UTF-8 字节边界（表头/CRLF/转义/多字节，经实际读取路径）；合法 >256MiB 短行大文件因容量拒绝；
// 小阈值下写入/收尾/再次关闭的失败与两级指针；生产限制（JSONL 2GiB / 派生 CSV 256MiB / 四文件 8MiB）不变。
import { afterEach, describe, expect, it } from 'vitest'
import { EVENTS_CSV_HEADER, LINK_STATE_CSV_HEADER } from '../../src/contracts/domain-models'
import { inspectCsvRecord, parseCsvLine } from '../../src/features/data-exchange/csv-contract'
import sample from '../fixtures/engine-frame/params_check.json'
import { adaptEngineFrameSnapshot } from '../../src/features/data-exchange/engine-frame-snapshot'

const { mkdtemp, rm, readFile, readdir, open, stat } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { createHash } = await import('node:' + 'crypto')
const { createEngineFrameArchive } = await import('../../server/local/' + 'engine-frame-archive.js')
const { __setDerivedCsvLimitBytesForTest, validateCsvFile, createEngineCsvSession } = await import('../../server/local/' + 'engine-frame-csv.js')

const roots: string[] = []
afterEach(async () => {
  __setDerivedCsvLimitBytesForTest(undefined)
  await Promise.all(roots.splice(0).map((root: string) => rm(root, { recursive: true, force: true })))
})
const scope = { taskId: 'TASK-001', runId: 'RUN-ARCHIVE', scenarioId: 'SCN-001', revision: 1, startedAt: '2026-11-10T00:00:00Z' }
const bindings = { 'L-1': { type: 'MICROWAVE' as const, sourcePlatformId: 'A', targetPlatformId: 'B' } }
function frame(frameId: number) {
  const value = { ...adaptEngineFrameSnapshot({ ...sample, frame_id: frameId, sim_time_s: undefined }).data!, runId: 'RUN-ARCHIVE', engineEpoch: 0 }
  const link = value.links[0]!
  Object.assign(link, { linkIds: ['L-1'], sourcePlatformId: 'A', targetPlatformId: 'B', status: 'UP' })
  Object.assign(link.quality, { gxbDb: 2, ber: 0.01, rxPowerDbm: -80 })
  return value
}
async function makeRoot(tag: string) { const root = await mkdtemp(join(tmpdir(), `wrj-l01-cap-${tag}-`)); roots.push(root); return root }
async function pointerSha(root: string, name: string) { return String(JSON.parse(await readFile(join(root, scope.runId, name), 'utf8')).sourceSha256) }
async function rawFrameIds(root: string): Promise<number[]> {
  const dir = join(root, scope.runId); const ids: number[] = []
  for (const name of (await readdir(dir) as string[]).filter((n: string) => n.endsWith('.jsonl'))) for (const line of (await readFile(join(dir, name), 'utf8')).split('\n')) if (line.trim()) ids.push(JSON.parse(line).frameId as number)
  return ids
}
const csvEscape = (value: string) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
function eventsRow(time: number) {
  const fields = ['TASK-001', '1.1', String(time), 'MESSAGE_RECEIVED', 'UAV-01', 'GCC-01', 'OK', '1', '2', '3', '备注,含逗号与"引号"和多字节链路']
  return fields.map(csvEscape).join(',')
}
const linkStateRow = (time: number) => `TASK-001,1.1,${time},UAV-01,GCC-01,MICROWAVE,UP,2,0.01,-80`

describe('L01 派生 CSV 容量上限（A2）', () => {
  it('真实 UTF-8 字节边界（表头+CRLF+转义+多字节，经实际读取路径）低于/等于/超过', async () => {
    const root = await makeRoot('bytes'); const filePath = join(root, 'events.csv')
    const content = `${EVENTS_CSV_HEADER}\r\n${eventsRow(1)}\r\n`
    // 内容确为合法 events 记录（含多字节/逗号/引号转义）
    const dataLine = content.split('\r\n')[1]!
    expect(parseCsvLine(dataLine)).toHaveLength(EVENTS_CSV_HEADER.split(',').length)
    expect(inspectCsvRecord({ name: 'events.csv', version: '1.1', sourceRef: 'x', fields: EVENTS_CSV_HEADER.split(',') }, dataLine, 2)).toEqual([])
    const handle = await open(filePath, 'w'); await handle.write(new TextEncoder().encode(content)); await handle.close()
    const size = (await stat(filePath)).size
    expect(size).toBe(new TextEncoder().encode(content).length)
    expect(new TextEncoder().encode(content).length).toBeGreaterThan(content.length) // 多字节确实按字节计
    // 低于：阈值 = size+1 → 通过
    __setDerivedCsvLimitBytesForTest(size + 1)
    expect(await validateCsvFile(filePath, 'events.csv')).toMatchObject({ rowCount: 1 })
    // 等于：阈值 = size → 通过（含表头/CRLF/转义/多字节实际字节）
    __setDerivedCsvLimitBytesForTest(size)
    expect(await validateCsvFile(filePath, 'events.csv')).toMatchObject({ rowCount: 1 })
    // 超过：阈值 = size-1 → 拒绝（读取上限，先于逐行解析）
    __setDerivedCsvLimitBytesForTest(size - 1)
    await expect(validateCsvFile(filePath, 'events.csv')).rejects.toThrow(/流式读取上限/)
  })

  it('合法 >256MiB 短行 CSV 因单文件容量限制被拒绝；同规则合法小文件成功', async () => {
    __setDerivedCsvLimitBytesForTest(undefined) // 生产 256MiB
    const root = await makeRoot('real256'); const filePath = join(root, 'over.csv')
    const header = `${LINK_STATE_CSV_HEADER}\n`
    // 契约合法：首行/尾行抽样均需通过 inspectCsvRecord
    const contract = { name: 'link_state.csv', version: '1.1', sourceRef: 'x', fields: LINK_STATE_CSV_HEADER.split(',') }
    expect(inspectCsvRecord(contract, linkStateRow(0), 2)).toEqual([])
    const target = 256 * 1024 * 1024 + 8192
    const writeHash = createHash('sha256')
    const handle = await open(filePath, 'w')
    let total = 0, rowIndex = 0, lastRow = ''
    try {
      const head = new TextEncoder().encode(header); await handle.write(head); writeHash.update(head); total += head.length
      while (total < target) {
        let block = ''
        while (block.length < 1024 * 1024) { lastRow = linkStateRow(rowIndex); block += `${lastRow}\n`; rowIndex += 1 }
        const buf = new TextEncoder().encode(block); await handle.write(buf); writeHash.update(buf); total += buf.length
      }
    } finally { await handle.close() }
    const writtenSha = writeHash.digest('hex')
    // 实际大小 > 256MiB，且与写入字节一致
    expect((await stat(filePath)).size).toBe(total)
    expect(total).toBeGreaterThan(256 * 1024 * 1024)
    // 读回实际 SHA256 与写入一致
    const readHash = createHash('sha256')
    const rh = await open(filePath, 'r')
    try { let offset = 0; const chunk = new Uint8Array(1024 * 1024); while (true) { const { bytesRead } = await rh.read(chunk, 0, chunk.length, offset); if (!bytesRead) break; readHash.update(chunk.subarray(0, bytesRead)); offset += bytesRead } } finally { await rh.close() }
    expect(readHash.digest('hex')).toBe(writtenSha)
    // 首行表头与首条数据行合法；尾行为契约合法短行且尾部完整（不整读大文件）
    const headHandle = await open(filePath, 'r')
    let headText = ''
    try { const buf = new Uint8Array(512); const { bytesRead } = await headHandle.read(buf, 0, 512, 0); headText = new TextDecoder().decode(buf.subarray(0, bytesRead)) } finally { await headHandle.close() }
    const headLines = headText.split('\n')
    expect(headLines[0]).toBe(LINK_STATE_CSV_HEADER)
    expect(inspectCsvRecord(contract, headLines[1]!, 2)).toEqual([])
    expect(lastRow).toBe(linkStateRow(rowIndex - 1))
    expect(inspectCsvRecord(contract, lastRow, rowIndex + 1)).toEqual([])
    // 拒绝来自单文件 256MiB 读取上限（先于逐行解析），而非格式/单行/摘要
    await expect(validateCsvFile(filePath, 'link_state.csv')).rejects.toThrow(/256 MiB/)
    // 同规则合法小文件成功对照
    const smallPath = join(root, 'small.csv')
    const smallRows = Array.from({ length: 3 }, (_, i) => linkStateRow(i))
    const smallHandle = await open(smallPath, 'w'); await smallHandle.write(new TextEncoder().encode(`${header}${smallRows.join('\n')}\n`)); await smallHandle.close()
    expect((await stat(smallPath)).size).toBeLessThan(256 * 1024 * 1024)
    expect(await validateCsvFile(smallPath, 'link_state.csv')).toMatchObject({ rowCount: 3 })
  }, 180000)

  it('写入路径：小阈值下 append 记录失败，首次及再次 close 均拒绝，两级指针保留旧 A，B 原文保留', async () => {
    __setDerivedCsvLimitBytesForTest(4096)
    const root = await makeRoot('over')
    const archive = createEngineFrameArchive(root, () => scope.startedAt)
    const a = await archive.begin(scope, bindings); await a.append(frame(1)); await a.close()
    const rawA = await pointerSha(root, 'current.json'), csvA = await pointerSha(root, 'csv/current.json')
    expect(await archive.getCsvFile(scope.runId, rawA, 'link_state.csv')).toBeTruthy()

    const b = await archive.begin(scope, bindings)
    for (let i = 2; i < 202; i += 1) await b.append(frame(i))
    expect(b.failure()?.message).toContain('256MiB')
    await expect(b.close()).rejects.toThrow('256MiB')
    expect(b.failure()).not.toBeNull()
    expect(await pointerSha(root, 'current.json')).toBe(rawA)
    expect(await pointerSha(root, 'csv/current.json')).toBe(csvA)
    expect(await archive.getFile(scope.runId, rawA)).toBeTruthy()
    expect(await archive.getCsvFile(scope.runId, rawA, 'link_state.csv')).toBeTruthy()
    expect(await rawFrameIds(root)).toEqual(expect.arrayContaining([2]))
    await expect(b.close()).rejects.toThrow('256MiB')
  })

  it('生产写入路径三边界：真实序列化/转义/多字节/表头/CRLF 计字节，低于/等于成功、超过失败', async () => {
    const escBindings = { 'L-1': { type: 'MICROWAVE' as const, sourcePlatformId: 'UAV,01"Ö', targetPlatformId: 'GCC-01' } }
    const escapedFrame = (frameId: number) => {
      const value = { ...adaptEngineFrameSnapshot({ ...sample, frame_id: frameId, sim_time_s: undefined }).data!, runId: 'RUN-ARCHIVE', engineEpoch: 0 }
      const link = value.links[0]!
      Object.assign(link, { linkId: 'SEG-0', linkIds: ['L-1'], sourcePlatformId: 'UAV,01"Ö', targetPlatformId: 'GCC-01', status: 'UP', error: null })
      Object.assign(link.quality, { gxbDb: 2, ber: 0.01, rxPowerDbm: -80 })
      return value
    }
    const root = await makeRoot('write-bytes')
    // 用生产序列化跑一次，测量各派生 CSV 实际字节（含表头/CRLF/转义/多字节）
    __setDerivedCsvLimitBytesForTest(256 * 1024 * 1024)
    const session = await createEngineCsvSession(root, 'TASK-001', escBindings)
    await session.append(escapedFrame(1))
    await session.close('a'.repeat(64), { deferPointer: true })
    const generation = (await readdir(root)).find((name: string) => name.startsWith('engine-csv-'))!
    const genDir = join(root, generation)
    const stateText = await readFile(join(genDir, 'link_state.csv'), 'utf8')
    // 生产写入使用 CRLF；转义后的多字节平台名真实出现在文件中
    expect(stateText.split('\r\n')[0]).toBe(LINK_STATE_CSV_HEADER)
    expect(stateText).toContain('UAV,01')
    expect(stateText).toContain('Ö')
    const csvNames = (await readdir(genDir)).filter((name: string) => name.endsWith('.csv'))
    const sizes = await Promise.all(csvNames.map(async (name: string) => (await stat(join(genDir, name))).size))
    const maxSize = Math.max(...sizes)
    // 等于阈值（针对实际最大文件）成功
    __setDerivedCsvLimitBytesForTest(maxSize)
    const equalSession = await createEngineCsvSession(join(root, 'eq'), 'TASK-001', escBindings)
    await equalSession.append(escapedFrame(1)); await equalSession.close('a'.repeat(64), { deferPointer: true })
    // 低于阈值（阈值更大）成功
    __setDerivedCsvLimitBytesForTest(maxSize + 64)
    const belowSession = await createEngineCsvSession(join(root, 'lt'), 'TASK-001', escBindings)
    await belowSession.append(escapedFrame(1)); await belowSession.close('a'.repeat(64), { deferPointer: true })
    // 超过阈值（最大文件超 1 字节）：生产写入路径在 append/收尾阶段明确失败
    __setDerivedCsvLimitBytesForTest(maxSize - 1)
    const overSession = await createEngineCsvSession(join(root, 'gt'), 'TASK-001', escBindings)
    let overRejected = false
    let overReleased = false
    try {
      try { await overSession.append(escapedFrame(1)); await overSession.close('a'.repeat(64), { deferPointer: true }) }
      catch (error) { overRejected = true; expect((error as Error).message).toContain('256MiB') }
    } finally {
      // 失败会话显式释放 FileHandle 与临时目录，不依赖 afterEach 删目录或 GC 关闭句柄。
      await overSession.abort(); overReleased = true
    }
    expect(overRejected).toBe(true)
    // 从控制流确认释放确实执行（abort 后再 append 必须被拒绝）
    expect(overReleased).toBe(true)
    await expect(overSession.append(escapedFrame(1))).rejects.toThrow('已关闭')
  })
})
