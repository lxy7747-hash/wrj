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
export interface Principal { userId: Identifier; username: string; role: Role; permissions: readonly Permission[]; menuPaths?: string[]; }
export interface RbacDecision { allowed: boolean; permission: Permission; reason?: 'PERMISSION_DENIED' | 'LAST_ADMIN_GUARD' | 'CONFIRMATION_REQUIRED'; }
export interface LoginRequest { username: string; passwordFixture: string; }
export interface AuthResult { authenticated: boolean; principal?: Principal; reason?: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED'; sessionCreated: boolean; }

/** Four business information-node roles counted by the 50-node capacity rule. */
export type BusinessInformationNodeType =
  | 'REAR_COMMAND_NODE' | 'FORWARD_RELAY_NODE'
  | 'GROUND_CLUSTER_COMMAND_NODE' | 'AIRBORNE_MISSION_CLUSTER';
/** Configurable supporting entities; they never count toward the 50 business nodes. */
export type SupportingEntityType = 'COMMUNICATION_SATELLITE' | 'GROUND_JAMMER_DETECTION_STATION' | 'AIRBORNE_JAMMER_PLATFORM';
export type PlatformType = BusinessInformationNodeType | SupportingEntityType;
/** 通信卫星的业务子类型；不增加信息节点分类数量。 */
export type SatelliteType = 'TIANTONG' | 'SHENTONG';
export type DeploymentDomain = 'ground' | 'air' | 'space';
export type LinkType = 'SAT' | 'MICROWAVE' | 'DATALINK' | 'LASER' | 'FIBER';
/** 已确认的新写入业务类型四枚举；读取保留历史业务文本。 */
export type InformationType = '态势信息' | '目标指令' | '侦察信息' | '状态信息';
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
  /** 仿真时钟倍速；旧场景缺省时使用文档默认值 2。 */
  simClockSpeed?: number;
  /** 海峡宽度，单位 km；不是各条链路的实际通信距离。 */
  transmissionDistance?: number;
  /** 气象档位仅作为配置保存，不自动换算成物理雨衰值。 */
  rainCloudAttenuation?: 'none' | 'lightRain' | 'moderateRain' | 'heavyRain';
}
export interface ScenarioIdentity {
  id: ScenarioId; name: string; description: string; startTime: Iso8601Utc;
  duration: Seconds; timeStep: Seconds; environment: Environment;
}
export interface Platform {
  id: Identifier; name: string; type: PlatformType; category: DeploymentDomain; initialPosition: Position;
  /** 仅通信卫星使用；旧场景允许缺省，新增或编辑卫星时必须选择。 */
  satelliteType?: SatelliteType;
  waypoints: Waypoint[]; linkIds: Identifier[]; sensorIds: Identifier[]; jammerIds: Identifier[];
}
export interface Link {
  id: Identifier; type: LinkType; sourcePlatformId: Identifier; targetPlatformId: Identifier;
  /** 本条链路独立启停；旧配置缺省时沿用历史类型开关，否则默认启用。 */
  enabled?: boolean;
  frequency: Megahertz; bandwidth: Megahertz; txPower: Watts; antennaGain: AntennaGain;
  modulation: Modulation; berThreshold: Ratio01; dataRate: MegabitsPerSecond; direction: LinkDirection;
  /** 链路增益修正，单位 dB；独立于收发天线绝对增益，缺省为 0。 */
  antennaGainCorrectionDb?: Decibels;
  /** 后端约定的编码标识；null 表示尚未指定，UNCODED 表示明确不编码。 */
  coding?: string | null;
  /** 波形抗干扰增益和空域隔离衰减，单位 dB，缺省均为 0。 */
  antiJammingGainDb?: Decibels;
  spatialIsolationDb?: Decibels;
  /** 单跳中继实体：SAT 链路引用通信卫星；微波/数传可引用 FORWARD_RELAY_NODE；缺省或 null 表示无额外中继跳。 */
  relayPlatformId?: Identifier | null;
}
/** 场景级卫星启用与链路切换策略；单条链路开关保存在 Link.enabled。 */
export interface ScenarioLinkSettings {
  /** @deprecated 仅兼容历史配置的默认状态；新配置不再生成或编辑全局类型开关。 */
  enabledTypes?: Record<Exclude<LinkType, 'FIBER'>, boolean> & { FIBER?: boolean };
  enabledSatellites: Record<SatelliteType, boolean>;
  switchCooldownS: Seconds;
  priority: LinkType[];
}
export interface Jammer {
  id: Identifier; platformId: Identifier; type: 'BARRAGE' | 'SPOT' | 'SWEEP'; defaultPower: Watts;
  frequency: Megahertz; bandwidth: Megahertz; autoDetect: boolean; detectionRange: Meters;
  /** 干扰有效作用距离，合同单位 m；界面按海里编辑。候选 weapon 无 maximum_range，生成器用距离门控。 */
  jammingRange: Meters;
  /** 相对仿真开始的触发秒数；旧记录未指定时保留缺省，新建默认 300 秒。 */
  triggerTimeS?: Seconds;
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
  /** 单条链路的业务配置；旧数据缺省时保留为未关联业务。 */
  linkId?: Identifier;
  /** 旧场景缺省时保留未设置方向；新业务明确区分前向和返向。 */
  direction?: 'FORWARD' | 'REVERSE';
  /** 单项业务独立启停；旧场景缺省视为启用，停用保留参数。 */
  enabled?: boolean;
  /** 读取保留历史业务文本；写入由共享校验限制为 InformationType 四枚举。 */
  informationType: string; volumeMb: number; frequencyHz: number; priority: 'HIGH' | 'NORMAL';
  maxLatencyMs: Milliseconds; minDataRateMbps: MegabitsPerSecond;
}
export interface ScenarioConfig {
  schemaVersion: '1.0'; scenario: ScenarioIdentity; platforms: Platform[]; links: Link[];
  jammers: Jammer[]; sensors: Sensor[]; output: OutputConfig;
  informationDemand: InformationDemand[];
  /** 兼容旧场景缺省；链路默认启用，中继卫星单选默认天通（需实体），冷却 5 秒。 */
  linkSettings?: ScenarioLinkSettings;
  /** 场景干扰总开关，缺省为禁用；不覆盖单设备启停设置。 */
  jammingEnabled?: boolean;
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
export interface ScenarioDraftUpdate { config: ScenarioConfig; uiExtensions: ScenarioUiExtensions; expectedRevision?: number; }
export interface ScenarioDraft { config: ScenarioConfig; uiExtensions: ScenarioUiExtensions; revision: number; officialLibraryChanged: false; locked: boolean; }
export interface ScenarioTemplate { templateId: Identifier; name: string; version: string; official: boolean; config: ScenarioConfig; referenceCount: number; uiExtensions?: ScenarioDraft['uiExtensions']; }
export interface ScriptContract { scriptId: Identifier; taskId: TaskId; scenarioId: ScenarioId; configVersion: string; target: 'AFSIM 2.9.0'; checksum: string; preview: string; generatedTime: Iso8601Utc; }
export interface ScenarioValidationRequest { config: ScenarioConfig; }
export interface MutationRequest { expectedRevision: number; }
export interface ScenarioImportRequest { items: ScenarioConfig[]; }
export interface ScenarioImportResult { imported: number; rejected: number; drafts: ScenarioDraft[]; }
export interface TemplateMutationRequest { name: string; config: ScenarioConfig; uiExtensions?: ScenarioDraft['uiExtensions']; }
export interface CopyTemplateRequest { name: string; scenarioId?: ScenarioId; }
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
export interface JammingCommand {
  enabled: boolean; frequency: Megahertz; bandwidth: Megahertz;
  power: Watts; direction: Degrees; duration: Seconds;
}
export interface JammerState extends JammingCommand {
  taskId: TaskId; jammerId: Identifier; executionStatus: 'SUCCESS';
  effectiveFrameId: FrameId; reason: string;
}
export interface ClosedLoopContext {
  frameId: FrameId; detectionEventId: Identifier; targetPlatformId: Identifier; affectedLinkId: Identifier;
}
export interface JammingDecision {
  decisionId: Identifier; runId: RunId; frameId: FrameId; detectionEventId: Identifier;
  targetPlatformId: Identifier; jammerId: Identifier; affectedLinkId: Identifier;
  action: 'START'; linkStatus: UiLinkStatus; effectiveFrameId: FrameId; reason: string;
}
export interface JammingParameterSet {
  version: number; effectiveFrameId: FrameId; parameters: JammingCommand;
}
export interface SyncResult {
  taskId: TaskId; jammerId: Identifier; parameterVersion: number;
  configParameterVersion: number; nodeParameterVersion: number;
  engineParameterVersion: number; uiParameterVersion: number;
  effectiveFrameId: FrameId; effectiveSimulationTime: Seconds;
  status: 'SYNCHRONIZED'; jammerStatus: JammerStatusData;
}
export interface CompositeLossEvidence {
  linkId: Identifier; freeSpaceLossDb: Decibels; systemLossDb: Decibels;
  obstructionLossDb: Decibels; interferenceLossDb: Decibels; totalPathLossDb: Decibels;
  noisePowerDbm: DecibelMilliwatts; effectiveNoiseAndInterferenceDbm: DecibelMilliwatts;
  modelVersion: 'COMPOSITE-LOSS-1.0';
}
export interface RouteCandidateEvidence {
  linkId: Identifier; direction: LinkDirection; eligible: boolean; jamImpactDb: Decibels;
  ber: Ratio01; stabilityFrames: number; rank: number; eliminationReason: string | null;
}
export interface RouteDecision {
  taskId: TaskId; runId: RunId; frameId: FrameId; simulationTime: Seconds;
  direction: LinkDirection; selectedLinkId: Identifier; previousLinkId: Identifier;
  strategy: 'MIN_JAM_IMPACT' | 'MIN_BER_WITH_HYSTERESIS'; metric: number;
  minimumStableFrames: number; hysteresisThreshold: number | null; reason: string;
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
  losses: CompositeLossEvidence[]; routeCandidates: RouteCandidateEvidence[]; routeDecisions: RouteDecision[];
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
export interface SwitchEvent {
  eventId: Identifier; frameId: FrameId; time: Seconds; sourceRegistryTime?: Seconds; type: 'LINK_SWITCH';
  direction: LinkDirection; oldLinkId: Identifier; newLinkId: Identifier; oldBer: Ratio01; newBer: Ratio01;
  stabilityFrames: number; minimumStableFrames: number; hysteresisSatisfied: boolean; cooldownRemainingS: Seconds;
  decision: 'ACCEPTED' | 'REJECTED'; reason: string; dedupeKey: string;
}
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
export interface ReportTimeSeriesPoint { time: Seconds; snrDb: Decibels; ber: Ratio01; interferencePowerDbm: Decibels; }
export interface ReportTimeSeries {
  linkId: Identifier; sourcePlatformId: Identifier; targetPlatformId: Identifier; points: ReportTimeSeriesPoint[];
}
export interface LocalReportEvidence {
  eventFile: { fileName: string; sha256: string }
  positionFile: { fileName: string; sha256: string }
  startTimeS: number
  endTimeS: number
  simulationComplete: boolean
  positionCount: number
  positionIssueCount: number
  waitingForPositionLine: boolean
  eventCount: number
  eventWarningCount: number
  nodes: Array<{ platformId: string; name: string; type: string; side: string; positionCount: number; firstTimeS: number; lastTimeS: number }>
  eventCounts: Array<{ type: string; count: number }>
  connections: Array<{ eventId: string; time: number; scope: 'INTERNAL' | 'INTER_PLATFORM'; sourcePlatformId: string; sourceDeviceId: string; targetPlatformId: string; targetDeviceId: string }>
  deviceEvents: Array<{ eventId: string; type: string; time: number; platformId: string; deviceId: string }>
}
export interface LocalReportExportResult {
  reportId: ReportId
  generated: true
  status: 'SUCCESS'
  format: 'HTML' | 'CSV'
  watermark: string
  verifiedAt: Iso8601Utc
  filePath: string
  sha256: string
}
export interface Report { reportId: ReportId; runId?: RunId; batchId?: Identifier; classification: ReportClassification; generatedTime: Iso8601Utc; status: 'READY'; kpis?: ReportKpis; timeSeries?: ReportTimeSeries[]; localEvidence?: LocalReportEvidence; }
export interface ReportExportRequest { reportId: ReportId; format: 'HTML' | 'PDF' | 'CSV'; confirmationId?: Identifier; }
export interface ReportExportResult { reportId: ReportId; generated: false; status: 'FIXTURE_SUCCESS'; watermark: string; verifiedAt: Iso8601Utc; }
export interface Replay { replayId: ReplayId; runId: RunId; state: ReplayState; durationS: Seconds; currentTimeS: Seconds; eventIds: Identifier[]; }
export interface ReplayCommand { command: 'PLAY' | 'PAUSE' | 'SEEK' | 'STEP_FORWARD' | 'STEP_BACK' | 'SPEED'; value?: number; }
export type ConfirmationAction =
  | 'SCENARIO_WARNING_CONTINUE' | 'OFFICIAL_TEMPLATE_DELETE' | 'SIMULATION_STOP'
  | 'MASTER_DATA_DELETE' | 'BATCH_LEVEL_III_EXPORT' | 'BACKUP_RESTORE' | 'FULL_CONFIG_EXPORT' | 'AUDIT_EXPORT';
export interface ConfirmationRequest { action: ConfirmationAction; objectId: Identifier; }
export interface ConfirmationContext { confirmationId: Identifier; state: ConfirmationState; actor: string; role: Role; createdAt: Iso8601Utc; expiresAt: Iso8601Utc; }

export interface User { userId: Identifier; username: string; role: Role; status: 'ACTIVE' | 'DISABLED' | 'LOCKED'; lastLoginAt?: Iso8601Utc; }
export interface MasterDataEntry { key: string; valueType: 'TEXT' | 'NUMBER' | 'BOOLEAN'; value: string | number | boolean; unit?: string; minimum?: number; maximum?: number; }
export interface MasterDataContent { name: string; description: string; entries: MasterDataEntry[]; }
export interface MasterData { dataId: Identifier; kind: string; version: number; referenceCount: number; active: boolean; content?: MasterDataContent; }
/** 显式登记的版本关系，不表示参数已应用到场景；历史关系不自动解除。 */
export interface MasterDataReference { dataId: Identifier; dataVersion: number; targetType: 'SCENARIO' | 'TEMPLATE'; targetId: Identifier; targetVersion: string; }
export interface MasterDataTarget { targetType: 'SCENARIO' | 'TEMPLATE'; targetId: Identifier; targetVersion: string; name: string; }
export interface MasterDataDetails { dataId: Identifier; history: MasterData[]; references: MasterDataReference[]; }
/** 管理员维护的装备默认参数；空值表示未配置，不代表零。频率单位 MHz，阈值为 BER。 */
export interface EquipmentParameter {
  equipmentId: string
  type: string
  frequencyMinMHz: number | null
  frequencyMaxMHz: number | null
  modulation: string | null
  berThreshold: number | null
  bandwidthMHz?: number | null
  txPowerW?: number | null
  dataRateMbps?: number | null
  readOnly: boolean
  version: number
}
export interface MasterDataRequest { operation: 'CREATE' | 'UPDATE' | 'DELETE'; data: MasterData; confirmationId?: Identifier; }
export interface EquipmentReference { equipmentId: string; scenarioId: string; linkId: string; equipmentVersion: number; }
export interface EquipmentDetails { history: EquipmentParameter[]; references: EquipmentReference[]; }
export interface RoleProfile { profileId: string; name: string; baseRole: Role; permissions: Permission[]; menuPaths: string[]; }
export interface RoleAssignment { userId: string; profileId: string; }
export interface AccessControlConfig { version: number; profiles: RoleProfile[]; assignments: RoleAssignment[]; }
export interface UserRoleCommand { operation: 'CREATE' | 'UPDATE' | 'DELETE' | 'ENABLE' | 'DISABLE'; user: User; confirmationId?: Identifier; password?: string; }
export interface BackupRecord { backupId: Identifier; status: 'VALID_FIXTURE' | 'INVALID_FIXTURE' | 'VALID' | 'INVALID'; checksum: string; createdAt: Iso8601Utc; name?: string; format?: 'SYSTEM_SQLITE_V1' | 'MAIN_SQLITE_V1'; }
export interface BackupRequest { operation: 'BACKUP'; backupId?: Identifier; name?: string; confirmationId: Identifier; }
export interface BackupPlan { version: number; enabled: boolean; name: string; intervalMinutes: number; }
export interface BackupExecution { startedAt: Iso8601Utc; completedAt: Iso8601Utc; result: 'SUCCESS' | 'FAILURE'; backupId: string | null; message: string; }
export interface BackupPlanStatus { plan: BackupPlan; nextRunAt: Iso8601Utc | null; executions: BackupExecution[]; }
export interface RestoreRequest { operation: 'RESTORE'; backupId: Identifier; confirmationId: Identifier; }
export interface AuditRecord { auditId: Identifier; actor: string; role: Role; module: string; action: string; objectId?: Identifier; result: 'SUCCESS' | 'DENIED' | 'ERROR'; occurredAt: Iso8601Utc; immutableFixture: true; }
export interface AuditRequest { from?: Iso8601Utc; to?: Iso8601Utc; actor?: string; role?: Role; module?: string; action?: string; result?: AuditRecord['result']; export?: boolean; confirmationId?: Identifier; }
export interface AuditExportRequest extends AuditRequest { export: true; confirmationId: Identifier; }
export interface AuditExportResult { objectId: 'AUDIT-LOG'; generated: true; classification: 'INTERNAL'; watermark: string; verifiedAt: Iso8601Utc; fileName: string; content: string; recordCount: number; }
export interface SystemHealth { ui: 'HEALTHY'; engine: 'NOT_CONNECTED_BY_DESIGN'; database: 'NOT_CONNECTED_BY_DESIGN'; channel: 'NOT_CONNECTED_BY_DESIGN'; }
export interface ArchiveRecord { archiveId: ArchiveId; taskId: TaskId; scenarioId: ScenarioId; runId: RunId; replayId: ReplayId; reportId: ReportId; status: 'INDEXED'; }
/** 真实文件快照不借用任务或运行编号；保留旧 ArchiveRecord 供旧合同读取。 */
export interface LocalArchiveRecord {
  archiveId: string; name: string; createdAt: Iso8601Utc; createdBy: string;
  sourceKind: 'LOCAL_FILE_SNAPSHOT'; binding: 'UNBOUND';
  eventFile: { fileName: string; sha256: string }; positionFile: { fileName: string; sha256: string };
  reportId: ReportId; nodeCount: number; positionCount: number; durationS: Seconds;
}
export interface DeleteResult { deleted: boolean; objectId: Identifier; }
export interface RestoreResult { prebackupId: Identifier; integrityValid: boolean; progress: Percent0To100; result: 'SUCCESS' | 'FAILURE'; rolledBack: boolean; generated: boolean; }
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
  | 'INVALID_TRANSITION' | 'NODE_LIMIT_EXCEEDED' | 'DUPLICATE_EVENT' | 'VERSION_CONFLICT' | 'FRAME_MISMATCH'
  | 'HEADER_INVALID' | 'TYPE_INVALID' | 'ENCODING_INVALID' | 'ATOMIC_REPLACE_FAILED'
  | 'START_FAILED' | 'TIMEOUT' | 'EXIT_NONZERO' | 'CORRUPT_FIXTURE'
  | 'OUT_OF_RANGE' | 'DEVICE_DISABLED'
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
