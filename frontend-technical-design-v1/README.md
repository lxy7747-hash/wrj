# 前端技术设计包 V1.1

本目录是后续 Vue/Node 实现的技术设计基线，只含文档与机器可读合同。它依据两份上位 Word 文档和已评审通过的《前端开发需求基线》保留 29 项能力、7 类接口、11 条路由、权限边界、状态投影和确定性夹具关系；HTML 原型仅用于页面和交互说明，不得覆盖文档需求。本目录不包含应用脚手架、依赖、脚本、服务端/客户端实现或构建产物。

## 使用顺序

1. 阅读 `01-frontend-architecture.md`，固定边界、数据流和状态机。
2. 按 `02-routes-components-stores.md` 建立页面、组件和 Pinia 所有权。
3. 直接采用 `contracts/domain-models.ts` 的名称与单位；`03-typescript-domain-models.md` 解释 canonical/扩展边界。
4. 依据 `contracts/mock-api.openapi.yaml` 实现仅回环的确定性 mock；行为见 `04-mock-api.md`。
5. 将 `contracts/deterministic-fixtures.json` 作为唯一测试初始值。
6. 用 `05-traceability-matrix.md` 验收 29+7 目的地，用 `06-testing-and-implementation-sequence.md` 安排实现与门禁。
7. 用工作区根目录的 `前端功能推进表.md` 记录每个功能包的开发、测试、负责人和验收证据；表中“已完成”必须满足单功能完成门槛。

## 来源、哈希与优先级

| 优先级 | 只读来源 | SHA-256 | 采用范围 |
|---:|---|---|---|
| 1 | `多手段无人集群通联技术软件需求规格说明-lxy - 副本.docx` | `7F8F252BDD5763E564D2DA460DCE3E5C1885F082FF863ABB29A4994E9A159253` | 产品范围、29 项 canonical 需求、7 类接口、容量、角色、单位及验收目标 |
| 2 | `多手段无人集群通联技术软件详细设计说明-lxy - 副本.docx` | `21DBD43D74B29F57E7F508A5D83A87219B6CBEA957A2D68CFB949DA5820CB05D` | 分层架构、数据结构、流程、异常、安全和测试设计；不得缩减需求规格 |
| 3 | `多手段无人集群通联技术软件-前端开发需求基线.md`（V1.1.39，本机备份恢复变更待验收） | `24929B16B11D0994BBC370DAFD8664DFE2286B4C9B160CFE1846C81A604C8ADA` | 面向前端/Node.js Mock 的需求解释、来源决策、需求/测试 ID 和实施门禁 |
| 4 | `多手段集群通联仿真软件-UI原型设计稿V1.2.html` | `83E431388C0FBC7C4771088DCA1E4AB01376C085037019C7E0F696ED329A3C0C` | 页面布局、中文文案和交互演示；只作表现参考，不替代需求或技术合同 |

冲突处理固定为：先按需求规格说明确定产品需求，再由详细设计补充流程、数据和异常；评审通过的前端需求基线负责记录面向本阶段的采用决策；HTML 不得反向覆盖前三者。任何来源变更都必须重新计算哈希、复核八项决策并更新全部追踪目的地。源文件始终只读。

## 计划技术栈

Vue 3、TypeScript、Vite、Pinia、Vue Router、Element Plus、离线 Leaflet；本地 Node.js/Express mock、`ws`、AJV；Vitest、Vue Test Utils、Supertest、Playwright。此清单是后续实现约束，不授权安装依赖。

## 全局验收门禁

- mock 只能监听 `127.0.0.1`，浏览器不得产生非回环请求；地图图块必须离线打包。
- mock 鉴权是假且无状态；数据仅在内存中。页面只能调用 `uiStore.resetAllProjections()`，由它唯一协调 `POST /api/v1/reset` 并恢复全部冻结投影。
- mock 不读取/写入文件，不访问 SQLite，不派生进程，不加密，不生成任何导出文件。
- ScenarioConfig 中四类业务信息节点合计上限为 50；通信卫星和地面固定式干扰侦测站属于支撑实体，不计入容量。第 51 个业务信息节点返回 `NODE_LIMIT_EXCEEDED` 和 `platforms` fieldPath，草稿不得改变。
- ScenarioConfig 必须至少保留 1 个业务信息节点和 1 项 `informationDemand`；四类链路、两类干扰设备以及所有场景编辑字段必须在合同和夹具中可验证。
- ScenarioConfig 必须逐字段保留 SRS §3.5.3 表 22 名称；带单位后缀的内部 view-model 只能经显式 adapter 存在。
- 每个 OpenAPI operation 必须保有具体 request/response schema；本机除公开 login/session/logout 外均要求 SessionCookie，X-Demo-Role 仅供独立纯 Mock 测试。fixture 必须通过 `DeterministicFixtures` 根 schema。
- UI 生命周期和 canonical 数据不得混写：`STOPPED` 不序列化为 SRS SimulationState；`DEGRADED` 不写入 canonical LinkStatus/CSV。
- 核心 store、状态投影、RBAC 与 adapter 的单元覆盖率不低于 90%。

