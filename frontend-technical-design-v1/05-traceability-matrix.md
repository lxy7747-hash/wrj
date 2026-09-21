# 05 需求、接口与来源决策追踪

本矩阵是实现目的地清单。来源采用顺序固定为 SRS → DD → 已评审通过的前端需求基线；HTML 仅保留能力卡锚点，不构成上位需求。`六态证据` 均要求组件测试覆盖 LOADING、VALIDATING、EXECUTING、SUCCESS、EMPTY、ERROR，并在 SUCCESS/ERROR 中断言列出的 fixture 或错误；T-XQ-010、T-XQ-011、T-XQ-012、T-XQ-013、T-XQ-014、T-XQ-018～021 固定证据能力例外为无 EXECUTING 的五态。29 个能力行与 7 个接口行各自唯一，不以来源决策行重复计数。

## 29 项能力

| Requirement | Sources | Route | Page / component | Store | Type | Endpoint / topic | Fixture | 六态证据 | Test ID | Coverage |
|---|---|---|---|---|---|---|---|---|---|---|
| DSDWRJQTLJS-XQ-QDZS-STXR | SRS 3.2.1.1/3.3.1.1; DD 4.1.1/4.2.1.1/5.1.2.1; HTML cap-stxr | `/situation` | `SituationPage/OfflineSituationMap` | `telemetryStore` | `TelemetryFrame`, `PlatformStatus` | `GET .../frames/{frameId}`; `simulation.frame` | F-00042, CMD-01, UAV-01 | 六态+同 frame 图层 | T-XQ-001 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-QDZS-ZBJK | SRS 3.2.1.1/3.3.1.2; DD 4.1.1/4.2.1.2/5.1.2.2; HTML cap-zbjk | `/situation` | `SituationPage/MetricPanel` | `telemetryStore` | `LinkStatusAggregateExtension` | `link.metric`, `runtime.state` | F-00042, RUN-001 | 六态+单位/时刻 | T-XQ-002 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-QDZS-LLTC | SRS 3.2.1.1/3.3.1.3; DD 4.1.1/4.2.1.3/5.1.2.3; HTML cap-lltc | `/situation` | `SituationPage/LinkQualityDialog` | `telemetryStore` | `LinkQualityData`, `UiLinkProjection` | `link.metric` | L-MW-01, L-DL-03 | 六态+新鲜/过期/缺失 | T-XQ-003 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-QDZS-BBKSH | SRS 3.2.1.1/3.3.1.4; DD 4.1.1/4.2.1.4/5.1.2.4; HTML cap-bbksh | `/reports` | `ReportsPage/ReportTabs/LocalReportTabs` | `reportStore`, `batchStore`, `telemetryStore` | `Report`, `ReportTimeSeries`, `BatchRunResult`, `LocalReportEvidence` | `GET /api/v1/reports/{reportId}`、`POST /api/v1/reports/{reportId}/export` | 纯 Mock：RPT-001/RPT-BATCH-001；本机：事件与位置 CSV 摘要绑定 | 保留原测试合同；本机统计不回退夹具，HTML/CSV 真实导出，缺失质量指标/曲线明确无数据 | T-XQ-004 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-CJPZYJBSC-CJKSH | SRS 1.2.2/3.2.1.2/3.3.2.1; DD 4.1.2/4.2.2.1/5.2.2.1; 基线 6.1–6.4; HTML cap-cjksh | `/scenarios` | `ScenariosPage/ScenarioEditor` | `scenarioStore` | `ScenarioConfig`, `ScenarioDraft`, `ScenarioUiExtensions` | `GET/PUT /api/v1/scenarios/{scenarioId}` | SCN-001, `scenarioCoverage` | 六态+四类业务节点/三类支撑实体/50 边界/四类链路/两类干扰/全数据域 | T-XQ-005 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-CJPZYJBSC-CSJY | SRS 3.2.1.2/3.3.2.2; DD 4.1.2/4.2.2.2/5.2.2.2; 基线 6.1/6.3; HTML cap-csjy | `/scenarios` | `ScenariosPage/ValidationPanel` | `scenarioStore` | `ValidationResult`, `ConfirmationContext` | `POST .../scenarios/{scenarioId}/validate`; confirmations | SCN-001 valid/negative txPower/warning | 六态+fieldPath+ERROR 阻断+WARNING 确认 | T-XQ-006 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-CJPZYJBSC-CJMB | SRS 3.2.1.2/3.3.2.3; DD 4.1.2/4.2.2.3/5.2.2.3; HTML cap-cjmb | `/scenarios` | `ScenariosPage/TemplateLibrary` | `scenarioStore`, `authStore` | `ScenarioTemplate`, `ConfirmationState` | `/api/v1/templates*` | SCN-001 template, referenceCount=2 | 六态+七动作/RBAC/引用拒绝 | T-XQ-007 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-CJPZYJBSC-JBSC | SRS 3.2.1.2/3.3.2.4; DD 4.1.2/4.2.2.4/5.2.2.4; HTML cap-jbsc | `/scenarios` | `ScenariosPage/ScriptPreview` | `scenarioStore` | `ScriptContract` | `POST /api/v1/scripts/preview`; preflight | SCRIPT-001 | 六态+结构/行列/追溯 | T-XQ-008 | VISIBLE_CONTRACT |
| DSDWRJQTLJS-XQ-FZYXYLLJS-YQQD | SRS 3.2.1.3/3.3.3.1; DD 4.1.3/4.2.3.1/5.3.2.1; 基线 3/4.2; HTML cap-yqqd | `/situation` | `SituationPage/SimulationToolbar` | `simulationStore` | `SimulationRun`, `SimulationCommand`, `SimulationMode`, `UiSimulationStatus` | `POST .../simulations/{runId}/commands`; `runtime.state` | RUN-001 | 六态+开始/暂停/继续/单步/停止/倍速/模式+UI/canonical/锁清理 | T-XQ-009 | VISIBLE_CONTRACT |
| DSDWRJQTLJS-XQ-FZYXYLLJS-LLJS | SRS 3.2.1.3/3.3.3.2; DD 4.1.3/4.2.3.2/5.3.2.2; HTML cap-lljs | `/blueprint` | `BlueprintPage/LinkCalculatorContractCard` | `traceabilityStore`, `telemetryStore` | `LinkQualityData` | `link.metric` | F-00042, L-MW-01 | 五态（固定证据无 EXECUTING）+同 frame 标准字段 | T-XQ-010 | VISIBLE_CONTRACT |
| DSDWRJQTLJS-XQ-FZYXYLLJS-FHSX | SRS 3.2.1.3/3.3.3.3; DD 4.1.3/4.2.3.3/5.3.2.3; HTML cap-fhsx | `/interactions` | `InteractionsPage/CompositeLossExample` | `telemetryStore`, `uiStore` | `LinkQualityData`, `CompositeLossEvidence` | `GET .../frames/F-00042` | `frame.evidence.losses[L-MW-01]` 四分量=142.5 dB/model 1.0 | 五态（固定证据无 EXECUTING）+总损耗/分量/版本 | T-XQ-011 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-FZYXYLLJS-SNBER | SRS 3.2.1.3/3.3.3.4; DD 4.1.3/4.2.3.4/5.3.2.4; HTML cap-snber | `/interactions` | `InteractionsPage/SnrBerExample` | `telemetryStore`, `uiStore` | `TelemetryLinkRecord`, `CompositeLossEvidence` | `GET .../frames/F-00042` | L-MW-01 receivedPower=-84/noise=-104/SNR=18.62/BER=3.2e-7 | 五态（固定证据无 EXECUTING）+Pr/noise/SNR/BER | T-XQ-012 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-FZYXYLLJS-LLZT | SRS 3.2.1.3/3.3.3.5; DD 4.1.3/4.2.3.5/5.3.2.5; HTML cap-llzt | `/situation` | `SituationPage/LinkStateBadge` | `telemetryStore` | `UiLinkProjection`, `CanonicalLinkStatus` | `link.metric` | L-DL-03 DEGRADED→DOWN | 五态（固定证据无 EXECUTING）+连续帧/滞回/投影 | T-XQ-013 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-GRYGZ-ESMGL | SRS 3.2.1.4/3.3.4.1; DD 4.1.4/4.2.4.1/5.4.2.1; HTML cap-esmgl | `/interactions` | `InteractionsPage/EsmSensorPanel` | `telemetryStore` | `Sensor`, `DetectionEvent` | `jammer.event` | ESM-01 2000..5000 MHz；DET-042 probability=.95/time=42 | 五态（固定证据无 EXECUTING）+启停/频带/概率/时刻 | T-XQ-014 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-GRYGZ-RFGR | SRS 3.2.1.4/3.3.4.2; DD 4.1.4/4.2.4.2/5.4.2.2; HTML cap-rfgr | `/interactions` | `InteractionsPage/RfJammerPanel` | `telemetryStore` | `Jammer`, `JammingCommand`, `JammerState`, `JammerExecutionEvidence` | `POST /api/v1/tasks/{taskId}/jammers/{jammerId}/commands`; `jammer.event` | `frame.evidence.jammerExecution` 72W/2200MHz/1470s/AUTO_DETECTION | 六态+频带/功率/方向/持续/原因/生效帧 | T-XQ-015 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-GRYGZ-BHC | SRS 3.2.1.4/3.3.4.3; DD 4.1.4/4.2.4.3/5.4.2.3; HTML cap-bhc | `/interactions` | `InteractionsPage/ClosedLoopStepper` | `telemetryStore` | `ClosedLoopContext`, `JammingDecision`, `DetectionEvent`, `JammerExecutionEvidence`, `UiLinkProjection` | `POST /api/v1/simulations/{runId}/events`; jammer/link topics | F-00042@42: DET-042→JAM-WB-01-TX→L-DL-03 DEGRADED/DOWN | 六态+同帧/重复拒绝 | T-XQ-016 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-GRYGZ-CSS | SRS 3.2.1.4/3.3.4.4; DD 4.1.4/4.2.4.4/5.4.2.4; HTML cap-css | `/interactions` | `InteractionsPage/JammerSyncPanel` | `telemetryStore` | `JammingParameterSet`, `SyncResult`, `RealtimeEnvelope<JammerStatusData>` | `POST /api/v1/tasks/{taskId}/jammers/{jammerId}/parameters`; `jammer.event` | config/Node/engine/UI parameterVersion=5；effectiveFrame=F-00042@42 | 六态+四端版本/生效帧 | T-XQ-017 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-LLQHYYX-LLJC | SRS 3.2.1.5/3.3.5.1; DD 4.1.5/4.2.5.1/5.5.2.1; HTML cap-lljc | `/situation` | `SituationPage/LinkCandidatePanel` | `telemetryStore` | `LinkStatusSummary` | `link.metric` | `frame.linkSummaries` 四链路@42 + routeCandidates | 五态（固定证据无 EXECUTING）+一致历史/候选快照 | T-XQ-018 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-LLQHYYX-QXL | SRS 3.2.1.5/3.3.5.2; DD 4.1.5/4.2.5.2/5.5.2.2; HTML cap-qxl | `/interactions` | `InteractionsPage/RouteRankingPanel[FORWARD]` | `telemetryStore` | `RouteCandidateEvidence`, `RouteDecision` | `simulation.frame`, `link.metric` | FORWARD ranks: L-MW-01#1, L-SAT-02#2 | 五态（固定证据无 EXECUTING）+连通后 jamImpact 排名 | T-XQ-019 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-LLQHYYX-HXL | SRS 3.2.1.5/3.3.5.3; DD 4.1.5/4.2.5.3/5.5.2.3; HTML cap-hxl | `/interactions` | `InteractionsPage/RouteRankingPanel[REVERSE]` | `telemetryStore` | `RouteCandidateEvidence`, `RouteDecision` | `simulation.frame`, `link.metric` | REVERSE ranks: L-LASER-04#1, L-DL-03#2 | 五态（固定证据无 EXECUTING）+BER/稳定/滞回排名 | T-XQ-020 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-LLQHYYX-QHJY | SRS 3.2.1.5/3.3.5.4; DD 4.1.5/4.2.5.4/5.5.2.4; HTML cap-qhjy | `/interactions` | `InteractionsPage/SwitchDecisionPanel` | `telemetryStore` | `SwitchEvent` | `switch.event` | SW-003 接受，SW-004 冷却拒绝 | 五态（固定证据无 EXECUTING）+接受/拒绝/冷却/前后路由 | T-XQ-021 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-SJJHYJK-CSVDX | SRS 3.2.1.6/3.3.6.1/3.5.2; DD 4.1.6/4.2.6.1/5.6.2.1; HTML de-cap-csvdx | `/admin/data-exchange` | `DataExchangePage/CsvContractCard` | `dataExchangeStore` | CSV literal constants, row adapters | `GET /api/v1/contracts/csv` | FILE-001 contract | 六态+3 header/type/UTF-8/atomic status | T-XQ-022 | VISIBLE_CONTRACT |
| DSDWRJQTLJS-XQ-SJJHYJK-JSONJX | SRS 3.2.1.6/3.3.6.2/3.5.3; DD 4.1.6/4.2.6.2/5.6.2.2; HTML de-cap-jsonjx | `/admin/data-exchange` | `DataExchangePage/ScenarioJsonPanel` | `dataExchangeStore`, `scenarioStore` | `ScenarioConfig`, `ApiResult` | `GET /api/v1/contracts/scenario-config`; validate | SCN-001 schemaVersion=1.0 | 六态+syntax/field/version | T-XQ-023 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-SJJHYJK-WSTC | SRS 3.2.1.6/3.3.6.3; DD 4.1.6/4.2.6.3/5.6.2.3; 基线 8.2; HTML de-cap-wstc | `/admin/data-exchange` | `DataExchangePage/WebSocketContractCard` | `telemetryStore` | `RealtimeEnvelope`, `WsSubscribeRequest` | `/ws/v1`; five canonical topics | F-00042 sequence=42 | 六态+topic/envelope/gap/reconnect | T-XQ-024 | VISIBLE_CONTRACT |
| DSDWRJQTLJS-XQ-SJJHYJK-JCGJ | SRS 3.2.1.6/3.3.6.4; DD 4.1.6/4.2.6.4/5.6.2.4; HTML de-cap-jcgj | `/admin/data-exchange` | `DataExchangePage/ProcessContractCard` | `dataExchangeStore`, `simulationStore` | `SimulationRun`, `SystemHealth` | simulation commands; `runtime.state` | RUN-001, engine NOT_CONNECTED_BY_DESIGN | 六态+单实例/stdout/超时/清理合同 | T-XQ-025 | VISIBLE_CONTRACT |
| DSDWRJQTLJS-XQ-XTGL-JCSJ | SRS 3.2.1.7/3.3.7.1; DD 4.1.7/4.2.7.1/5.7.2.1; HTML cap-jcsj | `/admin` | `AdminPage/MasterDataPanel` | `adminStore`, `authStore` | `MasterData` | `/api/v1/admin/master-data*` | MW-COMM v4, referenceCount=2 | 六态+CRUD/RBAC/引用/版本 | T-XQ-026 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-XTGL-YHJS | SRS 3.2.1.7/3.3.7.2; DD 4.1.7/4.2.7.2/5.7.2.2; HTML cap-yhjs | `/admin`, `/login` | `AdminPage/UserRolePanel`, `LoginPage/AuthResultPanel` | `authStore`, `adminStore` | `User`, `Principal`, `RbacDecision` | auth; `/api/v1/admin/users*` | USR-ADMIN, USR-OPERATOR | 六态+成功/凭据/锁定/拒绝/last-admin | T-XQ-027 | INTERACTIVE_UI |
| DSDWRJQTLJS-XQ-XTGL-BFHF | SRS 3.2.1.7/3.3.7.3; DD 4.1.7/4.2.7.3/5.7.2.3; HTML cap-bfhf | `/admin` | `AdminPage/BackupRestoreWizard` | `adminStore`, `authStore` | `BackupRecord`, `RestoreResult`, `ConfirmationState` | `GET /api/v1/admin/backups`、`POST /api/v1/admin/backup` and `/api/v1/admin/restore` | 本机：真实 SQLite/持久化目录/SHA-256；纯 Mock：PREBACKUP-002 / BACKUP-CORRUPT-001 / BACKUP-ROLLBACK-001 | 六态+真实 prebackup/check/confirm/事务恢复/rollback，审计保留、成功重新登录 | T-XQ-028 | VISIBLE_CONTRACT |
| DSDWRJQTLJS-XQ-XTGL-CZRZ | SRS 3.2.1.7/3.3.7.4; DD 4.1.7/4.2.7.4/5.7.2.4; HTML cap-czrz | `/admin` | `AdminPage/AuditLog` | `adminStore`, `authStore` | `AuditRecord`, `AuditExportResult` | `GET /api/v1/admin/audit`; `POST /api/v1/admin/audit/export` | 本机 SQLite 真实记录；纯 Mock 使用 AUD-001 | 六态+筛选/分类/水印/只读 TXT 下载；用户批准开发阶段明文，加密待补 | T-XQ-029 | INTERACTIVE_UI |

