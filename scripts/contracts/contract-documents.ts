import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The canonical type is source-owned; this Node-only validator deliberately does not pull source files into its TS project.
// @ts-ignore -- tsconfig.node.json intentionally excludes app source while this import is erased at runtime.
import type { DeterministicFixtureSet as SourceDeterministicFixtureSet } from '../../src/contracts/domain-models.js'

export type DeterministicFixtureSet = SourceDeterministicFixtureSet

export interface ValidationFinding {
  code: string
  path: string
  message: string
}

type JsonObject = Record<string, unknown>
type HttpMethod = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options' | 'trace'

const HTTP_METHODS: readonly HttpMethod[] = [
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'head',
  'options',
  'trace',
]
const WRITE_METHODS = new Set<HttpMethod>(['post', 'put', 'patch'])
const SCHEMA_REF_PREFIX = '#/components/schemas/'
const DEMO_ROLE_REF = '#/components/parameters/DemoRole'
const ERROR_ENVELOPE_REF = '#/components/schemas/ErrorEnvelope'
const LINK_QUALITY_CSV_HEADER = 'Time,SourcePlatform,DestPlatform,LinkType,Frequency,Bandwidth,Distance,TxPower,TxAntennaGain,RxAntennaGain,PathLoss,JammingPower,ReceivedPower,SNR,Modulation,BER,LinkStatus,BERThreshold,DataRate'
const EVENTS_CSV_HEADER = 'Time,EventType,SourcePlatform,TargetPlatform,Status,Power,Frequency,Bandwidth,Parameters'
const LINK_SWITCH_CSV_HEADER = 'Time,SourcePlatform,DestPlatform,Direction,OldLinkType,NewLinkType,OldBER,NewBER,SwitchReason'
const EXPECTED_ERROR_CODES = [
  'INVALID_REQUEST',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'PERMISSION_DENIED',
  'LAST_ADMIN_GUARD',
  'CONFIRMATION_REQUIRED',
  'CONFIRMATION_EXPIRED',
  'CONFIG_LOCKED',
  'INVALID_TRANSITION',
  'NODE_LIMIT_EXCEEDED',
  'DUPLICATE_EVENT',
  'HEADER_INVALID',
  'TYPE_INVALID',
  'ENCODING_INVALID',
  'ATOMIC_REPLACE_FAILED',
  'START_FAILED',
  'TIMEOUT',
  'EXIT_NONZERO',
  'CORRUPT_FIXTURE',
  'LOOPBACK_ONLY',
  'TOPIC_FORBIDDEN',
  'SEQUENCE_GAP',
  'INTERNAL_FIXTURE_ERROR',
] as const

const contractDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../frontend-technical-design-v1/contracts',
)

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function objectAt(parent: JsonObject, key: string): JsonObject | undefined {
  const value = parent[key]
  return isObject(value) ? value : undefined
}

function stringAt(parent: JsonObject | undefined, key: string): string | undefined {
  const value = parent?.[key]
  return typeof value === 'string' ? value : undefined
}

function addFinding(
  findings: ValidationFinding[],
  code: string,
  path: string,
  message: string,
): void {
  findings.push({ code, path, message })
}

function resolveLocalPointer(document: JsonObject, reference: string): unknown {
  if (!reference.startsWith('#/')) return undefined

  let current: unknown = document
  for (const encodedPart of reference.slice(2).split('/')) {
    if (!isObject(current)) return undefined
    const part = encodedPart.replaceAll('~1', '/').replaceAll('~0', '~')
    current = current[part]
  }
  return current
}

function parameterReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((parameter) => {
    if (!isObject(parameter)) return []
    const reference = stringAt(parameter, '$ref')
    return reference === undefined ? [] : [reference]
  })
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual) || !actual.every((value) => typeof value === 'string')) return false

  const actualValues = new Set(actual)
  const expectedValues: ReadonlySet<string> = new Set(expected)
  return actualValues.size === actual.length
    && expectedValues.size === expected.length
    && actualValues.size === expectedValues.size
    && actual.every((value) => expectedValues.has(value))
}

