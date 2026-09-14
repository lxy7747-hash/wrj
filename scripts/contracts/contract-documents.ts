import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OPENAPI_SCHEMA_SNAPSHOT } from './openapi-schema.snapshot.js'

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
type OperationContract = {
  readonly method: HttpMethod
  readonly path: string
  readonly operationId: string
}
type OperationSchemaBinding = {
  readonly requestTargetRef: string | null
  readonly successStatus: string
  readonly dataRef: string | null
}
type CanonicalTopic = 'simulation.frame' | 'runtime.state' | 'link.metric' | 'jammer.event' | 'switch.event'

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
  'VERSION_CONFLICT',
  'FRAME_MISMATCH',
  'HEADER_INVALID',
  'TYPE_INVALID',
  'ENCODING_INVALID',
  'ATOMIC_REPLACE_FAILED',
  'START_FAILED',
  'TIMEOUT',
  'EXIT_NONZERO',
  'CORRUPT_FIXTURE',
  'OUT_OF_RANGE',
  'DEVICE_DISABLED',
  'LOOPBACK_ONLY',
  'TOPIC_FORBIDDEN',
  'SEQUENCE_GAP',
  'INTERNAL_FIXTURE_ERROR',
] as const
const SCHEMA_BEARING_KEYS = Object.freeze([
  'properties',
  'required',
  'enum',
  'const',
  '$ref',
  'oneOf',
  'anyOf',
  'allOf',
] as const)
const EXPECTED_OPENAPI_OPERATIONS = Object.freeze([
  { method: 'post', path: '/api/v1/auth/login', operationId: 'postapiV1AuthLogin' },
  { method: 'get', path: '/api/v1/auth/session', operationId: 'getapiV1AuthSession' },
  { method: 'post', path: '/api/v1/auth/logout', operationId: 'postapiV1AuthLogout' },
  { method: 'get', path: '/api/v1/auth/permissions', operationId: 'getapiV1AuthPermissions' },
  { method: 'get', path: '/api/v1/meta/capabilities', operationId: 'getapiV1MetaCapabilities' },
  { method: 'get', path: '/api/v1/meta/interfaces', operationId: 'getapiV1MetaInterfaces' },
  { method: 'get', path: '/api/v1/meta/decisions', operationId: 'getapiV1MetaDecisions' },
  { method: 'get', path: '/api/v1/meta/routes', operationId: 'getapiV1MetaRoutes' },
  { method: 'get', path: '/api/v1/scenarios', operationId: 'getapiV1Scenarios' },
  { method: 'post', path: '/api/v1/scenarios', operationId: 'postapiV1Scenarios' },
  { method: 'get', path: '/api/v1/scenarios/{scenarioId}', operationId: 'getapiV1ScenariosScenarioId' },
  { method: 'delete', path: '/api/v1/scenarios/{scenarioId}', operationId: 'deleteapiV1ScenariosScenarioId' },
  { method: 'put', path: '/api/v1/scenarios/{scenarioId}', operationId: 'putapiV1ScenariosScenarioId' },
  { method: 'post', path: '/api/v1/scenarios/{scenarioId}/validate', operationId: 'postapiV1ScenariosScenarioIdValidate' },
  { method: 'post', path: '/api/v1/scenarios/{scenarioId}/undo', operationId: 'postapiV1ScenariosScenarioIdUndo' },
  { method: 'post', path: '/api/v1/scenarios/{scenarioId}/reset', operationId: 'postapiV1ScenariosScenarioIdReset' },
  { method: 'post', path: '/api/v1/scenarios/import', operationId: 'postapiV1ScenariosImport' },
  { method: 'get', path: '/api/v1/templates', operationId: 'getapiV1Templates' },
  { method: 'post', path: '/api/v1/templates', operationId: 'postapiV1Templates' },
  { method: 'get', path: '/api/v1/templates/{templateId}', operationId: 'getapiV1TemplatesTemplateId' },
  { method: 'put', path: '/api/v1/templates/{templateId}', operationId: 'putapiV1TemplatesTemplateId' },
  { method: 'delete', path: '/api/v1/templates/{templateId}', operationId: 'deleteapiV1TemplatesTemplateId' },
  { method: 'post', path: '/api/v1/templates/{templateId}/copy', operationId: 'postapiV1TemplatesTemplateIdCopy' },
  { method: 'post', path: '/api/v1/scripts/preview', operationId: 'postapiV1ScriptsPreview' },
  { method: 'post', path: '/api/v1/scripts/{scriptId}/preflight', operationId: 'postapiV1ScriptsScriptIdPreflight' },
  { method: 'get', path: '/api/v1/contracts/scenario-config', operationId: 'getapiV1ContractsScenarioConfig' },
  { method: 'get', path: '/api/v1/contracts/frontend-types', operationId: 'getapiV1ContractsFrontendTypes' },
  { method: 'get', path: '/api/v1/contracts/csv', operationId: 'getapiV1ContractsCsv' },
  { method: 'get', path: '/api/v1/simulations', operationId: 'getapiV1Simulations' },
  { method: 'post', path: '/api/v1/simulations', operationId: 'postapiV1Simulations' },
  { method: 'get', path: '/api/v1/simulations/{runId}', operationId: 'getapiV1SimulationsRunId' },
  { method: 'post', path: '/api/v1/simulations/{runId}/commands', operationId: 'postapiV1SimulationsRunIdCommands' },
  { method: 'post', path: '/api/v1/tasks/{taskId}/jammers/{jammerId}/commands', operationId: 'postapiV1TasksTaskIdJammersJammerIdCommands' },
  { method: 'post', path: '/api/v1/tasks/{taskId}/jammers/{jammerId}/parameters', operationId: 'postapiV1TasksTaskIdJammersJammerIdParameters' },
  { method: 'get', path: '/api/v1/simulations/{runId}/frames/{frameId}', operationId: 'getapiV1SimulationsRunIdFramesFrameId' },
  { method: 'get', path: '/api/v1/simulations/{runId}/events', operationId: 'getapiV1SimulationsRunIdEvents' },
  { method: 'post', path: '/api/v1/simulations/{runId}/events', operationId: 'postapiV1SimulationsRunIdEvents' },
  { method: 'get', path: '/api/v1/batches', operationId: 'getapiV1Batches' },
  { method: 'post', path: '/api/v1/batches', operationId: 'postapiV1Batches' },
  { method: 'get', path: '/api/v1/batches/{batchId}', operationId: 'getapiV1BatchesBatchId' },
  { method: 'post', path: '/api/v1/batches/{batchId}/commands', operationId: 'postapiV1BatchesBatchIdCommands' },
  { method: 'get', path: '/api/v1/reports', operationId: 'getapiV1Reports' },
  { method: 'get', path: '/api/v1/reports/{reportId}', operationId: 'getapiV1ReportsReportId' },
  { method: 'post', path: '/api/v1/reports/{reportId}/export', operationId: 'postapiV1ReportsReportIdExport' },
  { method: 'post', path: '/api/v1/confirmations', operationId: 'postapiV1Confirmations' },
  { method: 'post', path: '/api/v1/confirmations/{confirmationId}', operationId: 'postapiV1ConfirmationsConfirmationId' },
  { method: 'get', path: '/api/v1/replays', operationId: 'getapiV1Replays' },
  { method: 'get', path: '/api/v1/replays/{replayId}', operationId: 'getapiV1ReplaysReplayId' },
  { method: 'post', path: '/api/v1/replays/{replayId}/commands', operationId: 'postapiV1ReplaysReplayIdCommands' },
  { method: 'get', path: '/api/v1/admin/master-data', operationId: 'getapiV1AdminMasterData' },
  { method: 'post', path: '/api/v1/admin/master-data', operationId: 'postapiV1AdminMasterData' },
  { method: 'put', path: '/api/v1/admin/master-data/{dataId}', operationId: 'putapiV1AdminMasterDataDataId' },
  { method: 'delete', path: '/api/v1/admin/master-data/{dataId}', operationId: 'deleteapiV1AdminMasterDataDataId' },
  { method: 'get', path: '/api/v1/admin/users', operationId: 'getapiV1AdminUsers' },
  { method: 'post', path: '/api/v1/admin/users', operationId: 'postapiV1AdminUsers' },
  { method: 'put', path: '/api/v1/admin/users/{userId}', operationId: 'putapiV1AdminUsersUserId' },
  { method: 'delete', path: '/api/v1/admin/users/{userId}', operationId: 'deleteapiV1AdminUsersUserId' },
  { method: 'get', path: '/api/v1/admin/audit', operationId: 'getapiV1AdminAudit' },
  { method: 'post', path: '/api/v1/admin/audit/export', operationId: 'postapiV1AdminAuditExport' },
  { method: 'get', path: '/api/v1/admin/backups', operationId: 'getapiV1AdminBackups' },
  { method: 'post', path: '/api/v1/admin/backup', operationId: 'postapiV1AdminBackup' },
  { method: 'post', path: '/api/v1/admin/restore', operationId: 'postapiV1AdminRestore' },
  { method: 'get', path: '/api/v1/admin/health', operationId: 'getapiV1AdminHealth' },
  { method: 'get', path: '/api/v1/admin/archives', operationId: 'getapiV1AdminArchives' },
  { method: 'post', path: '/api/v1/reset', operationId: 'postapiV1Reset' },
  { method: 'get', path: '/ws/v1', operationId: 'getwsV1' },
  { method: 'post', path: '/api/v1/admin/config/export', operationId: 'postapiV1AdminConfigExport' },
] as const satisfies readonly OperationContract[])
const EXPECTED_OPENAPI_SCHEMA_BINDINGS = Object.freeze({
  postapiV1AuthLogin: operationSchemaBinding('#/components/schemas/LoginRequest', '200', '#/components/schemas/AuthResult'),
  getapiV1AuthSession: operationSchemaBinding(null, '200', '#/components/schemas/AuthResult'),
  postapiV1AuthLogout: operationSchemaBinding('#/components/schemas/LogoutRequest', '200', '#/components/schemas/AuthResult'),
  getapiV1AuthPermissions: operationSchemaBinding(null, '200', '#/components/schemas/PermissionSet'),
  getapiV1MetaCapabilities: operationSchemaBinding(null, '200', '#/components/schemas/CapabilityMetadataList'),
  getapiV1MetaInterfaces: operationSchemaBinding(null, '200', '#/components/schemas/InterfaceMetadataList'),
  getapiV1MetaDecisions: operationSchemaBinding(null, '200', '#/components/schemas/DecisionMetadataList'),
  getapiV1MetaRoutes: operationSchemaBinding(null, '200', '#/components/schemas/RouteMetadataList'),
  getapiV1Scenarios: operationSchemaBinding(null, '200', '#/components/schemas/ScenarioList'),
  postapiV1Scenarios: operationSchemaBinding('#/components/schemas/ScenarioDraftUpdate', '201', '#/components/schemas/ScenarioDraft'),
  deleteapiV1ScenariosScenarioId: operationSchemaBinding(null, '200', '#/components/schemas/DeleteResult'),
  getapiV1ScenariosScenarioId: operationSchemaBinding(null, '200', '#/components/schemas/ScenarioDraft'),
  putapiV1ScenariosScenarioId: operationSchemaBinding('#/components/schemas/ScenarioDraftUpdate', '200', '#/components/schemas/ScenarioDraft'),
  postapiV1ScenariosScenarioIdValidate: operationSchemaBinding('#/components/schemas/ScenarioValidationRequest', '200', '#/components/schemas/ValidationResult'),
  postapiV1ScenariosScenarioIdUndo: operationSchemaBinding('#/components/schemas/MutationRequest', '200', '#/components/schemas/ScenarioDraft'),
  postapiV1ScenariosScenarioIdReset: operationSchemaBinding('#/components/schemas/MutationRequest', '200', '#/components/schemas/ScenarioDraft'),
  postapiV1ScenariosImport: operationSchemaBinding('#/components/schemas/ScenarioImportRequest', '200', '#/components/schemas/ImportResult'),
  getapiV1Templates: operationSchemaBinding(null, '200', '#/components/schemas/TemplateList'),
  postapiV1Templates: operationSchemaBinding('#/components/schemas/TemplateMutationRequest', '201', '#/components/schemas/ScenarioTemplate'),
  getapiV1TemplatesTemplateId: operationSchemaBinding(null, '200', '#/components/schemas/ScenarioTemplate'),
  putapiV1TemplatesTemplateId: operationSchemaBinding('#/components/schemas/TemplateMutationRequest', '200', '#/components/schemas/ScenarioTemplate'),
  deleteapiV1TemplatesTemplateId: operationSchemaBinding(null, '200', '#/components/schemas/DeleteResult'),
  postapiV1TemplatesTemplateIdCopy: operationSchemaBinding('#/components/schemas/CopyTemplateRequest', '201', '#/components/schemas/ScenarioDraft'),
  postapiV1ScriptsPreview: operationSchemaBinding('#/components/schemas/ScriptPreviewRequest', '200', '#/components/schemas/ScriptContract'),
  postapiV1ScriptsScriptIdPreflight: operationSchemaBinding('#/components/schemas/PreflightRequest', '200', '#/components/schemas/ValidationResult'),
  getapiV1ContractsScenarioConfig: operationSchemaBinding(null, '200', '#/components/schemas/ContractDescriptor'),
  getapiV1ContractsFrontendTypes: operationSchemaBinding(null, '200', '#/components/schemas/FrontendContractList'),
  getapiV1ContractsCsv: operationSchemaBinding(null, '200', '#/components/schemas/CsvContractList'),
  getapiV1Simulations: operationSchemaBinding(null, '200', '#/components/schemas/SimulationRunList'),
  postapiV1Simulations: operationSchemaBinding('#/components/schemas/SimulationCreateRequest', '201', '#/components/schemas/SimulationRun'),
  getapiV1SimulationsRunId: operationSchemaBinding(null, '200', '#/components/schemas/SimulationRun'),
  postapiV1SimulationsRunIdCommands: operationSchemaBinding('#/components/schemas/SimulationCommand', '200', '#/components/schemas/SimulationRun'),
  postapiV1TasksTaskIdJammersJammerIdCommands: operationSchemaBinding('#/components/schemas/JammingCommand', '200', '#/components/schemas/JammerState'),
  postapiV1TasksTaskIdJammersJammerIdParameters: operationSchemaBinding('#/components/schemas/JammingParameterSet', '200', '#/components/schemas/SyncResult'),
  getapiV1SimulationsRunIdFramesFrameId: operationSchemaBinding(null, '200', '#/components/schemas/TelemetryFrame'),
  getapiV1SimulationsRunIdEvents: operationSchemaBinding(null, '200', '#/components/schemas/EventList'),
  postapiV1SimulationsRunIdEvents: operationSchemaBinding('#/components/schemas/ClosedLoopContext', '200', '#/components/schemas/JammingDecision'),
  getapiV1Batches: operationSchemaBinding(null, '200', '#/components/schemas/BatchList'),
  postapiV1Batches: operationSchemaBinding('#/components/schemas/BatchRequest', '201', '#/components/schemas/Batch'),
  getapiV1BatchesBatchId: operationSchemaBinding(null, '200', '#/components/schemas/BatchDetail'),
  postapiV1BatchesBatchIdCommands: operationSchemaBinding('#/components/schemas/BatchCommand', '200', '#/components/schemas/Batch'),
  getapiV1Reports: operationSchemaBinding(null, '200', '#/components/schemas/ReportList'),
  getapiV1ReportsReportId: operationSchemaBinding(null, '200', '#/components/schemas/Report'),
  postapiV1ReportsReportIdExport: operationSchemaBinding('#/components/schemas/ReportExportRequest', '200', '#/components/schemas/ReportExportResult'),
  postapiV1Confirmations: operationSchemaBinding('#/components/schemas/ConfirmationRequest', '201', '#/components/schemas/ConfirmationContext'),
  postapiV1ConfirmationsConfirmationId: operationSchemaBinding('#/components/schemas/ConfirmRequest', '200', '#/components/schemas/ConfirmationContext'),
  getapiV1Replays: operationSchemaBinding(null, '200', '#/components/schemas/ReplayList'),
  getapiV1ReplaysReplayId: operationSchemaBinding(null, '200', '#/components/schemas/Replay'),
  postapiV1ReplaysReplayIdCommands: operationSchemaBinding('#/components/schemas/ReplayCommand', '200', '#/components/schemas/Replay'),
  getapiV1AdminMasterData: operationSchemaBinding(null, '200', '#/components/schemas/MasterDataList'),
  postapiV1AdminMasterData: operationSchemaBinding('#/components/schemas/MasterDataRequest', '201', '#/components/schemas/MasterData'),
  putapiV1AdminMasterDataDataId: operationSchemaBinding('#/components/schemas/MasterDataRequest', '200', '#/components/schemas/MasterData'),
  deleteapiV1AdminMasterDataDataId: operationSchemaBinding(null, '200', '#/components/schemas/DeleteResult'),
  getapiV1AdminUsers: operationSchemaBinding(null, '200', '#/components/schemas/UserList'),
  postapiV1AdminUsers: operationSchemaBinding('#/components/schemas/UserRoleCommand', '201', '#/components/schemas/User'),
  putapiV1AdminUsersUserId: operationSchemaBinding('#/components/schemas/UserRoleCommand', '200', '#/components/schemas/User'),
  deleteapiV1AdminUsersUserId: operationSchemaBinding(null, '200', '#/components/schemas/DeleteResult'),
  getapiV1AdminAudit: operationSchemaBinding(null, '200', '#/components/schemas/AuditList'),
  postapiV1AdminAuditExport: operationSchemaBinding('#/components/schemas/AuditExportRequest', '200', '#/components/schemas/AuditExportResult'),
  getapiV1AdminBackups: operationSchemaBinding(null, '200', '#/components/schemas/BackupList'),
  postapiV1AdminBackup: operationSchemaBinding('#/components/schemas/BackupRequest', '200', '#/components/schemas/BackupRecord'),
  postapiV1AdminRestore: operationSchemaBinding('#/components/schemas/RestoreRequest', '200', '#/components/schemas/RestoreResult'),
  getapiV1AdminHealth: operationSchemaBinding(null, '200', '#/components/schemas/SystemHealth'),
  getapiV1AdminArchives: operationSchemaBinding(null, '200', '#/components/schemas/ArchiveList'),
  postapiV1Reset: operationSchemaBinding('#/components/schemas/ResetRequest', '200', '#/components/schemas/ResetResult'),
  getwsV1: operationSchemaBinding(null, '101', null),
  postapiV1AdminConfigExport: operationSchemaBinding('#/components/schemas/FullConfigExportRequest', '200', '#/components/schemas/ExportStatus'),
} satisfies Record<(typeof EXPECTED_OPENAPI_OPERATIONS)[number]['operationId'], OperationSchemaBinding>)
const EXPECTED_OPENAPI_ERROR_STATUSES = Object.freeze({
  postapiV1AuthLogin: ['401', '423', '429'],
  getapiV1AuthSession: ['403'],
  postapiV1AuthLogout: ['400', '403'],
  getapiV1AuthPermissions: ['401', '403'],
  getapiV1MetaCapabilities: ['401'],
  getapiV1MetaInterfaces: ['401'],
  getapiV1MetaDecisions: ['401'],
  getapiV1MetaRoutes: ['401'],
  getapiV1Scenarios: ['401', '403', '503'],
  postapiV1Scenarios: ['401', '403', '409', '422', '503'],
  getapiV1ScenariosScenarioId: ['401', '404', '503'],
  deleteapiV1ScenariosScenarioId: ['401', '403', '404', '409', '422', '503'],
  putapiV1ScenariosScenarioId: ['401', '409', '422', '503'],
  postapiV1ScenariosScenarioIdValidate: ['401', '409', '422', '503'],
  postapiV1ScenariosScenarioIdUndo: ['401', '404', '409', '422', '503'],
  postapiV1ScenariosScenarioIdReset: ['401', '404', '409', '422', '503'],
  postapiV1ScenariosImport: ['401', '409', '422', '503'],
  getapiV1Templates: ['401', '503'],
  postapiV1Templates: ['401', '403', '409', '422', '503'],
  getapiV1TemplatesTemplateId: ['401', '404', '503'],
  putapiV1TemplatesTemplateId: ['401', '403', '404', '409', '422', '503'],
  deleteapiV1TemplatesTemplateId: ['401', '403', '404', '409', '428', '503'],
  postapiV1TemplatesTemplateIdCopy: ['401', '403', '404', '409', '422', '503'],
  postapiV1ScriptsPreview: ['401', '409', '422', '428'],
  postapiV1ScriptsScriptIdPreflight: ['401', '422'],
  getapiV1ContractsScenarioConfig: ['401'],
  getapiV1ContractsFrontendTypes: ['401'],
  getapiV1ContractsCsv: ['401'],
  getapiV1Simulations: ['401'],
  postapiV1Simulations: ['401', '409'],
  getapiV1SimulationsRunId: ['401', '404'],
  postapiV1SimulationsRunIdCommands: ['401', '409', '428'],
  postapiV1TasksTaskIdJammersJammerIdCommands: ['401', '403', '404', '409', '422'],
  postapiV1TasksTaskIdJammersJammerIdParameters: ['401', '403', '404', '409', '422'],
  getapiV1SimulationsRunIdFramesFrameId: ['401', '404'],
  getapiV1SimulationsRunIdEvents: ['401'],
  postapiV1SimulationsRunIdEvents: ['401', '403', '404', '409', '422'],
  getapiV1Batches: ['401'],
  postapiV1Batches: ['401', '422'],
  getapiV1BatchesBatchId: ['401', '404', '409'],
  postapiV1BatchesBatchIdCommands: ['401', '409'],
  getapiV1Reports: ['401'],
  getapiV1ReportsReportId: ['401'],
  postapiV1ReportsReportIdExport: ['401', '403', '428'],
  postapiV1Confirmations: ['401', '400', '403'],
  postapiV1ConfirmationsConfirmationId: ['401', '400', '403', '409'],
  getapiV1Replays: ['401'],
  getapiV1ReplaysReplayId: ['401'],
  postapiV1ReplaysReplayIdCommands: ['401', '409'],
  getapiV1AdminMasterData: ['401', '403'],
  postapiV1AdminMasterData: ['401', '403', '409', '422'],
  putapiV1AdminMasterDataDataId: ['401', '403', '404', '409', '422'],
  deleteapiV1AdminMasterDataDataId: ['401', '403', '404', '409', '428'],
  getapiV1AdminUsers: ['401'],
  postapiV1AdminUsers: ['401'],
  putapiV1AdminUsersUserId: ['401', '409'],
  deleteapiV1AdminUsersUserId: ['401', '409'],
  getapiV1AdminAudit: ['401', '400', '403'],
  postapiV1AdminAuditExport: ['401', '400', '403', '409', '428'],
  getapiV1AdminBackups: ['401', '403'],
  postapiV1AdminBackup: ['401', '403', '404', '409', '422', '428'],
  postapiV1AdminRestore: ['401', '403', '404', '409', '422', '428'],
  getapiV1AdminHealth: ['401', '403'],
  getapiV1AdminArchives: ['401', '403'],
  postapiV1Reset: ['401'],
  getwsV1: ['401', '400', '403'],
  postapiV1AdminConfigExport: ['401', '403', '409', '422', '428'],
} satisfies Record<(typeof EXPECTED_OPENAPI_OPERATIONS)[number]['operationId'], readonly string[]>)
const EXPECTED_COMPONENT_SCHEMA_LITERALS = Object.freeze([
  ['#/components/schemas/Platform/allOf/0/if/properties/type/const','REAR_COMMAND_NODE'],
  ['#/components/schemas/Platform/allOf/0/then/properties/category/const','ground'],
  ['#/components/schemas/Platform/allOf/1/if/properties/type/const','FORWARD_RELAY_NODE'],
  ['#/components/schemas/Platform/allOf/1/then/properties/category/const','air'],
  ['#/components/schemas/Platform/allOf/2/if/properties/type/const','GROUND_CLUSTER_COMMAND_NODE'],
  ['#/components/schemas/Platform/allOf/2/then/properties/category/const','ground'],
  ['#/components/schemas/Platform/allOf/3/if/properties/type/const','AIRBORNE_MISSION_CLUSTER'],
  ['#/components/schemas/Platform/allOf/3/then/properties/category/const','air'],
  ['#/components/schemas/Platform/allOf/4/if/properties/type/const','COMMUNICATION_SATELLITE'],
  ['#/components/schemas/Platform/allOf/4/then/properties/category/const','space'],
  ['#/components/schemas/Platform/allOf/5/if/properties/type/const','GROUND_JAMMER_DETECTION_STATION'],
  ['#/components/schemas/Platform/allOf/5/then/properties/category/const','ground'],
  ['#/components/schemas/Platform/allOf/6/if/properties/type/const','COMMUNICATION_SATELLITE'],
  ['#/components/schemas/Platform/allOf/7/if/properties/type/const','AIRBORNE_JAMMER_PLATFORM'],
  ['#/components/schemas/Platform/allOf/7/then/properties/category/const','air'],
  ['#/components/schemas/PlatformWrite/allOf/1/if/properties/type/const','COMMUNICATION_SATELLITE'],
  ['#/components/parameters/DemoRole/schema/enum', ['ADMIN','OPERATOR']],
  ['#/components/schemas/UserRoleCommand/allOf/0/then/properties/operation/const', 'CREATE'],
  ['#/components/schemas/LogoutRequest/properties/confirm/const', true],
  ['#/components/schemas/GetapiV1AuthSessionResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1AuthLogoutResponse/properties/ok/const', true],
  ['#/components/schemas/Environment/properties/rainCloudAttenuation/enum', ['none','lightRain','moderateRain','heavyRain']],
  ['#/components/schemas/Platform/properties/type/enum', ['REAR_COMMAND_NODE','FORWARD_RELAY_NODE','GROUND_CLUSTER_COMMAND_NODE','AIRBORNE_MISSION_CLUSTER','COMMUNICATION_SATELLITE','GROUND_JAMMER_DETECTION_STATION','AIRBORNE_JAMMER_PLATFORM']],
  ['#/components/schemas/Platform/properties/satelliteType/enum', ['TIANTONG','SHENTONG']],
  ['#/components/schemas/Platform/properties/category/enum', ['ground','air','space']],
  ['#/components/schemas/Link/properties/type/enum', ['SAT','MICROWAVE','DATALINK','LASER']],
  ['#/components/schemas/Link/allOf/0/if/properties/type/const', 'SAT'],
  ['#/components/schemas/ScenarioLinkSettings/properties/priority/items/enum', ['SAT','MICROWAVE','DATALINK','LASER']],
  ['#/components/schemas/Link/properties/modulation/enum', ['BPSK','QPSK']],
  ['#/components/schemas/Link/properties/direction/enum', ['FORWARD','REVERSE']],
  ['#/components/schemas/Jammer/properties/type/enum', ['BARRAGE','SPOT','SWEEP']],
  ['#/components/schemas/InformationDemand/properties/priority/enum', ['HIGH','NORMAL']],
  ['#/components/schemas/InformationDemand/properties/direction/enum', ['FORWARD','REVERSE']],
  ['#/components/schemas/ScenarioConfig/properties/schemaVersion/const', '1.0'],
  ['#/components/schemas/LinkQualityData/properties/linkType/enum', ['SAT','MICROWAVE','DATALINK','LASER']],
  ['#/components/schemas/LinkQualityData/properties/modulation/enum', ['BPSK','QPSK']],
  ['#/components/schemas/LinkQualityData/properties/linkStatus/enum', ['UP','DOWN']],
  ['#/components/schemas/TelemetryLinkRecord/properties/linkType/enum', ['SAT','MICROWAVE','DATALINK','LASER']],
  ['#/components/schemas/TelemetryLinkRecord/properties/modulation/enum', ['BPSK','QPSK']],
  ['#/components/schemas/TelemetryLinkRecord/properties/linkStatus/enum', ['UP','DOWN']],
  ['#/components/schemas/PlatformStatus/properties/type/enum', ['REAR_COMMAND_NODE','FORWARD_RELAY_NODE','GROUND_CLUSTER_COMMAND_NODE','AIRBORNE_MISSION_CLUSTER','COMMUNICATION_SATELLITE','GROUND_JAMMER_DETECTION_STATION','AIRBORNE_JAMMER_PLATFORM']],
  ['#/components/schemas/SimulationState/properties/status/enum', ['IDLE','RUNNING','PAUSED','COMPLETED','ERROR']],
  ['#/components/schemas/UiLinkProjection/properties/status/enum', ['UP','DEGRADED','DOWN']],
  ['#/components/schemas/UiLinkProjection/properties/canonicalStatus/enum', ['UP','DOWN']],
  ['#/components/schemas/UiLinkProjection/properties/thresholdVersion/const', 'LLZT-1.0'],
  ['#/components/schemas/CompositeLossEvidence/properties/modelVersion/const', 'COMPOSITE-LOSS-1.0'],
  ['#/components/schemas/TelemetryLinkRecord/properties/coding/const', 'UNCODED'],
  ['#/components/schemas/TelemetryLinkRecord/properties/qualityModelVersion/const', 'SNBER-1.2'],
  ['#/components/schemas/RouteCandidateEvidence/properties/direction/enum', ['FORWARD','REVERSE']],
  ['#/components/schemas/SynchronizationEvidence/properties/configVersion/const', 'SCN-001-v4'],
  ['#/components/schemas/SynchronizationEvidence/properties/engineVersion/const', 'AFSIM-2.9.0-FIXTURE'],
  ['#/components/schemas/SynchronizationEvidence/properties/uiVersion/const', 'FRAME-1.0'],
  ['#/components/schemas/EventRecord/properties/type/enum', ['DETECTION','LINK_SWITCH']],
  ['#/components/schemas/EventRecord/properties/decision/enum', ['ACCEPTED','REJECTED']],
  ['#/components/schemas/EventRecord/properties/direction/enum', ['FORWARD','REVERSE']],
  ['#/components/schemas/EventRecord/allOf/0/if/properties/type/const', 'DETECTION'],
  ['#/components/schemas/EventRecord/allOf/1/if/properties/type/const', 'LINK_SWITCH'],
  ['#/components/schemas/SimulationRun/properties/uiStatus/enum', ['IDLE','RUNNING','PAUSED','STOPPED','COMPLETED','ERROR']],
  ['#/components/schemas/ValidationIssue/properties/severity/enum', ['ERROR','WARNING']],
  ['#/components/schemas/SensorUiExtension/properties/type/const', 'ESM'],
  ['#/components/schemas/SensorUiExtension/properties/direction/oneOf/0/const', 'OMNI'],
  ['#/components/schemas/ScenarioDraft/properties/officialLibraryChanged/const', false],
  ['#/components/schemas/ScriptContract/properties/target/const', 'AFSIM 2.9.0'],
  ['#/components/schemas/BatchRunResult/properties/status/enum', ['COMPLETED','ERROR']],
  ['#/components/schemas/Batch/properties/state/enum', ['DRAFT','VALIDATING','QUEUED','RUNNING','COMPLETED','PARTIAL_FAILURE','CANCELLED','ERROR']],
  ['#/components/schemas/Report/properties/classification/enum', ['LEVEL_II','LEVEL_III']],
  ['#/components/schemas/Report/properties/status/const', 'READY'],
  ['#/components/schemas/Replay/properties/state/enum', ['EMPTY','LOADING','PAUSED','PLAYING','SEEKING','COMPLETED','CORRUPT','ERROR']],
  ['#/components/schemas/User/properties/role/enum', ['ADMIN','OPERATOR']],
  ['#/components/schemas/User/properties/status/enum', ['ACTIVE','DISABLED','LOCKED']],
  ['#/components/schemas/BackupRecord/properties/status/enum', ['VALID_FIXTURE','INVALID_FIXTURE']],
  ['#/components/schemas/AuditRecord/properties/role/enum', ['ADMIN','OPERATOR']],
  ['#/components/schemas/AuditRecord/properties/result/enum', ['SUCCESS','DENIED','ERROR']],
  ['#/components/schemas/AuditRecord/properties/immutableFixture/const', true],
  ['#/components/schemas/SystemHealth/properties/ui/const', 'HEALTHY'],
  ['#/components/schemas/SystemHealth/properties/engine/const', 'NOT_CONNECTED_BY_DESIGN'],
  ['#/components/schemas/SystemHealth/properties/database/const', 'NOT_CONNECTED_BY_DESIGN'],
  ['#/components/schemas/SystemHealth/properties/channel/const', 'NOT_CONNECTED_BY_DESIGN'],
  ['#/components/schemas/ArchiveRecord/properties/status/const', 'INDEXED'],
  ['#/components/schemas/ErrorCode/enum', ['INVALID_REQUEST','VALIDATION_FAILED','NOT_FOUND','CONFLICT','INVALID_CREDENTIALS','ACCOUNT_LOCKED','PERMISSION_DENIED','LAST_ADMIN_GUARD','CONFIRMATION_REQUIRED','CONFIRMATION_EXPIRED','CONFIG_LOCKED','INVALID_TRANSITION','NODE_LIMIT_EXCEEDED','DUPLICATE_EVENT','VERSION_CONFLICT','FRAME_MISMATCH','HEADER_INVALID','TYPE_INVALID','ENCODING_INVALID','ATOMIC_REPLACE_FAILED','START_FAILED','TIMEOUT','EXIT_NONZERO','CORRUPT_FIXTURE','OUT_OF_RANGE','DEVICE_DISABLED','LOOPBACK_ONLY','TOPIC_FORBIDDEN','SEQUENCE_GAP','INTERNAL_FIXTURE_ERROR']],
  ['#/components/schemas/ErrorEnvelope/properties/ok/const', false],
  ['#/components/schemas/AuthResult/properties/principal/properties/role/enum', ['ADMIN','OPERATOR']],
  ['#/components/schemas/AuthResult/properties/reason/enum', ['INVALID_CREDENTIALS','ACCOUNT_LOCKED']],
  ['#/components/schemas/PermissionSet/properties/role/enum', ['ADMIN','OPERATOR']],
  ['#/components/schemas/CapabilityMetadata/allOf/0/if/properties/id/enum', ['DSDWRJQTLJS-XQ-FZYXYLLJS-LLJS','DSDWRJQTLJS-XQ-FZYXYLLJS-FHSX','DSDWRJQTLJS-XQ-FZYXYLLJS-SNBER','DSDWRJQTLJS-XQ-FZYXYLLJS-LLZT','DSDWRJQTLJS-XQ-GRYGZ-ESMGL','DSDWRJQTLJS-XQ-LLQHYYX-LLJC','DSDWRJQTLJS-XQ-LLQHYYX-QXL','DSDWRJQTLJS-XQ-LLQHYYX-HXL','DSDWRJQTLJS-XQ-LLQHYYX-QHJY']],
  ['#/components/schemas/CapabilityMetadata/allOf/0/then/properties/states/not/contains/const', 'EXECUTING'],
  ['#/components/schemas/CapabilityMetadata/properties/coverage/enum', ['INTERACTIVE_UI','VISIBLE_CONTRACT']],
  ['#/components/schemas/CapabilityMetadata/properties/states/items/enum', ['LOADING','VALIDATING','EXECUTING','SUCCESS','EMPTY','ERROR']],
  ['#/components/schemas/InterfaceMetadata/properties/kind/enum', ['外部','内部']],
  ['#/components/schemas/ReportExportResult/properties/generated/const', false],
  ['#/components/schemas/ReportExportResult/properties/status/const', 'FIXTURE_SUCCESS'],
  ['#/components/schemas/ConfirmationContext/properties/state/enum', ['CLOSED','AWAITING_CONFIRMATION','CONFIRMED','CANCELLED','EXPIRED','ERROR']],
  ['#/components/schemas/ConfirmationContext/properties/role/enum', ['ADMIN','OPERATOR']],
  ['#/components/schemas/RestoreResult/properties/result/enum', ['SUCCESS','FAILURE']],
  ['#/components/schemas/RestoreResult/properties/generated/const', false],
  ['#/components/schemas/ExportStatus/properties/generated/const', false],
  ['#/components/schemas/ExportStatus/properties/classification/enum', ['INTERNAL','LEVEL_II','LEVEL_III']],
  ['#/components/schemas/ResetResult/properties/requestId/const', 'REQ-RESET-001'],
  ['#/components/schemas/ResetResult/properties/nextSequence/const', 1],
  ['#/components/schemas/SimulationCommand/properties/command/enum', ['START','PAUSE','RESUME','STEP','STOP','SET_SPEED']],
  ['#/components/schemas/SimulationCommand/properties/mode/enum', ['INTERACTIVE_SINGLE','BATCH_PARAMETER_TRAVERSAL','PARAMETER_SCAN','HISTORICAL_REPLAY']],
  ['#/components/schemas/SimulationCommand/properties/stepCount/const', 1],
  ['#/components/schemas/JammerState/properties/executionStatus/const', 'SUCCESS'],
  ['#/components/schemas/RouteDecision/properties/direction/enum', ['FORWARD','REVERSE']],
  ['#/components/schemas/RouteDecision/properties/strategy/enum', ['MIN_JAM_IMPACT','MIN_BER_WITH_HYSTERESIS']],
  ['#/components/schemas/JammingDecision/properties/action/const', 'START'],
  ['#/components/schemas/JammingDecision/properties/linkStatus/enum', ['UP','DEGRADED','DOWN']],
  ['#/components/schemas/SyncResult/properties/status/const', 'SYNCHRONIZED'],
  ['#/components/schemas/BatchRequest/properties/powersW/const', [50,100,150,200]],
  ['#/components/schemas/BatchRequest/properties/distancesKm/const', [80,100,120]],
  ['#/components/schemas/BatchRequest/properties/deterministicOrder/const', true],
  ['#/components/schemas/BatchCommand/properties/command/enum', ['START','CANCEL']],
  ['#/components/schemas/ReportExportRequest/properties/format/enum', ['HTML','PDF','CSV']],
  ['#/components/schemas/ConfirmationRequest/properties/action/enum', ['SCENARIO_WARNING_CONTINUE','OFFICIAL_TEMPLATE_DELETE','SIMULATION_STOP','BATCH_LEVEL_III_EXPORT','BACKUP_RESTORE','FULL_CONFIG_EXPORT','AUDIT_EXPORT','MASTER_DATA_DELETE']],
  ['#/components/schemas/ConfirmRequest/properties/confirm/const', true],
  ['#/components/schemas/ReplayCommand/properties/command/enum', ['PLAY','PAUSE','SEEK','STEP_FORWARD','STEP_BACK','SPEED']],
  ['#/components/schemas/MasterData/properties/dataId/not/enum', ['.','..']],
  ['#/components/schemas/MasterDataRequest/properties/operation/enum', ['CREATE','UPDATE','DELETE']],
  ['#/components/schemas/UserRoleCommand/properties/operation/enum', ['CREATE','UPDATE','DELETE','ENABLE','DISABLE']],
  ['#/components/schemas/AuditRequest/properties/role/enum', ['ADMIN','OPERATOR']],
  ['#/components/schemas/AuditRequest/properties/result/enum', ['SUCCESS','DENIED','ERROR']],
  ['#/components/schemas/BackupRequest/properties/operation/const', 'BACKUP'],
  ['#/components/schemas/RestoreRequest/properties/operation/const', 'RESTORE'],
  ['#/components/schemas/FullConfigExportRequest/properties/format/const', 'JSON'],
  ['#/components/schemas/ResetRequest/properties/confirm/const', true],
  ['#/components/schemas/FixtureValidationLink/properties/openApiDocument/const', 'mock-api.openapi.yaml'],
  ['#/components/schemas/FixtureValidationLink/properties/rootSchema/const', '#/components/schemas/DeterministicFixtures'],
  ['#/components/schemas/FixtureValidationLink/properties/typeContract/const', 'domain-models.ts#DeterministicFixtureSet'],
  ['#/components/schemas/FileArchiveFixture/properties/contract/enum', ['link_quality.csv','events.csv','link_switch.csv']],
  ['#/components/schemas/FileArchiveFixture/properties/status/const', 'VALID_FIXTURE'],
  ['#/components/schemas/ResetFixture/properties/method/const', 'POST'],
  ['#/components/schemas/ResetFixture/properties/path/const', '/api/v1/reset'],
  ['#/components/schemas/ResetFixture/properties/requestId/const', 'REQ-RESET-001'],
  ['#/components/schemas/ResetFixture/properties/nextSequence/const', 1],
  ['#/components/schemas/ScenarioCoverageFixture/properties/businessNodeTypes/items/enum', ['REAR_COMMAND_NODE','FORWARD_RELAY_NODE','GROUND_CLUSTER_COMMAND_NODE','AIRBORNE_MISSION_CLUSTER']],
  ['#/components/schemas/ScenarioCoverageFixture/properties/supportingEntityTypes/items/enum', ['COMMUNICATION_SATELLITE','GROUND_JAMMER_DETECTION_STATION','AIRBORNE_JAMMER_PLATFORM']],
  ['#/components/schemas/ScenarioCoverageFixture/properties/acceptedBusinessNodeCount/const', 50],
  ['#/components/schemas/ScenarioCoverageFixture/properties/rejectedBusinessNodeCount/const', 51],
  ['#/components/schemas/ScenarioCoverageFixture/properties/rejection/properties/code/const', 'NODE_LIMIT_EXCEEDED'],
  ['#/components/schemas/ScenarioCoverageFixture/properties/rejection/properties/fieldPath/const', 'platforms'],
  ['#/components/schemas/ScenarioCoverageFixture/properties/rejection/properties/mutationApplied/const', false],
  ['#/components/schemas/ScenarioCoverageFixture/properties/linkTypes/items/enum', ['SAT','MICROWAVE','DATALINK','LASER']],
  ['#/components/schemas/ScenarioCoverageFixture/properties/jammerTypes/items/enum', ['BARRAGE','SPOT','SWEEP']],
  ['#/components/schemas/ScenarioCoverageFixture/properties/minimumInformationDemandCount/const', 1],
  ['#/components/schemas/DeterministicFixtures/properties/schemaVersion/const', '1.0'],
  ['#/components/schemas/PostapiV1AuthLoginResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1TasksTaskIdJammersJammerIdCommandsResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1TasksTaskIdJammersJammerIdParametersResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1AuthPermissionsResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1MetaCapabilitiesResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1MetaInterfacesResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1MetaDecisionsResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1MetaRoutesResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1ScenariosResponse/properties/ok/const', true],
  ['#/components/schemas/DeleteapiV1ScenariosScenarioIdResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ScenariosResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1ScenariosScenarioIdResponse/properties/ok/const', true],
  ['#/components/schemas/PutapiV1ScenariosScenarioIdResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ScenariosScenarioIdValidateResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ScenariosScenarioIdUndoResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ScenariosScenarioIdResetResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ScenariosImportResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1TemplatesResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1TemplatesResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1TemplatesTemplateIdResponse/properties/ok/const', true],
  ['#/components/schemas/PutapiV1TemplatesTemplateIdResponse/properties/ok/const', true],
  ['#/components/schemas/DeleteapiV1TemplatesTemplateIdResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1TemplatesTemplateIdCopyResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ScriptsPreviewResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ScriptsScriptIdPreflightResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1ContractsScenarioConfigResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1ContractsFrontendTypesResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1ContractsCsvResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1SimulationsResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1SimulationsResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1SimulationsRunIdResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1SimulationsRunIdCommandsResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1SimulationsRunIdFramesFrameIdResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1SimulationsRunIdEventsResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1SimulationsRunIdEventsResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1BatchesResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1BatchesResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1BatchesBatchIdResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1BatchesBatchIdCommandsResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1ReportsResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1ReportsReportIdResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ReportsReportIdExportResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ConfirmationsResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ConfirmationsConfirmationIdResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1ReplaysResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1ReplaysReplayIdResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ReplaysReplayIdCommandsResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1AdminMasterDataResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1AdminMasterDataResponse/properties/ok/const', true],
  ['#/components/schemas/PutapiV1AdminMasterDataDataIdResponse/properties/ok/const', true],
  ['#/components/schemas/DeleteapiV1AdminMasterDataDataIdResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1AdminUsersResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1AdminUsersResponse/properties/ok/const', true],
  ['#/components/schemas/PutapiV1AdminUsersUserIdResponse/properties/ok/const', true],
  ['#/components/schemas/DeleteapiV1AdminUsersUserIdResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1AdminAuditResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1AdminAuditExportResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1AdminBackupsResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1AdminBackupResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1AdminRestoreResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1AdminHealthResponse/properties/ok/const', true],
  ['#/components/schemas/GetapiV1AdminArchivesResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1ResetResponse/properties/ok/const', true],
  ['#/components/schemas/PostapiV1AdminConfigExportResponse/properties/ok/const', true],
  ['#/components/schemas/AuditExportRequest/properties/role/enum', ['ADMIN','OPERATOR']],
  ['#/components/schemas/AuditExportRequest/properties/result/enum', ['SUCCESS','DENIED','ERROR']],
  ['#/components/schemas/AuditExportRequest/properties/export/const', true],
  ['#/components/schemas/AuditExportResult/properties/objectId/const', 'AUDIT-LOG'],
  ['#/components/schemas/AuditExportResult/properties/generated/const', true],
  ['#/components/schemas/AuditExportResult/properties/classification/const', 'INTERNAL'],
  ['#/components/schemas/LinkStatusSummary/properties/linkType/enum', ['SAT','MICROWAVE','DATALINK','LASER']],
  ['#/components/schemas/LinkStatusSummary/properties/status/enum', ['UP','DOWN']],
] as const satisfies readonly (readonly [string, unknown])[])
const EXPECTED_CAPABILITY_IDS = Object.freeze([
  'DSDWRJQTLJS-XQ-QDZS-STXR',
  'DSDWRJQTLJS-XQ-QDZS-ZBJK',
  'DSDWRJQTLJS-XQ-QDZS-LLTC',
  'DSDWRJQTLJS-XQ-QDZS-BBKSH',
  'DSDWRJQTLJS-XQ-CJPZYJBSC-CJKSH',
  'DSDWRJQTLJS-XQ-CJPZYJBSC-CSJY',
  'DSDWRJQTLJS-XQ-CJPZYJBSC-CJMB',
  'DSDWRJQTLJS-XQ-CJPZYJBSC-JBSC',
  'DSDWRJQTLJS-XQ-FZYXYLLJS-YQQD',
  'DSDWRJQTLJS-XQ-FZYXYLLJS-LLJS',
  'DSDWRJQTLJS-XQ-FZYXYLLJS-FHSX',
  'DSDWRJQTLJS-XQ-FZYXYLLJS-SNBER',
  'DSDWRJQTLJS-XQ-FZYXYLLJS-LLZT',
  'DSDWRJQTLJS-XQ-GRYGZ-ESMGL',
  'DSDWRJQTLJS-XQ-GRYGZ-RFGR',
  'DSDWRJQTLJS-XQ-GRYGZ-BHC',
  'DSDWRJQTLJS-XQ-GRYGZ-CSS',
  'DSDWRJQTLJS-XQ-LLQHYYX-LLJC',
  'DSDWRJQTLJS-XQ-LLQHYYX-QXL',
  'DSDWRJQTLJS-XQ-LLQHYYX-HXL',
  'DSDWRJQTLJS-XQ-LLQHYYX-QHJY',
  'DSDWRJQTLJS-XQ-SJJHYJK-CSVDX',
  'DSDWRJQTLJS-XQ-SJJHYJK-JSONJX',
  'DSDWRJQTLJS-XQ-SJJHYJK-WSTC',
  'DSDWRJQTLJS-XQ-SJJHYJK-JCGJ',
  'DSDWRJQTLJS-XQ-XTGL-JCSJ',
  'DSDWRJQTLJS-XQ-XTGL-YHJS',
  'DSDWRJQTLJS-XQ-XTGL-BFHF',
  'DSDWRJQTLJS-XQ-XTGL-CZRZ',
] as const)
const EXPECTED_INTERFACE_IDS = Object.freeze([
  'DSDWRJQTLJS-JK-YHCZ',
  'DSDWRJQTLJS-JK-WJXT',
  'DSDWRJQTLJS-JK-CZXT',
  'DSDWRJQTLJS-JK-QDZS-SJJHYJK',
  'DSDWRJQTLJS-JK-SJJHYJK-FZYXYLLJS',
  'DSDWRJQTLJS-JK-CJPZYJBSC-WJXT',
  'DSDWRJQTLJS-JK-CSCI-SJJH',
] as const)
const EXPECTED_DECISION_IDS = Object.freeze([
  'DEC-001',
  'DEC-002',
  'DEC-003',
  'DEC-004',
  'DEC-005',
  'DEC-006',
  'DEC-007',
  'DEC-008',
] as const)
const EXPECTED_UI_ROUTES = Object.freeze([
  '/login',
  '/situation',
  '/scenarios',
  '/batches',
  '/reports',
  '/replays',
  '/admin',
  '/blueprint',
  '/admin/data-exchange',
  '/traceability',
  '/interactions',
] as const)
const EXPECTED_CAPABILITY_DESTINATIONS = Object.freeze({
  'DSDWRJQTLJS-XQ-QDZS-STXR': 'cap-stxr',
  'DSDWRJQTLJS-XQ-QDZS-ZBJK': 'cap-zbjk',
  'DSDWRJQTLJS-XQ-QDZS-LLTC': 'cap-lltc',
  'DSDWRJQTLJS-XQ-QDZS-BBKSH': 'cap-bbksh',
  'DSDWRJQTLJS-XQ-CJPZYJBSC-CJKSH': 'cap-cjksh',
  'DSDWRJQTLJS-XQ-CJPZYJBSC-CSJY': 'cap-csjy',
  'DSDWRJQTLJS-XQ-CJPZYJBSC-CJMB': 'cap-cjmb',
  'DSDWRJQTLJS-XQ-CJPZYJBSC-JBSC': 'cap-jbsc',
  'DSDWRJQTLJS-XQ-FZYXYLLJS-YQQD': 'cap-yqqd',
  'DSDWRJQTLJS-XQ-FZYXYLLJS-LLJS': 'cap-lljs',
  'DSDWRJQTLJS-XQ-FZYXYLLJS-FHSX': 'cap-fhsx',
  'DSDWRJQTLJS-XQ-FZYXYLLJS-SNBER': 'cap-snber',
  'DSDWRJQTLJS-XQ-FZYXYLLJS-LLZT': 'cap-llzt',
  'DSDWRJQTLJS-XQ-GRYGZ-ESMGL': 'cap-esmgl',
  'DSDWRJQTLJS-XQ-GRYGZ-RFGR': 'cap-rfgr',
  'DSDWRJQTLJS-XQ-GRYGZ-BHC': 'cap-bhc',
  'DSDWRJQTLJS-XQ-GRYGZ-CSS': 'cap-css',
  'DSDWRJQTLJS-XQ-LLQHYYX-LLJC': 'cap-lljc',
  'DSDWRJQTLJS-XQ-LLQHYYX-QXL': 'cap-qxl',
  'DSDWRJQTLJS-XQ-LLQHYYX-HXL': 'cap-hxl',
  'DSDWRJQTLJS-XQ-LLQHYYX-QHJY': 'cap-qhjy',
  'DSDWRJQTLJS-XQ-SJJHYJK-CSVDX': 'de-cap-csvdx',
  'DSDWRJQTLJS-XQ-SJJHYJK-JSONJX': 'de-cap-jsonjx',
  'DSDWRJQTLJS-XQ-SJJHYJK-WSTC': 'de-cap-wstc',
  'DSDWRJQTLJS-XQ-SJJHYJK-JCGJ': 'de-cap-jcgj',
  'DSDWRJQTLJS-XQ-XTGL-JCSJ': 'cap-jcsj',
  'DSDWRJQTLJS-XQ-XTGL-YHJS': 'cap-yhjs',
  'DSDWRJQTLJS-XQ-XTGL-BFHF': 'cap-bfhf',
  'DSDWRJQTLJS-XQ-XTGL-CZRZ': 'cap-czrz',
} satisfies Record<(typeof EXPECTED_CAPABILITY_IDS)[number], string>)
const EXPECTED_INTERFACE_DESTINATIONS = Object.freeze({
  'DSDWRJQTLJS-JK-YHCZ': 'de-if-jk-yhcz',
  'DSDWRJQTLJS-JK-WJXT': 'de-if-jk-wjxt',
  'DSDWRJQTLJS-JK-CZXT': 'de-if-jk-czxt',
  'DSDWRJQTLJS-JK-QDZS-SJJHYJK': 'de-if-jk-qdzs-sjjhyjk',
  'DSDWRJQTLJS-JK-SJJHYJK-FZYXYLLJS': 'de-if-jk-sjjhyjk-fzyxylljs',
  'DSDWRJQTLJS-JK-CJPZYJBSC-WJXT': 'de-if-jk-cjpzyjbsc-wjxt',
  'DSDWRJQTLJS-JK-CSCI-SJJH': 'de-if-jk-csci-sjjh',
} satisfies Record<(typeof EXPECTED_INTERFACE_IDS)[number], string>)
const EXPECTED_CAPABILITY_STATES = Object.freeze([
  'LOADING',
  'VALIDATING',
  'EXECUTING',
  'SUCCESS',
  'EMPTY',
  'ERROR',
] as const)
const EXPECTED_FIXED_EVIDENCE_STATES = Object.freeze([
  'LOADING',
  'VALIDATING',
  'SUCCESS',
  'EMPTY',
  'ERROR',
] as const)
const EXPECTED_ROUTE_CONTRACTS = Object.freeze({
  '/login': routeContract('LoginPage', ['authStore', 'uiStore'], 'PUBLIC'),
  '/situation': routeContract('SituationPage', ['simulationStore', 'telemetryStore', 'uiStore'], 'requirePrincipal'),
  '/scenarios': routeContract('ScenariosPage', ['scenarioStore', 'uiStore'], 'requirePrincipal'),
  '/batches': routeContract('BatchesPage', ['batchStore', 'scenarioStore', 'uiStore'], 'requirePrincipal'),
  '/reports': routeContract('ReportsPage', ['reportStore', 'batchStore', 'telemetryStore', 'authStore', 'uiStore'], 'requirePrincipal'),
  '/replays': routeContract('ReplaysPage', ['replayStore', 'telemetryStore', 'uiStore'], 'requirePrincipal'),
  '/admin': routeContract('AdminPage', ['adminStore', 'authStore', 'uiStore'], 'requireAdmin'),
  '/blueprint': routeContract('BlueprintPage', ['traceabilityStore', 'authStore', 'uiStore'], 'requirePrincipal'),
  '/admin/data-exchange': routeContract('DataExchangePage', ['scenarioStore', 'simulationStore', 'telemetryStore', 'dataExchangeStore', 'uiStore'], 'requirePrincipal'),
  '/traceability': routeContract('TraceabilityPage', ['traceabilityStore', 'uiStore'], 'requirePrincipal'),
  '/interactions': routeContract('InteractionsPage', ['authStore', 'scenarioStore', 'simulationStore', 'telemetryStore', 'batchStore', 'reportStore', 'replayStore', 'adminStore', 'traceabilityStore', 'uiStore'], 'requirePrincipal'),
} satisfies Record<(typeof EXPECTED_UI_ROUTES)[number], {
  readonly page: string
  readonly stores: readonly string[]
  readonly guard: string
}>)
const CANONICAL_TOPICS: ReadonlySet<CanonicalTopic> = new Set([
  'simulation.frame',
  'runtime.state',
  'link.metric',
  'jammer.event',
  'switch.event',
])