## 7 类接口

| Interface | Sources | Route | Page / component | Store | Type | Endpoint / topic | Fixture | 六态证据 | Test ID | Coverage |
|---|---|---|---|---|---|---|---|---|---|---|
| DSDWRJQTLJS-JK-YHCZ | SRS 3.4.1.1; DD interface design; HTML if-jk-yhcz | `/interactions` | `InteractionsPage` 业务面板 | `telemetryStore`, `scenarioStore` | `CapabilityState`, `ApiResult` | UI events→store actions | P4 frozen fixtures | 六态+键鼠/提示/表图反馈 | T-JK-001 | INTERACTIVE_UI |
| DSDWRJQTLJS-JK-WJXT | SRS 3.4.1.2; DD file interfaces; HTML de-if-jk-wjxt | `/admin/data-exchange` | `CsvContractCard`, `ScenarioJsonPanel`, `InterfaceContractTable` | `dataExchangeStore` | `OutputConfig`, `BackupRecord` | contracts fixture endpoints | FILE-001, PREBACKUP-002 | 六态+JSON/TXT/CSV/SQLite/HTML/PDF 状态 | T-JK-002 | VISIBLE_CONTRACT |
| DSDWRJQTLJS-JK-CZXT | SRS 3.4.1.3; DD OS interfaces; HTML de-if-jk-czxt | `/admin/data-exchange` | `ProcessContractCard`, `InterfaceContractTable` | `dataExchangeStore`, `simulationStore` | `SimulationRun`, `SystemHealth` | simulation runtime projection | RUN-001, diagnostics | 六态+PID/state/stdout 合同 | T-JK-003 | VISIBLE_CONTRACT |
| DSDWRJQTLJS-JK-QDZS-SJJHYJK | SRS 3.4.2.1; DD frontend/data exchange; HTML de-if-jk-qdzs-sjjhyjk | `/admin/data-exchange` | `WebSocketContractCard`, `InterfaceContractTable` | `telemetryStore` | `RealtimeEnvelope` | `/ws/v1`; REST snapshots | F-00042 | 六态+loopback/version/topic | T-JK-004 | INTERACTIVE_UI |
| DSDWRJQTLJS-JK-SJJHYJK-FZYXYLLJS | SRS 3.4.2.2; DD data/AFSIM; HTML de-if-jk-sjjhyjk-fzyxylljs | `/admin/data-exchange` | `CsvContractCard`, `ProcessContractCard`, `InterfaceContractTable` | `dataExchangeStore`, `simulationStore` | `SimulationRun`, `LinkQualityData` | simulations/contracts topics | RUN-001, F-00042 | 六态+进程/插件/CSV 可见合同 | T-JK-005 | VISIBLE_CONTRACT |
| DSDWRJQTLJS-JK-CJPZYJBSC-WJXT | SRS 3.4.2.3; DD generator/files; HTML de-if-jk-cjpzyjbsc-wjxt | `/admin/data-exchange` | `ScenarioJsonPanel`, `InterfaceContractTable` | `dataExchangeStore`, `scenarioStore` | `ScenarioConfig`, `ScriptContract`, `ValidationResult` | scenario validate/script preview | SCN-001, SCRIPT-001 | 六态+validated JSON→preview/checksum/error | T-JK-006 | INTERACTIVE_UI |
| DSDWRJQTLJS-JK-CSCI-SJJH | SRS 3.4.2.4; DD seven CSCI exchange; HTML de-if-jk-csci-sjjh | `/admin/data-exchange` | `InterfaceContractTable` | `dataExchangeStore`, `telemetryStore` | `RealtimeEnvelope`, all canonical IDs | meta interfaces; `/ws/v1` | TASK-001, F-00042 | 六态+unique ID/owner/frame/no-cycle | T-JK-007 | INTERACTIVE_UI |