function auditLocalReferences(
  document: JsonObject,
  value: unknown,
  path: string,
  findings: ValidationFinding[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => auditLocalReferences(document, item, `${path}[${index}]`, findings))
    return
  }
  if (!isObject(value)) return

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (key === '$ref' && typeof child === 'string' && child.startsWith('#/')) {
      if (resolveLocalPointer(document, child) === undefined) {
        addFinding(findings, 'OPENAPI_UNRESOLVED_REF', childPath, `Unresolved local reference ${child}`)
      }
      continue
    }
    auditLocalReferences(document, child, childPath, findings)
  }
}

export function loadContractDocuments(): { openApi: unknown; fixtures: unknown } {
  // The authority intentionally uses JSON syntax in a .yaml file; JSON.parse is the contract boundary.
  const openApi = JSON.parse(
    readFileSync(resolve(contractDirectory, 'mock-api.openapi.yaml'), 'utf8'),
  ) as unknown
  const fixtures = JSON.parse(
    readFileSync(resolve(contractDirectory, 'deterministic-fixtures.json'), 'utf8'),
  ) as unknown

  return { openApi, fixtures }
}

export function auditOpenApi(openApi: unknown): ValidationFinding[] {
  const findings: ValidationFinding[] = []
  if (!isObject(openApi)) {
    addFinding(findings, 'OPENAPI_DOCUMENT', '$', 'OpenAPI document must be an object')
    return findings
  }

  if (openApi.openapi !== '3.1.0') {
    addFinding(findings, 'OPENAPI_VERSION', '$.openapi', 'Expected OpenAPI 3.1.0')
  }

  const paths = objectAt(openApi, 'paths')
  const components = objectAt(openApi, 'components')
  const schemas = components && objectAt(components, 'schemas')
  const parameters = components && objectAt(components, 'parameters')
  if (!paths || !schemas || !parameters) {
    addFinding(
      findings,
      'OPENAPI_STRUCTURE',
      '$',
      'paths, components.schemas, and components.parameters are required',
    )
    return findings
  }

  const operationIds = new Map<string, string>()
  const requestSchemaOwners = new Map<string, string>()
  const successSchemaOwners = new Map<string, string>()
  let operationCount = 0
  let writeCount = 0

  for (const [route, pathValue] of Object.entries(paths)) {
    if (!isObject(pathValue)) continue
    const pathParameterValues = Array.isArray(pathValue.parameters) ? pathValue.parameters : []
    const placeholders = [...route.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])

    for (const method of HTTP_METHODS) {
      const operation = pathValue[method]
      if (!isObject(operation)) continue

      operationCount += 1
      const operationPath = `$.paths[${JSON.stringify(route)}].${method}`
      const owner = `${method.toUpperCase()} ${route}`
      const operationId = stringAt(operation, 'operationId')
      if (!operationId) {
        addFinding(findings, 'OPENAPI_OPERATION_ID', `${operationPath}.operationId`, 'operationId is required')
      } else {
        const previousOwner = operationIds.get(operationId)
        if (previousOwner) {
          addFinding(
            findings,
            'OPENAPI_OPERATION_ID',
            `${operationPath}.operationId`,
            `operationId ${operationId} is already used by ${previousOwner}`,
          )
        } else {
          operationIds.set(operationId, owner)
        }
      }

      const operationParameterValues = Array.isArray(operation.parameters) ? operation.parameters : []
      if (route !== '/api/v1/auth/login'
        && !parameterReferences(operationParameterValues).includes(DEMO_ROLE_REF)) {
        addFinding(
          findings,
          'OPENAPI_DEMO_ROLE',
          `${operationPath}.parameters`,
          'Every non-login operation must explicitly reference DemoRole',
        )
      }

      const combinedParameters = [...pathParameterValues, ...operationParameterValues]
      for (const placeholder of placeholders) {
        const matchingParameters = combinedParameters.filter((parameter) => {
          if (!isObject(parameter)) return false
          const reference = stringAt(parameter, '$ref')
          const resolved = reference ? resolveLocalPointer(openApi, reference) : parameter
          return isObject(resolved)
            && resolved.name === placeholder
            && resolved.in === 'path'
            && resolved.required === true
        })
        if (matchingParameters.length !== 1) {
          addFinding(
            findings,
            'OPENAPI_PATH_PARAMETER',
            `${operationPath}.parameters`,
            `Path placeholder {${placeholder}} must have exactly one required path parameter`,
          )
        }
      }

      if (WRITE_METHODS.has(method)) {
        writeCount += 1
        const requestBody = objectAt(operation, 'requestBody')
        const content = requestBody && objectAt(requestBody, 'content')
        const mediaType = content && objectAt(content, 'application/json')
        const requestSchema = mediaType && objectAt(mediaType, 'schema')
        const requestReference = stringAt(requestSchema, '$ref')
        const requestPath = `${operationPath}.requestBody.content["application/json"].schema`
        if (requestBody?.required !== true
          || !requestReference?.startsWith(SCHEMA_REF_PREFIX)
          || !isObject(resolveLocalPointer(openApi, requestReference))) {
          addFinding(
            findings,
            'OPENAPI_WRITE_SCHEMA',
            requestPath,
            'POST/PUT/PATCH operations require a resolvable local request schema reference',
          )
        } else {
          const previousOwner = requestSchemaOwners.get(requestReference)
          if (previousOwner) {
            addFinding(
              findings,
              'OPENAPI_WRITE_SCHEMA',
              requestPath,
              `Request schema ${requestReference} is already used by ${previousOwner}`,
            )
          } else {
            requestSchemaOwners.set(requestReference, owner)
          }
        }
      }

      const responses = objectAt(operation, 'responses')
      const responseEntries = responses ? Object.entries(responses) : []
      const successEntries = responseEntries.filter(
        ([status]) => /^2\d\d$/.test(status) && status !== '101',
      )
      const isCanonicalUpgrade = route === '/ws/v1'
        && method === 'get'
        && responseEntries.some(([status]) => status === '101')
      if (successEntries.length === 0 && !isCanonicalUpgrade) {
        addFinding(
          findings,
          'OPENAPI_SUCCESS_ENVELOPE',
          `${operationPath}.responses`,
          'REST operations require a typed non-101 2xx response',
        )
      }

      for (const [status, responseValue] of successEntries) {
        const response = isObject(responseValue) ? responseValue : undefined
        const content = response && objectAt(response, 'content')
        const mediaType = content && objectAt(content, 'application/json')
        const responseSchema = mediaType && objectAt(mediaType, 'schema')
        const responseReference = stringAt(responseSchema, '$ref')
        const responsePath = `${operationPath}.responses[${JSON.stringify(status)}]`
        const envelope = responseReference ? resolveLocalPointer(openApi, responseReference) : undefined
        const envelopeProperties = isObject(envelope) ? objectAt(envelope, 'properties') : undefined
        const dataSchema = envelopeProperties && objectAt(envelopeProperties, 'data')
        const dataReference = stringAt(dataSchema, '$ref')
        const required = isObject(envelope) ? envelope.required : undefined

        if (!responseReference?.startsWith(SCHEMA_REF_PREFIX)
          || !isObject(envelope)
          || !sameStrings(required, ['ok', 'data', 'meta'])
          || objectAt(envelopeProperties ?? {}, 'ok')?.const !== true
          || !dataReference?.startsWith(SCHEMA_REF_PREFIX)
          || !isObject(resolveLocalPointer(openApi, dataReference))) {
          addFinding(
            findings,
            'OPENAPI_SUCCESS_ENVELOPE',
            responsePath,
            'Each non-101 2xx response must reference a strict typed success envelope',
          )
          continue
        }

        const previousOwner = successSchemaOwners.get(responseReference)
        if (previousOwner) {
          addFinding(
            findings,
            'OPENAPI_SUCCESS_ENVELOPE',
            responsePath,
            `Success envelope ${responseReference} is already used by ${previousOwner}`,
          )
        } else {
          successSchemaOwners.set(responseReference, owner)
        }
      }

      for (const [status, responseValue] of responseEntries) {
        if (/^[123]\d\d$/.test(status)) continue
        const response = isObject(responseValue) ? responseValue : undefined
        const content = response && objectAt(response, 'content')
        const mediaType = content && objectAt(content, 'application/json')
        const responseSchema = mediaType && objectAt(mediaType, 'schema')
        if (stringAt(responseSchema, '$ref') !== ERROR_ENVELOPE_REF) {
          addFinding(
            findings,
            'OPENAPI_ERROR_ENVELOPE',
            `${operationPath}.responses[${JSON.stringify(status)}]`,
            `Error response ${status} must reference ErrorEnvelope`,
          )
        }
      }
    }
  }

  if (operationCount !== 61) {
    addFinding(
      findings,
      'OPENAPI_OPERATION_COUNT',
      '$.paths',
      `Expected exactly 61 operations, found ${operationCount}`,
    )
  }
  if (writeCount !== 30 || requestSchemaOwners.size !== 30) {
    addFinding(
      findings,
      'OPENAPI_WRITE_COUNT',
      '$.paths',
      `Expected exactly 30 independently typed POST/PUT/PATCH writes, found ${writeCount} writes and ${requestSchemaOwners.size} unique request schemas`,
    )
  }

  const demoRole = parameters.DemoRole
  const demoRoleSchema = isObject(demoRole) ? objectAt(demoRole, 'schema') : undefined
  if (!isObject(demoRole)
    || demoRole.name !== 'X-Demo-Role'
    || demoRole.in !== 'header'
    || demoRole.required !== true
    || !sameStrings(demoRoleSchema?.enum, ['ADMIN', 'OPERATOR'])) {
    addFinding(
      findings,
      'OPENAPI_DEMO_ROLE',
      '$.components.parameters.DemoRole',
      'DemoRole must be the required X-Demo-Role header with ADMIN and OPERATOR values',
    )
  }

  const errorCode = schemas.ErrorCode
  if (!isObject(errorCode) || !sameStrings(errorCode.enum, EXPECTED_ERROR_CODES)) {
    addFinding(
      findings,
      'OPENAPI_ERROR_CATALOG',
      '$.components.schemas.ErrorCode.enum',
      `Error catalog must contain exactly the ${EXPECTED_ERROR_CODES.length} canonical codes`,
    )
  }

  const fixtureValidation = objectAt(openApi, 'x-fixture-validation')
  if (fixtureValidation?.document !== 'deterministic-fixtures.json'
    || fixtureValidation.schema !== '#/components/schemas/DeterministicFixtures'
    || fixtureValidation.typeContract !== 'domain-models.ts#DeterministicFixtureSet'
    || !isObject(schemas.DeterministicFixtures)) {
    addFinding(
      findings,
      'OPENAPI_FIXTURE_LINK',
      '$.x-fixture-validation',
      'OpenAPI and DeterministicFixtures must preserve the three-way fixture linkage',
    )
  }

  auditLocalReferences(openApi, openApi, '$', findings)
  return findings
}

