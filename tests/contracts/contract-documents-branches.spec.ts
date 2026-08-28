import { beforeAll, describe, expect, it } from 'vitest'

import type { DeterministicFixtureSet } from '../../src/contracts/domain-models.js'

type JsonObject = Record<string, unknown>
type ValidationFinding = { code: string; path: string; message: string }

let auditOpenApi: (openApi: unknown) => ValidationFinding[]
let auditFixtureClosure: (fixtures: DeterministicFixtureSet) => ValidationFinding[]
let loadContractDocuments: () => { openApi: unknown; fixtures: unknown }

beforeAll(async () => {
  // Runtime loading keeps Node-only validation code outside the browser-oriented app TS project.
  const modulePath = '../../scripts/contracts/contract-' + 'documents.js'
  const contractModule = await import(modulePath) as {
    auditOpenApi: typeof auditOpenApi
    auditFixtureClosure: typeof auditFixtureClosure
    loadContractDocuments: typeof loadContractDocuments
  }
  ;({ auditOpenApi, auditFixtureClosure, loadContractDocuments } = contractModule)
})

function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected object in contract test')
  }
  return value as JsonObject
}

function operationAt(openApi: unknown, route: string, method: string): JsonObject {
  const paths = asObject(asObject(openApi).paths)
  return asObject(asObject(paths[route])[method])
}

function expectFinding(findings: ValidationFinding[], code: string, path: string): void {
  expect(findings).toContainEqual(expect.objectContaining({ code, path }))
}

describe('contract document malformed-input audit branches', () => {
  it('rejects a non-object OpenAPI document', () => {
    expectFinding(auditOpenApi(null), 'OPENAPI_DOCUMENT', '$')
  })

  it.each([
    {
      name: 'an unsupported OpenAPI version',
      mutate: (document: unknown) => {
        asObject(document).openapi = '3.0.3'
      },
      finding: { code: 'OPENAPI_VERSION', path: '$.openapi' },
    },
    {
      name: 'a missing components structure',
      mutate: (document: unknown) => {
        delete asObject(document).components
      },
      finding: { code: 'OPENAPI_STRUCTURE', path: '$' },
    },
    {
      name: 'a non-object path entry',
      mutate: (document: unknown) => {
        asObject(asObject(document).paths)['/api/v1/meta/capabilities'] = null
      },
      finding: { code: 'OPENAPI_OPERATION_COUNT', path: '$.paths' },
    },
    {
      name: 'non-array operation parameters',
      mutate: (document: unknown) => {
        operationAt(document, '/api/v1/meta/capabilities', 'get').parameters = {}
      },
      finding: {
        code: 'OPENAPI_DEMO_ROLE',
        path: '$.paths["/api/v1/meta/capabilities"].get.parameters',
      },
    },
    {
      name: 'a path parameter with the wrong location',
      mutate: (document: unknown) => {
        const paths = asObject(asObject(document).paths)
        asObject(paths['/api/v1/scenarios/{scenarioId}']).parameters = [
          { name: 'scenarioId', in: 'query', required: true },
        ]
      },
      finding: {
        code: 'OPENAPI_PATH_PARAMETER',
        path: '$.paths["/api/v1/scenarios/{scenarioId}"].get.parameters',
      },
    },
    {
      name: 'a malformed success response and error envelope',
      mutate: (document: unknown) => {
        operationAt(document, '/api/v1/meta/capabilities', 'get').responses = {
          200: null,
          400: {},
        }
      },
      finding: {
        code: 'OPENAPI_SUCCESS_ENVELOPE',
        path: '$.paths["/api/v1/meta/capabilities"].get.responses["200"]',
      },
    },
    {
      name: 'an unresolved local schema reference',
      mutate: (document: unknown) => {
        const components = asObject(asObject(document).components)
        const schemas = asObject(components.schemas)
        const properties = asObject(asObject(schemas.LoginRequest).properties)
        properties.forged = { $ref: '#/components/schemas/Absent' }
      },
      finding: {
        code: 'OPENAPI_UNRESOLVED_REF',
        path: '$.components.schemas.LoginRequest.properties.forged.$ref',
      },
    },
  ])('reports $name', ({ mutate, finding }) => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    mutate(candidate)

    expectFinding(auditOpenApi(candidate), finding.code, finding.path)
  })

  it.each([
    {
      name: 'duplicate metadata identifiers',
      mutate: (fixtures: DeterministicFixtureSet) => {
        fixtures.metadata.routes[1].path = fixtures.metadata.routes[0].path
      },
      finding: { code: 'FIXTURE_DUPLICATE_ID', path: '$.metadata.routes[].path[1]' },
    },
    {
      name: 'a missing traceability route',
      mutate: (fixtures: DeterministicFixtureSet) => {
        const index = fixtures.metadata.routes.findIndex(({ path }) => path === '/situation')
        fixtures.metadata.routes.splice(index, 1)
      },
      finding: {
        code: 'FIXTURE_CAPABILITY_TRACE',
        path: '$.metadata.capabilities[0].id',
      },
    },
    {
      name: 'a mismatched batch report pair',
      mutate: (fixtures: DeterministicFixtureSet) => {
        fixtures.batchReports[0].runId = 'RUN-ORPHAN'
      },
      finding: { code: 'FIXTURE_BATCH_PAIR', path: '$.batchReports[].runId' },
    },
    {
      name: 'a missing canonical CSV declaration',
      mutate: (fixtures: DeterministicFixtureSet) => {
        fixtures.contracts.csv.pop()
      },
      finding: { code: 'FIXTURE_CSV_ORDER', path: '$.contracts.csv.length' },
    },
  ])('reports $name', ({ mutate, finding }) => {
    const { fixtures } = loadContractDocuments()
    const candidate = structuredClone(fixtures) as DeterministicFixtureSet
    mutate(candidate)

    expectFinding(auditFixtureClosure(candidate), finding.code, finding.path)
  })
})