## 非目标与生产延期项

纯 Mock 阶段不实现真实 AFSIM/插件、SQLite、文件系统、认证会话、密钥/加密、水印、防篡改存储、PDF/HTML/CSV 生成或生产部署。生产阶段需要另行批准：身份提供方、密钥托管、持久化迁移、受控目录、原子文件替换、进程沙箱、审计留存、分类审批、Leaflet 离线图资许可和端口配置。上述事项不得在 mock 中用伪实现暗示已具备安全能力。

### 2026-09-10 本机 SQLite 模板开发验证补充

用户授权的 `server/local.ts` 本机入口通过 `SCENARIO_DB_PATH` 持久化非敏感场景和模板，属于上述纯 Mock 边界的独立开发验证入口；`server/index.ts` / Playwright 仍使用纯内存夹具。普通 SQLite 未加密，不代表生产安全能力已实现，使用与回退见根目录 `SQLite开发验证.md`。

模板合同兼容扩展：`ScenarioTemplate` 与 `TemplateMutationRequest` 新增可选 `uiExtensions`，旧模板允许缺省，新模板保留完整扩展；模板六个接口增加明确的 503 存储失败响应。未修改确定性夹具、需求基线或 HTML 原型。当前重新冻结 SHA-256：

- `contracts/domain-models.ts`（与 `src/contracts/domain-models.ts` 同步）：`ECE5E12BCE449A0F89160D0ECBB1ABEE2F6B98B5156272248A626033CFA9E5A4`
- `contracts/mock-api.openapi.yaml`：`DBA309956162FA0F8C2DE6753D833BD6713202B64C8823D228F3E6F1C1B90831`
- `scripts/contracts/openapi-schema.snapshot.ts`：`B50498C3E50CA2E10C26D0AF79508F1C0AA3104113B8E8F3038F4CEB8C561AC2`

### 2026-09-11 场景列表合同补充（历史冻结记录）

列表/新建接口正式实现，按编号 GET/PUT，新增带 `expectedRevision` 查询参数的 DELETE；`ScenarioDraftUpdate` 增加可选 `expectedRevision`，`CopyTemplateRequest` 增加可选目标 `scenarioId`。页面新建及复制使用 POST，不覆盖同编号记录；旧 PUT 创建调用保留兼容。65 个操作、32 个 POST/PUT/PATCH 写操作（DELETE 另计）。存量 SQLite 表结构及数据不变，fixture 和 HTML 原型不变。

- `contracts/domain-models.ts`（与源码镜像一致）：`99371DB7D72DCFCEE1826E27336A3637ADABC77D1CFDA2058665509347130FA2`
- `contracts/mock-api.openapi.yaml`：`E1ABE93AFE8D26C776B05A422A88210045E6D50306DA3097BDE55B5398042DF5`
- `scripts/contracts/openapi-schema.snapshot.ts`：`6029A740FBA86062B0708D3D791DD462ED1DEE97FE20499A327FB749E74023E3`

### 2026-09-11 SQLite 登录合同补充（历史冻结记录）

后续审计持久化已获用户批准：仅本机入口新增 audit_logs，取消演示审计，重启/reset 保留真实记录；不改变下列冻结合同或哈希。实现边界和回退说明见 SQLite开发验证.md，纯 Mock 和导出状态接口保持原规则。

用户授权将 server/local.ts 登录及账号管理接入 SQLite；新增 session/logout 接口，总计 67 个操作、33 个 POST/PUT/PATCH。用户名取消固定枚举；AuthResult.sessionCreated 支持真实会话；UserRoleCommand 支持仅创建时提交独立密码。本机不接受角色请求头鉴权，未认证业务 REST 返回 401，WS 拒绝连接/订阅；纯 Mock 测试仍隔离在 server/index.ts。说明见 04-mock-api.md 和 SQLite开发验证.md；本轮不修改 fixture 或 HTML 原型，不代表其他模块已持久化。

