# 02 路由、组件与 Store 所有权

## 固定路由表（恰好 11 条）

| Route | Page | 主要组件 | Store | API/Topic | Guard |
|---|---|---|---|---|---|
| `/login` | `LoginPage` | `LoginForm`, `AuthFeedback` | `authStore`, `uiStore` | `POST /api/v1/auth/login` | 独立公开布局；成功后 `replace('/situation')` |
| `/situation` | `SituationPage` | `OfflineSituationMap`, `MetricPanel`, `LinkQualityDialog`, `SimulationToolbar` | `simulationStore`, `telemetryStore`, `uiStore` | simulations/frames；`simulation.frame`, `link.metric`, `runtime.state` | `requirePrincipal` |
| `/scenarios` | `ScenariosPage` | `ScenarioEditor`, `ValidationPanel`, `TemplateLibrary`, `ScriptPreview` | `scenarioStore`, `uiStore` | scenarios/templates/scripts/contracts | `requirePrincipal`; 官方库写操作另需 ADMIN |
| `/batches` | `BatchesPage` | `BatchForm`, `BatchRunTable`, `BatchStateCard` | `batchStore`, `scenarioStore`, `uiStore` | batches | `requirePrincipal` |
| `/reports` | `ReportsPage` | `ReportSourcePicker`, `KpiGrid`, `ReportTabs`, `BatchComparisonTable`, `ExportConfirmationDialog` | `reportStore`, `batchStore`, `telemetryStore`, `authStore`, `uiStore` | reports/batches/simulations/confirmations | `requirePrincipal`; Level III 导出需 ADMIN+确认 |
| `/replays` | `ReplaysPage` | `ReplaySelector`, `ReplayTimeline`, `ReplayToolbar`, `ReplayEventDetail` | `replayStore`, `telemetryStore`, `uiStore` | replays | `requirePrincipal` |
| `/admin` | `AdminPage` | `MasterDataPanel`, `UserRolePanel`, `BackupRestoreWizard`, `AuditPanel`, `FullConfigExportPanel`, `ArchivePanel`, `HealthPanel` | `adminStore`, `authStore`, `uiStore` | admin groups including `/api/v1/admin/config/export` | `requireAdmin`; operator 重定向 `/blueprint` 并显示拒绝原因 |
| `/blueprint` | `BlueprintPage` | `CapabilityCardGrid`, `InterfaceContractTable`, `DecisionRegister` | `traceabilityStore`, `authStore`, `uiStore` | meta capabilities/interfaces/decisions | `requirePrincipal` |
| `/admin/data-exchange` | `DataExchangePage` | `CsvContractCard`, `ScenarioJsonPanel`, `WebSocketContractCard`, `ProcessContractCard`, `InterfaceContractTable` | `dataExchangeStore`, `scenarioStore`, `simulationStore`, `telemetryStore` | contracts/csv；scenario JSON；`/ws/v1`；runtime state | `requirePrincipal`; 通过 `/admin` 系统管理壳进入，其他管理子页仍需 `requireAdmin` |
| `/traceability` | `TraceabilityPage` | `TraceFilterBar`, `RequirementTraceTable`, `InterfaceTraceTable` | `traceabilityStore`, `uiStore` | meta capabilities/interfaces/routes | `requirePrincipal` |
| `/interactions` | `InteractionsPage` | `StateFixtureGallery`, `ErrorCatalogPanel`, `ContractExamples` | `authStore`, `scenarioStore`, `simulationStore`, `telemetryStore`, `batchStore`, `reportStore`, `replayStore`, `adminStore`, `traceabilityStore`, `uiStore` | contracts/meta/reset | `requirePrincipal` |

未知路径重定向 `/login` 不新增命名路由。`requirePrincipal` 只检查内存 principal；`requireAdmin` 同时在 UI 产生 `PERMISSION_DENIED` 证据。真正操作仍由 mock 的 `x-rbac` 重验。

## Pinia Store 合同