## 八项来源决策登记（不计入上表行数）

| Decision ID | 冲突 | 采用项 | 实现与验证影响 |
|---|---|---|---|
| DEC-001 | `scenario` vs `scene` | ScenarioConfig 1.0 输出只用 `scenario`；`scene` 仅 legacy read adapter | schema/fixture snapshot 拒绝 canonical `scene` |
| DEC-002 | 三 CSV vs 旧内部候选 | 仅 link_quality、events、link_switch 三个 canonical 文件合同 | contract test 锁定三个 literal constants；mock 不生成文件 |
| DEC-003 | 五态 vs 六态 | SRS canonical 五态；UI 增加 STOPPED | adapter test 证明 STOPPED 不序列化 |
| DEC-004 | 两态 vs 三态链路 | SRS/CSV UP|DOWN；UI 增加 DEGRADED | L-DL-03 fixture 证明 DEGRADED→DOWN |
| DEC-005 | 回环消息 vs 无外网 | 后续通道只绑定 127.0.0.1；原型零连接 | Supertest/Playwright 断言无非回环请求 |
| DEC-006 | 四类业务信息节点与通信卫星、地面干扰侦测站等支撑实体混用 | 四类业务信息节点固定为 REAR_COMMAND_NODE/FORWARD_RELAY_NODE/GROUND_CLUSTER_COMMAND_NODE/AIRBORNE_MISSION_CLUSTER；COMMUNICATION_SATELLITE/GROUND_JAMMER_DETECTION_STATION/AIRBORNE_JAMMER_PLATFORM 单列为支撑实体 | schema enum、分组 UI、业务节点容量和引用闭合测试；支撑实体不计入 50 个容量 |
| DEC-007 | 报告权限/分级 | operator 普通 Level II；批次比较固定 Level III，仅 ADMIN+二次确认 | RBAC 组合测试与 generated:false |
| DEC-008 | SRS 五接口 vs 详细设计稀疏接口 | SRS Tables 23–28 为 canonical superset；稀疏数据仅 read adapter；聚合另列扩展 | 类型 shape/adapter/aggregate 分离测试 |

