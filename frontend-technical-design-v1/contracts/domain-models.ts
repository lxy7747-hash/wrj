/** Frontend/mock contract declarations. Source authority: SRS, DD, approved frontend baseline V1.1. */

export type Iso8601Utc = string;
export type Identifier = string;
export type TaskId = `TASK-${string}`;
export type ScenarioId = `SCN-${string}`;
export type RunId = `RUN-${string}`;
export type FrameId = `F-${string}`;
export type ReportId = `RPT-${string}`;
export type ReplayId = `REPLAY-${string}`;
export type ArchiveId = `ARCH-${string}`;
export type Seconds = number;
export type Milliseconds = number;
export type Meters = number;
export type Kilometers = number;
export type MetersPerSecond = number;
export type Degrees = number;
export type Megahertz = number;
export type Watts = number;
export type DecibelMilliwatts = number;
export type Decibels = number;
export type DecibelsIsotropic = number;
export type MegabitsPerSecond = number;
export type Ratio01 = number;
export type Percent0To100 = number;
export type SequenceNumber = number;

export type Role = 'ADMIN' | 'OPERATOR';
export type Permission =
  | 'BUSINESS_READ' | 'SCENARIO_DRAFT_WRITE' | 'SIMULATION_CONTROL'
  | 'ORDINARY_REPORT_EXPORT' | 'OFFICIAL_TEMPLATE_MAINTAIN'
  | 'MASTER_DATA_MAINTAIN' | 'USER_ROLE_MAINTAIN'
  | 'BACKUP_RESTORE' | 'AUDIT_READ' | 'FULL_CONFIG_EXPORT'
  | 'BATCH_LEVEL_III_EXPORT';