- `contracts/domain-models.ts`（与源码镜像一致）：`5B9E093A1AE0C1C071A57EF4593C5EA1B7D691C95B474F62B74640FA64E7E63A`
- `contracts/mock-api.openapi.yaml`：`5869436076639885CE530445463CD76B576E27678336E1628D2A32EBC2188A2C`
- `scripts/contracts/openapi-schema.snapshot.ts`：`4EC6A8292CA3BFFFA22755BD39031E6D2C930B764C50571D439DE47861CDF354`

### 2026-09-11 审计 TXT 下载合同补充（历史冻结记录）

用户批准当前阶段明文下载，加密后续补。POST `/api/v1/admin/audit/export` 保持原请求、ADMIN 和一次性确认约束，响应改为独立 `AuditExportResult`：`generated:true`，包含 `fileName/content/recordCount`、分类、水印及导出时间。本机读取 SQLite 快照和真实账号/时钟；纯 Mock 按冻结内存数据及固定时钟生成文件内容。其他 `ExportStatus/generated:false` 不变。前后端同步部署，旧响应不通过新客户端校验；回退需同步恢复前后端，无数据库迁移。未修改原始文档、fixture 或 HTML 原型；原文加密要求仍为后续交付项。

- `contracts/domain-models.ts`（与源码镜像一致）：`6AF0615471B17A6A2AAC969A7BAE33F976085449E1F942AD369271C401CD06E8`
- `contracts/mock-api.openapi.yaml`：`09372C04DDF4A3DC8EB0C4E595CE1ABA456D8C3CB1A5F86A6F9D8C8310B0127F`
- `scripts/contracts/openapi-schema.snapshot.ts`：`32E55485D05C01EE67181196CE1545C1ECEC69DA9FCBE3CF636569FE6CF999A8`

### 2026-09-11 新建用户密码下限调整（历史冻结记录）

用户确认新建账号密码为 6–128 位；首次初始化管理员仍为 12–128 位，既有密码哈希不变，无数据库迁移。界面、API、SQLite 写入与 schema snapshot 同步；旧接口在升级前仍会拒绝 6–11 位创建请求，需重启接口启用；回退不删除已创建账号，既有短密码登录保持兼容。领域模型、fixture 与原型不变。

- `contracts/mock-api.openapi.yaml`：`E6DD0F590118097C51D0E8BAFAA1230E4AF8D316BA2E1F268A4B5C78D9D21887`
- `scripts/contracts/openapi-schema.snapshot.ts`：`1222CD807E1852BE803470606D06780F3DA89F9E9CB8B89820A065A9AB5DD727`

### 2026-09-11 新建用户密码范围 6–32 位（历史冻结记录）

用户确认将新建账号密码上限改为 32 位；UI、API、SQLite 写入及 schema snapshot 同步。登录仍接受既有的最长 128 位密码；首次初始化管理员仍为 12–128 位。无数据库迁移，不修改既有哈希；新旧服务混用时旧服务仍接受较长的新密码，需重启接口使规则一致。回退保留现有账号。领域模型、fixture、原型不变。

- `contracts/mock-api.openapi.yaml`：`B48BBF63C406D62DDE58C6C60F5B5832B80B7E5757DB79B1FB7CC3F7C8D75A85`
- `scripts/contracts/openapi-schema.snapshot.ts`：`7BD9F2D6C9E5647C8A28B30A3815C40D5C4A7C94E748D89C9105FAC8E93AD991`

### 2026-09-11 本机 SQLite 备份／恢复（当前冻结记录）

用户授权真实备份、独立持久化目录、预备份、完整性与结构检查、事务恢复和失败回滚。真实状态新增 VALID/INVALID，checksum 为大写 SHA-256；RestoreResult.generated 支持 boolean，true 表示真实流程，不替代 result 的成功/失败含义。三接口补充 503，管理员权限及一次性确认保留。恢复场景、模板和账号，审计不回退，旧会话与内存运行失效。前后端同步升级；回退不删除数据库或备份目录。加密仍后续补，不表示灾难恢复已完成。

- `contracts/domain-models.ts`（与源码镜像一致）：`B5F5763B131EED29715E14D4CA73730268BBD18E2018934C3EFB75904725DE23`
- `contracts/mock-api.openapi.yaml`：`87F4F12C02BDB82A0F79B034418FAB8AE27253E32F6B3E85E1A6BF4A19872C42`
- `scripts/contracts/openapi-schema.snapshot.ts`：`8F5FE1E2CA3D790DE032B5E4A2618D4C591822876DF01B415476BC6A7BA3D73F`
- `contracts/deterministic-fixtures.json` 未修改：`2908EDEE19C38B318282999A1D8BF5B8EA19C5318E4170C1258D953BB5783B84`；HTML 原型、原始 SRS/DD 未修改。
