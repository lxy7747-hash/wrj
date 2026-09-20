// @vitest-environment node
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { EQUIPMENT } from '../fixtures/equipment'
import { isEquipmentParameter } from '../../src/features/admin/equipment-contract'
const modulePath = '../../scripts/contracts/contract-' + 'documents.js'
const { loadContractDocuments } = await import(modulePath)
const { openApi } = loadContractDocuments()
const validate = new Ajv2020({ strict: false }).compile(openApi.components.schemas.EquipmentParameter)

describe('装备参数合同与运行时边界', () => {
  it('有效参数、未配置值和 BER 边界一致', () => {
    for (const data of [EQUIPMENT, { ...EQUIPMENT, berThreshold: 0 }, { ...EQUIPMENT, berThreshold: 1 },
      { ...EQUIPMENT, frequencyMinMHz: null, frequencyMaxMHz: null, modulation: null, berThreshold: null }]) {
      expect(validate(data)).toBe(true)
      expect(isEquipmentParameter(data)).toBe(true)
    }
    const ajv = new Ajv2020({ strict: false })
    ajv.addSchema(openApi, 'equipment-contract')
    const create = ajv.compile({ $ref: 'equipment-contract#/components/schemas/EquipmentCreateRequest' })
    const update = ajv.compile({ $ref: 'equipment-contract#/components/schemas/EquipmentUpdateRequest' })
    expect(create(EQUIPMENT)).toBe(true)
    expect(create({ ...EQUIPMENT, version: 2 })).toBe(false)
    expect(create({ ...EQUIPMENT, readOnly: true })).toBe(false)
    expect(update({ ...EQUIPMENT, version: 2 })).toBe(true)
    expect(update({ ...EQUIPMENT, readOnly: true })).toBe(false)
    expect(validate({ ...EQUIPMENT, readOnly: true })).toBe(true)
  })
  it.each([{ equipmentId: '..' }, { type: '' }, { frequencyMinMHz: 0 }, { frequencyMaxMHz: -1 },
    { modulation: ['QPSK'] }, { modulation: ' ' }, { berThreshold: 1.1 }, { berThreshold: -1 },
    { version: 1.5 }, { readOnly: 'false' }, { extra: true }])('拒绝非法数据 %j', change => {
    const data = { ...EQUIPMENT, ...change }
    expect(validate(data)).toBe(false)
    expect(isEquipmentParameter(data)).toBe(false)
  })
})