function operationReference(
  method: HttpMethod,
  path: string,
  operationId: string,
): OperationContract {
  return Object.freeze({ method, path, operationId })
}

function capabilityTrace(
  uiRoute: string,
  operations: readonly OperationContract[] = [],
  topics: readonly CanonicalTopic[] = [],
): { readonly uiRoute: string; readonly operations: readonly OperationContract[]; readonly topics: readonly CanonicalTopic[] } {
  return Object.freeze({
    uiRoute,
    operations: Object.freeze(operations),
    topics: Object.freeze(topics),
  })
}

// Fixture metadata omits endpoints/topics, so this frozen bridge preserves the traceability authority without conflating UI and API routes.
const CAPABILITY_TRACEABILITY = Object.freeze({
  'DSDWRJQTLJS-XQ-QDZS-STXR': capabilityTrace('/situation', [
    operationReference('get', '/api/v1/simulations/{runId}/frames/{frameId}', 'getapiV1SimulationsRunIdFramesFrameId'),
  ]),
  'DSDWRJQTLJS-XQ-QDZS-ZBJK': capabilityTrace('/situation', [], ['link.metric', 'runtime.state']),
  'DSDWRJQTLJS-XQ-QDZS-LLTC': capabilityTrace('/situation', [], ['link.metric']),
  'DSDWRJQTLJS-XQ-QDZS-BBKSH': capabilityTrace('/reports', [
    operationReference('get', '/api/v1/reports/{reportId}', 'getapiV1ReportsReportId'),
  ]),
  'DSDWRJQTLJS-XQ-CJPZYJBSC-CJKSH': capabilityTrace('/scenarios', [
    operationReference('get', '/api/v1/scenarios/{scenarioId}', 'getapiV1ScenariosScenarioId'),
    operationReference('put', '/api/v1/scenarios/{scenarioId}', 'putapiV1ScenariosScenarioId'),
  ]),
  'DSDWRJQTLJS-XQ-CJPZYJBSC-CSJY': capabilityTrace('/scenarios', [
    operationReference('post', '/api/v1/scenarios/{scenarioId}/validate', 'postapiV1ScenariosScenarioIdValidate'),
    operationReference('post', '/api/v1/confirmations', 'postapiV1Confirmations'),
    operationReference('post', '/api/v1/confirmations/{confirmationId}', 'postapiV1ConfirmationsConfirmationId'),
  ]),
  'DSDWRJQTLJS-XQ-CJPZYJBSC-CJMB': capabilityTrace('/scenarios', [
    operationReference('get', '/api/v1/templates', 'getapiV1Templates'),
    operationReference('post', '/api/v1/templates', 'postapiV1Templates'),
    operationReference('get', '/api/v1/templates/{templateId}', 'getapiV1TemplatesTemplateId'),
    operationReference('put', '/api/v1/templates/{templateId}', 'putapiV1TemplatesTemplateId'),
    operationReference('delete', '/api/v1/templates/{templateId}', 'deleteapiV1TemplatesTemplateId'),
    operationReference('post', '/api/v1/templates/{templateId}/copy', 'postapiV1TemplatesTemplateIdCopy'),
  ]),
  'DSDWRJQTLJS-XQ-CJPZYJBSC-JBSC': capabilityTrace('/scenarios', [
    operationReference('post', '/api/v1/scripts/preview', 'postapiV1ScriptsPreview'),
    operationReference('post', '/api/v1/scripts/{scriptId}/preflight', 'postapiV1ScriptsScriptIdPreflight'),
  ]),
  'DSDWRJQTLJS-XQ-FZYXYLLJS-YQQD': capabilityTrace('/situation', [
    operationReference('post', '/api/v1/simulations/{runId}/commands', 'postapiV1SimulationsRunIdCommands'),
  ], ['runtime.state']),
  'DSDWRJQTLJS-XQ-FZYXYLLJS-LLJS': capabilityTrace('/blueprint', [], ['link.metric']),
  'DSDWRJQTLJS-XQ-FZYXYLLJS-FHSX': capabilityTrace('/interactions', [
    operationReference('get', '/api/v1/simulations/{runId}/frames/{frameId}', 'getapiV1SimulationsRunIdFramesFrameId'),
  ]),
  'DSDWRJQTLJS-XQ-FZYXYLLJS-SNBER': capabilityTrace('/interactions', [
    operationReference('get', '/api/v1/simulations/{runId}/frames/{frameId}', 'getapiV1SimulationsRunIdFramesFrameId'),
  ]),
  'DSDWRJQTLJS-XQ-FZYXYLLJS-LLZT': capabilityTrace('/situation', [], ['link.metric']),
  'DSDWRJQTLJS-XQ-GRYGZ-ESMGL': capabilityTrace('/interactions', [], ['jammer.event']),
  'DSDWRJQTLJS-XQ-GRYGZ-RFGR': capabilityTrace('/interactions', [
    operationReference('post', '/api/v1/tasks/{taskId}/jammers/{jammerId}/commands', 'postapiV1TasksTaskIdJammersJammerIdCommands'),
    operationReference('post', '/api/v1/tasks/{taskId}/jammers/{jammerId}/parameters', 'postapiV1TasksTaskIdJammersJammerIdParameters'),
  ], ['jammer.event']),
  'DSDWRJQTLJS-XQ-GRYGZ-BHC': capabilityTrace('/interactions', [
    operationReference('post', '/api/v1/simulations/{runId}/events', 'postapiV1SimulationsRunIdEvents'),
  ], ['jammer.event', 'link.metric']),
  'DSDWRJQTLJS-XQ-GRYGZ-CSS': capabilityTrace('/interactions', [], ['jammer.event', 'simulation.frame']),
  'DSDWRJQTLJS-XQ-LLQHYYX-LLJC': capabilityTrace('/situation', [], ['link.metric']),
  'DSDWRJQTLJS-XQ-LLQHYYX-QXL': capabilityTrace('/interactions', [], ['link.metric']),
  'DSDWRJQTLJS-XQ-LLQHYYX-HXL': capabilityTrace('/interactions', [], ['link.metric']),
  'DSDWRJQTLJS-XQ-LLQHYYX-QHJY': capabilityTrace('/interactions', [], ['switch.event']),
  'DSDWRJQTLJS-XQ-SJJHYJK-CSVDX': capabilityTrace('/admin/data-exchange', [
    operationReference('get', '/api/v1/contracts/csv', 'getapiV1ContractsCsv'),
  ]),
  'DSDWRJQTLJS-XQ-SJJHYJK-JSONJX': capabilityTrace('/admin/data-exchange', [
    operationReference('get', '/api/v1/contracts/scenario-config', 'getapiV1ContractsScenarioConfig'),
    operationReference('post', '/api/v1/scenarios/{scenarioId}/validate', 'postapiV1ScenariosScenarioIdValidate'),
  ]),
  'DSDWRJQTLJS-XQ-SJJHYJK-WSTC': capabilityTrace('/admin/data-exchange', [
    operationReference('get', '/ws/v1', 'getwsV1'),
  ], ['simulation.frame', 'runtime.state', 'link.metric', 'jammer.event', 'switch.event']),
  'DSDWRJQTLJS-XQ-SJJHYJK-JCGJ': capabilityTrace('/admin/data-exchange', [
    operationReference('post', '/api/v1/simulations/{runId}/commands', 'postapiV1SimulationsRunIdCommands'),
  ], ['runtime.state']),
  'DSDWRJQTLJS-XQ-XTGL-JCSJ': capabilityTrace('/admin', [
    operationReference('get', '/api/v1/admin/master-data', 'getapiV1AdminMasterData'),
    operationReference('post', '/api/v1/admin/master-data', 'postapiV1AdminMasterData'),
    operationReference('put', '/api/v1/admin/master-data/{dataId}', 'putapiV1AdminMasterDataDataId'),
    operationReference('delete', '/api/v1/admin/master-data/{dataId}', 'deleteapiV1AdminMasterDataDataId'),
  ]),
  'DSDWRJQTLJS-XQ-XTGL-YHJS': capabilityTrace('/admin', [
    operationReference('post', '/api/v1/auth/login', 'postapiV1AuthLogin'),
    operationReference('get', '/api/v1/auth/permissions', 'getapiV1AuthPermissions'),
    operationReference('get', '/api/v1/admin/users', 'getapiV1AdminUsers'),
    operationReference('post', '/api/v1/admin/users', 'postapiV1AdminUsers'),
    operationReference('put', '/api/v1/admin/users/{userId}', 'putapiV1AdminUsersUserId'),
    operationReference('delete', '/api/v1/admin/users/{userId}', 'deleteapiV1AdminUsersUserId'),
  ]),
  'DSDWRJQTLJS-XQ-XTGL-BFHF': capabilityTrace('/admin', [
    operationReference('post', '/api/v1/admin/backup', 'postapiV1AdminBackup'),
    operationReference('post', '/api/v1/admin/restore', 'postapiV1AdminRestore'),
  ]),
  'DSDWRJQTLJS-XQ-XTGL-CZRZ': capabilityTrace('/admin', [
    operationReference('get', '/api/v1/admin/audit', 'getapiV1AdminAudit'),
    operationReference('post', '/api/v1/admin/audit/export', 'postapiV1AdminAuditExport'),
  ]),
})

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

function sameOrderedStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index])
}

function operationSchemaBinding(
  requestTargetRef: string | null,
  successStatus: string,
  dataRef: string | null,
): OperationSchemaBinding {
  return Object.freeze({ requestTargetRef, successStatus, dataRef })
}

function routeContract(
  page: string,
  stores: readonly string[],
  guard: string,
): { readonly page: string; readonly stores: readonly string[]; readonly guard: string } {
  return Object.freeze({ page, stores: Object.freeze(stores), guard })
}

function expectedSchemaReference(operationId: string, suffix: 'Request' | 'Response'): string {
  return `${SCHEMA_REF_PREFIX}${operationId[0].toUpperCase()}${operationId.slice(1)}${suffix}`
}

function escapeJsonPointerPart(part: string): string {
  return part.replaceAll('~', '~0').replaceAll('/', '~1')
}

function collectComponentSchemaLiterals(
  value: unknown,
  pointer: string,
  literals: Array<readonly [string, unknown]>,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectComponentSchemaLiterals(child, `${pointer}/${index}`, literals))
    return
  }
  if (!isObject(value)) return

  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${escapeJsonPointerPart(key)}`
    if (key === 'const' || key === 'enum') {
      literals.push([childPointer, child])
    }
    collectComponentSchemaLiterals(child, childPointer, literals)
  }
}

function formatJsonValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue)
  }
  if (!isObject(value)) return value

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJsonValue(value[key])]),
  )
}

function describeSchemaSnapshotValue(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (isObject(value)) return 'object'
  return formatJsonValue(value)
}

function auditSchemaSnapshotDifference(
  expected: unknown,
  actual: unknown,
  pointer: string,
  findings: ValidationFinding[],
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      addFinding(
        findings,
        'OPENAPI_SCHEMA_SNAPSHOT',
        pointer,
        `Expected array, found ${describeSchemaSnapshotValue(actual)}`,
      )
      return
    }

    if (actual.length !== expected.length) {
      addFinding(
        findings,
        'OPENAPI_SCHEMA_SNAPSHOT',
        pointer,
        `Expected array length ${expected.length}, found ${actual.length}`,
      )
    }
    const sharedLength = Math.min(expected.length, actual.length)
    for (let index = 0; index < sharedLength; index += 1) {
      auditSchemaSnapshotDifference(expected[index], actual[index], `${pointer}/${index}`, findings)
    }
    return
  }

  if (isObject(expected)) {
    if (!isObject(actual)) {
      addFinding(
        findings,
        'OPENAPI_SCHEMA_SNAPSHOT',
        pointer,
        `Expected object, found ${describeSchemaSnapshotValue(actual)}`,
      )
      return
    }

    for (const key of Object.keys(expected)) {
      const childPointer = `${pointer}/${escapeJsonPointerPart(key)}`
      if (!Object.hasOwn(actual, key)) {
        addFinding(
          findings,
          'OPENAPI_SCHEMA_SNAPSHOT',
          childPointer,
          'Missing authoritative schema value',
        )
      } else {
        auditSchemaSnapshotDifference(expected[key], actual[key], childPointer, findings)
      }
    }
    for (const key of Object.keys(actual)) {
      if (!Object.hasOwn(expected, key)) {
        addFinding(
          findings,
          'OPENAPI_SCHEMA_SNAPSHOT',
          `${pointer}/${escapeJsonPointerPart(key)}`,
          'Unexpected schema value',
        )
      }
    }
    return
  }

  if (!Object.is(actual, expected)) {
    addFinding(
      findings,
      'OPENAPI_SCHEMA_SNAPSHOT',
      pointer,
      `Expected ${describeSchemaSnapshotValue(expected)}, found ${describeSchemaSnapshotValue(actual)}`,
    )
  }
}

function auditComponentSchemaSnapshot(
  schemas: JsonObject,
  findings: ValidationFinding[],
): void {
  for (const [name, expected] of Object.entries(OPENAPI_SCHEMA_SNAPSHOT)) {
    const pointer = `#/components/schemas/${escapeJsonPointerPart(name)}`
    if (!Object.hasOwn(schemas, name)) {
      addFinding(
        findings,
        'OPENAPI_SCHEMA_SNAPSHOT',
        pointer,
        'Missing authoritative schema component',
      )
      continue
    }

    const normalizedActual = normalizeJsonValue(schemas[name])
    if (JSON.stringify(normalizedActual) !== JSON.stringify(expected)) {
      auditSchemaSnapshotDifference(expected, normalizedActual, pointer, findings)
    }
  }

  for (const name of Object.keys(schemas)) {
    if (!Object.hasOwn(OPENAPI_SCHEMA_SNAPSHOT, name)) {
      addFinding(
        findings,
        'OPENAPI_SCHEMA_SNAPSHOT',
        `#/components/schemas/${escapeJsonPointerPart(name)}`,
        'Unexpected schema component',
      )
    }
  }
}