function expectUnique(
  values: readonly string[],
  path: string,
  findings: ValidationFinding[],
): Set<string> {
  const result = new Set<string>()
  values.forEach((value, index) => {
    if (result.has(value)) {
      addFinding(findings, 'FIXTURE_DUPLICATE_ID', `${path}[${index}]`, `Duplicate ID ${value}`)
    }
    result.add(value)
  })
  return result
}

function expectReference(
  ids: ReadonlySet<string>,
  value: string,
  path: string,
  kind: string,
  findings: ValidationFinding[],
): void {
  if (!ids.has(value)) {
    addFinding(findings, 'FIXTURE_ORPHAN_REFERENCE', path, `Unknown ${kind} reference ${value}`)
  }
}

function expectValue(
  actual: unknown,
  expected: unknown,
  path: string,
  code: string,
  findings: ValidationFinding[],
): void {
  if (actual !== expected) {
    addFinding(findings, code, path, `Expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`)
  }
}

function expectSameIds(
  actual: readonly string[],
  expected: ReadonlySet<string>,
  path: string,
  findings: ValidationFinding[],
): void {
  const actualIds = expectUnique(actual, path, findings)
  const missing = [...expected].filter((value) => !actualIds.has(value))
  const extra = [...actualIds].filter((value) => !expected.has(value))
  if (missing.length > 0 || extra.length > 0) {
    addFinding(
      findings,
      'FIXTURE_BATCH_PAIR',
      path,
      `ID set mismatch; missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
    )
  }
}

export function auditFixtureClosure(fixtures: DeterministicFixtureSet): ValidationFinding[] {
  const findings: ValidationFinding[] = []
  const scenarioIds = new Set([fixtures.scenario.scenario.id])
  const taskIds = new Set([fixtures.task.taskId])
  const scriptIds = new Set([fixtures.script.scriptId])
  const runIds = new Set([fixtures.run.runId])
  const replayIds = new Set([fixtures.replay.replayId])
  const reportIds = new Set([fixtures.report.reportId])
  const frameIds = new Set([fixtures.frame.frameId])
  const platformIds = expectUnique(fixtures.scenario.platforms.map(({ id }) => id), '$.scenario.platforms', findings)
  const linkIds = expectUnique(fixtures.scenario.links.map(({ id }) => id), '$.scenario.links', findings)
  const sensorIds = expectUnique(fixtures.scenario.sensors.map(({ id }) => id), '$.scenario.sensors', findings)
  const jammerIds = expectUnique(fixtures.scenario.jammers.map(({ id }) => id), '$.scenario.jammers', findings)
  const eventIds = expectUnique(fixtures.events.map(({ eventId }) => eventId), '$.events', findings)

  expectReference(scenarioIds, fixtures.task.scenarioId, '$.task.scenarioId', 'scenario', findings)
  expectReference(scriptIds, fixtures.task.scriptId, '$.task.scriptId', 'script', findings)
  expectReference(taskIds, fixtures.script.taskId, '$.script.taskId', 'task', findings)
  expectReference(scenarioIds, fixtures.script.scenarioId, '$.script.scenarioId', 'scenario', findings)
  expectReference(taskIds, fixtures.run.taskId, '$.run.taskId', 'task', findings)
  expectReference(scenarioIds, fixtures.run.scenarioId, '$.run.scenarioId', 'scenario', findings)
  expectReference(taskIds, fixtures.frame.taskId, '$.frame.taskId', 'task', findings)
  expectReference(runIds, fixtures.frame.runId, '$.frame.runId', 'run', findings)

  fixtures.fileArchives.forEach((archive, index) => {
    expectReference(taskIds, archive.taskId, `$.fileArchives[${index}].taskId`, 'task', findings)
  })
  fixtures.templates.forEach((template, index) => {
    expectReference(scenarioIds, template.scenarioId, `$.templates[${index}].scenarioId`, 'scenario', findings)
  })
  fixtures.scenario.links.forEach((link, index) => {
    expectReference(platformIds, link.sourcePlatformId, `$.scenario.links[${index}].sourcePlatformId`, 'platform', findings)
    expectReference(platformIds, link.targetPlatformId, `$.scenario.links[${index}].targetPlatformId`, 'platform', findings)
  })
  fixtures.scenario.sensors.forEach((sensor, index) => {
    expectReference(platformIds, sensor.platformId, `$.scenario.sensors[${index}].platformId`, 'platform', findings)
  })
  fixtures.scenario.jammers.forEach((jammer, index) => {
    expectReference(platformIds, jammer.platformId, `$.scenario.jammers[${index}].platformId`, 'platform', findings)
  })
  fixtures.scenario.platforms.forEach((platform, platformIndex) => {
    platform.linkIds.forEach((linkId, index) => {
      expectReference(linkIds, linkId, `$.scenario.platforms[${platformIndex}].linkIds[${index}]`, 'link', findings)
    })
    platform.sensorIds.forEach((sensorId, index) => {
      expectReference(sensorIds, sensorId, `$.scenario.platforms[${platformIndex}].sensorIds[${index}]`, 'sensor', findings)
    })
    platform.jammerIds.forEach((jammerId, index) => {
      expectReference(jammerIds, jammerId, `$.scenario.platforms[${platformIndex}].jammerIds[${index}]`, 'jammer', findings)
    })
  })
  fixtures.scenario.informationDemand.forEach((demand, demandIndex) => {
    expectReference(platformIds, demand.sourcePlatformId, `$.scenario.informationDemand[${demandIndex}].sourcePlatformId`, 'platform', findings)
    demand.destinationPlatformIds.forEach((platformId, index) => {
      expectReference(platformIds, platformId, `$.scenario.informationDemand[${demandIndex}].destinationPlatformIds[${index}]`, 'platform', findings)
    })
  })

  fixtures.frame.platforms.forEach((platform, platformIndex) => {
    expectReference(platformIds, platform.platformId, `$.frame.platforms[${platformIndex}].platformId`, 'platform', findings)
    platform.linkIds.forEach((linkId, index) => {
      expectReference(linkIds, linkId, `$.frame.platforms[${platformIndex}].linkIds[${index}]`, 'link', findings)
    })
    platform.jammers.forEach((jammer, jammerIndex) => {
      const basePath = `$.frame.platforms[${platformIndex}].jammers[${jammerIndex}]`
      expectReference(jammerIds, jammer.jammerId, `${basePath}.jammerId`, 'jammer', findings)
      expectReference(platformIds, jammer.platformId, `${basePath}.platformId`, 'platform', findings)
      if (jammer.targetPlatform) {
        expectReference(platformIds, jammer.targetPlatform, `${basePath}.targetPlatform`, 'platform', findings)
      }
      expectValue(jammer.time, 42, `${basePath}.time`, 'FIXTURE_TIME_42', findings)
    })
    expectValue(platform.updatedAt, 42, `$.frame.platforms[${platformIndex}].updatedAt`, 'FIXTURE_TIME_42', findings)
  })
  fixtures.frame.links.forEach((link, index) => {
    const basePath = `$.frame.links[${index}]`
    expectReference(linkIds, link.linkId, `${basePath}.linkId`, 'link', findings)
    expectReference(platformIds, link.sourcePlatform, `${basePath}.sourcePlatform`, 'platform', findings)
    expectReference(platformIds, link.destPlatform, `${basePath}.destPlatform`, 'platform', findings)
    expectValue(link.time, 42, `${basePath}.time`, 'FIXTURE_TIME_42', findings)
  })
  fixtures.frame.uiLinks.forEach((link, index) => {
    expectReference(linkIds, link.linkId, `$.frame.uiLinks[${index}].linkId`, 'link', findings)
    expectReference(frameIds, link.frameId, `$.frame.uiLinks[${index}].frameId`, 'frame', findings)
  })
  fixtures.frame.linkSummaries.forEach((link, index) => {
    expectReference(platformIds, link.sourcePlatform, `$.frame.linkSummaries[${index}].sourcePlatform`, 'platform', findings)
    expectReference(platformIds, link.destPlatform, `$.frame.linkSummaries[${index}].destPlatform`, 'platform', findings)
    expectValue(link.updatedAt, 42, `$.frame.linkSummaries[${index}].updatedAt`, 'FIXTURE_TIME_42', findings)
  })
  fixtures.frame.evidence.losses.forEach((loss, index) => {
    expectReference(linkIds, loss.linkId, `$.frame.evidence.losses[${index}].linkId`, 'link', findings)
  })
  fixtures.frame.evidence.routeCandidates.forEach((candidate, index) => {
    expectReference(linkIds, candidate.linkId, `$.frame.evidence.routeCandidates[${index}].linkId`, 'link', findings)
  })
  expectReference(jammerIds, fixtures.frame.evidence.jammerExecution.jammerId, '$.frame.evidence.jammerExecution.jammerId', 'jammer', findings)
  expectReference(platformIds, fixtures.frame.evidence.jammerExecution.targetPlatformId, '$.frame.evidence.jammerExecution.targetPlatformId', 'platform', findings)
  expectReference(frameIds, fixtures.frame.evidence.synchronization.effectiveFrameId, '$.frame.evidence.synchronization.effectiveFrameId', 'frame', findings)

  fixtures.frame.eventIds.forEach((eventId, index) => {
    expectReference(eventIds, eventId, `$.frame.eventIds[${index}]`, 'event', findings)
  })
  fixtures.events.forEach((event, index) => {
    const basePath = `$.events[${index}]`
    expectReference(frameIds, event.frameId, `${basePath}.frameId`, 'frame', findings)
    expectValue(event.time, 42, `${basePath}.time`, 'FIXTURE_TIME_42', findings)
    if (event.type === 'DETECTION') {
      expectReference(sensorIds, event.sensorId, `${basePath}.sensorId`, 'sensor', findings)
      expectReference(platformIds, event.targetPlatformId, `${basePath}.targetPlatformId`, 'platform', findings)
    } else {
      expectReference(linkIds, event.oldLinkId, `${basePath}.oldLinkId`, 'link', findings)
      expectReference(linkIds, event.newLinkId, `${basePath}.newLinkId`, 'link', findings)
    }
  })

  expectReference(runIds, fixtures.replay.runId, '$.replay.runId', 'run', findings)
  fixtures.replay.eventIds.forEach((eventId, index) => {
    expectReference(eventIds, eventId, `$.replay.eventIds[${index}]`, 'event', findings)
  })
  if (fixtures.report.runId) {
    expectReference(runIds, fixtures.report.runId, '$.report.runId', 'run', findings)
  }
  expectReference(taskIds, fixtures.archive.taskId, '$.archive.taskId', 'task', findings)
  expectReference(scenarioIds, fixtures.archive.scenarioId, '$.archive.scenarioId', 'scenario', findings)
  expectReference(runIds, fixtures.archive.runId, '$.archive.runId', 'run', findings)
  expectReference(replayIds, fixtures.archive.replayId, '$.archive.replayId', 'replay', findings)
  expectReference(reportIds, fixtures.archive.reportId, '$.archive.reportId', 'report', findings)

  const batchRunIds = expectUnique(fixtures.batchRuns.map(({ runId }) => runId), '$.batchRuns[].runId', findings)
  const batchRunReportIds = expectUnique(fixtures.batchRuns.map(({ reportId }) => reportId), '$.batchRuns[].reportId', findings)
  const batchReportRunIds = expectUnique(fixtures.batchReports.map(({ runId }) => runId), '$.batchReports[].runId', findings)
  const batchReportIds = expectUnique(fixtures.batchReports.map(({ reportId }) => reportId), '$.batchReports[].reportId', findings)
  expectValue(fixtures.batch.batchId, 'BATCH-001', '$.batch.batchId', 'FIXTURE_BATCH_PAIR', findings)
  expectValue(fixtures.batchRuns.length, 12, '$.batchRuns.length', 'FIXTURE_BATCH_PAIR', findings)
  expectValue(fixtures.batchReports.length, 12, '$.batchReports.length', 'FIXTURE_BATCH_PAIR', findings)
  expectValue(fixtures.batch.runIds.length, 12, '$.batch.runIds.length', 'FIXTURE_BATCH_PAIR', findings)
  expectValue(fixtures.batch.reportIds.length, 12, '$.batch.reportIds.length', 'FIXTURE_BATCH_PAIR', findings)
  expectSameIds(fixtures.batch.runIds, batchRunIds, '$.batch.runIds', findings)
  expectSameIds(fixtures.batch.reportIds, batchRunReportIds, '$.batch.reportIds', findings)
  expectSameIds([...batchReportRunIds], batchRunIds, '$.batchReports[].runId', findings)
  expectSameIds([...batchReportIds], batchRunReportIds, '$.batchReports[].reportId', findings)
  fixtures.batchRuns.forEach((run, index) => {
    const report = fixtures.batchReports[index]
    if (!report || report.runId !== run.runId || report.reportId !== run.reportId
      || fixtures.batch.runIds[index] !== run.runId
      || fixtures.batch.reportIds[index] !== run.reportId) {
      addFinding(
        findings,
        'FIXTURE_BATCH_PAIR',
        `$.batchRuns[${index}]`,
        'BATCH-001 run/report arrays must preserve the same deterministic pair order',
      )
    }
  })
  expectValue(fixtures.batchAggregateReport.batchId, fixtures.batch.batchId, '$.batchAggregateReport.batchId', 'FIXTURE_BATCH_PAIR', findings)
  expectValue(fixtures.batchAggregateReport.reportId, fixtures.batch.aggregateReportId, '$.batchAggregateReport.reportId', 'FIXTURE_BATCH_PAIR', findings)

  expectValue(fixtures.frame.simulationTime, 42, '$.frame.simulationTime', 'FIXTURE_TIME_42', findings)
  expectValue(fixtures.frame.sequence, 42, '$.frame.sequence', 'FIXTURE_TIME_42', findings)
  expectValue(fixtures.frame.evidence.synchronization.effectiveSimulationTime, 42, '$.frame.evidence.synchronization.effectiveSimulationTime', 'FIXTURE_TIME_42', findings)
  expectValue(fixtures.frame.evidence.jammerExecution.startTime, 42, '$.frame.evidence.jammerExecution.startTime', 'FIXTURE_TIME_42', findings)

  const expectedCsv = [
    { name: 'link_quality.csv', header: LINK_QUALITY_CSV_HEADER },
    { name: 'events.csv', header: EVENTS_CSV_HEADER },
    { name: 'link_switch.csv', header: LINK_SWITCH_CSV_HEADER },
  ] as const
  expectValue(fixtures.contracts.csv.length, 3, '$.contracts.csv.length', 'FIXTURE_CSV_ORDER', findings)
  expectedCsv.forEach((expected, index) => {
    const actual = fixtures.contracts.csv[index]
    if (!actual || actual.name !== expected.name || actual.fields.join(',') !== expected.header) {
      addFinding(
        findings,
        'FIXTURE_CSV_ORDER',
        `$.contracts.csv[${index}]`,
        `${expected.name} must match its canonical CSV header and field order`,
      )
    }
  })

  return findings
}
