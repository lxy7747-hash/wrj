import { beforeAll, describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

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

it('freezes new-account passwords at 6–32 characters', () => {
  const { openApi } = loadContractDocuments()
  const password = asObject(asObject(schemaAt(openApi, 'UserRoleCommand').properties).password)
  const validate = new Ajv2020({ strict: false }).compile(password)
  for (const length of [5, 6, 32, 33, 128]) {
    expect(validate('x'.repeat(length)), `length=${length}`).toBe(length >= 6 && length <= 32)
  }
})

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
  it('完整备份名称和计划冻结边界，执行结果与备份编号闭合', () => {
    const document = loadContractDocuments().openApi
    const ajv = new Ajv2020({ strict: false })
    addFormats(ajv)
    ajv.addSchema({ $id: 'backup-contract', components: asObject(document).components })
    const plan = ajv.compile({ $ref: 'backup-contract#/components/schemas/BackupPlan' })
    const status = ajv.compile({ $ref: 'backup-contract#/components/schemas/BackupPlanStatus' })
    const request = ajv.compile({ $ref: 'backup-contract#/components/schemas/BackupRequest' })
    const value = { version: 1, enabled: false, name: '每日备份', intervalMinutes: 1440 }
    expect(plan(value)).toBe(true)
    for (const patch of [{ name: ' ' }, { intervalMinutes: 59 }, { intervalMinutes: 10081 }, { intervalMinutes: 60.5 }, { version: 0 }, { extra: true }]) {
      expect(plan({ ...value, ...patch })).toBe(false)
    }
    expect(request({ operation: 'BACKUP', confirmationId: 'CONF-1', name: '手动备份' })).toBe(true)
    expect(request({ operation: 'BACKUP', confirmationId: 'CONF-1', name: ' ' })).toBe(false)
    const data = { plan: value, nextRunAt: null, executions: [] }
    expect(status(data)).toBe(true)
    expect(status({ ...data, plan: { ...value, enabled: true } })).toBe(false)
    const time = '2026-09-21T00:00:00Z'
    expect(status({ ...data, plan: { ...value, enabled: true }, nextRunAt: time })).toBe(true)
    const execution = { startedAt: time, completedAt: time, result: 'SUCCESS', backupId: 'BACKUP-1', message: '完成' }
    expect(status({ ...data, executions: [execution] })).toBe(true)
    expect(status({ ...data, executions: [{ ...execution, backupId: null }] })).toBe(false)
    expect(status({ ...data, executions: [{ ...execution, result: 'FAILURE' }] })).toBe(false)
    expect(status({ ...data, executions: [{ ...execution, result: 'FAILURE', backupId: null }] })).toBe(true)
  })
  it('主数据旧记录可读，新写必须包含闭合的真实内容；版本引用接口保持冻结', () => {
    const document = loadContractDocuments().openApi
    const ajv = new Ajv2020({ strict: false })
    addFormats(ajv)
    ajv.addSchema({ $id: 'master-contract', components: asObject(document).components })
    const read = ajv.compile({ $ref: 'master-contract#/components/schemas/MasterData' })
    const write = ajv.compile({ $ref: 'master-contract#/components/schemas/MasterDataWrite' })
    const record = { dataId: 'DICT-1', kind: 'PARAMETER_DICTIONARY', version: 1, referenceCount: 0, active: true }
    expect(read(record)).toBe(true)
    expect(write(record)).toBe(false)
    const content = { name: '通信字典', description: '', entries: [{ key: 'mode', valueType: 'TEXT', value: '标准' }] }
    expect(write({ ...record, content })).toBe(true)
    for (const patch of [{ kind: 'DEVICE' }, { content: { ...content, entries: [] } },
      { content: { ...content, entries: [{ key: 'x', valueType: 'NUMBER', value: '3' }] } },
      { content: { ...content, entries: [{ key: 'x', valueType: 'BOOLEAN', value: false, unit: 'm' }] } },
      { content: { ...content, name: ' ' } }, { extra: true }]) {
      expect(write({ ...record, content, ...patch })).toBe(false)
    }
    for (const [valueType, value] of [['NUMBER', 0], ['BOOLEAN', false]] as const) {
      expect(write({ ...record, content: { ...content, entries: [{ key: 'x', valueType, value }] } })).toBe(true)
    }
    for (const path of ['/api/v1/admin/master-data/targets', '/api/v1/admin/master-data/{dataId}/details', '/api/v1/admin/master-data/{dataId}/reference']) {
      expect(responseSchemaAt(document, path, path.endsWith('/reference') ? 'put' : 'get', '503').$ref).toBe('#/components/schemas/ErrorEnvelope')
    }
  })

  it('freezes real SQLite backup status, checksum and restore results while retaining pure Mock compatibility', () => {
    const document = loadContractDocuments().openApi
    const ajv = new Ajv2020({ strict: false })
    addFormats(ajv)
    const validate = ajv.compile(schemaAt(document, 'BackupRecord'))
    const record = { backupId: 'BACKUP-TEST', status: 'VALID', checksum: 'A'.repeat(64), createdAt: '2026-09-11T08:00:00Z' }
    expect(validate(record)).toBe(true)
    expect(validate({ ...record, status: 'INVALID' })).toBe(true)
    expect(validate({ ...record, status: 'VALID_FIXTURE', checksum: 'MOCK-TEST' })).toBe(true)
    for (const change of [{ status: 'UNKNOWN' }, { checksum: '' }, { checksum: 'MOCK-TEST' }, { extra: true }]) expect(validate({ ...record, ...change })).toBe(false)
    const result = ajv.compile(schemaAt(document, 'RestoreResult'))
    const restored = { prebackupId: 'PREBACKUP-TEST', integrityValid: true, progress: 100, result: 'SUCCESS', rolledBack: false, generated: true }
    expect(result(restored)).toBe(true)
    expect(result({ ...restored, generated: false })).toBe(true)
    expect(result({ ...restored, generated: 'true' })).toBe(false)
    for (const path of ['/api/v1/admin/backups', '/api/v1/admin/backup', '/api/v1/admin/restore']) {
      expect(responseSchemaAt(document, path, path.endsWith('/backups') ? 'get' : 'post', '503').$ref).toBe('#/components/schemas/ErrorEnvelope')
    }
  })

  it('freezes downloadable audit results without changing other export status contracts', () => {
    const document = loadContractDocuments().openApi
    const ajv = new Ajv2020({ strict: false })
    addFormats(ajv)
    const validate = ajv.compile(schemaAt(document, 'AuditExportResult'))
    const file = { objectId: 'AUDIT-LOG', generated: true, classification: 'INTERNAL', watermark: '内部使用',
      verifiedAt: '2026-09-11T06:01:57Z', fileName: 'operation_audit_20260911140157_CONF-001.txt', content: '审计日志', recordCount: 0 }
    expect(validate(file)).toBe(true)
    for (const change of [{ generated: false }, { objectId: 'OTHER' }, { classification: 'PUBLIC' },
      { fileName: '../log.txt' }, { content: '' }, { recordCount: -1 }, { recordCount: 0.5 }, { extra: true }, { verifiedAt: 'invalid' }]) {
      expect(validate({ ...file, ...change })).toBe(false)
    }
    const { content: omitted, ...missingContent } = file
    expect(omitted).toBe('审计日志')
    expect(validate(missingContent)).toBe(false)
    expect(schemaPropertyAt(document, 'ExportStatus', 'generated').const).toBe(false)
  })

  it('rejects removal of session authentication from protected operations', () => {
    const document = structuredClone(loadContractDocuments().openApi)
    operationAt(document, '/api/v1/admin/users', 'get').security = []
    expect(auditOpenApi(document)).toContainEqual(expect.objectContaining({ code: 'OPENAPI_SESSION_SECURITY' }))
    const modified = asObject(structuredClone(loadContractDocuments().openApi))
    asObject(asObject(asObject(modified.components).securitySchemes).SessionCookie).name = 'other_cookie'
    expect(auditOpenApi(modified)).toContainEqual(expect.objectContaining({ code: 'OPENAPI_SESSION_SECURITY', path: '$.components.securitySchemes.SessionCookie' }))
  })
  it.each([
    undefined,
    [],
    [null],
    [{ url: 'http://127.0.0.1:4179' }],
    [{ url: 'https://example.com:4173' }],
    [{ url: 'http://127.0.0.1:4173' }, { url: 'http://127.0.0.1:4179' }],
  ].map(servers => [servers]))('拒绝未冻结的 servers 配置：%j', (servers) => {
    const document = asObject(structuredClone(loadContractDocuments().openApi))
    document.servers = servers
    expect(auditOpenApi(document)).toContainEqual(expect.objectContaining({ code: 'OPENAPI_SERVERS', path: '$.servers' }))
  })

  it('accepts the authoritative 83-operation contract', () => {
    const { openApi } = loadContractDocuments()

    expect(asObject(openApi).servers).toEqual([expect.objectContaining({ url: 'http://127.0.0.1:4173' })])
    expect(auditOpenApi(openApi)).toEqual([])

    const paths = asObject(asObject(openApi).paths)
    const operations = Object.values(paths).flatMap((pathValue) => {
      const path = asObject(pathValue)
      return ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace']
        .filter((method) => path[method] !== undefined)
        .map((method) => ({ method, operation: asObject(path[method]) }))
    })
    expect(operations).toHaveLength(83)
    expect(operations.filter(({ method }) => ['post', 'put', 'patch'].includes(method))).toHaveLength(40)
    expect(new Set(operations.map(({ operation }) => operation.operationId)).size).toBe(83)
  })

  it('binds the P4 closed-loop and versioned jammer synchronization contracts', () => {
    const { openApi } = loadContractDocuments()
    expect(requestSchemaAt(openApi, '/api/v1/simulations/{runId}/events', 'post')).toEqual({
      $ref: '#/components/schemas/PostapiV1SimulationsRunIdEventsRequest',
    })
    expect(schemaAt(openApi, 'PostapiV1SimulationsRunIdEventsRequest')).toEqual({
      $ref: '#/components/schemas/ClosedLoopContext',
    })
    expect(requestSchemaAt(openApi, '/api/v1/tasks/{taskId}/jammers/{jammerId}/parameters', 'post')).toEqual({
      $ref: '#/components/schemas/PostapiV1TasksTaskIdJammersJammerIdParametersRequest',
    })
    expect(schemaAt(openApi, 'PostapiV1TasksTaskIdJammersJammerIdParametersRequest')).toEqual({
      $ref: '#/components/schemas/JammingParameterSet',
    })
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
        config: { $ref: '#/components/schemas/ScenarioConfigWrite' },
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

  it('rejects removal of a frozen operation error status', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    const responses = asObject(operationAt(candidate, '/api/v1/templates/{templateId}', 'delete').responses)
    delete responses['409']

    expect(auditOpenApi(candidate)).toContainEqual(expect.objectContaining({
      code: 'OPENAPI_ERROR_STATUS',
      path: '$.paths["/api/v1/templates/{templateId}"].delete.responses',
    }))
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

  it('rejects a changed LoginRequest username type while retaining its bounds', () => {
    const { openApi } = loadContractDocuments()
    const candidate = structuredClone(openApi)
    schemaPropertyAt(candidate, 'LoginRequest', 'username').type = 'number'

    expect(schemaPropertyAt(candidate, 'LoginRequest', 'username')).toMatchObject({ minLength: 1, maxLength: 64 })
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