function auditComponentSchemaLiterals(
  components: JsonObject,
  findings: ValidationFinding[],
): void {
  const actualLiterals: Array<readonly [string, unknown]> = []
  collectComponentSchemaLiterals(components, '#/components', actualLiterals)
  const actualByPointer = new Map(actualLiterals)
  const expectedByPointer = new Map<string, unknown>(EXPECTED_COMPONENT_SCHEMA_LITERALS)

  for (const [pointer, expected] of EXPECTED_COMPONENT_SCHEMA_LITERALS) {
    if (!actualByPointer.has(pointer)) {
      addFinding(
        findings,
        'OPENAPI_SCHEMA_LITERALS',
        pointer,
        `Missing authoritative schema literal ${formatJsonValue(expected)}`,
      )
    } else {
      const actual = actualByPointer.get(pointer)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        addFinding(
          findings,
          'OPENAPI_SCHEMA_LITERALS',
          pointer,
          `Expected ${formatJsonValue(expected)}, found ${formatJsonValue(actual)}`,
        )
      }
    }
  }

  for (const [pointer, actual] of actualLiterals) {
    if (!expectedByPointer.has(pointer)) {
      addFinding(
        findings,
        'OPENAPI_SCHEMA_LITERALS',
        pointer,
        `Unexpected schema literal ${formatJsonValue(actual)}`,
      )
    }
  }
}

