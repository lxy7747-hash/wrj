import { describe, expect, it } from 'vitest'
import type { QualityScope } from '../../src/contracts/domain-models'
import { EVIDENCE_KIND_FILE, EvidenceImportError, evidenceBundlePayload, inspectEvidenceImportRequest, isEvidenceImportResult } from '../../src/features/data-exchange/evidence-contract'
import { inspectCsvText } from '../../src/features/data-exchange/csv-contract'
import { parseEvidenceBundle } from '../../src/features/data-exchange/evidence-records'
import { isQualityDataset, type QualityConfig } from '../../src/features/data-exchange/quality-records'

const { createHash } = await import('node:' + 'crypto')

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const scope: QualityScope = { taskId: 'TASK-1', runId: 'RUN-1', scenarioId: 'SCN-1', revision: 1, startedAt: '2026-01-01T00:00:00.000Z' }
const config = {
  scenario: { id: 'SCN-1', timeStep: 1 },
  platforms: [{ id: 'A' }, { id: 'B' }],
  links: [{ id: 'L-1', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', enabled: true }],
  linkSettings: {},
} as unknown as QualityConfig

const QUALITY_CSV = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,Frequency,Bandwidth,Distance,TxPower,TxAntennaGain,RxAntennaGain,PathLoss,JammingPower,ReceivedPower,SNR,GXB,Modulation,BER,LinkStatus,BERThreshold,DataRate'}\nTASK-1,1.1,0,A,B,MICROWAVE,8000,20,1000,10,1,1,100,-90,-70,12,12,QPSK,0.0001,UP,0.01,10`
const STATE_CSV = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,12,0.0001,-70\nTASK-1,1.1,1,A,B,MICROWAVE,DOWN,,,`
const LOSS_CSV = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,FreeSpaceLoss,SeaMultipathLoss,AtmosphericLoss,CloudRainLoss,JammingLoss,TotalLoss'}\nTASK-1,1.1,0,A,B,MICROWAVE,1,2,3,4,5,15`
const SWITCH_CSV = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,Direction,OldLinkType,NewLinkType,OldBER,NewBER,SwitchReason'}\nTASK-1,1.1,0,A,B,FORWARD,MICROWAVE,DATALINK,0.0001,0.0002,BER_THRESHOLD`
const file = (kind: keyof typeof EVIDENCE_KIND_FILE, text: string) => ({ fileName: EVIDENCE_KIND_FILE[kind], text })
const source = { sha256: sha, importedAt: '2026-01-01T00:01:00.000Z' }

describe('D2 文件集合同与解析', () => {
  it('暂无数据单元格回读为 null，零值保留，非法数字和任务时间仍拒绝', () => {
    const state = STATE_CSV.split('\n').slice(0, 2).join('\n').replace(',12,0.0001,-70', ',0,0,暂无数据')
    const loss = LOSS_CSV.replace(',1,2,3,4,5,15', ',1,2,3,暂无数据,0,15')
    const switched = SWITCH_CSV.replace('MICROWAVE,DATALINK,0.0001,0.0002', '暂无数据,暂无数据,暂无数据,暂无数据')
    const parsed = parseEvidenceBundle({ files: [file('state', state), file('loss', loss), file('switch', switched)] }, scope, config, source)
    const contract = { name: 'link_state.csv', version: '1.1', sourceRef: 'test', fields: state.split('\n')[0]!.split(',') }
    expect(inspectCsvText(contract, state).valid).toBe(true)
    for (const bad of [state.replace('TASK-1', '暂无数据'), state.replace('1.1,0,', '1.1,暂无数据,'), state.replace('暂无数据', 'NaN')]) expect(inspectCsvText(contract, bad).valid).toBe(false)
    expect(parsed.state[0]).toMatchObject({ gxbDb: 0, ber: 0, receivedPower: null })
    expect(parsed.loss[0]).toMatchObject({ cloudRainLossDb: null, jammingLossDb: 0, totalLossDb: 15 })
    expect(parsed.switch[0]).toMatchObject({ oldBer: null, newBer: null })
    for (const invalid of ['NaN', 'Infinity', 'abc']) expect(() => parseEvidenceBundle({ files: [file('loss', loss.replace('暂无数据', invalid))] }, scope, config, source)).toThrow()
    expect(() => parseEvidenceBundle({ files: [file('state', state.replace('1.1,0,', '1.1,暂无数据,'))] }, scope, config, source)).toThrow()
  })

  it('D2-01 四类完整集逐字段对照，调换文件次序不改变 bundleSha256', () => {
    const files = [file('quality', QUALITY_CSV), file('state', STATE_CSV), file('loss', LOSS_CSV), file('switch', SWITCH_CSV)]
    const forward = parseEvidenceBundle({ files }, scope, config, source)
    const reversed = parseEvidenceBundle({ files: [...files].reverse() }, scope, config, source)
    expect(forward.result.bundleSha256).toBe(reversed.result.bundleSha256)
    expect(forward.result.capabilities).toEqual(['quality', 'state', 'loss', 'switch'])
    expect(forward.result.missing).toEqual([])
    expect(forward.result.association).toBe('USER_SELECTED_RUN')
    expect(forward.result.files.map(item => item.fileName)).toEqual(['link_loss.csv', 'link_quality.csv', 'link_state.csv', 'link_switch.csv'])
    expect(forward.quality?.samples).toHaveLength(1)
    expect(forward.state).toEqual([{ time: 0, linkId: 'L-1', linkStatus: 'UP', gxbDb: 12, ber: 0.0001, receivedPower: -70, sourcePlatformId: 'A', targetPlatformId: 'B' }, { time: 1, linkId: 'L-1', linkStatus: 'DOWN', gxbDb: null, ber: null, receivedPower: null, sourcePlatformId: 'A', targetPlatformId: 'B' }])
    expect(forward.loss[0]).toMatchObject({ linkId: 'L-1', freeSpaceLossDb: 1, totalLossDb: 15 })
    expect(forward.switch[0]).toMatchObject({ direction: 'FORWARD', oldBer: 0.0001, newBer: 0.0002, reason: 'BER_THRESHOLD' })
    expect(sha(evidenceBundlePayload(forward.result.files))).toBe(forward.result.bundleSha256)
  })

  it('D2-02 state-only 展示实际 GXB/BER/接收功率且不提供 SNR，缺 loss/switch 反映为缺失', () => {
    const parsed = parseEvidenceBundle({ files: [file('state', STATE_CSV)] }, scope, config, source)
    expect(parsed.result.capabilities).toEqual(['state'])
    expect(parsed.result.missing).toEqual(['quality', 'loss', 'switch'])
    expect(parsed.quality).toBeUndefined()
    expect(parsed.state[0]).toEqual({ time: 0, linkId: 'L-1', linkStatus: 'UP', gxbDb: 12, ber: 0.0001, receivedPower: -70, sourcePlatformId: 'A', targetPlatformId: 'B' })
    expect('snr' in parsed.state[0]!).toBe(false)
    expect(parsed.result.warnings.some(warning => warning.includes('不提供也不能推导 SNR'))).toBe(true)
  })

  it('D2-03 空文件、重复文件、未知文件名、非法数值与跨文件冲突均拒绝并定位', () => {
    expect('issues' in inspectEvidenceImportRequest({ files: [] })).toBe(true)
    expect('issues' in inspectEvidenceImportRequest({ files: [file('quality', QUALITY_CSV), file('quality', QUALITY_CSV)] })).toBe(true)
    expect('issues' in inspectEvidenceImportRequest({ files: [{ fileName: 'other.csv', text: '' }] })).toBe(true)
    expect(() => parseEvidenceBundle({ files: [{ fileName: 'link_state.csv', text: `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,NaN,A,B,MICROWAVE,UP,12,0.1,-70` }] }, scope, config, source)).toThrow(EvidenceImportError)
    const conflictState = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,999,0.0001,-70`
    expect(() => parseEvidenceBundle({ files: [file('quality', QUALITY_CSV), { fileName: 'link_state.csv', text: conflictState }] }, scope, config, source)).toThrow(/冲突/)
    // 重复行
    const dup = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,0,A,B,MICROWAVE,UP,12,0.0001,-70\nTASK-1,1.1,0,A,B,MICROWAVE,UP,12,0.0001,-70`
    expect(() => parseEvidenceBundle({ files: [{ fileName: 'link_state.csv', text: dup }] }, scope, config, source)).toThrow(/重复/)
  })

  it('D2-04 多链路端点无法唯一映射时拒绝，不生成原 frameId/eventId', () => {
    const ambiguous = { ...config, links: [...config.links, { id: 'L-2', type: 'MICROWAVE', sourcePlatformId: 'A', targetPlatformId: 'B', enabled: true }] } as unknown as QualityConfig
    try {
      parseEvidenceBundle({ files: [file('state', STATE_CSV)] }, scope, ambiguous, source)
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceImportError)
      expect((error as EvidenceImportError).issues[0]!.code).toBe('EVIDENCE_LINK_AMBIGUOUS')
    }
  })

  it('D2-06 新文件集回执与旧 QualityDataset 互不混用', () => {
    const parsed = parseEvidenceBundle({ files: [file('quality', QUALITY_CSV), file('state', STATE_CSV)] }, scope, config, source)
    expect(isEvidenceImportResult(parsed.result)).toBe(true)
    expect(isQualityDataset(parsed.result as unknown)).toBe(false)
    expect(isEvidenceImportResult(parsed.quality as unknown)).toBe(false)
  })

  it('D2-02 空 switch 视为已提供(rows=0)，未提供才为 missing，不补默认值', () => {
    const emptySwitch = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,Direction,OldLinkType,NewLinkType,OldBER,NewBER,SwitchReason'}\n`
    const withEmpty = parseEvidenceBundle({ files: [file('switch', emptySwitch)] }, scope, config, source)
    expect(withEmpty.result.capabilities).toEqual(['switch'])
    expect(withEmpty.switch).toHaveLength(0)
    expect(withEmpty.result.files.find(item => item.fileName === 'link_switch.csv')?.rows).toBe(0)
    const absent = parseEvidenceBundle({ files: [file('state', STATE_CSV)] }, scope, config, source)
    expect(absent.result.missing).toContain('switch')
  })

  it('T1 两条同端点同类型但不同 linkId 的冻结链路→歧义拒绝（与无匹配分离）', () => {
    const duplicate = { ...config, links: [{ ...config.links[0]!, id: 'L-1' }, { ...config.links[0]!, id: 'L-2' }] } as unknown as QualityConfig
    try {
      parseEvidenceBundle({ files: [file('state', STATE_CSV)] }, scope, duplicate, source)
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceImportError)
      expect((error as EvidenceImportError).issues[0]!.code).toBe('EVIDENCE_LINK_AMBIGUOUS')
    }
    const noMatch = `${'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower'}\nTASK-1,1.1,0,ZZZ,YYY,MICROWAVE,UP,1,0.1,-70`
    expect(() => parseEvidenceBundle({ files: [{ fileName: 'link_state.csv', text: noMatch }] }, scope, config, source)).toThrow(EvidenceImportError)
  })
})
