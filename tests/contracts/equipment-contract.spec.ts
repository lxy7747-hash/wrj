// @vitest-environment node
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { EQUIPMENT } from '../fixtures/equipment'
import { equipmentIssue, isEquipmentActive, isEquipmentParameter } from '../../src/features/admin/equipment-contract'
const modulePath = '../../scripts/contracts/contract-' + 'documents.js'
const { loadContractDocuments } = await import(modulePath)
const { openApi } = loadContractDocuments()
const validate = new Ajv2020({ strict: false }).compile(openApi.components.schemas.EquipmentParameter)

describe('装备参数合同与运行时边界', () => {
  it('有效参数、未配置值和 BER 边界一致', () => {
    const { active: _active, ...legacy } = EQUIPMENT
    for (const data of [EQUIPMENT, { ...EQUIPMENT, active: false }, legacy, { ...EQUIPMENT, berThreshold: 0 }, { ...EQUIPMENT, berThreshold: 1 },
      { ...EQUIPMENT, frequencyMinMHz: null, frequencyMaxMHz: null, modulation: null, berThreshold: null }]) {
      expect(validate(data)).toBe(true)
      expect(isEquipmentParameter(data)).toBe(true)
    }
    expect(isEquipmentActive(legacy as { active?: boolean })).toBe(true)
    expect(isEquipmentActive({ ...EQUIPMENT, active: false })).toBe(false)
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

    const satellite = { ...EQUIPMENT, equipmentId: 'SAT-1', type: '卫星通信设备', frequencyMinMHz: 12000, frequencyMaxMHz: 12000,
      modulation: 'QPSK', txPowerW: 1000, dataRateMbps: 16 }
    const microwave = { ...EQUIPMENT, equipmentId: 'MW-1', type: '微波通信设备', modulation: 'BPSK', txPowerW: 100, dataRateMbps: 80 }
    const datalink = { ...EQUIPMENT, equipmentId: 'DL-1', type: '数传通信设备', modulation: 'QPSK', txPowerW: 100, dataRateMbps: 0.0064 }
    const laser = { ...EQUIPMENT, equipmentId: 'LASER-1', type: '激光通信设备', frequencyMinMHz: null, frequencyMaxMHz: null,
      modulation: 'OOK', txPowerW: 1, dataRateMbps: null }
    const fiber = { ...EQUIPMENT, equipmentId: 'FIBER-1', type: '光纤通信设备', modulation: 'BPSK', txPowerW: 100, dataRateMbps: 10 }
    for (const record of [satellite, microwave, datalink, laser, fiber]) {
      expect(create(record)).toBe(true)
      expect(update({ ...record, version: 2 })).toBe(true)
      expect(equipmentIssue(record, 'write')).toBeNull()
    }
  })

  it.each([
    [{ type: '卫星通信设备', txPowerW: 1001 }, 'txPowerW'],
    [{ type: '卫星通信设备', dataRateMbps: 80 }, 'dataRateMbps'],
    [{ type: '微波通信设备', txPowerW: 101 }, 'txPowerW'],
    [{ type: '微波通信设备', dataRateMbps: 2 }, 'dataRateMbps'],
    [{ type: '数传通信设备', dataRateMbps: 1 }, 'dataRateMbps'],
    [{ type: '激光通信设备', modulation: 'QPSK', txPowerW: 1 }, 'modulation'],
    [{ type: '激光通信设备', frequencyMinMHz: null, frequencyMaxMHz: null, modulation: 'OOK', txPowerW: 0 }, 'txPowerW'],
    [{ type: '光纤通信设备', dataRateMbps: 9 }, 'dataRateMbps'],
  ])('写入合同与运行时共同拒绝类型条件 %j', (change, fieldPath) => {
    const ajv = new Ajv2020({ strict: false })
    ajv.addSchema(openApi, 'equipment-contract')
    const create = ajv.compile({ $ref: 'equipment-contract#/components/schemas/EquipmentCreateRequest' })
    const update = ajv.compile({ $ref: 'equipment-contract#/components/schemas/EquipmentUpdateRequest' })
    const record = { ...EQUIPMENT, ...change }
    expect(validate(record)).toBe(true)
    expect(create(record)).toBe(false)
    expect(update({ ...record, version: 2 })).toBe(false)
    expect(equipmentIssue(record, 'write')).toMatchObject({ fieldPath })
  })

  it('读取模型仍兼容未知历史类型，写入合同不推断其链路类别', () => {
    const legacy = { ...EQUIPMENT, type: '历史通信设备', modulation: 'OOK', txPowerW: 500, dataRateMbps: 9999 }
    const ajv = new Ajv2020({ strict: false })
    ajv.addSchema(openApi, 'equipment-contract')
    const create = ajv.compile({ $ref: 'equipment-contract#/components/schemas/EquipmentCreateRequest' })
    expect(validate(legacy)).toBe(true)
    expect(create(legacy)).toBe(true)
    expect(isEquipmentParameter(legacy)).toBe(true)
    expect(equipmentIssue(legacy, 'write')).toBeNull()
  })
  it.each([{ equipmentId: '..' }, { type: '' }, { frequencyMinMHz: 0 }, { frequencyMaxMHz: -1 },
    { modulation: ['QPSK'] }, { modulation: ' ' }, { berThreshold: 1.1 }, { berThreshold: -1 },
    { version: 1.5 }, { readOnly: 'false' }, { active: 'false' }, { extra: true }])('拒绝非法数据 %j', change => {
    const data = { ...EQUIPMENT, ...change }
    expect(validate(data)).toBe(false)
    expect(isEquipmentParameter(data)).toBe(false)
  })
})
