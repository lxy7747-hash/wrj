import { beforeAll, describe, expect, it } from 'vitest'

type JsonObject = Record<string, unknown>
type ValidationFinding = { code: string; path: string; message: string }

let auditOpenApi: (openApi: unknown) => ValidationFinding[]
let loadContractDocuments: () => { openApi: unknown; fixtures: unknown }

beforeAll(async () => {
  // Runtime loading keeps Node-only validation code outside the browser-oriented app TS project.
  const modulePath = '../../scripts/contracts/contract-' + 'documents.js'
  const contractModule = await import(modulePath) as {
    auditOpenApi: typeof auditOpenApi
    loadContractDocuments: typeof loadContractDocuments
  }
  ;({ auditOpenApi, loadContractDocuments } = contractModule)
})

function asObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected object in contract test')
  }
  return value as JsonObject
}

function operationAt(openApi: unknown, route: string, method: string): JsonObject {
  const document = asObject(openApi)
  const paths = asObject(document.paths)
  return asObject(asObject(paths[route])[method])
}

function schemaAt(openApi: unknown, name: string): JsonObject {
  const components = asObject(asObject(openApi).components)
  return asObject(asObject(components.schemas)[name])
}

describe('OpenAPI contract audit', () => {
  it('accepts the authoritative 61-operation contract', () => {
    const { openApi } = loadContractDocuments()

    expect(auditOpenApi(openApi)).toEqual([])

    const paths = asObject(asObject(openApi).paths)
    const operations = Object.values(paths).flatMap((pathValue) => {
      const path = asObject(pathValue)
      return ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']
        .filter((method) => path[method] !== undefined)
        .map((method) => ({ method, operation: asObject(path[method]) }))
    })
    expect(operations).toHaveLength(61)
    expect(operations.filter(({ method }) => ['post', 'put', 'patch'].includes(method))).toHaveLength(30)
    expect(new Set(operations.map(({ operation }) => operation.operationId)).size).toBe(61)
  })

  it('rejects a duplicate operationId', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    operationAt(candidate, '/api/v1/meta/capabilities', 'get').operationId = 'postapiV1AuthLogin'

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_OPERATION_ID')
  })

  it('rejects removal of the explicit DemoRole boundary', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    operationAt(candidate, '/api/v1/meta/capabilities', 'get').parameters = []

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_DEMO_ROLE')
  })

  it('rejects duplicate values disguised as the complete DemoRole enum', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const components = asObject(asObject(candidate).components)
    const demoRole = asObject(asObject(components.parameters).DemoRole)
    asObject(demoRole.schema).enum = ['ADMIN', 'ADMIN']

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_DEMO_ROLE')
  })

  it('rejects duplicate values disguised as the complete error catalog', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    schemaAt(candidate, 'ErrorCode').enum = Array.from({ length: 26 }, () => 'INVALID_REQUEST')

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_ERROR_CATALOG')
  })

  it('rejects duplicate required keys in a success envelope', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    schemaAt(candidate, 'GetapiV1MetaCapabilitiesResponse').required = ['ok', 'ok', 'ok']

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SUCCESS_ENVELOPE')
  })

  it.each(['head', 'options', 'trace'] as const)('counts and audits an added %s operation', (method) => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const paths = asObject(asObject(candidate).paths)
    const capabilitiesPath = asObject(paths['/api/v1/meta/capabilities'])
    capabilitiesPath[method] = {
      parameters: [],
      responses: structuredClone(asObject(capabilitiesPath.get).responses),
    }

    const codes = auditOpenApi(candidate).map(({ code }) => code)
    expect(codes).toContain('OPENAPI_OPERATION_COUNT')
    expect(codes).toContain('OPENAPI_OPERATION_ID')
    expect(codes).toContain('OPENAPI_DEMO_ROLE')
    expect(codes).toContain('OPENAPI_SUCCESS_ENVELOPE')
  })

  it('does not let a REST operation use a 101 response instead of a typed 2xx envelope', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const upgradeResponses = asObject(operationAt(candidate, '/ws/v1', 'get').responses)
    operationAt(candidate, '/api/v1/meta/capabilities', 'get').responses = {
      101: structuredClone(upgradeResponses['101']),
    }

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SUCCESS_ENVELOPE')
  })
})
