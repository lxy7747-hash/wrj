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

function requestSchemaAt(openApi: unknown, route: string, method: string): JsonObject {
  const requestBody = asObject(operationAt(openApi, route, method).requestBody)
  const content = asObject(requestBody.content)
  return asObject(asObject(content['application/json']).schema)
}

function responseSchemaAt(openApi: unknown, route: string, method: string, status: string): JsonObject {
  const responses = asObject(operationAt(openApi, route, method).responses)
  const response = asObject(responses[status])
  const content = asObject(response.content)
  return asObject(asObject(content['application/json']).schema)
}

function schemaPropertyAt(openApi: unknown, name: string, property: string): JsonObject {
  return asObject(asObject(schemaAt(openApi, name).properties)[property])
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

  it('uses the minimal scenario draft update wrapper without server-owned fields', () => {
    const { openApi } = loadContractDocuments()

    expect(requestSchemaAt(openApi, '/api/v1/scenarios/{scenarioId}', 'put')).toEqual({
      $ref: '#/components/schemas/PutapiV1ScenariosScenarioIdRequest',
    })
    expect(schemaAt(openApi, 'PutapiV1ScenariosScenarioIdRequest')).toEqual({
      $ref: '#/components/schemas/ScenarioDraftUpdate',
    })
    expect(schemaAt(openApi, 'ScenarioDraftUpdate')).toMatchObject({
      additionalProperties: false,
      required: ['config', 'uiExtensions'],
      properties: {
        config: { $ref: '#/components/schemas/ScenarioConfig' },
        uiExtensions: { $ref: '#/components/schemas/ScenarioUiExtensions' },
      },
    })
  })

  it('rejects a duplicate operationId', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    operationAt(candidate, '/api/v1/meta/capabilities', 'get').operationId = 'postapiV1AuthLogin'

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_OPERATION_ID')
  })

  it('rejects a unique but non-authoritative operationId', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    operationAt(candidate, '/api/v1/meta/capabilities', 'get').operationId = 'getapiV1MetaCapabilityList'

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_OPERATION_MANIFEST')
  })

  it('rejects a renamed path even when the operation count is unchanged', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const paths = asObject(asObject(candidate).paths)
    paths['/api/v1/meta/capability-list'] = paths['/api/v1/meta/capabilities']
    delete paths['/api/v1/meta/capabilities']

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_OPERATION_MANIFEST')
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

  it('rejects an empty resolved write request schema', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const components = asObject(asObject(candidate).components)
    asObject(components.schemas).PostapiV1AuthLoginRequest = {}

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_WRITE_SCHEMA')
  })

  it('rejects a write request schema alias that resolves to an empty schema', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const components = asObject(asObject(candidate).components)
    const schemas = asObject(components.schemas)
    schemas.EmptyProbe = {}
    schemas.PostapiV1AuthLoginRequest = { $ref: '#/components/schemas/EmptyProbe' }

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_WRITE_SCHEMA')
  })

  it('rejects two valid request wrapper refs swapped between operations', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const loginRequest = requestSchemaAt(candidate, '/api/v1/auth/login', 'post')
    const scenarioRequest = requestSchemaAt(candidate, '/api/v1/scenarios', 'post')
    ;[loginRequest.$ref, scenarioRequest.$ref] = [scenarioRequest.$ref, loginRequest.$ref]

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_WRITE_SCHEMA')
  })

  it('rejects valid request wrapper targets swapped between schemas', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const loginWrapper = schemaAt(candidate, 'PostapiV1AuthLoginRequest')
    const scenarioWrapper = schemaAt(candidate, 'PostapiV1ScenariosRequest')
    ;[loginWrapper.$ref, scenarioWrapper.$ref] = [scenarioWrapper.$ref, loginWrapper.$ref]

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_WRITE_SCHEMA')
  })

  it('rejects a request schema added to a non-write operation', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    operationAt(candidate, '/api/v1/auth/permissions', 'get').requestBody = structuredClone(
      operationAt(candidate, '/api/v1/auth/login', 'post').requestBody,
    )

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_WRITE_SCHEMA')
  })

  it('rejects a non-JSON request body added to a non-write operation', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    operationAt(candidate, '/api/v1/auth/permissions', 'get').requestBody = {
      content: {
        'text/plain': {},
      },
    }

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_WRITE_SCHEMA')
  })

  it('rejects an empty resolved success response data schema', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const components = asObject(asObject(candidate).components)
    asObject(components.schemas).AuthResult = {}

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SUCCESS_ENVELOPE')
  })

  it('rejects a success response data schema alias that resolves to an empty schema', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const components = asObject(asObject(candidate).components)
    const schemas = asObject(components.schemas)
    schemas.EmptyProbe = {}
    schemas.AuthResult = { $ref: '#/components/schemas/EmptyProbe' }

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SUCCESS_ENVELOPE')
  })

  it('rejects two valid success envelope refs swapped between operations', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const loginResponse = responseSchemaAt(candidate, '/api/v1/auth/login', 'post', '200')
    const permissionsResponse = responseSchemaAt(candidate, '/api/v1/auth/permissions', 'get', '200')
    ;[loginResponse.$ref, permissionsResponse.$ref] = [permissionsResponse.$ref, loginResponse.$ref]

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SUCCESS_ENVELOPE')
  })

  it('rejects a changed success status with an otherwise valid envelope', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const responses = asObject(operationAt(candidate, '/api/v1/meta/capabilities', 'get').responses)
    responses['201'] = responses['200']
    delete responses['200']

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SUCCESS_ENVELOPE')
  })

  it('rejects valid success envelope data refs swapped between schemas', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const loginData = schemaPropertyAt(candidate, 'PostapiV1AuthLoginResponse', 'data')
    const permissionsData = schemaPropertyAt(candidate, 'GetapiV1AuthPermissionsResponse', 'data')
    ;[loginData.$ref, permissionsData.$ref] = [permissionsData.$ref, loginData.$ref]

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SUCCESS_ENVELOPE')
  })

  it('rejects missing and extra schema component names', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const schemas = asObject(asObject(asObject(candidate).components).schemas)
    delete schemas.LoginRequest
    schemas.ForgedSchema = { type: 'object' }

    expect(auditOpenApi(candidate)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'OPENAPI_SCHEMA_SNAPSHOT',
        path: '#/components/schemas/LoginRequest',
      }),
      expect.objectContaining({
        code: 'OPENAPI_SCHEMA_SNAPSHOT',
        path: '#/components/schemas/ForgedSchema',
      }),
    ]))
  })

  it('rejects removal of a required LoginRequest field', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const loginRequest = schemaAt(candidate, 'LoginRequest')
    loginRequest.required = (loginRequest.required as unknown[])
      .filter((field) => field !== 'username')

    expect(auditOpenApi(candidate)).toContainEqual(expect.objectContaining({
      code: 'OPENAPI_SCHEMA_SNAPSHOT',
      path: '#/components/schemas/LoginRequest/required',
    }))
  })

  it('rejects a changed LoginRequest username type while retaining its enum', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    schemaPropertyAt(candidate, 'LoginRequest', 'username').type = 'number'

    expect(schemaPropertyAt(candidate, 'LoginRequest', 'username').enum).toEqual([
      'admin',
      'operator',
      'locked',
    ])
    expect(auditOpenApi(candidate)).toContainEqual(expect.objectContaining({
      code: 'OPENAPI_SCHEMA_SNAPSHOT',
      path: '#/components/schemas/LoginRequest/properties/username/type',
    }))
  })

  it('rejects valid nested ScenarioConfig refs swapped between properties', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const linksItems = asObject(schemaPropertyAt(candidate, 'ScenarioConfig', 'links').items)
    const jammersItems = asObject(schemaPropertyAt(candidate, 'ScenarioConfig', 'jammers').items)
    ;[linksItems.$ref, jammersItems.$ref] = [jammersItems.$ref, linksItems.$ref]

    const snapshotPaths = auditOpenApi(candidate)
      .filter(({ code }) => code === 'OPENAPI_SCHEMA_SNAPSHOT')
      .map(({ path }) => path)
    expect(snapshotPaths).toEqual(expect.arrayContaining([
      '#/components/schemas/ScenarioConfig/properties/links/items/$ref',
      '#/components/schemas/ScenarioConfig/properties/jammers/items/$ref',
    ]))
  })

  it('rejects an unchecked schema keyword', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    schemaAt(candidate, 'LoginRequest').maxProperties = 2

    expect(auditOpenApi(candidate)).toContainEqual(expect.objectContaining({
      code: 'OPENAPI_SCHEMA_SNAPSHOT',
      path: '#/components/schemas/LoginRequest/maxProperties',
    }))
  })

  it('rejects a changed authoritative const', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    schemaPropertyAt(candidate, 'ScenarioConfig', 'schemaVersion').const = '2.0'

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SCHEMA_LITERALS')
  })

  it('rejects a reordered authoritative enum', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const typeSchema = schemaPropertyAt(candidate, 'Link', 'type')
    const values = typeSchema.enum as unknown[]
    ;[values[0], values[1]] = [values[1], values[0]]

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SCHEMA_LITERALS')
  })

  it('rejects an added schema literal occurrence', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    schemaAt(candidate, 'LoginRequest').const = 'FORGED'

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SCHEMA_LITERALS')
  })

  it('rejects a removed schema literal occurrence', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    delete schemaPropertyAt(candidate, 'ScenarioConfig', 'schemaVersion').const

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SCHEMA_LITERALS')
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

  it('rejects JSON content on the exact WebSocket 101 upgrade', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const responses = asObject(operationAt(candidate, '/ws/v1', 'get').responses)
    responses['101'] = {
      description: 'Switching Protocols',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/GetapiV1MetaCapabilitiesResponse' },
        },
      },
    }

    expect(auditOpenApi(candidate).map(({ code }) => code)).toContain('OPENAPI_SUCCESS_ENVELOPE')
  })
})
