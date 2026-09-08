# 03 TypeScript 领域模型

机器可读合同是 `contracts/domain-models.ts`；后续实现复制或发布该文件时不得改名、删字段、改变单位或缩窄 SRS 接口。该文件无 imports、无依赖、无实现体，仅有类型、三个 literal header constants 和 adapter 声明。

## Canonical 根模型

`ScenarioConfig` 固定 `schemaVersion: '1.0'`，根字段依次覆盖 `scenario/platforms/links/jammers/sensors/output/informationDemand`。以下字段来自 SRS §1.2.2、§3.5.3 与已评审通过的需求基线 §6.1；canonical 合同不得改名或用带单位后缀的内部名称替换：

| 对象 | Canonical fields | 嵌套对象 |
|---|---|---|
| `scenario` | `id`, `name`, `description`, `startTime`, `duration`, `timeStep`, `environment` | environment 完整覆盖海况、温湿、降雨/多径参数 |
| `platforms[]` | `id`, `name`, `type`, `category`, `initialPosition`, `waypoints`, `linkIds`, `sensorIds`, `jammerIds` | 四个关联集合必须存在但允许为空；position=`longitude/latitude/altitude`; waypoint 再含 `speed/arrivalTime` |
| `links[]` | `id`, `type`, `sourcePlatformId`, `targetPlatformId`, `frequency`, `bandwidth`, `txPower`, `antennaGain`, `modulation`, `berThreshold`, `dataRate`, `direction` | antennaGain=`tx/rx`; direction=`FORWARD/REVERSE` |
| `jammers[]` | `id`, `platformId`, `type`, `defaultPower`, `frequency`, `bandwidth`, `autoDetect`, `detectionRange` | type=`BARRAGE/SPOT` 对应宽带压制/瞄准式 |
| `sensors[]` | `id`, `platformId`, `frequencyRange`, `detectionRange` | frequencyRange=`min/max` |
| `output` | `directory`, `writeInterval`, `linkQualityEnabled`, `eventsEnabled`, `linkSwitchEnabled` | 平铺三个 SRS 输出开关，不重塑成内部 `csv` 对象 |
| `informationDemand[]` | `id`, `sourcePlatformId`, `destinationPlatformIds`, `informationType`, `volumeMb`, `frequencyHz`, `priority`, `maxLatencyMs`, `minDataRateMbps` | 至少一项；源/目标引用闭合，目标非空且不重复 |

`scenario` 是 canonical 名；输入适配器可以识别旧称 `scene`，但输出、store 和 API 永不发出旧称。`InformationDemand[]` 已由冻结需求基线纳入本阶段 canonical ScenarioConfig，不能省略。干扰器和传感器的 UI 扩展单独存放在 `ScenarioUiExtensions`，不得进入正式 ScenarioConfig JSON。若实现希望使用带单位后缀的 view-model，只能定义独立 DTO 与 adapter，不能修改上述 canonical 类型。

场景实体类型为七项（含本轮用户新增机载干扰平台）：四类业务信息节点 `REAR_COMMAND_NODE | FORWARD_RELAY_NODE | GROUND_CLUSTER_COMMAND_NODE | AIRBORNE_MISSION_CLUSTER`，三类支撑实体 `COMMUNICATION_SATELLITE | GROUND_JAMMER_DETECTION_STATION | AIRBORNE_JAMMER_PLATFORM`。只有四类业务信息节点计入 50 个容量；`category` 仅表示 `ground | air | space` 部署域。链路允许 `SAT | MICROWAVE | DATALINK | LASER`。坐标为 degrees，高度/距离为 m，速度 m/s，频率/带宽 MHz，发射/干扰设备功率 W，接收/干扰计算功率 dBm，增益 dBi，损耗/SNR dB，速率 Mbps，时延 ms，时间/持续期 s，BER/概率为 0..1，无百分号字段除显式 Percent0To100。

## 五个 SRS 前端接口

| 类型 | 必须完整保留的字段组 | 消费者 |
|---|---|---|
| `LinkQualityData` | time、两端平台、体制、频带、距离、功率/增益/损耗、干扰/接收功率、SNR、调制、BER、canonical 状态、阈值、速率 | telemetry、链路弹窗、报告、CSV adapter |
| `LinkStatusSummary` | linkKey、两端、体制、当前 SNR/BER、canonical 状态、updatedAt | 指标面板、候选/切换 |
| `JammerStatusData` | time、jammer/platform/target、功率、频带、active | 干扰闭环、平台状态 |
| `PlatformStatus` | identity/type、经纬高/速度、linkIds、jammers、updatedAt | 地图、节点弹窗 |
| `SimulationState` | canonical 五态、current/total time、processId、progress、errorMessage | 仿真工具栏、runtime topic |

详细设计中的稀疏 LinkQualityData 仅能通过兼容 adapter 读入，不能取代上述 superset。聚合字段独立放在 `LinkStatusAggregateExtension`，不得污染单链路接口。

## UI 投影

- `UiSimulationStatus` 比 canonical 多 `STOPPED`；`projectUiSimulationStatus` 是唯一写出边界。
- `UiLinkStatus` 比 canonical 多 `DEGRADED`；`projectUiLinkStatus` 必须结合 BER/阈值，禁止直接 cast。
- capability、confirmation、replay、batch、configuration lock 均使用独立 union，禁止复用一个宽泛 `status: string`。
- adapter 返回 `ApiResult<T>`，错误必须包含 error code、message、retryable、correlationId，可定位字段时必须有 fieldPath。

## CSV 合同

三个 literal constants 是字段名和顺序的唯一来源：`LINK_QUALITY_CSV_HEADER`、`EVENTS_CSV_HEADER`、`LINK_SWITCH_CSV_HEADER`。编码 UTF-8、逗号分隔、首行表头、任务隔离和生产阶段原子替换属于 writer 约束。当前 mock 只返回合同描述，绝不创建 CSV。UI `DEGRADED` 必须先投影为 `UP/DOWN`。

## 验证规则

- `schemaVersion` 精确等于 `1.0`；未知版本拒绝。
- platform/link/jammer/sensor/id 在各自集合唯一；所有引用必须闭合。
- 经度 `[-180,180]`、纬度 `[-90,90]`；duration、timeStep、frequency、bandwidth 必须 `> 0`；txPower、defaultPower、dataRate、detectionRange 必须 `>= 0`；BER/概率为 `[0,1]`。
- waypoints 按 `arrivalTime` 严格递增且不超过 duration；frame 级 `jammerExecution` 的时间窗落在仿真区间。
- 四类业务信息节点的实例合计不超过 50 且至少 1 个；支撑实体不计入容量。第 51 个业务信息节点返回 `NODE_LIMIT_EXCEEDED` 与 `platforms` fieldPath，草稿保持不变。
- 四类链路与 `BARRAGE/SPOT` 两类干扰设备都必须有确定性覆盖；`informationDemand` 至少 1 项。
- 校验只有 WARNING 时允许继续，但脚本预览必须携带一次性 warning confirmation；存在 ERROR 时拒绝。
- WS envelope 的 schemaVersion/taskId/topic/sequence 必填；frame topic 必须有 frameId 和 simulationTime。

## 版本演进规则

1.x 只允许向可选扩展对象增加字段；canonical 必填字段、枚举、单位或 CSV 顺序变化必须升级 major 并保留读入 adapter。OpenAPI `DeterministicFixtures`、JSON 顶层 `validation` 和 TypeScript `DeterministicFixtureSet` 形成可机读三向链接；contract tests 同时锁定名称、schema、error catalog 和 fixture shape，防止漂移。
