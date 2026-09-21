import { describe, expect, it } from 'vitest'
import { isMasterData, isMasterWrite, isMasterContent, isMasterEntry, isMasterReference, isMasterDetails, isMasterTarget } from '../../src/features/admin/admin-contract'

const record = { dataId: 'DICT-1', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true,
  content: { name: '参数字典', description: '', entries: [{ key: 'mode', valueType: 'TEXT', value: 'standard' }] } }
const reference = { dataId: record.dataId, dataVersion: 1, targetType: 'SCENARIO', targetId: 'SCN-1', targetVersion: '2' }

describe('主数据内容与引用的共享信任边界', () => {
  it('保留旧元数据只读兼容，新写不接受空内容、设备副本或非法类型', () => {
    const { content, ...legacy } = record
    expect(isMasterData(legacy)).toBe(true)
    expect(isMasterWrite(legacy)).toBe(false)
    expect(isMasterWrite(record)).toBe(true)
    for (const kind of ['COMMUNICATION_SYSTEM', 'ENUMERATION']) expect(isMasterWrite({ ...record, kind })).toBe(true)
    for (const patch of [{ kind: 'DEVICE' }, { kind: 'OTHER' }, { content: null }, { content: { ...content, name: '' } },
      { dataId: '.' }, { dataId: '..' }, { version: 0 }, { referenceCount: -1 }, { active: 1 }, { extra: true }]) {
      expect(isMasterWrite({ ...record, ...patch })).toBe(false)
    }
  })

  it('文本、数值及布尔值严格区分；数值范围包含边界与零', () => {
    for (const value of [0, 10]) expect(isMasterEntry({ key: 'range', valueType: 'NUMBER', value, unit: 'km', minimum: 0, maximum: 10 })).toBe(true)
    expect(isMasterEntry({ key: 'flag', valueType: 'BOOLEAN', value: false })).toBe(true)
    expect(isMasterEntry(record.content.entries[0])).toBe(true)
    for (const value of [null, {}, [], { key: '', valueType: 'TEXT', value: 'a' }, { key: '1bad', valueType: 'TEXT', value: 'a' },
      { key: 'a', valueType: 'TEXT', value: ' ' }, { key: 'a', valueType: 'TEXT', value: 'a'.repeat(1001) },
      { key: 'a', valueType: 'TEXT', value: 'a', unit: 'm' }, { key: 'a', valueType: 'BOOLEAN', value: 'false' },
      { key: 'a', valueType: 'BOOLEAN', value: false, minimum: 0 }, { key: 'a', valueType: 'UNKNOWN', value: 1 }]) expect(isMasterEntry(value)).toBe(false)
    const numeric = { key: 'rate', valueType: 'NUMBER', value: 0 }
    expect(isMasterEntry(numeric)).toBe(true)
    for (const patch of [{ value: NaN }, { value: Infinity }, { value: '0' }, { unit: 1 }, { unit: 'a'.repeat(25) },
      { minimum: 1 }, { maximum: -1 }, { minimum: NaN }, { maximum: Infinity }, { minimum: '0' }, { maximum: '1' }]) {
      expect(isMasterEntry({ ...numeric, ...patch })).toBe(false)
    }
  })

  it('内容拒绝重名键及非法枚举；不丢弃未知字段', () => {
    const content = record.content
    for (const patch of [{ name: 'a'.repeat(81) }, { description: 'a'.repeat(1001) }, { description: null }, { entries: [] },
      { entries: [content.entries[0], content.entries[0]] }, { entries: Array(101).fill(content.entries[0]) }, { extra: true }]) expect(isMasterContent({ ...content, ...patch })).toBe(false)
    expect(isMasterWrite({ ...record, kind: 'ENUMERATION', content: { ...content, entries: [{ key: 'one', valueType: 'NUMBER', value: 1 }] } })).toBe(false)
    expect(isMasterWrite({ ...record, kind: 'ENUMERATION', content: { ...content, entries: [...content.entries, { ...content.entries[0], key: 'two' }] } })).toBe(false)
  })

  it('引用与实际历史闭合，拒绝重复、乱序、异编号或未知版本', () => {
    expect(isMasterReference(reference)).toBe(true)
    for (const patch of [{ dataId: '.' }, { dataId: '..' }, { dataVersion: 0 }, { dataVersion: 1.5 }, { targetType: 'RUN' }, { targetId: '' }, { targetVersion: '' }, { extra: true }]) expect(isMasterReference({ ...reference, ...patch })).toBe(false)
    const target = { targetType: 'TEMPLATE', targetId: 'TPL-1', targetVersion: '1.0', name: '模板' }
    expect(isMasterTarget(target)).toBe(true)
    for (const patch of [{ targetType: 'RUN' }, { targetId: '' }, { name: '' }, { targetVersion: '' }, { extra: true }]) expect(isMasterTarget({ ...target, ...patch })).toBe(false)
    const details = { dataId: record.dataId, history: [{ ...record, version: 2 }, record], references: [reference] }
    expect(isMasterDetails(details)).toBe(true)
    for (const patch of [{ history: [record, record] }, { history: [record, { ...record, version: 2 }] },
      { history: [{ ...record, dataId: 'OTHER' }] }, { history: [] }, { references: [reference, reference] },
      { references: [{ ...reference, dataId: 'OTHER' }] }, { references: [{ ...reference, dataVersion: 3 }] },
      { references: null }, { history: [null] }, { dataId: '' }, { dataId: '.' }, { dataId: '..' }, { extra: true }]) expect(isMasterDetails({ ...details, ...patch })).toBe(false)
  })
})
