// @vitest-environment node
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { EQUIPMENT } from '../fixtures/equipment'
import { isRoleProfile } from '../../src/features/admin/access-control'
import { equipmentIssue } from '../../src/features/admin/equipment-contract'
const { loadContractDocuments } = await import('../../scripts/contracts/contract-' + 'documents.js')
const ajv = new Ajv2020({ strict: false })
addFormats(ajv)
ajv.addSchema(loadContractDocuments().openApi, 'capabilities')
const equipment = ajv.compile({ $ref: 'capabilities#/components/schemas/EquipmentParameter' })
const profile = ajv.compile({ $ref: 'capabilities#/components/schemas/RoleProfile' })
describe('前端能力增量合同兼容', () => {
  it('旧装备、完整可选参数及零功率合法；数值和闭合边界一致', () => {
    for (const value of [EQUIPMENT, { ...EQUIPMENT, bandwidthMHz: 0.1, dataRateMbps: 0.1, txPowerW: 0 }, { ...EQUIPMENT, bandwidthMHz: null }]) {
      expect(equipment(value)).toBe(true)
      expect(equipmentIssue(value)).toBeNull()
    }
    for (const change of [{ bandwidthMHz: 0 }, { dataRateMbps: -1 }, { txPowerW: -1 }, { txPowerW: '0' }, { other: true }]) {
      expect(equipment({ ...EQUIPMENT, ...change })).toBe(false)
      expect(equipmentIssue({ ...EQUIPMENT, ...change })).not.toBeNull()
    }
  })
  it('角色权限与菜单仅收窄，管理员保留治理入口，未知与重复值被拒绝', () => {
    const operator = { profileId: 'R', name: '只读', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] }
    expect(profile(operator)).toBe(true)
    for (const change of [{ permissions: ['BUSINESS_READ', 'AUDIT_READ'] }, { permissions: ['BUSINESS_READ', 'BUSINESS_READ'] }, { menuPaths: ['/admin'] }, { menuPaths: ['/missing'] }, { menuPaths: ['/situation', '/situation'] }, { baseRole: 'ADMIN' }]) {
      expect(profile({ ...operator, ...change })).toBe(false)
      expect(isRoleProfile({ ...operator, ...change })).toBe(false)
    }
    expect(profile({ ...operator, baseRole: 'ADMIN', permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'], menuPaths: ['/admin'] })).toBe(true)
  })
})
