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

    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('rejects a duplicate substituted for a capability state', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    const states = candidate.metadata.capabilities[0].states as CapabilityState[]
    states[5] = 'LOADING'

    expect(auditFixtureClosure(candidate).map(({ code }) => code))
      .toContain('FIXTURE_METADATA_CONTRACT')
  })

  it('accepts a pure reorder of the complete capability state set', () => {
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    const states = candidate.metadata.capabilities[0].states as CapabilityState[]
    states.reverse()

    expect(auditFixtureClosure(candidate)).toEqual([])
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
})