function hasSchemaBearingTarget(
  document: JsonObject,
  schema: unknown,
  visitedReferences: ReadonlySet<string> = new Set(),
): boolean {
  if (!isObject(schema)) return false

  const hasMeaningfulKey = SCHEMA_BEARING_KEYS.some((key) => {
    const value = schema[key]
    if (key === 'properties') {
      return isObject(value) && Object.keys(value).length > 0
    }
    if (key === 'required') {
      return Array.isArray(value)
        && value.length > 0
        && value.every((entry) => typeof entry === 'string')
    }
    if (key === 'enum') {
      return Array.isArray(value) && value.length > 0
    }
    if (key === 'const') {
      return Object.hasOwn(schema, key)
    }
    if (key === '$ref') {
      if (typeof value !== 'string'
        || !value.startsWith(SCHEMA_REF_PREFIX)
        || visitedReferences.has(value)) {
        return false
      }
      const nextVisitedReferences = new Set(visitedReferences)
      nextVisitedReferences.add(value)
      return hasSchemaBearingTarget(
        document,
        resolveLocalPointer(document, value),
        nextVisitedReferences,
      )
    }
    return Array.isArray(value)
      && value.length > 0
      && value.every((entry) => hasSchemaBearingTarget(document, entry, visitedReferences))
  })
  if (hasMeaningfulKey) return true

  return hasSchemaBearingTarget(document, schema.items, visitedReferences)
}

