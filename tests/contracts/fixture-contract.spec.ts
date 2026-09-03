import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ValidateFunction } from 'ajv'

import type { CapabilityState, DeterministicFixtureSet } from '../../src/contracts/domain-models.js'

type JsonObject = Record<string, unknown>
type ValidationFinding = { code: string; path: string; message: string }

let auditFixtureClosure: (fixtures: DeterministicFixtureSet) => ValidationFinding[]
let loadContractDocuments: () => { openApi: unknown; fixtures: unknown }
let buildDeterministicFixtureSchema: (openApi: unknown) => object

function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected object in contract test')
  }
  return value as JsonObject
}

describe('deterministic fixture contract', () => {
  let openApi: unknown
  let fixtures: unknown
  let validateFixture: ValidateFunction

  beforeAll(async () => {
    // Runtime loading keeps Node-only validation code outside the browser-oriented app TS project.
    const contractModulePath = '../../scripts/contracts/contract-' + 'documents.js'
    const fixtureSchemaModulePath = '../../scripts/contracts/fixture-' + 'schema.js'
    const contractModule = await import(contractModulePath) as {
      auditFixtureClosure: typeof auditFixtureClosure
      loadContractDocuments: typeof loadContractDocuments
    }
    const fixtureSchemaModule = await import(fixtureSchemaModulePath) as {
      buildDeterministicFixtureSchema: typeof buildDeterministicFixtureSchema
    }
    ;({ auditFixtureClosure, loadContractDocuments } = contractModule)
    ;({ buildDeterministicFixtureSchema } = fixtureSchemaModule)
    ;({ openApi, fixtures } = loadContractDocuments())
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    addFormats(ajv)
    validateFixture = ajv.compile(buildDeterministicFixtureSchema(openApi))
  })

  it('validates the entire authoritative fixture and its semantic closure', () => {
    expect(validateFixture(fixtures), JSON.stringify(validateFixture.errors)).toBe(true)
    expect(auditFixtureClosure(fixtures as DeterministicFixtureSet)).toEqual([])
  })

  it('keeps Taiwan-frame telemetry aligned with scenario positions and waypoint deltas', () => {
    const fixture = fixtures as DeterministicFixtureSet
    const expectedCoreCoordinates = {
      'CMD-01': { longitude: 118.15, latitude: 24.45 },
      'UAV-01': { longitude: 119.35, latitude: 24.70 },
      'GCC-01': { longitude: 118.65, latitude: 23.55 },
      'AIR-01': { longitude: 120.15, latitude: 23.95 },
      'SAT-01': { longitude: 121.25, latitude: 25.75 },
      'STN-01': { longitude: 119.55, latitude: 25.25 },
    }
    const frameCoordinates = Object.fromEntries(fixture.frame.platforms.map((platform) => [
      platform.platformId,
      { longitude: platform.longitude, latitude: platform.latitude },
    ]))
    const scenarioCoordinates = Object.fromEntries(fixture.scenario.platforms.map((platform) => [
      platform.id,
      {
        longitude: platform.initialPosition.longitude,
        latitude: platform.initialPosition.latitude,
      },
    ]))

    expect(fixture.fixtureVersion).toBe('2026-09-03.4')
    expect(frameCoordinates).toEqual(scenarioCoordinates)
    Object.entries(expectedCoreCoordinates).forEach(([platformId, coordinates]) => {
      expect(frameCoordinates[platformId]).toEqual(coordinates)
    })

    const businessTypes = new Set([
      'REAR_COMMAND_NODE', 'FORWARD_RELAY_NODE', 'GROUND_CLUSTER_COMMAND_NODE', 'AIRBORNE_MISSION_CLUSTER',
    ])
    const businessPlatforms = fixture.scenario.platforms.filter(({ type }) => businessTypes.has(type))
    const airbornePlatforms = businessPlatforms.filter(({ type }) => type === 'AIRBORNE_MISSION_CLUSTER')
    expect(businessPlatforms).toHaveLength(6)
    expect(airbornePlatforms.map(({ id }) => id)).toEqual(['AIR-01', 'AIR-02', 'AIR-03'])
    expect(fixture.scenario.jammers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'JAM-WB-01-TX', platformId: 'STN-01' }),
      expect.objectContaining({ id: 'JAM-SPOT-01-TX', platformId: 'AIR-03' }),
    ]))

    const uav = fixture.scenario.platforms.find(({ id }) => id === 'UAV-01')
    const air = fixture.scenario.platforms.find(({ id }) => id === 'AIR-01')
    if (!uav?.waypoints[0] || !air?.waypoints[0]) {
      throw new Error('Expected UAV-01 and AIR-01 deterministic waypoints')
    }
    expect(uav.waypoints[0].longitude - uav.initialPosition.longitude).toBeCloseTo(0.20)
    expect(uav.waypoints[0].latitude - uav.initialPosition.latitude).toBeCloseTo(0.10)
    expect(air.waypoints[0].longitude - air.initialPosition.longitude).toBeCloseTo(0.18)
    expect(air.waypoints[0].latitude - air.initialPosition.latitude).toBeCloseTo(0.08)
  })

  it('converts only local component-schema references without mutating OpenAPI', () => {
    const sourceSnapshot = structuredClone(openApi)
    const schema = asObject(buildDeterministicFixtureSchema(openApi))

    expect(schema.$ref).toBe('#/$defs/DeterministicFixtures')
    expect(asObject(asObject(schema.$defs).DeterministicFixtures)['x-type-contract'])
      .toBe('domain-models.ts#DeterministicFixtureSet')
    expect(openApi).toEqual(sourceSnapshot)
  })

  it('rejects a fixture missing a required field', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    delete (candidate.scenario.scenario as Partial<typeof candidate.scenario.scenario>).name

    expect(validateFixture(candidate)).toBe(false)
    expect(validateFixture.errors?.some(({ keyword }) => keyword === 'required')).toBe(true)
  })

  it('keeps the degraded link state decision evidence closed', () => {
    const fixture = fixtures as DeterministicFixtureSet
    const degraded = fixture.frame.uiLinks.find(({ linkId }) => linkId === 'L-DL-03')

    expect(degraded).toMatchObject({
      frameId: 'F-00042',
      status: 'DEGRADED',
      canonicalStatus: 'DOWN',
      reason: 'BER_THRESHOLD_AND_HYSTERESIS',
      thresholdVersion: 'LLZT-1.0',
      consecutiveFrames: 3,
    })
  })

  it('rejects an unknown schemaVersion', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    ;(candidate as { schemaVersion: string }).schemaVersion = '2.0'

    expect(validateFixture(candidate)).toBe(false)
    expect(validateFixture.errors?.some(({ keyword }) => keyword === 'const')).toBe(true)
  })

  it('rejects an orphan fixture reference', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    candidate.frame.links[0].linkId = 'L-ORPHAN'

    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_ORPHAN_REFERENCE')
  })

  it('rejects an orphan template scenario reference', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    candidate.templates[0].scenarioId = 'SCN-ORPHAN'

    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_ORPHAN_REFERENCE')
  })

  it('rejects a forged capability metadata ID', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    candidate.metadata.capabilities[0].id = 'DSDWRJQTLJS-XQ-FORGED'

    expect(auditFixtureClosure(candidate).map(({ code }) => code)).toContain('FIXTURE_METADATA_SET')
  })

  it('rejects a forged UI route path', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    candidate.metadata.routes[0].path = '/forged'

    expect(auditFixtureClosure(candidate).map(({ code }) => code)).toContain('FIXTURE_METADATA_SET')
  })

  it('rejects a changed capability destination', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    candidate.metadata.capabilities[0].destination = 'cap-forged'

    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('rejects a changed interface destination', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    candidate.metadata.interfaces[0].destination = 'de-if-forged'

    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('rejects a changed route page', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    candidate.metadata.routes[0].page = 'ForgedPage'

    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('rejects changed route store order', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    const stores = candidate.metadata.routes[0].stores
    ;[stores[0], stores[1]] = [stores[1], stores[0]]

    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('rejects a changed route guard', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    candidate.metadata.routes[0].guard = 'requirePrincipal'

    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('rejects a missing capability state', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    const states = candidate.metadata.capabilities[0].states as CapabilityState[]
    states.pop()

    expect(validateFixture(candidate)).toBe(false)
    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('rejects a duplicate substituted for a capability state', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    const states = candidate.metadata.capabilities[0].states as CapabilityState[]
    states[5] = 'LOADING'

    expect(validateFixture(candidate)).toBe(false)
    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('accepts a pure reorder of the complete capability state set', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    const states = candidate.metadata.capabilities[0].states as CapabilityState[]
    states.reverse()

    expect(validateFixture(candidate), JSON.stringify(validateFixture.errors)).toBe(true)
    expect(auditFixtureClosure(candidate)).toEqual([])
  })

  it('freezes the fixed composite-loss evidence card without an EXECUTING state', () => {
    const fixture = fixtures as DeterministicFixtureSet
    const capability = fixture.metadata.capabilities.find(({ id }) => (
      id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-FHSX'
    ))

    expect(capability?.states).toEqual(['LOADING', 'VALIDATING', 'SUCCESS', 'EMPTY', 'ERROR'])
    expect(validateFixture(fixture), JSON.stringify(validateFixture.errors)).toBe(true)

    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    const candidateCapability = candidate.metadata.capabilities.find(({ id }) => (
      id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-FHSX'
    ))
    if (candidateCapability === undefined) throw new Error('测试夹具缺少 T-XQ-011 capability metadata')
    ;(candidateCapability.states as CapabilityState[]).push('EXECUTING')
    expect(validateFixture(candidate)).toBe(false)
    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('freezes the five-state SNR/BER fixture inputs, outputs, and model mapping', () => {
    const fixture = fixtures as DeterministicFixtureSet
    const capability = fixture.metadata.capabilities.find(({ id }) => (
      id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-SNBER'
    ))
    const link = fixture.frame.links.find(({ linkId }) => linkId === 'L-MW-01')
    const loss = fixture.frame.evidence.losses.find(({ linkId }) => linkId === 'L-MW-01')

    expect(capability?.states).toEqual(['LOADING', 'VALIDATING', 'SUCCESS', 'EMPTY', 'ERROR'])
    expect(link).toMatchObject({
      receivedPower: -84, bandwidth: 20, modulation: 'QPSK', coding: 'UNCODED',
      qualityModelVersion: 'SNBER-1.2', snr: 18.62, ber: 3.2e-7,
    })
    expect(loss?.noisePowerDbm).toBe(-104)
    expect(validateFixture(fixture), JSON.stringify(validateFixture.errors)).toBe(true)

    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    const candidateCapability = candidate.metadata.capabilities.find(({ id }) => (
      id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-SNBER'
    ))
    if (candidateCapability === undefined) throw new Error('测试夹具缺少 T-XQ-012 capability metadata')
    ;(candidateCapability.states as CapabilityState[]).push('EXECUTING')
    expect(validateFixture(candidate)).toBe(false)
    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('freezes T-XQ-013 as fixed evidence without an EXECUTING state', () => {
    const fixture = fixtures as DeterministicFixtureSet
    const capability = fixture.metadata.capabilities.find(({ id }) => (
      id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-LLZT'
    ))

    expect(capability?.states).toEqual(['LOADING', 'VALIDATING', 'SUCCESS', 'EMPTY', 'ERROR'])
    expect(validateFixture(fixture), JSON.stringify(validateFixture.errors)).toBe(true)

    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    const candidateCapability = candidate.metadata.capabilities.find(({ id }) => (
      id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-LLZT'
    ))
    if (candidateCapability === undefined) throw new Error('测试夹具缺少 T-XQ-013 capability metadata')
    ;(candidateCapability.states as CapabilityState[]).push('EXECUTING')
    expect(validateFixture(candidate)).toBe(false)
    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('rejects a changed canonical CSV field order', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    const fields = candidate.contracts.csv[0].fields
    ;[fields[0], fields[1]] = [fields[1], fields[0]]

    expect(auditFixtureClosure(candidate).map(({ code }) => code)).toContain('FIXTURE_CSV_ORDER')
  })

  it('rejects altered time-42 evidence', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    candidate.frame.evidence.synchronization.effectiveSimulationTime = 43

    expect(auditFixtureClosure(candidate).map(({ code }) => code)).toContain('FIXTURE_TIME_42')
  })

  it.each([
    ['空阈值版本', 'thresholdVersion', ''],
    ['未知阈值版本', 'thresholdVersion', 'LLZT-2.0'],
    ['空判定原因', 'reason', ''],
    ['负稳定帧数', 'consecutiveFrames', -1],
    ['小数稳定帧数', 'consecutiveFrames', 1.5],
    ['负数据年龄', 'ageMs', -1],
  ])('OpenAPI 拒绝 UiLinkProjection 的%s', (_label, field, value) => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    Reflect.set(candidate.frame.uiLinks[0]!, field, value)

    expect(validateFixture(candidate)).toBe(false)
  })
})
