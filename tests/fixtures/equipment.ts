import type { EquipmentParameter } from '../../src/contracts/domain-models'

// 仅用于临时库与 HTTP 测试，不作为正式参数库种子。
export const EQUIPMENT: EquipmentParameter = {
  equipmentId: 'TEST-RADIO', type: '测试通信设备', frequencyMinMHz: 100,
  frequencyMaxMHz: 200, modulation: 'QPSK', berThreshold: 0.00001, readOnly: false, version: 1,
}