function operationKey(operation: OperationContract): string {
  return JSON.stringify([operation.method, operation.path, operation.operationId])
}

function formatOperation(operation: OperationContract): string {
  return `${operation.method.toUpperCase()} ${operation.path} (${operation.operationId || '<missing operationId>'})`
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

  if (!Array.isArray(openApi.servers) || openApi.servers.length !== 1
    || !isObject(openApi.servers[0]) || openApi.servers[0].url !== 'http://127.0.0.1:4173') {
    addFinding(findings, 'OPENAPI_SERVERS', '$.servers', 'Expected only http://127.0.0.1:4173')
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
  const actualOperations: OperationContract[] = []
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
      const publicAuth = ['/api/v1/auth/login', '/api/v1/auth/session', '/api/v1/auth/logout'].includes(route)
      if (JSON.stringify(operation.security) !== JSON.stringify(publicAuth ? [] : [{ SessionCookie: [] }])) {
        addFinding(findings, 'OPENAPI_SESSION_SECURITY', `${operationPath}.security`, 'Local authentication must use the frozen session cookie requirement')
      }
      const owner = `${method.toUpperCase()} ${route}`
      const operationId = stringAt(operation, 'operationId')
      const expectedOperation = EXPECTED_OPENAPI_OPERATIONS.find(
        (candidate) => candidate.method === method && candidate.path === route,
      )
      const expectedBinding = expectedOperation
        ? EXPECTED_OPENAPI_SCHEMA_BINDINGS[expectedOperation.operationId]
        : undefined
      actualOperations.push({ method, path: route, operationId: operationId ?? '' })
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
      if (!['/api/v1/auth/login', '/api/v1/auth/session', '/api/v1/auth/logout'].includes(route)
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

      const requestBody = objectAt(operation, 'requestBody')
      const requestContent = requestBody && objectAt(requestBody, 'content')
      const requestMediaType = requestContent && objectAt(requestContent, 'application/json')
      const requestSchemaValue = requestMediaType?.schema
      const requestSchema = isObject(requestSchemaValue) ? requestSchemaValue : undefined
      const requestReference = stringAt(requestSchema, '$ref')
      const resolvedRequestSchema = requestReference
        ? resolveLocalPointer(openApi, requestReference)
        : undefined
      const requestPath = `${operationPath}.requestBody.content["application/json"].schema`
      if (WRITE_METHODS.has(method)) {
        writeCount += 1
        if (requestBody?.required !== true
          || !requestReference?.startsWith(SCHEMA_REF_PREFIX)
          || !hasSchemaBearingTarget(openApi, resolvedRequestSchema)) {
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
        if (expectedBinding && expectedOperation) {
          const expectedRequestReference = expectedSchemaReference(expectedOperation.operationId, 'Request')
          const requestTargetReference = isObject(resolvedRequestSchema)
            ? stringAt(resolvedRequestSchema, '$ref')
            : undefined
          if (requestReference !== expectedRequestReference
            || requestTargetReference !== expectedBinding.requestTargetRef) {
            addFinding(
              findings,
              'OPENAPI_WRITE_SCHEMA',
              requestPath,
              `Expected ${expectedRequestReference} targeting ${expectedBinding.requestTargetRef}, found ${requestReference ?? '<missing>'} targeting ${requestTargetReference ?? '<missing>'}`,
            )
          }
        }
      } else if (expectedBinding && Object.hasOwn(operation, 'requestBody')) {
        addFinding(
          findings,
          'OPENAPI_WRITE_SCHEMA',
          `${operationPath}.requestBody`,
          'Non-write operations must not declare a request body',
        )
      }

      const responses = objectAt(operation, 'responses')
      const responseEntries = responses ? Object.entries(responses) : []
      const successEntries = responseEntries.filter(
        ([status]) => /^2\d\d$/.test(status) && status !== '101',
      )
      const contractSuccessStatuses = responseEntries
        .filter(([status]) => status === '101' || /^2\d\d$/.test(status))
        .map(([status]) => status)
      const isCanonicalUpgrade = route === '/ws/v1'
        && method === 'get'
        && responseEntries.some(([status]) => status === '101')
      if (expectedBinding && expectedOperation) {
        const statusPath = `${operationPath}.responses`
        if (!sameStrings(contractSuccessStatuses, [expectedBinding.successStatus])) {
          addFinding(
            findings,
            'OPENAPI_SUCCESS_ENVELOPE',
            statusPath,
            `Expected exact success status ${expectedBinding.successStatus}, found [${contractSuccessStatuses.join(', ')}]`,
          )
        }

        const actualErrorStatuses = responseEntries
          .filter(([status]) => !/^[123]\d\d$/.test(status))
          .map(([status]) => status)
        const expectedErrorStatuses = EXPECTED_OPENAPI_ERROR_STATUSES[expectedOperation.operationId]
        if (!sameStrings(actualErrorStatuses, expectedErrorStatuses)) {
          addFinding(
            findings,
            'OPENAPI_ERROR_STATUS',
            statusPath,
            `Expected exact error statuses [${expectedErrorStatuses.join(', ')}], found [${actualErrorStatuses.join(', ')}]`,
          )
        }

        const expectedResponseValue = responses?.[expectedBinding.successStatus]
        const expectedResponse = isObject(expectedResponseValue) ? expectedResponseValue : undefined
        const expectedContentValue = expectedResponse?.content
        const expectedContent = isObject(expectedContentValue) ? expectedContentValue : undefined
        const expectedMediaType = expectedContent && objectAt(expectedContent, 'application/json')
        const expectedResponseSchema = expectedMediaType && objectAt(expectedMediaType, 'schema')
        const actualEnvelopeReference = stringAt(expectedResponseSchema, '$ref')
        const actualEnvelope = actualEnvelopeReference
          ? resolveLocalPointer(openApi, actualEnvelopeReference)
          : undefined
        const actualEnvelopeProperties = isObject(actualEnvelope)
          ? objectAt(actualEnvelope, 'properties')
          : undefined
        const actualDataReference = stringAt(
          actualEnvelopeProperties && objectAt(actualEnvelopeProperties, 'data'),
          '$ref',
        )
        const responsePath = `${operationPath}.responses[${JSON.stringify(expectedBinding.successStatus)}]`
        if (expectedBinding.dataRef === null) {
          if (!expectedResponse || expectedContentValue !== undefined) {
            addFinding(
              findings,
              'OPENAPI_SUCCESS_ENVELOPE',
              responsePath,
              'The WebSocket upgrade must be an exact 101 response with no content envelope or data schema',
            )
          }
        } else {
          const expectedEnvelopeReference = expectedSchemaReference(expectedOperation.operationId, 'Response')
          if (actualEnvelopeReference !== expectedEnvelopeReference
            || actualDataReference !== expectedBinding.dataRef) {
            addFinding(
              findings,
              'OPENAPI_SUCCESS_ENVELOPE',
              responsePath,
              `Expected ${expectedEnvelopeReference} with data ${expectedBinding.dataRef}, found ${actualEnvelopeReference ?? '<missing>'} with data ${actualDataReference ?? '<missing>'}`,
            )
          }
        }
      }
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
        const resolvedDataSchema = dataReference
          ? resolveLocalPointer(openApi, dataReference)
          : undefined
        const required = isObject(envelope) ? envelope.required : undefined

        if (!responseReference?.startsWith(SCHEMA_REF_PREFIX)
          || !isObject(envelope)
          || !sameStrings(required, ['ok', 'data', 'meta'])
          || objectAt(envelopeProperties ?? {}, 'ok')?.const !== true
          || !dataReference?.startsWith(SCHEMA_REF_PREFIX)
          || !hasSchemaBearingTarget(openApi, resolvedDataSchema)) {
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

  if (operationCount !== 67) {
    addFinding(
      findings,
      'OPENAPI_OPERATION_COUNT',
      '$.paths',
      `Expected exactly 67 operations, found ${operationCount}`,
    )
  }
  const expectedOperationKeys = new Set(EXPECTED_OPENAPI_OPERATIONS.map(operationKey))
  const actualOperationKeys = new Set(actualOperations.map(operationKey))
  const missingOperations = EXPECTED_OPENAPI_OPERATIONS.filter(
    (operation) => !actualOperationKeys.has(operationKey(operation)),
  )
  const extraOperations = actualOperations.filter(
    (operation) => !expectedOperationKeys.has(operationKey(operation)),
  )
  if (missingOperations.length > 0 || extraOperations.length > 0) {
    addFinding(
      findings,
      'OPENAPI_OPERATION_MANIFEST',
      '$.paths',
      `Operation manifest mismatch; missing [${missingOperations.map(formatOperation).join(', ')}], extra [${extraOperations.map(formatOperation).join(', ')}]`,
    )
  }
  if (writeCount !== 33 || requestSchemaOwners.size !== 33) {
    addFinding(
      findings,
      'OPENAPI_WRITE_COUNT',
      '$.paths',
      `Expected exactly 33 independently typed POST/PUT/PATCH writes, found ${writeCount} writes and ${requestSchemaOwners.size} unique request schemas`,
    )
  }

  const demoRole = parameters.DemoRole
  const sessionCookie = components && objectAt(components, 'securitySchemes')?.SessionCookie
  if (!isObject(sessionCookie) || sessionCookie.type !== 'apiKey' || sessionCookie.in !== 'cookie' || sessionCookie.name !== 'wrj_session') {
    addFinding(findings, 'OPENAPI_SESSION_SECURITY', '$.components.securitySchemes.SessionCookie', 'SessionCookie must be the wrj_session cookie')
  }
  const demoRoleSchema = isObject(demoRole) ? objectAt(demoRole, 'schema') : undefined
  if (!isObject(demoRole)
    || demoRole.name !== 'X-Demo-Role'
    || demoRole.in !== 'header'
    || demoRole.required !== false
    || !sameStrings(demoRoleSchema?.enum, ['ADMIN', 'OPERATOR'])) {
    addFinding(
      findings,
      'OPENAPI_DEMO_ROLE',
      '$.components.parameters.DemoRole',
      'DemoRole must be the optional Mock-only X-Demo-Role header with ADMIN and OPERATOR values',
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

  auditComponentSchemaSnapshot(schemas, findings)
  auditComponentSchemaLiterals(components, findings)

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

function auditExactMetadataValues(
  values: readonly string[],
  expectedValues: readonly string[],
  path: string,
  findings: ValidationFinding[],
): Set<string> {
  const valuesSet = expectUnique(values, path, findings)
  const expectedSet = new Set(expectedValues)
  if (values.length !== expectedValues.length) {
    addFinding(
      findings,
      'FIXTURE_METADATA_COUNT',
      path,
      `Expected exactly ${expectedValues.length} values, found ${values.length}`,
    )
  }

  const missing = expectedValues.filter((value) => !valuesSet.has(value))
  const extra = values.filter((value) => !expectedSet.has(value))
  if (missing.length > 0 || extra.length > 0) {
    addFinding(
      findings,
      'FIXTURE_METADATA_SET',
      path,
      `Metadata set mismatch; missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
    )
  }
  return valuesSet
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
  const capabilityIds = fixtures.metadata.capabilities.map(({ id }) => id)
  const interfaceIds = fixtures.metadata.interfaces.map(({ id }) => id)
  const decisionIds = fixtures.metadata.decisions.map(({ id }) => id)
  const routePaths = fixtures.metadata.routes.map(({ path }) => path)
  auditExactMetadataValues(capabilityIds, EXPECTED_CAPABILITY_IDS, '$.metadata.capabilities[].id', findings)
  auditExactMetadataValues(interfaceIds, EXPECTED_INTERFACE_IDS, '$.metadata.interfaces[].id', findings)
  auditExactMetadataValues(decisionIds, EXPECTED_DECISION_IDS, '$.metadata.decisions[].id', findings)
  const routePathSet = auditExactMetadataValues(routePaths, EXPECTED_UI_ROUTES, '$.metadata.routes[].path', findings)

  fixtures.metadata.capabilities.forEach((capability, index) => {
    const expectedDestination = EXPECTED_CAPABILITY_DESTINATIONS[
      capability.id as keyof typeof EXPECTED_CAPABILITY_DESTINATIONS
    ]
    if (expectedDestination !== undefined) {
      expectValue(
        capability.destination,
        expectedDestination,
        `$.metadata.capabilities[${index}].destination`,
        'FIXTURE_METADATA_CONTRACT',
        findings,
      )
    }
    const expectedStates = capability.id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-LLJS'
      || capability.id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-FHSX'
      || capability.id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-SNBER'
      || capability.id === 'DSDWRJQTLJS-XQ-FZYXYLLJS-LLZT'
      || capability.id === 'DSDWRJQTLJS-XQ-GRYGZ-ESMGL'
      || capability.id === 'DSDWRJQTLJS-XQ-LLQHYYX-LLJC'
      || capability.id === 'DSDWRJQTLJS-XQ-LLQHYYX-QXL'
      || capability.id === 'DSDWRJQTLJS-XQ-LLQHYYX-HXL'
      || capability.id === 'DSDWRJQTLJS-XQ-LLQHYYX-QHJY'
      ? EXPECTED_FIXED_EVIDENCE_STATES
      : EXPECTED_CAPABILITY_STATES
    if (!sameStrings(capability.states, expectedStates)) {
      addFinding(
        findings,
        'FIXTURE_METADATA_CONTRACT',
        `$.metadata.capabilities[${index}].states`,
        `Capability states must be the complete duplicate-free set [${expectedStates.join(', ')}]`,
      )
    }
  })
  fixtures.metadata.interfaces.forEach((interfaceMetadata, index) => {
    const expectedDestination = EXPECTED_INTERFACE_DESTINATIONS[
      interfaceMetadata.id as keyof typeof EXPECTED_INTERFACE_DESTINATIONS
    ]
    if (expectedDestination !== undefined) {
      expectValue(
        interfaceMetadata.destination,
        expectedDestination,
        `$.metadata.interfaces[${index}].destination`,
        'FIXTURE_METADATA_CONTRACT',
        findings,
      )
    }
  })
  fixtures.metadata.routes.forEach((route, index) => {
    const expectedRoute = EXPECTED_ROUTE_CONTRACTS[
      route.path as keyof typeof EXPECTED_ROUTE_CONTRACTS
    ]
    if (!expectedRoute) return

    expectValue(
      route.page,
      expectedRoute.page,
      `$.metadata.routes[${index}].page`,
      'FIXTURE_METADATA_CONTRACT',
      findings,
    )
    if (!sameOrderedStrings(route.stores, expectedRoute.stores)) {
      addFinding(
        findings,
        'FIXTURE_METADATA_CONTRACT',
        `$.metadata.routes[${index}].stores`,
        `Expected ordered stores [${expectedRoute.stores.join(', ')}], found [${route.stores.join(', ')}]`,
      )
    }
    expectValue(
      route.guard,
      expectedRoute.guard,
      `$.metadata.routes[${index}].guard`,
      'FIXTURE_METADATA_CONTRACT',
      findings,
    )
  })

  const manifestKeys = new Set(EXPECTED_OPENAPI_OPERATIONS.map(operationKey))
  const expectedUiRouteSet: ReadonlySet<string> = new Set(EXPECTED_UI_ROUTES)
  auditExactMetadataValues(
    Object.keys(CAPABILITY_TRACEABILITY),
    EXPECTED_CAPABILITY_IDS,
    '$.metadata.capabilities[].traceability',
    findings,
  )
  for (const [capabilityId, trace] of Object.entries(CAPABILITY_TRACEABILITY)) {
    if (!expectedUiRouteSet.has(trace.uiRoute)) {
      addFinding(
        findings,
        'FIXTURE_CAPABILITY_TRACE',
        `$.metadata.capabilities[${JSON.stringify(capabilityId)}].uiRoute`,
        `Unknown UI route ${trace.uiRoute}`,
      )
    }
    trace.operations.forEach((operation, index) => {
      if (!manifestKeys.has(operationKey(operation))) {
        addFinding(
          findings,
          'FIXTURE_CAPABILITY_TRACE',
          `$.metadata.capabilities[${JSON.stringify(capabilityId)}].operations[${index}]`,
          `Unknown OpenAPI operation ${formatOperation(operation)}`,
        )
      }
    })
    trace.topics.forEach((topic, index) => {
      if (!CANONICAL_TOPICS.has(topic)) {
        addFinding(
          findings,
          'FIXTURE_CAPABILITY_TRACE',
          `$.metadata.capabilities[${JSON.stringify(capabilityId)}].topics[${index}]`,
          `Unknown topic ${topic}`,
        )
      }
    })
  }
  fixtures.metadata.capabilities.forEach((capability, index) => {
    const trace = CAPABILITY_TRACEABILITY[capability.id as keyof typeof CAPABILITY_TRACEABILITY]
    if (!trace) {
      addFinding(
        findings,
        'FIXTURE_CAPABILITY_TRACE',
        `$.metadata.capabilities[${index}].id`,
        `Capability ${capability.id} has no traceability bridge`,
      )
    } else if (!routePathSet.has(trace.uiRoute)) {
      addFinding(
        findings,
        'FIXTURE_CAPABILITY_TRACE',
        `$.metadata.capabilities[${index}].id`,
        `Capability ${capability.id} requires missing UI route ${trace.uiRoute}`,
      )
    }
  })

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
