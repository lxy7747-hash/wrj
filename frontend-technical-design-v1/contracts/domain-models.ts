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
  | 'BACKUP_RESTORE' | 'AUDIT_READ' | 'FULL_CONFIG_EXPORT';
export interface Principal { userId: Identifier; username: string; role: Role; permissions: readonly Permission[]; menuPaths?: string[]; }
export interface RbacDecision { allowed: boolean; permission: Permission; reason?: 'PERMISSION_DENIED' | 'LAST_ADMIN_GUARD' | 'CONFIRMATION_REQUIRED'; }
export interface LoginRequest { username: string; passwordFixture: string; }
export interface AuthResult { authenticated: boolean; principal?: Principal; reason?: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED'; sessionCreated: boolean; }

/** Four business information-node roles counted by the shared capacity rule. */
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
/** 激光链路的光学收发参数；波长由 frequency（MHz）换算，不重复存储。 */
export interface LaserLinkParameters {
  txApertureDiameterM: number;
  rxApertureDiameterM: number;
  pulseWidthS: number;
  modulation: 'OOK';
}
/** SRS §3.5.3 Table 22 nested position object. */
export interface Position { longitude: Degrees; latitude: Degrees; altitude: Meters; }
export interface Waypoint extends Position {
  speed: MetersPerSecond;
  /** 期望到达时刻（仿真秒），严格递增且不超过场景时长；引擎按速度推进，不强制到达时刻。 */
  arrivalTime: Seconds;
  /** 航向角，0～360°；缺省时由运动器根据航线计算。 */
  heading?: Degrees;
  /** 期望加速度（m/s²）；仅保留配置和清单记录。 */
  acceleration?: number;
}
export interface AntennaGain { tx: DecibelsIsotropic; rx: DecibelsIsotropic; }
/** 可由基础数据快照填充的链路字段；来源元数据只记录显式应用的字段。 */
export type LinkParameterField =
  | 'frequency' | 'bandwidth' | 'txPower' | 'dataRate' | 'modulation' | 'berThreshold' | 'coding'
  | 'rxFrequency' | 'rxBandwidth' | 'antennaGain.tx' | 'antennaGain.rx' | 'antennaGainCorrectionDb'
  | 'noiseFigureDb' | 'txPolarization' | 'rxPolarization';
/** 基础数据快照来源；目录实体的存在性和枚举 entryKey 的闭合由保存服务核对。 */
export interface LinkParameterSource {
  kind: 'EQUIPMENT' | 'MASTER_DATA';
  sourceId: string;
  sourceVersion: number;
  fields: LinkParameterField[];
  /** 仅 MASTER_DATA 枚举条目使用；未选择时不回退为任意默认项。 */
  entryKey?: string;
}
/** 新模板中通信设备按五类平台、端口及天线图统一配置。 */
export type TemplatePlatformType =
  | 'MISSION_UAV_PLATFORM'
  | 'COMMAND_VEHICLE_PLATFORM'
  | 'REAR_COMM_PLATFORM'
  | 'TIAN_TONG_SAT'
  | 'SHEN_TONG_SAT';
export type TemplateAntennaName =
  | 'OMNI_ANTENNA'
  | 'MICRO_UAV_OMNI_ANTENNA'
  | 'MICRO_REAR_PLATFORM_DIR_ANTENNA'
  | 'OMNI_ANTENNA_HIGHGAIN'
  | 'C_BAND_DIRECTIONAL_VEHICLE_ANTENNA'
  | 'C_BAND_DIRECTIONAL_UAV_ANTENNA'
  | 'L_BAND_DIRECTIONAL_VEHICLE_ANTENNA'
  | 'L_BAND_DIRECTIONAL_UAV_ANTENNA'
  | 'SAT_GROUND_MOBILE_ANTENNA'
  | 'SAT_SPACE_BEAM_ANTENNA'
  | 'SAT_UAV_CLUSTER_WIDEBAND_ANTENNA'
  | 'LASER_COMM_ANTENNA';
/** 一个模板通信端口的可编辑参数；省略时只在读取/生成时采用模板默认值。 */
export interface PortParameters {
  txFrequency: Megahertz; txBandwidth: Megahertz; txPower: Watts;
  rxFrequency: Megahertz; rxBandwidth: Megahertz; noiseFigureDb: Decibels;
  transferRate: MegabitsPerSecond;
  eirpDbw?: Decibels; gtDbk?: Decibels;
  parameterSource?: LinkParameterSource;
}
export interface DeviceParameters {
  ports?: Partial<Record<TemplatePlatformType, Partial<Record<string, PortParameters>>>>;
  antennaGains?: Partial<Record<TemplateAntennaName, Decibels>>;
}
export interface FrequencyRange { min: Megahertz; max: Megahertz; }
export interface Environment {
  seaState: number; rainRateMmPerHour: number; multipathEnabled: boolean;
  /** 仿真时钟倍速；旧场景缺省时使用文档默认值 2。 */
  simClockSpeed?: number;
  /** 海峡宽度，单位 km；不是各条链路的实际通信距离。 */
  transmissionDistance?: number;
  /** 雨强档位；界面选择后同步写入 rainRateMmPerHour（0/10/25/50/100 mm/h）。 */
  rainCloudAttenuation?: 'none' | 'lightRain' | 'moderateRain' | 'heavyRain' | 'stormRain';
  /** 云层高度范围（m）与云中液态水密度（g/m³）；旧场景缺省时采用对接示例值 500/2000/0.5。 */
  cloudAltitudeMinM?: Meters;
  cloudAltitudeMaxM?: Meters;
  cloudWaterDensityGM3?: number;
  /** 海面多径衰落启用后在地图上框选的海面区域顶点（至少 3 个，按绘制顺序）；缺省表示未框选，脚本不写坐标。 */
  seaPolygon?: GeoPoint[];
  /** 以下为 link_calc natural_environment 参数（《与前端字段确认说明》）；旧场景缺省时按文档默认值生成。 */
  rainEnabled?: boolean;
  rainAltitudeLimitM?: Meters;
  /** 固定雨衰兜底值，仅雨强为 0 时生效。 */
  rainAttenuationDb?: Decibels;
  cloudEnabled?: boolean;
  atmosphereModel?: 'itu' | 'simplified' | 'auto';
  /** 简化大气衰减率；大于 0 时优先于 ITU 模型。 */
  simplifiedAttenuationDbPerKm?: number;
  polarizationMismatchDb?: Decibels;
  pointingErrorDb?: Decibels;
  seaLowAltitudeThresholdM?: Meters;
  seaPathOverSeaThresholdKm?: number;
  seaModel?: 'coarse' | 'fine';
  seaPolarization?: Polarization;
  seaWaterTempC?: number;
  /** 海面高度标准差 σh（m）；不大于 0 时由海况等级推导。 */
  seaSurfaceRoughnessM?: Meters;
}
export type Polarization = 'vertical' | 'horizontal';
export interface GeoPoint { longitude: Degrees; latitude: Degrees; }
export interface ScenarioIdentity {
  id: ScenarioId; name: string; description: string; startTime: Iso8601Utc;
  duration: Seconds; timeStep: Seconds; environment: Environment;
  /** 用户明确设置的任务阶段，区间不重叠；缺省时不推断阶段。 */
  phases?: TaskPhase[];
  /** 新模板运行模式；旧场景读取时按实时模式处理。 */
  realtime?: boolean;
}
export interface TaskPhase { id: Identifier; name: string; startTimeS: Seconds; endTimeS: Seconds; }
/** 模板盘旋、返航路线点，仅要求位置和速度。 */
export interface TemplateRoutePoint extends Position { speed: MetersPerSecond; }
export interface ReturnPlan { timeS: Seconds; waypoints: TemplateRoutePoint[]; }
export interface Platform {
  id: Identifier; name: string; type: PlatformType; category: DeploymentDomain; initialPosition: Position;
  /** 仅通信卫星使用；旧场景允许缺省，新增或编辑卫星时必须选择。 */
  satelliteType?: SatelliteType;
  /** 仅任务无人机、前出中继和机载干扰平台支持；缺省表示不盘旋。 */
  loiterWaypoints?: TemplateRoutePoint[];
  /** 仅任务无人机、前出中继支持；缺省表示不生成返航路线。 */
  returnPlan?: ReturnPlan;
  waypoints: Waypoint[]; linkIds: Identifier[]; sensorIds: Identifier[]; jammerIds: Identifier[];
}
export interface Link {
  id: Identifier; type: LinkType; sourcePlatformId: Identifier; targetPlatformId: Identifier;
  /** 本条链路独立启停；旧配置缺省时沿用历史类型开关，否则默认启用。 */
  enabled?: boolean;
  frequency: Megahertz; bandwidth: Megahertz; txPower: Watts; antennaGain: AntennaGain;
  modulation: Modulation; berThreshold: Ratio01; dataRate: MegabitsPerSecond; direction: LinkDirection;
  /** 前向/返向独立传输速率；缺省时兼容历史 dataRate。 */
  forwardDataRate?: MegabitsPerSecond;
  reverseDataRate?: MegabitsPerSecond;
  /** 仅 LASER 使用；通用 modulation 仍兼容既有 BPSK/QPSK 链路字段。 */
  laser?: LaserLinkParameters;
  /** 链路增益修正，单位 dB；独立于收发天线绝对增益，缺省为 0。 */
  antennaGainCorrectionDb?: Decibels;
  /** 后端约定的编码标识；null 表示尚未指定，UNCODED 表示明确不编码。 */
  coding?: string | null;
  /** 波形抗干扰增益和空域隔离衰减，单位 dB，缺省均为 0。 */
  antiJammingGainDb?: Decibels;
  spatialIsolationDb?: Decibels;
  /** 单跳中继实体：SAT 链路引用通信卫星；微波/数传可引用 FORWARD_RELAY_NODE；缺省或 null 表示无额外中继跳。 */
  relayPlatformId?: Identifier | null;
  /** 数传波段，仅 DATALINK 使用；旧链路缺省为 C 波段。 */
  band?: DatalinkBand;
  /** 接收机频率与带宽（MHz）；缺省时与发射参数相同。frequency/bandwidth 为发射参数。 */
  rxFrequency?: Megahertz;
  rxBandwidth?: Megahertz;
  /** 收发极化；缺省时微波为水平极化，其余为垂直极化。 */
  txPolarization?: Polarization;
  rxPolarization?: Polarization;
  /** 接收机噪声系数（dB）；缺省 3 dB（含天通卫星）。 */
  noiseFigureDb?: Decibels;
  /** 新增/编辑时用户选择的基础数据快照；旧场景可省略。 */
  parameterSource?: LinkParameterSource;
}
export type DatalinkBand = 'C' | 'L';
/** 链路切换触发条件：两端距离超过/低于阈值，或指定干扰设备开启/关闭。 */
export type LinkSwitchTrigger = 'DISTANCE_ABOVE' | 'DISTANCE_BELOW' | 'JAMMING_ACTIVE' | 'JAMMING_STOPPED';
/**
 * 场景级链路切换规则：条件满足时，源→目标的业务改走 toLinkId。
 * 距离条件使用 distanceThresholdM；干扰条件使用 jammerId。多条规则按冷却时间防止往复切换。
 */
export interface LinkSwitchRule {
  id: Identifier; enabled?: boolean; trigger: LinkSwitchTrigger;
  sourcePlatformId: Identifier; targetPlatformId: Identifier; toLinkId: Identifier;
  distanceThresholdM?: Meters; jammerId?: Identifier;
}
/** 场景级卫星启用与链路切换策略；单条链路开关保存在 Link.enabled。 */
export interface ScenarioLinkSettings {
  /** 业务发送周期（s）；旧场景缺省为 5。 */
  messageIntervalS?: Seconds;
  /** @deprecated 仅兼容历史配置的默认状态；新配置不再生成或编辑全局类型开关。 */
  enabledTypes?: Record<Exclude<LinkType, 'FIBER'>, boolean> & { FIBER?: boolean };
  enabledSatellites: Record<SatelliteType, boolean>;
  switchCooldownS: Seconds;
  /** 防抖：新链路须连续满足条件的检查次数；缺省按 3 帧。 */
  switchStableChecks?: number;
  /** 防抖：切换前复核选路结果一致；缺省 true，候选在稳定窗内变化时重新计数。 */
  switchConsistencyCheck?: boolean;
  /** 质量选路门限；缺省由 LINK_DECISION_DEFAULTS 补齐。 */
  minimumGxbDb?: Decibels;
  maximumBer?: Ratio01;
  minimumGxbImprovementDb?: Decibels;
  minimumBerImprovementFactor?: number;
  switchCooldownFrames?: number;
  minimumSpatialIsolationDb?: Decibels;
  /** 可选的硬失效门限；未配置时不凭空把质量帧判为中断。 */
  minimumReceivedPowerDbm?: Decibels;
  failureGxbDb?: Decibels;
  failureBer?: Ratio01;
  priority: LinkType[];
  /** 可配置的阶段切换规则；缺省表示只按优先级选主链路，不在仿真中切换。 */
  switchRules?: LinkSwitchRule[];
  /** link_calc 全局阈值与编码；缺省时按《与前端字段确认说明》默认值生成。 */
  linkCalc?: LinkCalcSettings;
  /** 热链配置（全局）；缺省时按已启用链路自动串联。 */
  hotLinks?: HotLinkSettings;
}
/**
 * 热链：每条热链是首尾相接的链路编号序列（后一条的源平台等于前一条的目标平台），
 * 跳点与端口由生成器从链路设备推出。forward 只含前向链路，reverse 只含返向链路。
 */
export interface HotLinkSettings {
  forward: Identifier[][]; reverse: Identifier[][];
  /** 热链终点的平台类型，生成时写参考模型名（如 REAR_COMM_PLATFORM）；默认后方指挥节点。 */
  endPlatformType: Exclude<BusinessInformationNodeType, 'FORWARD_RELAY_NODE'>;
}
/** 信道编码增益（dB）：-1 关闭，0 无编码，5.0/6.5 卷积码，3.5 RS 码，8.0 Turbo 码。 */
export type ChannelEncodingScheme = -1 | 0 | 5 | 6.5 | 3.5 | 8;
export interface LinkCalcSettings {
  /** link_calc 更新周期（s）；旧场景缺省为 5。 */
  updateIntervalS?: Seconds;
  emergencyThreshold: Ratio01; warningThreshold: Ratio01; valueThresholdBer: Ratio01;
  /** 干扰圈半径，单位 km（0～100）。 */
  jammingRangeKm: number;
  channelEncodingScheme: ChannelEncodingScheme;
}
export interface Jammer {
  /** 2026-11-06 模板侦测与链路计算参数；缺省时由读取副本补齐。 */
  radarFrequency?: Megahertz; radarBandwidth?: Megahertz; radarPower?: Watts;
  noiseFigureDb?: Decibels; gtDbk?: Decibels; eirpDbw?: Decibels;
  antennaGainDbi?: DecibelsIsotropic; txLossDb?: Decibels; sweepDutyCycle?: Ratio01;
  id: Identifier; platformId: Identifier; type: 'BARRAGE' | 'SPOT' | 'SWEEP'; defaultPower: Watts;
  frequency: Megahertz; bandwidth: Megahertz; detectionRange: Meters;
  /** 干扰有效作用距离（触发半径），合同单位 m；界面按 km 编辑。候选 weapon 无 maximum_range，生成器用距离门控。 */
  jammingRange: Meters;
  /** 干扰机离开后的释放距离，合同单位 m；界面按 km 编辑，缺省为干扰范围加 5 海里。 */
  releaseRange?: Meters;
  /** 自动探测最小有效距离，单位 m；旧场景缺省时按模板的 1000 m 生成。 */
  detectionMinimumRange?: Meters;
  /** 相对仿真开始的触发秒数；旧记录未指定时保留缺省，新建默认 300 秒。 */
  triggerTimeS?: Seconds;
  /** 可选干扰时序配置，单位 s；未填写时不发送，需服务端同步支持。 */
  detectionDelayS?: Seconds; jammingDurationS?: Seconds;
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
  /** 新模板通信设备快照；缺省场景在读取/生成时采用模板默认值。 */
  deviceParameters?: DeviceParameters;
}

/** Five complete SRS §3.5.4 frontend interfaces (canonical superset). */
export interface LinkQualityData {
  time: Seconds; sourcePlatform: Identifier; destPlatform: Identifier; linkType: LinkType;
  frequency: Megahertz; bandwidth: Megahertz; distance: Meters; txPower: Watts;
  txAntennaGain: DecibelsIsotropic; rxAntennaGain: DecibelsIsotropic;
  pathLoss: Decibels; jammingPower: DecibelMilliwatts; receivedPower: DecibelMilliwatts;
  snr: Decibels; modulation: Modulation; ber: Ratio01; linkStatus: CanonicalLinkStatus;
  berThreshold: Ratio01; dataRate: MegabitsPerSecond;
  /** 干信比（dB）、端到端时延（ms）、可用率（%）；引擎提供时展示，缺省显示“暂无数据”。 */
  jsrDb?: Decibels; latencyMs?: number; availabilityPercent?: number;
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
  processId: number | null; progress: Percent0To100; errorMessage?: string; mode?: SimulationMode; speedMultiplier?: number;
}

export type CapabilityState = 'LOADING' | 'VALIDATING' | 'EXECUTING' | 'SUCCESS' | 'EMPTY' | 'ERROR';
export type CanonicalSimulationStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'ERROR';
export type UiSimulationStatus = CanonicalSimulationStatus | 'STOPPED';
export type CanonicalLinkStatus = 'UP' | 'DOWN';
export type UiLinkStatus = CanonicalLinkStatus | 'DEGRADED';
export type ConfirmationState = 'CLOSED' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'ERROR';
export type ReplayState = 'EMPTY' | 'LOADING' | 'PAUSED' | 'PLAYING' | 'SEEKING' | 'COMPLETED' | 'CORRUPT' | 'ERROR';
export type ConfigurationLockState = 'UNLOCKED' | 'LOCKING' | 'LOCKED' | 'UNLOCKING' | 'ERROR';
export interface UiLinkProjection {
  linkId: Identifier; frameId: FrameId; status: UiLinkStatus; canonicalStatus: CanonicalLinkStatus;
  reason: string; thresholdVersion: string; consecutiveFrames: number; ageMs: Milliseconds;
  jsrThresholdDb?: Decibels; warningBerThreshold?: Ratio01; emergencyBerThreshold?: Ratio01; jitterSuppressed?: boolean;
}
export interface LinkStatusAggregateExtension {
  totalLinks: number; upLinks: number; degradedUiLinks: number; downLinks: number;
  connectivityRate: Percent0To100; avgSnrDb: Decibels; avgBer: Ratio01; switchCount: number;
}

export interface ValidationIssue { severity: 'ERROR' | 'WARNING'; code: string; message: string; fieldPath: string; }
export interface ValidationResult { valid: boolean; errors: ValidationIssue[]; warnings: ValidationIssue[]; }
/** UI-only fields are kept beside, never inside, the canonical ScenarioConfig. */
export interface JammerUiExtension {
  jammerId: Identifier;
  /** 干扰指向方位角，0～360°。 */
  direction: Degrees;
  enabled: boolean;
  /** 干扰天线俯仰角，-10～60°；缺省为 0°。 */
  elevation?: Degrees;
}
export interface NativeEsmSettings { sensitivityDbw: number; detectionThresholdDb: number; dwellTimeS: Seconds; revisitTimeS: Seconds; }
export interface SensorUiExtension { sensorId: Identifier; type: 'ESM'; direction: 'OMNI' | Degrees; probability: Ratio01; enabled: boolean; esm?: NativeEsmSettings; }
export interface ScenarioUiExtensions { jammers: JammerUiExtension[]; sensors: SensorUiExtension[]; }
/** 本地场景文件格式，与纯 ScenarioConfig 导入保持兼容。 */
export interface ScenarioSnapshot { format: 'wrj.scenario.snapshot'; version: 1; config: ScenarioConfig; uiExtensions: ScenarioUiExtensions; }
export interface ScenarioDraftUpdate { config: ScenarioConfig; uiExtensions: ScenarioUiExtensions; expectedRevision: number; }
export interface ScenarioDraft { config: ScenarioConfig; uiExtensions: ScenarioUiExtensions; revision: number; officialLibraryChanged: false; locked: boolean; }
export interface ScenarioTemplate { templateId: Identifier; name: string; version: string; official: boolean; config: ScenarioConfig; referenceCount: number; uiExtensions?: ScenarioDraft['uiExtensions']; }
export interface ScriptContract { scriptId: Identifier; taskId: TaskId; scenarioId: ScenarioId; configVersion: string; target: 'AFSIM 2.9.0'; checksum: string; preview: string; generatedTime: Iso8601Utc; }
export interface ScenarioValidationRequest { config: ScenarioConfig; }
export interface MutationRequest { expectedRevision: number; }
export interface ScenarioImportRequest { items: Array<ScenarioConfig | ScenarioSnapshot>; }
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
  /** 仅记录 sim_control 发送状态；SENT 不代表引擎已执行，不修改 canonical 或解除配置锁。 */
  engineControl?: EngineControlState;
}
export type EngineControlAction = 'pause' | 'resume' | 'stop';
export interface EngineControlState {
  connected: boolean;
  action: EngineControlAction | null;
  delivery: 'IDLE' | 'SENDING' | 'SENT' | 'UNKNOWN';
}
export type SimulationMode = 'INTERACTIVE_SINGLE' | 'PARAMETER_SCAN' | 'HISTORICAL_REPLAY';
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
  action: 'START' | 'STOP'; linkStatus: UiLinkStatus; effectiveFrameId: FrameId; reason: string;
}
export interface JammingDecisionEvent { type: 'JAMMING_DECISION'; decision: JammingDecision; }
export interface SensorStatusData {
  type: 'SENSOR_STATUS'; time: Seconds; sensorId: Identifier; platformId: Identifier;
  active: boolean; scanCoveragePercent?: Percent0To100;
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
  modelVersion: string;
  seaMultipathLossDb?: Decibels; atmosphericLossDb?: Decibels; cloudRainLossDb?: Decibels;
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
  configVersion: string; engineVersion: string; uiVersion: string;
  effectiveFrameId: FrameId; effectiveSimulationTime: Seconds;
}
export interface JammerExecutionEvidence {
  jammerId: Identifier; targetPlatformId: Identifier; power: Watts; frequency: Megahertz;
  bandwidth: Megahertz; startTime: Seconds; duration: Seconds; reason: string;
}
export interface FrameEvidence {
  losses: CompositeLossEvidence[]; routeCandidates: RouteCandidateEvidence[]; routeDecisions: RouteDecision[];
  jammerExecution: JammerExecutionEvidence; synchronization: SynchronizationEvidence;
  /** 多台执行证据；存在时非空，首项须与必填的 jammerExecution 一致。 */
  jammerExecutions?: JammerExecutionEvidence[];
}
/** Mock 传输扩展：补充链路身份与质量计算证据，不修改 SRS LinkQualityData。 */
export interface TelemetryLinkRecord extends LinkQualityData {
  linkId: Identifier; coding: 'UNCODED'; qualityModelVersion: string; issues?: ValidationIssue[];
}
export interface TelemetryFrame {
  frameId: FrameId; taskId: TaskId; runId: RunId; simulationTime: Seconds; sequence: SequenceNumber;
  platforms: PlatformStatus[]; links: TelemetryLinkRecord[]; linkSummaries: LinkStatusSummary[];
  uiLinks: UiLinkProjection[];
  eventIds: Identifier[]; evidence: FrameEvidence;
}
export interface DetectionEvent { eventId: Identifier; frameId: FrameId; time: Seconds; sourceRegistryTime?: Seconds; type: 'DETECTION'; sensorId: Identifier; targetPlatformId: Identifier; detectionProbability: Ratio01; dedupeKey: string; frequencyMinMHz?: Megahertz; frequencyMaxMHz?: Megahertz; detected?: boolean; }
export interface SwitchEvent {
  eventId: Identifier; frameId: FrameId; time: Seconds; sourceRegistryTime?: Seconds; type: 'LINK_SWITCH';
  direction: LinkDirection; oldLinkId: Identifier; newLinkId: Identifier; oldBer: Ratio01; newBer: Ratio01;
  stabilityFrames: number; minimumStableFrames: number; hysteresisSatisfied: boolean; cooldownRemainingS: Seconds;
  decision: 'ACCEPTED' | 'REJECTED'; reason: string; dedupeKey: string;
}
export interface QualityScope { taskId: string; runId: string; scenarioId: string; revision: number; startedAt: string; }
export interface QualityLosses {
  freeSpaceLossDb: number; seaMultipathLossDb: number; atmosphericLossDb: number;
  cloudRainLossDb: number; jammingLossDb: number; totalLossDb: number;
}
/** 规范文件中的测量值，不使用场景默认值补齐。 */
export interface QualitySample extends Omit<LinkQualityData, 'modulation'> {
  modulation: Modulation | 'OOK';
  linkId: string; frameId: number; jsrDb: number; losses?: QualityLosses;
  /** 来源明确给出的干扰活动状态，不从有限的 dBm 数值推测。 */
  interferenceActive?: boolean;
}
export interface QualityDataset {
  schemaVersion: '1.0'; scope: QualityScope;
  source: { kind: 'FILE_IMPORT'; fileName: string; sha256: string; importedAt: string; frameIdKind: 'PROVIDED' | 'IMPORT_SEQUENCE'; switchEventsProvided?: boolean };
  expectedStepS: number; samples: QualitySample[];
  /** 文件明确记录的切换事件，不从本机决策生成成功事件。 */
  switchEvents: SwitchEvent[];
}
export interface QualityImportRequest { scope: QualityScope; fileName: string; format: 'JSON' | 'CSV'; text: string; }
/** WS 只发布更新引用，完整记录通过同一运行的质量接口读取。 */
export interface QualityDatasetUpdate { kind: 'QUALITY_UPDATED'; scope: QualityScope; sourceSha256: string; sampleCount: number; }
/** 引擎帧只展示引擎结论；不改变既有规范链路两态或文件质量合同。 */
export interface EngineLinkSegment {
  linkId: string; linkIds: string[];
  sourceName: string | null; sourcePlatformId: string | null; sourcePort: string | null;
  targetName: string | null; targetPlatformId: string | null; targetPort: string | null;
  status: 'UP' | 'DEGRADED' | 'DOWN' | 'UNKNOWN'; engineStatus: string | null; error: string | null;
  distanceM: number | null;
  losses: { freeSpaceDb: number | null; seaMultipathDb: number | null; atmosphericDb: number | null; cloudRainDb: number | null; jammingDb: number | null; totalDb: number | null; rainDb?: number | null; cloudDb?: number | null };
  /** delay 保留上游原值，单位未确认，不用于时长统计。 */
  quality: { gxbDb: number | null; ber: number | null; rxPowerDbw: number | null; rxPowerDbm: number | null; delay?: number | null };
  inputTrace: { eirpDbw: number | null; gtDbk: number | null; dataRateMbps: number | null; frequencyGHz: number | null;
    jammers: { jammerName: string | null; platformId: string | null; distanceM: number | null; eirpDbw: number | null; lossDb: number | null }[] };
}
export interface EnginePathNode { platformName: string | null; platformId: string | null; inPort: string | null; outPort: string | null }
export interface EngineRoute {
  pathId: string; direction: 'FORWARD' | 'REVERSE'; sourceName: string | null; targetName: string | null;
  sourcePlatformId: string | null; targetPlatformId: string | null; transTypes: string[]; nodes: EnginePathNode[];
  /** 原始路径参数，单位待确认；可选以兼容已归档的旧帧。 */
  parameters?: { delay: number | null; transFrequency: number | null; dataContent: number | null };
}
export interface EngineRouteSwitch extends EngineRoute {
  oldPathId: string | null; oldNodes: EnginePathNode[]; reasons: { linkId: string | null; reasons: string[] }[];
}
export interface EngineRouteAlarm { pathId: string | null; linkId: string | null; message: string | null }
export interface EngineFrameEvent { type: string | null; pathId: string | null; uavNames: string[]; jammerNames: string[]; uavIds: string[]; jammerIds: string[] }
export interface EngineJammer {
  name: string | null; platformId: string | null; detectStatus: string | null; deviceStatus: string | null;
  powerW: number | null; frequencyHz: number | null; rangeM: number | null;
  position?: { longitude: number | null; latitude: number | null; altitudeM: number | null };
  engineMode?: string | null;
  detections: { targetNames: string[]; targetIds: string[];
    targets: { name: string | null; platformId: string | null; longitude: number | null; latitude: number | null; altitudeM: number | null }[];
    platformType: string | null; frequencyHz: number | null; probability: number | null; rangeM: number | null }[];
  actions: { action: string | null; targetName: string | null; targetPlatformId: string | null; mode: 'BARRAGE' | 'SPOT' | 'SWEEP' | null; engineMode: string | null }[];
}
export interface EngineFrameSnapshot {
  /** simulationTime 为内部秒数；上游 sim_time_s 实际为毫秒，仅在接收入口转换。 */
  kind: 'ENGINE_FRAME'; runId: string; engineEpoch: number; frameId: number; simulationTime: number;
  /** 上游计时原值，起点未约定，不用于推送延迟判定。 */
  wallTimeMs?: number | null;
  modelVersion: string | null; modulation: string | null;
  links: EngineLinkSegment[]; jammers: EngineJammer[];
  routing: { switches: EngineRouteSwitch[]; alarms: EngineRouteAlarm[] };
  events: EngineFrameEvent[]; initRouting: EngineRoute[] | null;
}
export type LinkMetricPayload = LinkStatusSummary[] | QualityDatasetUpdate | EngineFrameSnapshot;
/**
 * Incremental mission-console output.  It deliberately carries no simulated
 * timestamp or frame identifier: a process log is wall-clock output and the
 * engine does not attach it to a simulation frame.
 */
