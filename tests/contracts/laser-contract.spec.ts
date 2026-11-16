import Ajv2020 from 'ajv/dist/2020.js'
import { beforeAll, describe, expect, it } from 'vitest'

type JsonObject = Record<string, unknown>

let loadContractDocuments: () => { openApi: unknown }

beforeAll(async () => {
  const modulePath = '../../scripts/contracts/contract-' + 'documents.js'
  const contractModule = await import(modulePath) as { loadContractDocuments: typeof loadContractDocuments }
  ;({ loadContractDocuments } = contractModule)
})

function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected OpenAPI object')
  }
  return value as JsonObject
}

function laserLink(): JsonObject {
  return {
    id: 'L-LASER-CONTRACT',
    type: 'LASER',
    sourcePlatformId: 'SOURCE',
    targetPlatformId: 'TARGET',
    frequency: 193500000,
    bandwidth: 1000,
    txPower: 20,
    antennaGain: { tx: 30, rx: 30 },
    // This legacy transport field deliberately remains independent from laser.modulation.
    modulation: 'QPSK',
    berThreshold: 0.000001,
    dataRate: 100,
    direction: 'FORWARD',
  }
}

describe('laser link contract', () => {
  it('keeps legacy laser reads and now allows enabled laser writes without an optical block', () => {
    const { openApi } = loadContractDocuments()
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    ajv.addSchema({ $id: 'laser-contract', components: asObject(openApi).components })
    const read = ajv.compile({ $ref: 'laser-contract#/components/schemas/Link' })
    const write = ajv.compile({ $ref: 'laser-contract#/components/schemas/LinkWrite' })
    const legacy = laserLink()
    const complete = {
      ...legacy,
      laser: {
        txApertureDiameterM: 0.1,
        rxApertureDiameterM: 0.1,
        pulseWidthS: 0.00000001,
        modulation: 'OOK',
      },
    }

    expect(read(legacy)).toBe(true)
    // 采用 lazer_link 参数集后，激光写入不再强制光学块；光学块为可选扩展。
    expect(write(legacy)).toBe(true)
    expect(write(complete)).toBe(true)
    expect(write({ ...legacy, enabled: false })).toBe(true)
  })

  it('rejects invalid optical parameter shapes and non-laser carriers', () => {
    const { openApi } = loadContractDocuments()
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    ajv.addSchema({ $id: 'laser-contract-negative', components: asObject(openApi).components })
    const read = ajv.compile({ $ref: 'laser-contract-negative#/components/schemas/Link' })
    const write = ajv.compile({ $ref: 'laser-contract-negative#/components/schemas/LinkWrite' })
    const complete = {
      ...laserLink(),
      laser: {
        txApertureDiameterM: 0.1,
        rxApertureDiameterM: 0.1,
        pulseWidthS: 0.00000001,
        modulation: 'OOK',
      },
    }

    expect(read({ ...laserLink(), type: 'MICROWAVE', laser: complete.laser })).toBe(false)
    // 光学块若存在仍按形状/范围/OOK 严格校验，非激光载体仍拒绝携带光学块。
    expect(write({ ...laserLink(), type: 'MICROWAVE', laser: complete.laser })).toBe(false)
    expect(write({ ...complete, laser: [] })).toBe(false)
    expect(write({ ...complete, laser: {} })).toBe(false)
    for (const field of ['txApertureDiameterM', 'rxApertureDiameterM', 'pulseWidthS'] as const) {
      expect(write({ ...complete, laser: { ...complete.laser, [field]: -1 } })).toBe(false)
    }
    expect(write({ ...complete, laser: { ...complete.laser, unexpected: true } })).toBe(false)
    expect(write({ ...complete, laser: { ...complete.laser, modulation: 'BPSK' } })).toBe(false)
  })
})
