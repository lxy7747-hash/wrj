import { describe, expect, it } from 'vitest'
import type { Link, MasterData } from '../../src/contracts/domain-models'
import { prepareLinkMasterData, PUBLIC_LINK_PARAMETER_OPTIONS } from '../../src/features/scenarios/link-master-parameters'
import { isLinkParameterSource } from '../../src/features/scenarios/link-parameter-source'

function link(change: Partial<Link> = {}): Link {
  return { id: 'L-1', type: 'DATALINK', sourcePlatformId: 'P-1', targetPlatformId: 'P-2', frequency: 150, bandwidth: 10,
    txPower: 20, antennaGain: { tx: 1, rx: 2 }, modulation: 'BPSK', berThreshold: 0.01, dataRate: 2, direction: 'FORWARD', band: 'C', ...change }
}
function master(entries: NonNullable<MasterData['content']>['entries']): MasterData {
  return { dataId: 'MASTER-1', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
    content: { name: '链路字典', description: '', entries } }
}

describe('通用基础数据预填链路', () => {
  it('中文下拉选项与现有链路字段、单位及旧别名使用同一映射', () => {
    expect(PUBLIC_LINK_PARAMETER_OPTIONS).toHaveLength(7)
    expect(PUBLIC_LINK_PARAMETER_OPTIONS.filter(option => option.kind === 'COMMUNICATION_SYSTEM').map(option => option.key))
      .toEqual(['frequencyMHz', 'rxFrequencyMHz', 'rxBandwidthMHz'])
    expect(PUBLIC_LINK_PARAMETER_OPTIONS.filter(option => option.kind === 'PARAMETER_DICTIONARY').map(option => option.key))
      .toEqual(['txAntennaGainDbi', 'rxAntennaGainDbi', 'antennaGainCorrectionDb', 'noiseFigureDb'])
    for (const option of PUBLIC_LINK_PARAMETER_OPTIONS) {
      expect(option.label).toMatch(/[\u4e00-\u9fff]/)
      const result = prepareLinkMasterData(link(), master([{ key: option.key, valueType: 'NUMBER', value: 3, unit: option.unit }]), [])
      expect(result).toMatchObject({ ok: true, skipped: [] })
      for (const alias of option.aliases) {
        const legacy = prepareLinkMasterData(link(), master([{ key: alias, valueType: 'NUMBER', value: 3, unit: option.unit }]), [])
        expect(legacy).toEqual(result)
      }
    }
  })

  it('仅接受闭合的来源快照与装备允许字段', () => {
    expect(isLinkParameterSource({ kind: 'EQUIPMENT', sourceId: 'EQ-1', sourceVersion: 1, fields: ['bandwidth'] })).toBe(true)
    expect(isLinkParameterSource({ kind: 'EQUIPMENT', sourceId: 'EQ-1', sourceVersion: 1, fields: ['frequency'] })).toBe(false)
    expect(isLinkParameterSource({ kind: 'MASTER_DATA', sourceId: 'MD-1', sourceVersion: 1, fields: ['coding'], entryKey: 'coding.UNCODED', extra: true })).toBe(false)
  })

  it('按明确字段名和单位复制，跳过未知和错误单位，且不修改输入', () => {
    const original = link()
    const result = prepareLinkMasterData(original, master([
      { key: 'rxBandwidthMHz', valueType: 'NUMBER', value: 5 }, { key: 'noiseFigureDb', valueType: 'NUMBER', value: 3, unit: 'dB' },
      { key: 'rxAntennaGainDbi', valueType: 'NUMBER', value: 8 }, { key: 'unknown', valueType: 'NUMBER', value: 1 },
      { key: 'frequency', valueType: 'NUMBER', value: 2, unit: 'GHz' },
    ]), [])
    expect(result).toMatchObject({ ok: true, fields: ['rxBandwidth', 'noiseFigureDb', 'antennaGain.rx'], link: { bandwidth: 10, txPower: 20, rxBandwidth: 5, noiseFigureDb: 3, antennaGain: { rx: 8 } },
      skipped: [{ key: 'unknown' }, { key: 'frequency' }] })
    expect(original).toMatchObject({ bandwidth: 10, txPower: 20, antennaGain: { rx: 2 } })
  })

  it('只应用用户选择的受控枚举条目，并保持激光调制和光学参数不变', () => {
    const dictionary = { ...master([{ key: 'modulation.QPSK', valueType: 'TEXT', value: 'QPSK' }, { key: 'coding.UNCODED', valueType: 'TEXT', value: 'UNCODED' }]), kind: 'ENUMERATION' }
    expect(prepareLinkMasterData(link(), dictionary, [], 'modulation.QPSK')).toMatchObject({ ok: true, fields: ['modulation'], link: { modulation: 'QPSK' } })
    expect(prepareLinkMasterData(link({ type: 'LASER' }), dictionary, [], 'modulation.QPSK')).toMatchObject({ ok: false, fieldPath: 'content.entries' })
  })

  it('拒绝停用、无内容及会被现有链路约束否决的取值', () => {
    expect(prepareLinkMasterData(link(), { ...master([{ key: 'bandwidthMHz', valueType: 'NUMBER', value: 5 }]), active: false }, [])).toMatchObject({ ok: false, fieldPath: 'active' })
    expect(prepareLinkMasterData(link(), master([{ key: 'noiseFigureDb', valueType: 'NUMBER', value: 101, unit: 'dB' }]), [])).toMatchObject({ ok: false, fieldPath: 'noiseFigureDb' })
    expect(prepareLinkMasterData(link(), master([{ key: 'frequency', valueType: 'TEXT', value: '150' }]), [])).toMatchObject({ ok: false, fieldPath: 'content.entries' })
  })

  it('新引用跳过设备固有字段；仅历史核验可复用旧字典原值', () => {
    const source = master([{ key: 'bandwidthMHz', valueType: 'NUMBER', value: 5 }, { key: 'txPowerW', valueType: 'NUMBER', value: 30 }])
    const original = link()
    expect(prepareLinkMasterData(original, source, [])).toMatchObject({ ok: false,
      skipped: [{ key: 'bandwidthMHz', reason: expect.stringContaining('设备固有参数') }, { key: 'txPowerW', reason: expect.stringContaining('设备固有参数') }] })
    expect(prepareLinkMasterData(original, source, [], undefined, true)).toMatchObject({ ok: true, fields: ['bandwidth', 'txPower'], link: { bandwidth: 5, txPower: 30 } })
    expect(original).toMatchObject({ bandwidth: 10, txPower: 20 })
    expect(prepareLinkMasterData(original, { ...source, content: { ...source.content!, entries: [...source.content!.entries, { key: 'noiseFigureDb', valueType: 'NUMBER', value: 4, unit: 'dB' }] } }, [])).toMatchObject({ ok: true, fields: ['noiseFigureDb'], link: { bandwidth: 10, txPower: 20, noiseFigureDb: 4 } })
  })
})
