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
  it('keeps legacy laser reads compatible while requiring complete optical parameters for enabled writes', () => {
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
    expect(write(legacy)).toBe(false)
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
    expect(write({ ...complete, laser: [] })).toBe(false)
    expect(write({ ...complete, laser: {} })).toBe(false)
    for (const field of ['txApertureDiameterM', 'rxApertureDiameterM', 'pulseWidthS'] as const) {
      expect(write({ ...complete, laser: { ...complete.laser, [field]: -1 } })).toBe(false)
    }
    expect(write({ ...complete, laser: { ...complete.laser, unexpected: true } })).toBe(false)
    expect(write({ ...complete, laser: { ...complete.laser, modulation: 'BPSK' } })).toBe(false)
  })
})