export interface Principal { userId: Identifier; username: string; role: Role; permissions: readonly Permission[]; }
export interface RbacDecision { allowed: boolean; permission: Permission; reason?: 'PERMISSION_DENIED' | 'LAST_ADMIN_GUARD' | 'CONFIRMATION_REQUIRED'; }
export interface LoginRequest { username: 'admin' | 'operator' | 'locked'; passwordFixture: string; }
export interface AuthResult { authenticated: boolean; principal?: Principal; reason?: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED'; sessionCreated: false; }

/** Four business information-node roles counted by the 50-node capacity rule. */
export type BusinessInformationNodeType =
  | 'REAR_COMMAND_NODE' | 'FORWARD_RELAY_NODE'
  | 'GROUND_CLUSTER_COMMAND_NODE' | 'AIRBORNE_MISSION_CLUSTER';
/** Configurable supporting entities; they never count toward the 50 business nodes. */
export type SupportingEntityType = 'COMMUNICATION_SATELLITE' | 'GROUND_JAMMER_DETECTION_STATION';
export type PlatformType = BusinessInformationNodeType | SupportingEntityType;
export type DeploymentDomain = 'ground' | 'air' | 'space';
export type LinkType = 'SAT' | 'MICROWAVE' | 'DATALINK' | 'LASER';
export type Modulation = 'BPSK' | 'QPSK';
export type LinkDirection = 'FORWARD' | 'REVERSE';
/** SRS §3.5.3 Table 22 nested position object. */
export interface Position { longitude: Degrees; latitude: Degrees; altitude: Meters; }
export interface Waypoint extends Position { speed: MetersPerSecond; arrivalTime: Seconds; }
export interface AntennaGain { tx: DecibelsIsotropic; rx: DecibelsIsotropic; }
export interface FrequencyRange { min: Megahertz; max: Megahertz; }
export interface Environment {
  seaState: number; temperatureC: number; humidityPercent: Percent0To100;
  rainRateMmPerHour: number; rainLossDbPerKm: number; multipathEnabled: boolean;
}
export interface ScenarioIdentity {
  id: ScenarioId; name: string; description: string; startTime: Iso8601Utc;
  duration: Seconds; timeStep: Seconds; environment: Environment;
}
export interface Platform {
  id: Identifier; name: string; type: PlatformType; category: DeploymentDomain; initialPosition: Position;
  waypoints: Waypoint[]; linkIds: Identifier[]; sensorIds: Identifier[]; jammerIds: Identifier[];
}
export interface Link {
  id: Identifier; type: LinkType; sourcePlatformId: Identifier; targetPlatformId: Identifier;
  frequency: Megahertz; bandwidth: Megahertz; txPower: Watts; antennaGain: AntennaGain;
  modulation: Modulation; berThreshold: Ratio01; dataRate: MegabitsPerSecond; direction: LinkDirection;
}
export interface Jammer {
  id: Identifier; platformId: Identifier; type: 'BARRAGE' | 'SPOT'; defaultPower: Watts;
  frequency: Megahertz; bandwidth: Megahertz; autoDetect: boolean; detectionRange: Meters;
}
export interface Sensor {
  id: Identifier; platformId: Identifier; frequencyRange: FrequencyRange; detectionRange: Meters;
}
export interface OutputConfig {
  directory: string; writeInterval: Seconds; linkQualityEnabled: boolean;
  eventsEnabled: boolean; linkSwitchEnabled: boolean;
}
/** Required by the approved frontend baseline as part of canonical ScenarioConfig 1.0. */
export interface InformationDemand {
  id: Identifier; sourcePlatformId: Identifier; destinationPlatformIds: Identifier[];
  informationType: string; volumeMb: number; frequencyHz: number; priority: 'HIGH' | 'NORMAL';
  maxLatencyMs: Milliseconds; minDataRateMbps: MegabitsPerSecond;
}
export interface ScenarioConfig {
  schemaVersion: '1.0'; scenario: ScenarioIdentity; platforms: Platform[]; links: Link[];
  jammers: Jammer[]; sensors: Sensor[]; output: OutputConfig;
  informationDemand: InformationDemand[];
}

/** Five complete SRS §3.5.4 frontend interfaces (canonical superset). */
export interface LinkQualityData {
  time: Seconds; sourcePlatform: Identifier; destPlatform: Identifier; linkType: LinkType;
  frequency: Megahertz; bandwidth: Megahertz; distance: Meters; txPower: Watts;
  txAntennaGain: DecibelsIsotropic; rxAntennaGain: DecibelsIsotropic;
  pathLoss: Decibels; jammingPower: DecibelMilliwatts; receivedPower: DecibelMilliwatts;
  snr: Decibels; modulation: Modulation; ber: Ratio01; linkStatus: CanonicalLinkStatus;
  berThreshold: Ratio01; dataRate: MegabitsPerSecond;
}
export interface LinkStatusSummary {
  linkKey: string; sourcePlatform: Identifier; destPlatform: Identifier; linkType: LinkType;
  currentSnr: Decibels; currentBer: Ratio01; status: CanonicalLinkStatus; updatedAt: Seconds;
}
export interface JammerStatusData {
  time: Seconds; jammerId: Identifier; platformId: Identifier; targetPlatform?: Identifier;
  power: Watts; frequency: Megahertz; bandwidth: Megahertz; active: boolean;
}
export interface PlatformStatus {
  platformId: Identifier; name: string; type: PlatformType; longitude: Degrees; latitude: Degrees;
  altitude: Meters; speed: MetersPerSecond; linkIds: Identifier[];
  jammers: JammerStatusData[]; updatedAt: Seconds;
}
export interface SimulationState {
  status: CanonicalSimulationStatus; currentTime: Seconds; totalDuration: Seconds;
  processId: number | null; progress: Percent0To100; errorMessage?: string;
}

export type CapabilityState = 'LOADING' | 'VALIDATING' | 'EXECUTING' | 'SUCCESS' | 'EMPTY' | 'ERROR';
export type CanonicalSimulationStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'ERROR';
export type UiSimulationStatus = CanonicalSimulationStatus | 'STOPPED';
export type CanonicalLinkStatus = 'UP' | 'DOWN';
export type UiLinkStatus = CanonicalLinkStatus | 'DEGRADED';
export type ConfirmationState = 'CLOSED' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'ERROR';
export type ReplayState = 'EMPTY' | 'LOADING' | 'PAUSED' | 'PLAYING' | 'SEEKING' | 'COMPLETED' | 'CORRUPT' | 'ERROR';
export type BatchState = 'DRAFT' | 'VALIDATING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL_FAILURE' | 'CANCELLED' | 'ERROR';
export type ConfigurationLockState = 'UNLOCKED' | 'LOCKING' | 'LOCKED' | 'UNLOCKING' | 'ERROR';
export interface UiLinkProjection {
  linkId: Identifier; frameId: FrameId; status: UiLinkStatus; canonicalStatus: CanonicalLinkStatus;
  reason: string; thresholdVersion: 'LLZT-1.0'; consecutiveFrames: number; ageMs: Milliseconds;
}
export interface LinkStatusAggregateExtension {
  totalLinks: number; upLinks: number; degradedUiLinks: number; downLinks: number;
  connectivityRate: Percent0To100; avgSnrDb: Decibels; avgBer: Ratio01; switchCount: number;
}

export interface ValidationIssue { severity: 'ERROR' | 'WARNING'; code: string; message: string; fieldPath: string; }
export interface ValidationResult { valid: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[]; }
/** UI-only fields are kept beside, never inside, the canonical ScenarioConfig. */
export interface JammerUiExtension { jammerId: Identifier; direction: Degrees; duration: Seconds; enabled: boolean; }
export interface SensorUiExtension { sensorId: Identifier; type: 'ESM'; direction: 'OMNI' | Degrees; probability: Ratio01; enabled: boolean; }
export interface ScenarioUiExtensions { jammers: JammerUiExtension[]; sensors: SensorUiExtension[]; }
export interface ScenarioDraftUpdate { config: ScenarioConfig; uiExtensions: ScenarioUiExtensions; }
export interface ScenarioDraft { config: ScenarioConfig; uiExtensions: ScenarioUiExtensions; revision: number; officialLibraryChanged: false; locked: boolean; }
export interface ScenarioTemplate { templateId: Identifier; name: string; version: string; official: boolean; config: ScenarioConfig; referenceCount: number; }
export interface ScriptContract { scriptId: Identifier; taskId: TaskId; scenarioId: ScenarioId; configVersion: string; target: 'AFSIM 2.9.0'; checksum: string; preview: string; generatedTime: Iso8601Utc; }
export interface ScenarioValidationRequest { config: ScenarioConfig; }
export interface MutationRequest { expectedRevision: number; }
export interface ScenarioImportRequest { items: ScenarioConfig[]; }
export interface ScenarioImportResult { imported: number; rejected: number; drafts: ScenarioDraft[]; }
export interface TemplateMutationRequest { name: string; config: ScenarioConfig; }
export interface CopyTemplateRequest { name: string; }
/** warningConfirmationId is mandatory by business rule when validation has WARNING and no ERROR. */
export interface ScriptPreviewRequest { scenarioId: ScenarioId; warningConfirmationId?: Identifier; }
export interface PreflightRequest { checksum: string; }
export interface SimulationCreateRequest { taskId: TaskId; scenarioId: ScenarioId; }

export interface SimulationRun {
  runId: RunId; taskId: TaskId; scenarioId: ScenarioId; uiStatus: UiSimulationStatus;
  canonical: SimulationState; configLocked: boolean; startedAt?: Iso8601Utc; completedAt?: Iso8601Utc;
}
export type SimulationMode = 'INTERACTIVE_SINGLE' | 'BATCH_PARAMETER_TRAVERSAL' | 'PARAMETER_SCAN' | 'HISTORICAL_REPLAY';
/** START requires mode; SET_SPEED requires speedMultiplier > 0; STEP requires stepCount=1. */
export interface SimulationCommand {
  command: 'START' | 'PAUSE' | 'RESUME' | 'STEP' | 'STOP' | 'SET_SPEED';
  mode?: SimulationMode; speedMultiplier?: number; stepCount?: 1; confirmationId?: Identifier;
}
export interface CompositeLossEvidence {
  linkId: Identifier; freeSpaceLossDb: Decibels; systemLossDb: Decibels;
  obstructionLossDb: Decibels; interferenceLossDb: Decibels; totalPathLossDb: Decibels;
  noisePowerDbm: DecibelMilliwatts; effectiveNoiseAndInterferenceDbm: DecibelMilliwatts;
  modelVersion: 'COMPOSITE-LOSS-1.0';
}
export interface RouteCandidateEvidence {
  linkId: Identifier; direction: LinkDirection; eligible: boolean; jamImpactDb: Decibels;
  ber: Ratio01; stabilityFrames: number; rank: number;
}
export interface SynchronizationEvidence {
  configVersion: 'SCN-001-v4'; engineVersion: 'AFSIM-2.9.0-FIXTURE'; uiVersion: 'FRAME-1.0';
  effectiveFrameId: FrameId; effectiveSimulationTime: Seconds;
}
export interface JammerExecutionEvidence {
  jammerId: Identifier; targetPlatformId: Identifier; power: Watts; frequency: Megahertz;
  bandwidth: Megahertz; startTime: Seconds; duration: Seconds; reason: string;
}
export interface FrameEvidence {
  losses: CompositeLossEvidence[]; routeCandidates: RouteCandidateEvidence[];
  jammerExecution: JammerExecutionEvidence; synchronization: SynchronizationEvidence;
}
/** Mock 传输扩展：补充链路身份与质量计算证据，不修改 SRS LinkQualityData。 */
export interface TelemetryLinkRecord extends LinkQualityData {
  linkId: Identifier; coding: 'UNCODED'; qualityModelVersion: 'SNBER-1.2';
}
export interface TelemetryFrame {
  frameId: FrameId; taskId: TaskId; runId: RunId; simulationTime: Seconds; sequence: SequenceNumber;
  platforms: PlatformStatus[]; links: TelemetryLinkRecord[]; linkSummaries: LinkStatusSummary[];
  uiLinks: UiLinkProjection[];
  eventIds: Identifier[]; evidence: FrameEvidence;
}
export interface DetectionEvent { eventId: Identifier; frameId: FrameId; time: Seconds; sourceRegistryTime?: Seconds; type: 'DETECTION'; sensorId: Identifier; targetPlatformId: Identifier; detectionProbability: Ratio01; dedupeKey: string; }
export interface SwitchEvent { eventId: Identifier; frameId: FrameId; time: Seconds; sourceRegistryTime?: Seconds; type: 'LINK_SWITCH'; oldLinkId: Identifier; newLinkId: Identifier; decision: 'ACCEPTED' | 'REJECTED'; reason: string; dedupeKey: string; }
export interface BatchRunResult {
  runId: RunId; reportId: ReportId; powerW: Watts; distanceKm: Kilometers;
  connectivityDurationS: Seconds; connectivityRate: Percent0To100; switchCount: number;
  avgBer: Ratio01; maxBer: Ratio01; avgSnrDb: Decibels; minSnrDb: Decibels;
  interferenceDurationS: Seconds; status: 'COMPLETED' | 'ERROR';
}
export interface Batch { batchId: Identifier; state: BatchState; runIds: RunId[]; reportIds: ReportId[]; aggregateReportId: ReportId; }
export interface BatchRequest { scenarioId: ScenarioId; powersW: Watts[]; distancesKm: Kilometers[]; deterministicOrder: true; }
export interface BatchCommand { command: 'START' | 'CANCEL'; }
export type ReportClassification = 'LEVEL_II' | 'LEVEL_III';
export interface ReportKpis {
  connectivityRate: Percent0To100; switchCount: number; avgBer: Ratio01; avgSnrDb: Decibels;
  interferenceDurationS: Seconds; avgConnectivityDurationS: Seconds; minSnrDb: Decibels; maxBer: Ratio01;
}
export interface Report { reportId: ReportId; runId?: RunId; batchId?: Identifier; classification: ReportClassification; generatedTime: Iso8601Utc; status: 'READY'; kpis?: ReportKpis; }
export interface ReportExportRequest { reportId: ReportId; format: 'HTML' | 'PDF' | 'CSV'; confirmationId?: Identifier; }
export interface ReportExportResult { reportId: ReportId; generated: false; status: 'FIXTURE_SUCCESS'; watermark: string; verifiedAt: Iso8601Utc; }
export interface Replay { replayId: ReplayId; runId: RunId; state: ReplayState; durationS: Seconds; currentTimeS: Seconds; eventIds: Identifier[]; }
export interface ReplayCommand { command: 'PLAY' | 'PAUSE' | 'SEEK' | 'STEP_FORWARD' | 'STEP_BACK' | 'SPEED'; value?: number; }
export type ConfirmationAction =
  | 'SCENARIO_WARNING_CONTINUE' | 'OFFICIAL_TEMPLATE_DELETE' | 'SIMULATION_STOP'
  | 'BATCH_LEVEL_III_EXPORT' | 'BACKUP_RESTORE' | 'FULL_CONFIG_EXPORT' | 'AUDIT_EXPORT';
export interface ConfirmationRequest { action: ConfirmationAction; objectId: Identifier; }
export interface ConfirmationContext { confirmationId: Identifier; state: ConfirmationState; actor: string; role: Role; createdAt: Iso8601Utc; expiresAt: Iso8601Utc; }

export interface User { userId: Identifier; username: string; role: Role; status: 'ACTIVE' | 'DISABLED' | 'LOCKED'; lastLoginAt?: Iso8601Utc; }
export interface MasterData { dataId: Identifier; kind: string; version: number; referenceCount: number; active: boolean; }
export interface MasterDataRequest { operation: 'CREATE' | 'UPDATE' | 'DELETE'; data: MasterData; confirmationId?: Identifier; }
export interface UserRoleCommand { operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'ENABLE' | 'DISABLE'; user: User; confirmationId?: Identifier; }
export interface BackupRecord { backupId: Identifier; status: 'VALID_FIXTURE' | 'INVALID_FIXTURE'; checksum: string; createdAt: Iso8601Utc; }
export interface BackupRequest { operation: 'BACKUP'; backupId?: Identifier; confirmationId: Identifier; }
export interface RestoreRequest { operation: 'RESTORE'; backupId: Identifier; confirmationId: Identifier; }
export interface AuditRecord { auditId: Identifier; actor: string; role: Role; action: string; objectId?: Identifier; result: 'SUCCESS' | 'DENIED' | 'ERROR'; occurredAt: Iso8601Utc; immutableFixture: true; }
export interface AuditRequest { from?: Iso8601Utc; to?: Iso8601Utc; actor?: string; role?: Role; action?: string; result?: AuditRecord['result']; export?: boolean; confirmationId?: Identifier; }
export interface AuditExportRequest extends AuditRequest { export: true; confirmationId: Identifier; }
export interface SystemHealth { ui: 'HEALTHY'; engine: 'NOT_CONNECTED_BY_DESIGN'; database: 'NOT_CONNECTED_BY_DESIGN'; channel: 'NOT_CONNECTED_BY_DESIGN'; }
export interface ArchiveRecord { archiveId: ArchiveId; taskId: TaskId; scenarioId: ScenarioId; runId: RunId; replayId: ReplayId; reportId: ReportId; status: 'INDEXED'; }
export interface DeleteResult { deleted: boolean; objectId: Identifier; }
export interface RestoreResult { prebackupId: Identifier; integrityValid: boolean; progress: Percent0To100; result: 'SUCCESS' | 'FAILURE'; rolledBack: boolean; generated: false; }
export interface ExportStatus { objectId: Identifier; generated: false; classification: 'INTERNAL' | 'LEVEL_II' | 'LEVEL_III'; watermark: string; verifiedAt: Iso8601Utc; }
export interface FullConfigExportRequest { format: 'JSON'; confirmationId: Identifier; }
export interface ResetRequest { confirm: true; }
export interface ResetResult { requestId: 'REQ-RESET-001'; generatedAt: Iso8601Utc; nextSequence: 1; }

export interface PageMeta { requestId: string; generatedAt: Iso8601Utc; page: number; pageSize: number; total: number; }
export interface ApiSuccess<T> { ok: true; data: T; meta: PageMeta; }
export interface ApiErrorDetail { code: ApiErrorCode; message: string; fieldPath?: string; details?: unknown; retryable: boolean; correlationId: string; }
export interface ApiFailure { ok: false; error: ApiErrorDetail; meta: Pick<PageMeta, 'requestId' | 'generatedAt'>; }
export type ApiResult<T> = ApiSuccess<T> | ApiFailure;
export type ApiErrorCode =
  | 'INVALID_REQUEST' | 'VALIDATION_FAILED' | 'NOT_FOUND' | 'CONFLICT'
  | 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED' | 'PERMISSION_DENIED' | 'LAST_ADMIN_GUARD'
  | 'CONFIRMATION_REQUIRED' | 'CONFIRMATION_EXPIRED' | 'CONFIG_LOCKED'
  | 'INVALID_TRANSITION' | 'NODE_LIMIT_EXCEEDED' | 'DUPLICATE_EVENT'
  | 'HEADER_INVALID' | 'TYPE_INVALID' | 'ENCODING_INVALID' | 'ATOMIC_REPLACE_FAILED'
  | 'START_FAILED' | 'TIMEOUT' | 'EXIT_NONZERO' | 'CORRUPT_FIXTURE'
  | 'LOOPBACK_ONLY' | 'TOPIC_FORBIDDEN' | 'SEQUENCE_GAP' | 'INTERNAL_FIXTURE_ERROR';
export interface ListRequest { page?: number; pageSize?: number; query?: string; }
export interface IdRequest<TId extends Identifier = Identifier> { id: TId; }
export interface CommandRequest<TPayload> { commandId: Identifier; requestedAt: Iso8601Utc; payload: TPayload; }
export interface CapabilityMetadata { id: string; module: string; name: string; coverage: 'INTERACTIVE_UI' | 'VISIBLE_CONTRACT'; destination: string; states: readonly CapabilityState[]; }
export interface InterfaceMetadata { id: string; kind: '外部' | '内部'; name: string; destination: string; }
export interface DecisionMetadata { id: `DEC-${string}`; conflict: string; adopted: string; effect: string; }
export interface RouteMetadata { path: string; page: string; stores: string[]; guard: string; }
export interface ContractDescriptor { name: string; version: string; sourceRef: string; fields: string[]; }

/** Canonical loopback topics from approved baseline §8.2. Commands use REST; node state rides simulation.frame. */
export type WsTopic = 'simulation.frame' | 'runtime.state' | 'link.metric' | 'jammer.event' | 'switch.event';
export type WsConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'SUBSCRIBED' | 'RETRYING' | 'FAILED';
export interface RealtimeEnvelope<T> { type: string; schemaVersion: '1.0'; topic: WsTopic; taskId: TaskId; sequence: SequenceNumber; simulationTime?: Seconds; frameId?: FrameId; payload: T; }
export interface WsSubscribeRequest { type: 'subscribe'; schemaVersion: '1.0'; taskId: TaskId; topics: WsTopic[]; lastSequence?: SequenceNumber; }
export interface WsRejection { type: 'rejected'; code: 'LOOPBACK_ONLY' | 'TOPIC_FORBIDDEN' | 'INVALID_ENVELOPE' | 'SEQUENCE_GAP'; message: string; closeCode: 1008; }

export interface FixtureValidationLink {
  openApiDocument: 'mock-api.openapi.yaml'; rootSchema: '#/components/schemas/DeterministicFixtures';
  typeContract: 'domain-models.ts#DeterministicFixtureSet';
  fixturePaths: Record<string, string>; requiredEvidence: string[];
}
export interface TaskFixture {
  taskId: TaskId; scenarioId: ScenarioId; configVersion: string; scriptId: Identifier; createdAt: Iso8601Utc;
}
export interface ScenarioTemplateIndex {
  templateId: Identifier; scenarioId: ScenarioId; name: string; version: string; official: boolean; referenceCount: number;
}
export interface FileArchiveFixture {
  fileId: Identifier; taskId: TaskId; contract: 'link_quality.csv' | 'events.csv' | 'link_switch.csv';
  status: 'VALID_FIXTURE'; createdAt: Iso8601Utc;
}
export interface BatchReportLink { reportId: ReportId; runId: RunId; }
export interface ResetFixture {
  method: 'POST'; path: '/api/v1/reset'; requestId: 'REQ-RESET-001';
  responseGeneratedAt: Iso8601Utc; nextSequence: 1;
}
export interface FixtureMetadata {
  capabilities: CapabilityMetadata[]; interfaces: InterfaceMetadata[];
  decisions: DecisionMetadata[]; routes: RouteMetadata[];
}
export interface FixtureContracts {
  scenarioConfig: ContractDescriptor; frontendTypes: ContractDescriptor[]; csv: ContractDescriptor[];
}
/** Machine-readable recipe used to generate the deterministic 50/51-node boundary cases. */
export interface ScenarioCoverageFixture {
  businessNodeTypes: BusinessInformationNodeType[]; supportingEntityTypes: SupportingEntityType[];
  acceptedBusinessNodeCount: 50; rejectedBusinessNodeCount: 51;
  rejection: { code: 'NODE_LIMIT_EXCEEDED'; fieldPath: 'platforms'; mutationApplied: false };
  linkTypes: LinkType[]; jammerTypes: Array<Jammer['type']>; minimumInformationDemandCount: 1;
}
/** Root shape validated by OpenAPI `DeterministicFixtures`; every referenced fixture is explicit. */
export interface DeterministicFixtureSet {
  schemaVersion: '1.0'; fixtureVersion: string; epoch: Iso8601Utc;
  validation: FixtureValidationLink; clock: Record<string, Iso8601Utc>; principals: User[];
  templates: ScenarioTemplateIndex[]; fileArchives: FileArchiveFixture[]; masterData: MasterData[];
  backups: BackupRecord[]; audit: AuditRecord[]; diagnostics: SystemHealth; scenarioCoverage: ScenarioCoverageFixture;
  scenario: ScenarioConfig; task: TaskFixture; script: ScriptContract; run: SimulationRun;
  frame: TelemetryFrame; events: Array<DetectionEvent | SwitchEvent>; replay: Replay;
  report: Report; archive: ArchiveRecord; batch: Batch;
  batchRuns: BatchRunResult[]; batchReports: BatchReportLink[]; batchAggregateReport: Report;
  reset: ResetFixture; metadata: FixtureMetadata; contracts: FixtureContracts;
}

export const LINK_QUALITY_CSV_HEADER = 'Time,SourcePlatform,DestPlatform,LinkType,Frequency,Bandwidth,Distance,TxPower,TxAntennaGain,RxAntennaGain,PathLoss,JammingPower,ReceivedPower,SNR,Modulation,BER,LinkStatus,BERThreshold,DataRate' as const;
export const EVENTS_CSV_HEADER = 'Time,EventType,SourcePlatform,TargetPlatform,Status,Power,Frequency,Bandwidth,Parameters' as const;
export const LINK_SWITCH_CSV_HEADER = 'Time,SourcePlatform,DestPlatform,Direction,OldLinkType,NewLinkType,OldBER,NewBER,SwitchReason' as const;

/** Signatures only: later adapters own validation and projection implementations. */
export declare function projectUiSimulationStatus(status: UiSimulationStatus): CanonicalSimulationStatus;
export declare function projectUiLinkStatus(status: UiLinkStatus, ber: Ratio01, threshold: Ratio01): CanonicalLinkStatus;
export declare function parseScenarioConfig(input: unknown): ApiResult<ScenarioConfig>;
export declare function validateScenarioConfig(config: ScenarioConfig): ValidationResult;
export declare function toLinkQualityCsvRow(data: LinkQualityData): readonly string[];
export declare function toEventsCsvRow(event: DetectionEvent): readonly string[];
export declare function toLinkSwitchCsvRow(event: SwitchEvent): readonly string[];
export declare function authorize(principal: Principal, permission: Permission): RbacDecision;
export declare function applyTelemetryEnvelope(envelope: RealtimeEnvelope<TelemetryFrame>): TelemetryFrame;
