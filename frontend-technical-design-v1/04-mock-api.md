# 04 本机确定性 Mock API

`contracts/mock-api.openapi.yaml` 使用 JSON 语法，因此同时是合法 YAML 1.2 并可直接 `JSON.parse`。它是本机 Express/`ws` 实现的权威合同。64 个 operation 均有唯一 `operationId` 和具体业务 response schema；全部 32 个 POST/PUT/PATCH operation 均有独立 request schema，读操作也不使用空对象代替业务 `data`。V1.1 合同以两份 Word 文档和已评审通过的前端需求基线为准，HTML 只作界面参考。

## 启动与安全不变量

后续 mock 必须显式 `listen(port, '127.0.0.1')`，并在启动测试中确认未绑定 `0.0.0.0`、`::` 或局域网地址。CORS 只允许本机 Vite origin；Host/Origin/WS peer 非回环返回 `LOOPBACK_ONLY`。禁止代理外网、遥测上报和在线地图图块。

数据仅来自冻结 JSON，启动和 reset 深拷贝为内存 projection。禁止 `fs`、SQLite driver、`child_process`、系统时间、随机数、加密 API、Blob/下载 URL 和导出生成器。即使 endpoint 名称包含 backup/export/script，也只返回设计状态。

## Envelope

成功：`{ ok:true, data:T, meta:{requestId,generatedAt,page,pageSize,total} }`。失败：`{ ok:false, error:{code,message,fieldPath?,details?,retryable,correlationId}, meta:{requestId,generatedAt} }`。所有时间冻结；分页即使单页也完整提供 meta。HTTP 状态与 code 配对：400 输入、401 凭据、403 权限/回环、404 缺失、409 状态/重复/引用、422 schema/业务校验、423 锁定账号、428 二次确认。

## 错误目录

| 类别 | Codes | UI 行为 |
|---|---|---|
| 输入/数据 | `INVALID_REQUEST`, `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `NODE_LIMIT_EXCEEDED`, `CORRUPT_FIXTURE`, `OUT_OF_RANGE`, `DEVICE_DISABLED` | 字段定位或错误面板；不可静默降级 |
| 身份/权限 | `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `PERMISSION_DENIED`, `LAST_ADMIN_GUARD` | 保留输入、显示拒绝证据、写内存审计 |
| 确认/锁 | `CONFIRMATION_REQUIRED`, `CONFIRMATION_EXPIRED`, `CONFIG_LOCKED`, `INVALID_TRANSITION` | 打开确认、刷新状态或禁用冲突动作 |
| 事件/CSV | `DUPLICATE_EVENT`, `HEADER_INVALID`, `TYPE_INVALID`, `ENCODING_INVALID`, `ATOMIC_REPLACE_FAILED` | 去重或合同错误；mock 不触碰文件 |
| 引擎合同 | `START_FAILED`, `TIMEOUT`, `EXIT_NONZERO` | 进入 ERROR 并解除配置锁；mock 不派生进程 |
| 通道 | `LOOPBACK_ONLY`, `TOPIC_FORBIDDEN`, `SEQUENCE_GAP` | 拒绝/重订阅/reset；不得连外网 |
| 内部 | `INTERNAL_FIXTURE_ERROR` | 阻断测试，修复 fixture/实现漂移 |

## RBAC

本机 server/local.ts 使用 SQLite users 和 HttpOnly Cookie 会话；公开 login/session/logout，其他 REST/WS operation 使用 SessionCookie。X-Demo-Role 仅为独立 server/index.ts 的无状态测试输入，本机入口忽略调用者提供的角色。两角色均可读取业务数据、建立场景、运行仿真、查看批次/回放/报告并导出普通 Level II 状态。仅 ADMIN 可维护官方模板、主数据、用户/角色、备份恢复、审计、全量配置或 Level III 批次导出。Level III 还需要有效一次性 confirmationId；本机确认绑定当前账号。当前管理员和最后管理员均不能删除/降级，返回 LAST_ADMIN_GUARD。

2026-09-11 授权扩展：新增 GET /api/v1/auth/session、POST /api/v1/auth/logout，共 67 个操作、33 个 POST/PUT/PATCH。旧 wire 字段 passwordFixture 为兼容保留，在本机入口传输真实密码，仅用于 scrypt 校验，禁止日志记录或响应回传；username 不再限定演示枚举。会话有效期 8 小时，进程重启失效；退出、用户变更即时撤销，WS 空闲会话每 30 秒复核。用户创建密码 6–32 位（首次初始化管理员仍为 12–128 位）；纯 Mock 允许不提供密码保持旧用例兼容。本机真实时间、随机盐和 SQLite 仅由 server/local 层提供，不进入纯 Mock 副作用闭包。

后续审计授权：本机日志存入同库 audit_logs，初始空表，取消演示记录，不迁移旧内存日志。沿用 AuditRecord 和现有查询筛选接口；登录、退出、鉴权拒绝和已有业务审计统一持久化，重启/reset 不清除。纯 Mock 仍读取 fixture 并在 reset 后恢复。immutableFixture 为旧传输字段，不作防篡改承诺。审计导出使用独立 AuditExportResult（generated:true），包含 UTF-8 TXT 内容、文件名、记录数、分类、水印和实际导出时间，浏览器生成下载文件。服务端按发起导出时的筛选值查询并消费 ADMIN 一次性确认，导出成功/失败/拒绝同样记录；导出本身不混入该次内容快照。用户批准当前明文开发验证，加密与密钥管理待补。存储故障沿用现有 INVALID_REQUEST 错误信封，业务与审计未形成跨模块统一事务，失败时需先重查业务结果。

## Endpoint 组