export interface MissionLogUpdate {
  kind: 'MISSION_LOG'; runId: RunId; text: string; replace: boolean; bytes: number; truncated: boolean;
  /** UTF-8-safe fragments of one source-tail observation, in publish order. */
  chunkIndex: number; chunkCount: number;
  /** Source-file byte interval represented by this update; replace records reset the view. */
  startByteOffset: number; endByteOffset: number;
}
/**
 * Objective upstream connection observation.  `FRAME_ADVANCE_OBSERVED` means
 * the received frame id delta differs from websocketNew's agreed step of 5
 * (5 simulation seconds); it does not establish upstream retransmission support.
 */
export interface EngineConnectionDiagnostic {
  kind: 'ENGINE_CONNECTION_DIAGNOSTIC'; runId: RunId;
  state: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'REJECTED' | 'FRAME_ADVANCE_OBSERVED';
  message: string; previousFrameId?: number; observedFrameId?: number;
}
export type MissionLogPayload = MissionLogUpdate | EngineConnectionDiagnostic;
/** Latest accepted records from the mission-owned position file; its cursor is not an engine frame. */
export interface MissionPositionUpdate {
  kind: 'MISSION_POSITION'; runId: RunId; scenarioId: ScenarioId; revision: number;
  sourceGeneration: number; sourceRecordCount: number; waitingForLine: boolean;
  nodes: Array<{ platformId: string; time: number; longitude: number; latitude: number; altitude: number; speed: number; heading: number }>;
}
/** External engine interference facts from one received engine frame. */
export interface EngineJammerFrameUpdate {
  kind: 'ENGINE_JAMMER_FRAME'; runId: RunId; engineEpoch: number; sourceFrameId: number; simulationTime: number;
  jammers: EngineJammer[]; events: EngineFrameEvent[];
}
/** External engine route switching facts from one received engine frame. */
export interface EngineSwitchFrameUpdate {
  kind: 'ENGINE_SWITCH_FRAME'; runId: RunId; engineEpoch: number; sourceFrameId: number; simulationTime: number;
  switches: EngineRouteSwitch[];
}
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
  /** 大型 CSV 的事件分类计数与来源摘要完整，但逐消息明细未装入内存快照。旧快照省略时视为完整。 */
  messageDetailsComplete?: boolean
  messageDetailEventCount?: number
  nodes: Array<{ platformId: string; name: string; type: string; side: string; positionCount: number; firstTimeS: number; lastTimeS: number }>
  /** 精确节点筛选中仅为关联登记保留的对端标识；不含位置或统计，避免混入节点范围。 */
  relatedNodeIds?: string[]
  eventCounts: Array<{ type: string; count: number }>
  connections: Array<{ eventId: string; time: number; scope: 'INTERNAL' | 'INTER_PLATFORM'; sourcePlatformId: string; sourceDeviceId: string; targetPlatformId: string; targetDeviceId: string }>
  deviceEvents: Array<{ eventId: string; type: string; time: number; platformId: string; deviceId: string }>
  /** ESM/传感器侦测规范事件（目标、频段、概率、时刻）；源文件未给出的字段为 null，不补默认值。旧报告省略。 */
  detectionEvents?: LocalDetectionEvent[]
  /** 链路切换事件；由引擎切换输出解析，旧报告或未发生切换时省略。 */
  switchEvents?: LocalSwitchEvent[]
  /** 评估指标；引擎提供质量与干扰输出时填写，缺省项在报表中显示“暂无数据”。 */
  qualityKpis?: LocalQualityKpis
  /** 按筛选边界裁剪后的有效观测连通率，避免表格截断样本导致图表丢失边界区间。 */
  qualityConnectivityRates?: Array<{ linkId: string; value: number }>
  /** 明确绑定本次运行的规范质量文件及测量记录；旧报告可省略。 */
  quality?: QualityDataset
  /** 真实引擎帧归档摘要；仅保留接收到的帧和其中已解析的事件/切换，不推定缺失帧。 */
  engineFrameArchive?: EngineFrameArchiveSummary
  /** 由已验证引擎帧独立生成的规范 CSV；旧报告可省略。 */
  engineCsv?: EngineCsvEvidence
}
export interface EngineFrameArchiveSummary {
  sourceSha256: string; frameCount: number; firstSimulationTime: number | null; lastSimulationTime: number | null;
  missingFieldNames: string[]; segmentRows: EngineFrameArchiveSegmentRow[];
  switchRows: EngineFrameArchiveSwitchRow[]; eventRows: EngineFrameArchiveEventRow[];
  /** Detail rows are bounded for report/UI/export memory; raw verified JSONL remains downloadable. */
  detailTruncated?: boolean; retainedDetailRows?: number;
  aggregate?: { uniqueSingleSegmentCount: number; averageGxbDb?: number; averageBer?: number; switchCount: number; missing: string[] };
}
export interface EngineCsvEvidence {
  sourceSha256: string
  files: Array<{ fileName: string; rowCount: number; sha256: string; status: 'COMPLETE' | 'PARTIAL'; skippedCount: number; reason?: string }>
  missing: Array<{ fileName: string; status: 'SOURCE_MISSING'; reason: string }>
}
/** 一行对应引擎输出的一段，不按逻辑链路合并。 */
export interface EngineFrameArchiveSegmentRow { engineEpoch: number; frameId: number; simulationTime: number; segment: EngineLinkSegment }
export interface EngineFrameArchiveSwitchRow { engineEpoch: number; frameId: number; simulationTime: number; value: EngineRouteSwitch }
export interface EngineFrameArchiveEventRow { engineEpoch: number; frameId: number; simulationTime: number; value: EngineFrameEvent }
export interface LocalSwitchEvent {
  eventId: string; time: number; demandId: string; ruleId: string | null; fromDeviceId: string; toDeviceId: string
  fromLinkId: string | null; toLinkId: string | null; stableChecks: number | null
}
export interface LocalQualityKpis {
  averageConnectedDurationS?: number; averageJsrDb?: number; averageBer?: number; jammingDurationS?: number
}
export interface LocalDetectionEvent {
  eventId: string; time: number; type: string; platformId: string; sensorId: string; targetPlatformId: string | null
  frequencyMinHz: number | null; frequencyMaxHz: number | null; probability: number | null; detected: boolean | null
}
export interface LocalReportExportResult {
  reportId: ReportId
  generated: true
  status: 'SUCCESS'
  format: 'HTML' | 'PDF' | 'CSV'
  watermark: string
  verifiedAt: Iso8601Utc
  filePath: string
  sha256: string
}
/** 真实运行结果的服务器端精确筛选条件；省略字段表示不过滤。 */
export interface LocalReportFilter { nodeId?: string; linkId?: string; stage?: string; from?: number; to?: number; }
/** 筛选后只返回有界时间线，聚合值始终由已绑定的结果索引计算。 */
export interface LocalReportFilterResult {
  report: Report
  filter: LocalReportFilter
  timeline: Array<{ id: string; time: number; type: string; subject: string; target?: string; device?: string; stage?: string }>
  timelineTotal: number
  stages: string[]
  links: string[]
}
export interface Report { reportId: ReportId; runId?: RunId; classification: ReportClassification; generatedTime: Iso8601Utc; status: 'READY'; kpis?: ReportKpis; timeSeries?: ReportTimeSeries[]; localEvidence?: LocalReportEvidence; }
export interface ReportExportRequest { reportId: ReportId; format: 'HTML' | 'PDF' | 'CSV'; confirmationId?: Identifier; filter?: LocalReportFilter; qualitySha256?: string; }
export interface ReportExportResult { reportId: ReportId; generated: false; status: 'FIXTURE_SUCCESS'; watermark: string; verifiedAt: Iso8601Utc; }
export interface Replay { replayId: ReplayId; runId: RunId; state: ReplayState; durationS: Seconds; currentTimeS: Seconds; eventIds: Identifier[]; }
export interface ReplayCommand { command: 'PLAY' | 'PAUSE' | 'SEEK' | 'STEP_FORWARD' | 'STEP_BACK' | 'SPEED'; value?: number; }
export type ConfirmationAction =
  | 'SCENARIO_WARNING_CONTINUE' | 'OFFICIAL_TEMPLATE_DELETE' | 'SIMULATION_STOP'
  | 'MASTER_DATA_DELETE' | 'BACKUP_RESTORE' | 'FULL_CONFIG_EXPORT' | 'AUDIT_EXPORT';
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
/** 管理员维护的装备默认参数；空值表示未配置，不代表零。频率单位 MHz，阈值为 BER。旧记录缺省 active 视为启用。 */
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
  /** false 表示不再可被新场景选用或新登记引用；既有引用和历史保持原状。 */
  active?: boolean
  readOnly: boolean
  version: number
}
/** 新建或编辑链路时可选择的基础数据目录快照。 */
export interface ScenarioParameterCatalog { equipment: EquipmentParameter[]; masterData: MasterData[]; }
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
export interface AuditDeleteRequest { auditIds: Identifier[]; }
export interface AuditDeleteResult { deletedIds: Identifier[]; }
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
  | 'START_FAILED' | 'INTERNAL_ERROR' | 'TIMEOUT' | 'EXIT_NONZERO' | 'CORRUPT_FIXTURE'
  | 'OUT_OF_RANGE' | 'DEVICE_DISABLED' | 'FILTER_UNSUPPORTED'
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
export type WsTopic = 'simulation.frame' | 'runtime.state' | 'link.metric' | 'jammer.event' | 'switch.event' | 'mission.log' | 'position.update';
export type WsConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'SUBSCRIBED' | 'RETRYING' | 'FAILED';
export interface RealtimeEnvelope<T> { type: string; schemaVersion: '1.0'; topic: WsTopic; taskId: TaskId; sequence: SequenceNumber; simulationTime?: Seconds; frameId?: FrameId; payload: T; }
export interface WsSubscribeRequest { type: 'subscribe'; schemaVersion: '1.0'; taskId: TaskId; topics: WsTopic[]; lastSequence?: SequenceNumber; lastSequences?: Partial<Record<WsTopic, SequenceNumber>>; }
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
  report: Report; archive: ArchiveRecord;
  reset: ResetFixture; metadata: FixtureMetadata; contracts: FixtureContracts;
}

export const LINK_QUALITY_CSV_HEADER = 'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,Frequency,Bandwidth,Distance,TxPower,TxAntennaGain,RxAntennaGain,PathLoss,JammingPower,ReceivedPower,SNR,GXB,Modulation,BER,LinkStatus,BERThreshold,DataRate' as const;
export const EVENTS_CSV_HEADER = 'task_id,SchemaVersion,Time,EventType,SourcePlatform,TargetPlatform,Status,Power,Frequency,Bandwidth,Parameters' as const;
export const LINK_SWITCH_CSV_HEADER = 'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,Direction,OldLinkType,NewLinkType,OldBER,NewBER,SwitchReason' as const;
export const LINK_STATE_CSV_HEADER = 'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,LinkStatus,GXB,BER,ReceivedPower' as const;
export const LINK_LOSS_CSV_HEADER = 'task_id,SchemaVersion,Time,SourcePlatform,DestPlatform,LinkType,FreeSpaceLoss,SeaMultipathLoss,AtmosphericLoss,CloudRainLoss,JammingLoss,TotalLoss' as const;

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