## 装备参数维护补项（2026-09-20）

T-XQ-026 系统维护范围新增实际装备参数子链，不改变 29 项能力编号或原能力状态口径：`/admin` → `EquipmentLibrary.vue` → `adminStore.loadMaintenance('equipment') / saveEquipment() / deleteEquipment()` → `EquipmentParameter / DeleteResult` → `/api/v1/admin/equipment` GET/POST、`/{equipmentId}` PUT/DELETE → 本机 `equipment.db`。删除复用确认接口并绑定编号和版本。纯 Mock 使用独立空内存集合，无默认演示参数。

验证落点为 `tests/components/equipment-library.spec.ts`、`tests/stores/equipment.spec.ts`、`tests/server/equipment-sqlite.spec.ts`、`tests/contracts/equipment-contract.spec.ts`。加载/校验、实际保存/删除请求执行、成功/空态/错误复用现有维护状态；只读、权限、版本冲突和离页/会话失效均不得伪造操作成功。参数包导入隐藏，不声明已接入导入或场景参数自动套用。

## 前端模块补齐（2026-09-21，兼容扩展，待整体交付验收）

| 模块 | 实现与来源 | 验证落点 |
|---|---|---|
| 评估报表 | LocalReportTabs 文件明细筛选/事件柱状图/登记与设备时间线；ReportTabs 消费正式时序和批次数据绘图；缺失质量、阶段和批次为“暂无数据”。浏览器打印当前视图另存 PDF，不冒称服务端生成。 | frontend-capabilities 组件/E2E；local-report/reports 既有测试 |
| 装备完整参数及过滤 | EquipmentLibrary → adminStore → 装备 API/SQLite；新增带宽、功率、速率可空；关键字、类型、频段包含筛选。 | equipment-library、equipment-sqlite、frontend-capabilities 合同 |
| 装备引用/历史 | EquipmentRelations → details/reference 接口；只记录真实保存版本及显式引用，不改既有场景参数。 | frontend-capabilities 组件、equipment-sqlite |
| 自定义角色/菜单 | AccountManagement 按钮展开 RoleProfiles → access-control API/SQLite → auth/路由/导航/服务端限制；不修改基础身份与默认权限。 | access-control 服务端、auth-session、frontend-capabilities 组件/合同/E2E |
| 实时质量面板 | QualityMetricPanel 只筛选当前 SituationLinkView 测量；文件/配置无质量数据时为空，不生成历史样本，不把 SNR 当干信比。 | frontend-capabilities 组件、situation 回归 |
| 链路详情 | LinkQualityDialog 区分测量、所选配置、本地关联；已有测量按证据显示，其他指标“暂无数据”，保持原 UI 三态和 canonical 映射。 | situation、frontend-capabilities 组件 |

## 完整性门禁

实现评审逐行确认 route、component、store、type、API/topic、fixture 和 test 均真实存在；锚点必须从 `/traceability` 导航到目标组件并聚焦能力卡。任何空 implementation destination、重复 requirement/interface ID、缺少已声明状态测试或 fixture orphan 都阻断合并。
