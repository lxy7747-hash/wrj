// @vitest-environment node
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { EQUIPMENT } from '../fixtures/equipment'
import { isAccessControlConfig, isRoleProfile, validMenuPaths } from '../../src/features/admin/access-control'
import { equipmentIssue } from '../../src/features/admin/equipment-contract'
const { loadContractDocuments } = await import('../../scripts/contracts/contract-' + 'documents.js')
const ajv = new Ajv2020({ strict: false })
addFormats(ajv)
ajv.addSchema(loadContractDocuments().openApi, 'capabilities')
const equipment = ajv.compile({ $ref: 'capabilities#/components/schemas/EquipmentParameter' })
const profile = ajv.compile({ $ref: 'capabilities#/components/schemas/RoleProfile' })
const profileWrite = ajv.compile({ $ref: 'capabilities#/components/schemas/RoleProfileWrite' })
const accessControl = ajv.compile({ $ref: 'capabilities#/components/schemas/AccessControlConfig' })
const accessControlWrite = ajv.compile({ $ref: 'capabilities#/components/schemas/AccessControlConfigWrite' })
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
    const retiredOperator = { ...operator, menuPaths: [] }
    expect(profile(retiredOperator)).toBe(true)
    expect(profileWrite(retiredOperator)).toBe(false)
    expect(isRoleProfile(retiredOperator, 'read')).toBe(true)
    expect(isRoleProfile(retiredOperator)).toBe(false)
    const retiredConfig = { version: 1, profiles: [retiredOperator], assignments: [] }
    expect(accessControl(retiredConfig)).toBe(true)
    expect(accessControlWrite(retiredConfig)).toBe(false)
    expect(isAccessControlConfig(retiredConfig, 'read')).toBe(true)
    expect(isAccessControlConfig(retiredConfig)).toBe(false)
  })
  it('退休菜单的读取兼容不放宽角色身份、权限或账号分配边界', () => {
    const operator = { profileId: 'READ', name: '只读', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: [] }
    const config = { version: 1, profiles: [operator], assignments: [{ userId: 'USER-1', profileId: 'READ' }] }
    expect(isAccessControlConfig(config, 'read')).toBe(true)
    for (const change of [
      { profileId: '' }, { name: '' }, { name: '字'.repeat(65) }, { baseRole: ['OPERATOR'] },
      { permissions: 'BUSINESS_READ' }, { permissions: ['BUSINESS_READ', 'BATCH_LEVEL_III_EXPORT'] },
      { permissions: ['BUSINESS_READ', 'BUSINESS_READ'] }, { permissions: [] },
      { menuPaths: '/situation' }, { menuPaths: ['/batches'] }, { menuPaths: ['/situation', '/situation'] },
      { baseRole: 'ADMIN', permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'] }, { other: true },
    ]) expect(isAccessControlConfig({ ...config, profiles: [{ ...operator, ...change }] }, 'read'), JSON.stringify(change)).toBe(false)
    for (const value of [
      null, [], { ...config, version: 0 }, { ...config, version: 1.5 },
      { ...config, profiles: {} }, { ...config, profiles: Array(101).fill(operator) },
      { ...config, profiles: [operator, operator] }, { ...config, assignments: {} },
      { ...config, assignments: Array(1001).fill(config.assignments[0]) },
      { ...config, assignments: [null] },
      { ...config, assignments: [{ userId: '', profileId: 'READ' }] },
      { ...config, assignments: [{ userId: 'USER-1', profileId: 'UNKNOWN' }] },
      { ...config, assignments: [config.assignments[0], config.assignments[0]] },
    ]) expect(isAccessControlConfig(value, 'read'), JSON.stringify(value)).toBe(false)
    expect(validMenuPaths([])).toBe(false)
    expect(validMenuPaths([], true)).toBe(true)
    expect(validMenuPaths(['/batches'], true)).toBe(false)
    expect(validMenuPaths([42], true)).toBe(false)
  })
})