| Store | 唯一拥有的 state | Actions | 不得拥有 |
|---|---|---|---|
| `authStore` | principal、role、permissions、最近授权结果 | `login`, `refreshPermissions`, `authorize`, `resetToSafeEmpty` | 业务数据、真实 token/session |
| `scenarioStore` | canonical draft、UI 扩展、history、revision、validation、warning confirmation、templates、script preview、lock projection | `load`, `edit`, `validate`, `requestWarningConfirmation`, `importScenarioSnapshot`, `undo`, `resetDraft`, `copyTemplate`, `previewScript`, `resetToSafeEmpty` | 仿真计时器、官方持久化假象 |
| `simulationStore` | RUN-001 UI/canonical 状态、time/progress/mode/speed、config lock、command feedback | `create`, `command`, `setSpeed`, `step`, `clearTimers`, `resetProjection`, `resetToSafeEmpty` | telemetry 数组、浏览器定时期望值 |
| `telemetryStore` | 按 frameId 的平台/链路/事件、topic sequence、新鲜度 | `connect`, `subscribe`, `acceptEnvelope`, `markDisconnected`, `disconnectAndReset`, `loadFrame`, `resetToSafeEmpty` | 仿真命令、地图实例 |
| `dataExchangeStore` | CSV/JSON 校验结果、合同目录、七类接口元数据和进程可见投影 | `loadContracts`, `validateCsv`, `parseScenarioJson`, `inspectProcess`, `resetToSafeEmpty` | 真实文件句柄、操作系统进程、场景草稿副本 |
| `batchStore` | batch form、BATCH-001、12 行、状态、selected run | `validate`, `create`, `command`, `loadComparison`, `resetToSafeEmpty` | report export 权限/确认 |
| `reportStore` | 报告列表、source、KPI view-model、tabs、confirmation、export result | `selectSource`, `load`, `requestExport`, `confirmExport`, `cancelConfirmation`, `invalidateConfirmation`, `resetToSafeEmpty` | 文件 Blob/下载 URL |
| `replayStore` | REPLAY-001、游标、速度、state、事件选择 | `load`, `play`, `pause`, `seek`, `step`, `setSpeed`, `stopPlaybackTimer`, `resetToSafeEmpty` | RUN 原始数据写操作 |
| `adminStore` | master data、users、audit、backup/restore/full-config-export fixture、confirmation、archives、health | `loadAll`, `mutateMasterData`, `mutateUser`, `runBackupFixture`, `runRestoreFixture`, `requestFullConfigExport`, `filterAudit`, `invalidateConfirmation`, `resetToSafeEmpty` | 真实秘密、文件、DB handle |
| `traceabilityStore` | 29 能力、7 接口、8 决策、11 路由、筛选条件 | `loadMetadata`, `filter`, `resolveDestination`, `resetToSafeEmpty` | 业务可变状态 |
| `uiStore` | 全局 toast、dialog、pending/错误呈现、viewport mode、route denial、全局 reset 协调状态 | `notify`, `openDialog`, `closeDialog`, `recordRouteDenial`, `resetAllProjections` | canonical 业务实体；只协调，不复制业务 state |

## 页面交互所有权

- P7 管理面板通过 `/admin?section=master-data`、`database-backup`、`simulation-data`、`runtime-status` 四个查询参数值切换，不增加命名路由。完整配置导出复用备份恢复页面内的区域，不另建重复面板。
- `adminStore.loadMaintenance` 统一读取主数据、备份、归档和健康投影；`saveMasterData` 保存主数据副本；`runMaintenanceAction` 串联创建确认、确认完成和敏感操作。面板卸载及登出调用 `resetMaintenance`，清空旧结果并使在途响应失效。页面不直接读取 fixture。