- metadata：capabilities 固定 29、interfaces 固定 7、decisions 固定 8、routes 固定 11。
- scenario/template：临时草稿可由两角色编辑；官方库写操作仅 ADMIN；校验含 schema/引用/单位/时序/频段、四类业务信息节点 50 个容量、至少一项信息需求、四类链路和两类干扰设备。WARNING 继续预览需一次性确认，ERROR 直接拒绝；官方模板删除需确认和引用检查。
- script/contract：只返回预览、预检、五接口与三 CSV 描述。
- simulation：命令仅改变 UI/canonical projection 与 lock；frame/event 为冻结事实。`POST /api/v1/simulations/{runId}/events` 输入 `ClosedLoopContext`、返回 `JammingDecision`，同目标同帧重复迁移返回 `DUPLICATE_EVENT`。任务级 RF 干扰控制使用 `POST /api/v1/tasks/{taskId}/jammers/{jammerId}/commands`；参数同步使用 `POST /api/v1/tasks/{taskId}/jammers/{jammerId}/parameters`，输入 `JammingParameterSet`、返回四端版本一致的 `SyncResult`，旧版本或错误生效帧被拒绝。Mock 依据场景设备参数形成确定性能力边界，不连接真实设备。
- batch/report/replay：BATCH-001 固定 12 对；普通与批次 report source 不混用；回放只移动游标；export 始终 `generated:false`。
- admin：纯 Mock 的 master/user/audit/backup/archive/health 为内存状态，本机 users/audit 已接 SQLite；恢复失败仅展示回滚合同。主数据删除、backup、restore、审计导出与 `/api/v1/admin/config/export` 均重验 ADMIN 和一次性 confirmationId，缺失时返回 HTTP 428/`CONFIRMATION_REQUIRED`；仅审计导出返回 `AuditExportResult/generated:true`，其他导出仍保留原 `generated:false` 合同。
- reset：清理定时器、连接、确认和可变 projection，重载 fixture，并把 WS sequence 恢复为 1。

### P7 系统维护确认与数据规则（2026-09-05）

- `GET /api/v1/admin/backups` 读取 `BackupRecord[]`，是恢复来源列表的唯一接口；新增备份只追加内存记录，禁止覆盖同名记录。
- 主数据创建要求版本 1、引用数量 0；更新携带当前版本并由服务端递增，旧版本返回 `VERSION_CONFLICT`。引用数量不可由客户端修改，已有引用的数据禁止删除。
- `MASTER_DATA_DELETE` 确认绑定主数据编号，删除请求通过 `X-Confirmation-Id` 传递；`BACKUP_RESTORE` 分别绑定 `BACKUP:NEW`（指定编号时为 `BACKUP:{backupId}`）或 `RESTORE:{backupId}`，创建和恢复确认不可互用；`FULL_CONFIG_EXPORT` 绑定 `FULL-CONFIG`。确认仅消费一次，过期、错对象或 reset 后一律拒绝。
- `PREBACKUP-002` 展示成功恢复流程；`BACKUP-CORRUPT-001` 展示完整性校验失败、恢复未开始；`BACKUP-ROLLBACK-001` 展示恢复失败并回滚。三者均为冻结夹具，不执行实际恢复。
- 归档接口返回任务、场景、运行、回放和报告的闭合关系。健康接口仅将前端标为正常，引擎、数据库和通道明确显示尚未接入。

## WebSocket `/ws/v1`

topics 固定为需求基线规定的五项：`simulation.frame`, `runtime.state`, `link.metric`, `jammer.event`, `switch.event`。仿真控制通过 REST 命令 endpoint，不另设 `control.command`；节点状态由 `simulation.frame` payload 承载，不另设 `node.state`。envelope 固定 `type/schemaVersion/topic/taskId/sequence`，按需带 `simulationTime/frameId` 和 payload。每个 task/topic 序号严格递增；重复序号丢弃，缺口返回 `SEQUENCE_GAP` 并触发 REST 快照重载。

非回环 peer、无效 envelope 或越权 topic 使用 close code 1008 拒绝。客户端重连间隔固定 250/500/1000/2000 ms，第四次失败进入 FAILED；订阅携带 lastSequence，服务端按冻结日志补发或明确返回 gap。reset 主动关闭旧连接，客户端重新认证角色夹具并从 sequence 1 订阅。

## 确定性 reset transcript

1. `POST /api/v1/reset` → requestId `REQ-RESET-001`，generatedAt `2026-08-06T08:00:00Z`，nextSequence 1。
2. `GET /api/v1/scenarios/SCN-001` → revision 0、officialLibraryChanged false。
3. `GET /api/v1/simulations/RUN-001/frames/F-00042` → L-MW-01 与 L-DL-03、DET-042、SW-003。
4. 再次执行 1–3，响应业务 data 必须深相等；仅传输层连接对象不参与比较。

## Fixture schema linkage

`deterministic-fixtures.json.validation` 指向 OpenAPI `#/components/schemas/DeterministicFixtures` 和 TypeScript `DeterministicFixtureSet`；OpenAPI 根部 `x-fixture-validation` 反向指向同一 JSON/TS 合同。schema 为 strict object，并通过 `x-fixture-path` 标出 ScenarioConfig、SimulationRun、TelemetryFrame 和事件证据位置。

在不安装依赖的设计审计中，使用 Node 只读校验器解析 `$ref/required/properties/additionalProperties/type/enum/const/range/pattern/array` 并以 `DeterministicFixtures` 验证完整 JSON；后续实现必须用 AJV 2020-12 对同一 schema 和 fixture 执行正式校验。审计还必须证明所有 operation 的成功响应指向独立 typed envelope、所有写 operation 有 requestBody schema、所有鉴权 operation 引用 `DemoRole` header，不能仅检查 JSON 可解析。