- `SituationPage` 只通过 selectors 获取同一 F-00042：地图、指标、弹窗必须同 frameId；ageMs 只接受 0～5000 ms，并按当前、最近 1 秒、最近 5 秒呈现，超过 5 秒拒绝。
- `ScenariosPage` 对 `ScenarioConfig` 使用单一 canonical 编辑副本，并以独立 `ScenarioUiExtensions` 保存干扰器/传感器 UI 扩展；保存/预览前必经 AJV+业务规则。四类业务信息节点合计支持 50 个，支撑实体不计数；新增第 51 个业务信息节点以 `NODE_LIMIT_EXCEEDED` 阻断且草稿不改变。
- `DataExchangePage` 作为系统管理下的共享子功能，集中承载 CSV、场景 JSON、本机消息和 AFSIM 进程四项数据交换能力；页面通过本机 Mock 加载合同并复用 `telemetryStore` 连接回环 WebSocket，但不读写真实文件、不启动操作系统进程。操作员可进入本子功能，其他管理子页仍拒绝访问。
- 场景实体类型控件按“业务信息节点”和“支撑实体”分组，`category` 只以“部署域”标签展示。校验存在警告而无错误时，预览脚本前必须完成一次性确认；存在错误时不得发起确认或预览。
- `ReportsPage` 的普通/批次 source 选择一次性替换 KPI、时序曲线、表格和导出策略；普通报告曲线只消费 `Report.timeSeries` 正式时序点，批次报告没有时序点时显示空态；禁止混合 RUN-001 与 BATCH-001 数据。
- `ReplaysPage` 使用 RUN-001 快照的只读投影；回放动作不发布 simulation control topic。
- `InteractionsPage` 只调用 `uiStore.resetAllProjections()`，不得直接请求 reset API 或逐个写业务 store。

## 全局 reset 唯一所有者

`uiStore.resetAllProjections()` 是 `POST /api/v1/reset` 的唯一前端协调 action。它按以下固定顺序执行：

1. 将 reset 状态置为 EXECUTING；调用 `telemetryStore.disconnectAndReset()` 关闭并标记旧 WS，调用 `simulationStore.clearTimers()` 与 `replayStore.stopPlaybackTimer()` 清理计时器。
2. 调用 `reportStore.invalidateConfirmation()` 与 `adminStore.invalidateConfirmation()`，取消所有一次性确认上下文。
3. 通过 API adapter 调用 `POST /api/v1/reset`；页面和其他 store 不得直接调用该 endpoint。
4. 成功后依次执行 `authStore.refreshPermissions()`、`scenarioStore.load()`、`simulationStore.resetProjection()`、`telemetryStore.loadFrame()`、`batchStore.loadComparison()`、`reportStore.load()`、`replayStore.load()`、`adminStore.loadAll()`、`traceabilityStore.loadMetadata()`。
5. 最后清除 UI pending/error/dialog，记录 reset SUCCESS，并允许 telemetryStore 重新建立订阅。

任一步失败都进入 reset ERROR；WS 保持断开、计时器保持清除、确认上下文保持失效，并对九个业务 store 全部调用 `resetToSafeEmpty()`，不得保留成功/失败混合的半初始化状态。ERROR 显示 correlationId 和重试入口；重试仍从步骤 1 开始。

## 接口锚点映射

`de-if-jk-yhcz`→表单/键鼠/反馈；`de-if-jk-wjxt`→contracts/admin 状态展示；`de-if-jk-czxt`→simulation/admin health 状态展示；`de-if-jk-qdzs-sjjhyjk`→REST/WS adapter；`de-if-jk-sjjhyjk-fzyxylljs`→simulation visible contract；`de-if-jk-cjpzyjbsc-wjxt`→validation/script preview contract；`de-if-jk-csci-sjjh`→统一 envelope、ID ownership 和 frameId 规则。

## 组件验收规则

每个 29 项 capability component 必须提供已声明状态切换测试、fixture evidence、错误/空状态和可达锚点；T-XQ-010、T-XQ-011、T-XQ-012、T-XQ-013、T-XQ-014、T-XQ-018～021 固定证据能力不声明无来源的 `EXECUTING`。表格在 1366×768 下允许内部横向滚动但操作列可达；1920×1080 下核心态势与控制不得依赖页面纵向滚动。所有图表有文本/表格等价内容，颜色不是唯一状态提示。
