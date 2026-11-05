# 前端技术设计包 V1.1

本目录是后续 Vue/Node 实现的技术设计基线，只含文档与机器可读合同。它依据两份上位 Word 文档和已评审通过的《前端开发需求基线》保留 29 项能力、7 类接口、10 条路由、权限边界、状态投影和确定性夹具关系；HTML 原型仅用于页面和交互说明，不得覆盖文档需求。本目录不包含应用脚手架、依赖、脚本、服务端/客户端实现或构建产物。

当前前端需求基线为 **V1.1.49**，SHA-256：`DD14B52B2F097300F2551657D8E1C047318E6F5A9EBAA779C6A918BA323F6972`。当前冻结记录为“2026-11-05 WebSocket 可选字段与本地干扰时序”；下方其余记录均为历史，旧哈希保持原样。

## WebSocket 可选字段与本地干扰时序（2026-11-05，当前冻结记录）

OpenAPI **1.10.0**，操作数量不变。质量模型、链路阈值、损耗模型及同步版本改为非空字符串；旧字面量仍有效。`SimulationState` 可选携带 `mode`、正数 `speedMultiplier`，START 初始化，SET_SPEED 更新，STOP、reset、运行结束清除。`FrameEvidence.jammerExecution` 继续必填，`jammerExecutions` 的兼容读取规则不变，确定性夹具不迁移。

损耗可选海面多径／大气／云雨分量；链路投影可选干信比与 BER 阈值、抖动抑制；链路详情可选结构化 `issues`。`DetectionEvent` 可选成对正频段（min ≤ max）及 `detected`；缺省按已发现，false 不得用于闭环。`jammer.event` 接受 JammerStatusData、SensorStatusData、JammingDecisionEvent、DetectionEvent，所有推送继续校验任务、帧与时刻。决策结构接受 START／STOP，REST 闭环仍只接受 START；决策按编号去重，传感器按编号替换。新增字段缺省时显示“暂无数据”。INTERFERENCE／LINK_DOWN 切换按选路、冷却、稳定性及原链路证据校验，不用 BER 改善代替原因。

`detectionDelayS` 为 0～仿真总时长，`jammingDurationS` 大于 0 且不超过仿真总时长，均可省略。它们只控制本地 link_calc 缺失时的 stub：目标连续处于触发半径内开始计时，离开取消等待；时长到期后须离开释放半径才重新就绪；3 秒检查周期有约 ±3 秒误差。对接方 TXT 及 calculator() 保持不变。远端旧服务未更新前仅可省略新配置字段，不能用配置保存或单测证明远端引擎时序生效。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts` | `A9516FBC6B12870FC9675508CE85790854A664F5DE6675AFF27B71ED20164BE7` |
| `contracts/mock-api.openapi.yaml` | `1A46DE5393280673FEC0610390E71BFF963887EFF0A444F81604DA6F2FE4BB9D` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `8592DD63B971BA2AE94F0BA14964109E0BFEAC0C003C55EEADB63E7AA47D38B4` |
| `contracts/deterministic-fixtures.json（未修改）` | `6A1B90E0B6932DE7518775B0F2107767906755C56D47F329F7092DB05245F616` |

## 干扰遥测兼容扩展（2026-11-05，历史冻结记录）

按用户确认的阶段 3 第 7 条修订，OpenAPI 更新为 **1.9.5**（84 操作 / 40 写操作不变）：`FrameEvidence.jammerExecution` 保留必填单对象，新增可选 `jammerExecutions`。复数数组存在时必须非空，每项符合 `JammerExecutionEvidence`，首项与单对象深相等（跨字段一致性由遥测运行时校验）。服务端有多台执行证据时同时发送两字段；统一通过 `frameJammerExecutions` 读取，旧载荷无需改名或迁移。确定性夹具及版本字面量保持不变；`runtime.state` 不含 mode/speed、侦测事件不含频段/detected 继续接受。

阶段 4 的 `Jammer.detectionDelayS` / `jammingDurationS` 为可选非负有限秒数；未填写或清空时删除键，不发送 null / NaN，不注入默认值。两个输入框均提示“需要服务端同步更新后才能保存”。该合同扩展允许服务端读写配置，本轮未新增 mission 时序 stub 或将这两个字段写入脚本，不据此宣称真实引擎时序生效；旧服务端仍可能拒绝填写后的新键，联调前需同步更新。回退前应保留含新字段的配置，不能用旧程序覆盖保存；本轮不改用户数据库。

阶段 6 的最后一项实测须在具有 `Release/Release/mission.exe` 的机器上以 `npm run dev` 执行真实 mission 干扰延迟／持续时长 stub，核对实际引擎日志与启停时刻。远程联调入口 `http://192.168.1.49:8080` 的服务端更新前无法验证，单元测试与投影层响应不替代该项实测。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts` | `DB6D9F2D70C9048D95D161B41FDE1AFD71BA3BE94FCEB007AD9F7F298EB541DD` |
| `contracts/mock-api.openapi.yaml` | `8C9909579B5CF3D11DD17B1E1F78DCDE4A22E1D4C7FDF4AC57D206F1F806E92B` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `954B8A2183DB35D71FBE29C8A6C4A2BA5B25BE4CD752BB15FCED483B19B0ECF3` |
| `contracts/deterministic-fixtures.json（未修改）` | `6A1B90E0B6932DE7518775B0F2107767906755C56D47F329F7092DB05245F616` |

## D1 运动与干扰方位配置恢复（2026-11-03，历史冻结记录）

依据 V1.2 测试大纲 GNZB-08 / GNZB-15，OpenAPI 更新为 **1.9.4**（84 操作 / 40 写操作不变）：普通航点恢复必填 `arrivalTime`、可选 `heading` / `acceleration`，干扰界面扩展恢复必填 `direction`。平台初始航向、干扰持续时间、自动检测、温湿度、雨衰等不恢复；盘旋/返航点仍使用原 `TemplateRoutePoint`。

场景库、模板库、导入和前端响应读取只对缺失字段补默认值，不改既有值、不自动改写磁盘记录；普通 PUT 不补字段。时刻顺序及场景时长只在写入时检查。配置与生成清单 `motion` / `jammerPointing` 对应，映射标志均为 false，对接方 TXT 不变，界面不加“不写入脚本”提示。前后端应同时升级；旧版程序仍可能丢弃这些字段，回退前须保留新版场景文件。本次不修改用户数据库或备份。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts` | `3122A762162FC527056C0056B050350C038D27F33A1ED241E03F88FB80978DFE` |
| `contracts/mock-api.openapi.yaml` | `45A749CD75774118D6F9ED1A4A085EA8534F798576A164675D8415D293B83C07` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `C8CDB0FC5B2049829C6D56B91DC1FD2E97971DF74D288BF413A33DB8D1E0006E` |
| `contracts/deterministic-fixtures.json` | `6A1B90E0B6932DE7518775B0F2107767906755C56D47F329F7092DB05245F616` |
| `../tests/contracts/fixture-contract.spec.ts` | `7DA45E7AFCC7F279FAD8DEB4607C9A6C89AF5688D858290355E21A2FCAB94081` |

## 退役模板外场景字段（2026-11-02，历史冻结记录）

新模板、前端参数表、技术要求和测试大纲均没有温度、相对湿度、雨衰（dB/km）、干扰方向／持续时间及自动检测的对应语句，用户确认删除。`Environment`、`Jammer` 和 `JammerUiExtension` 的新写入合同均不再接受这些属性；旧场景与模板在运行时读取、保存前统一丢弃它们，避免旧值回写。保留时间步长、雨强、干扰触发时刻和交互页 RF 命令的方向／持续时间合同；本次不新增 REST operation。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 `src/contracts/domain-models.ts` 一致） | `69731AA8EAD7025AAA0F812A09FF90ABEAC3677195C243ECE083609C1ABAF17A` |
| `contracts/mock-api.openapi.yaml` | `1CD525E10A6C4216FA1C8FA3BA912581DF79878F38AC7F5921945AC49258C774` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `37B7A3D294630822F6284E5CC851A69F5702A82609B73FFD2DAF1D8272D86660` |
| `contracts/deterministic-fixtures.json` | `3CECA3992D9D227E033A8D2584FADD5191B8DB59A28D5D4D1632F4FE0506A525` |
| `../tests/contracts/fixture-contract.spec.ts` | `A2B9B2AED525F767AD433EE9C76410D674CF4DBA96AF4684876333BDB7024782` |

## 新模板通信参数（2026-11-01，历史冻结记录）

按 2026-11-01 AFSIM 新模板兼容扩展五类模板通信平台、固定端口和天线图。`ScenarioConfig.deviceParameters`、实时开关、盘旋／返航路线及干扰最小探测距离均为可选字段，旧场景读取不迁移、不注入默认字段；默认值仅由共享读取模块在预览和生成时提供副本。端口名称、天线名称、正数数值和端口来源字段受合同约束：装备来源仅可引用带宽、功率和速率，通用数据来源可引用七项端口数值字段，不接受枚举条目。`ScenarioConfigWrite` 保持已有端点、跨对象和时长关系由运行时校验的边界；JSON Schema 仅表达单对象的正数／闭合约束。

本次仅扩展现有组件 schema 和领域模型，不新增 REST operation，不修改确定性 fixture。OpenAPI schema snapshot 和字面量审计已同步；`tests/contracts/template-parameters.spec.ts` 覆盖模板完整正例、旧数据兼容、端口／来源负例、盘旋返航和干扰最小距离边界。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 `src/contracts/domain-models.ts` 一致） | `9191C8EFB60734BD4ED33FD4F215A06A934C0873F6DB8B2AF346F069E4BBE4BC` |
| `contracts/mock-api.openapi.yaml` | `D74CE9E56859FE799DB149D7E83E11FC2D4402F36AA5A6F15B6B9AD80357EFA4` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `877024D1469F04D6DC7900A5F1AB8F8AA056351563D0B37A8D59F1B6299E2C19` |
| `../scripts/contracts/contract-documents.ts` | `CA4BFE2054F36CFEF059E6FD3D8B16D2CDF7ECE6BA7D42B735B502E744635090` |
| `../tests/contracts/template-parameters.spec.ts` | `482B30D6BBA550099FF3EC1C929C50A50BD4CA6F9E363120428DB51FA2CDD34F` |
| `contracts/deterministic-fixtures.json`（未修改） | `AA5C02D41D386844A2BE64B0B9883145AEDFA77D20EEB6E2919E0B86A388F1CB` |

## 批量仿真移除合同（2026-10-28，历史冻结记录）

OpenAPI 更新至 **1.9.0**（80 操作 / 39 个 typed POST/PUT/PATCH 写操作）。移除 `/api/v1/batches*` 七项端点、Batch/LocalBatch schema、批次 fixture 与批次路由；`BATCH_LEVEL_III_EXPORT`、批量参数遍历和批量报告导出不再存在。`ReportClassification.LEVEL_III` 仅保留为历史读取兼容，导出统一拒绝；普通 Level II 报告的导出权限保护不变。`POST /api/v1/admin/audit/delete` 保持 ADMIN 合同，未因本次移除而改变。访问控制读模型允许退休 OPERATOR profile 的空菜单，写入 schema 仍要求至少一个菜单，Principal 菜单和 ADMIN `/admin` 约束不变。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 `src/contracts/domain-models.ts` 一致） | `2DC988782A1BA6BD6028CE7CC6ED8D8E62256539A9D418905C794C255F852228` |
| `contracts/mock-api.openapi.yaml` | `2DD16E2459E84B92F0B8D2D0640D0D37463C363134BC6BA49CEAF155D410015E` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `9998EA5285CCD80A5E47643792D8A79628AADAD9E72CF6BDD0C9E584B0D0296C` |
| `contracts/deterministic-fixtures.json` | `AA5C02D41D386844A2BE64B0B9883145AEDFA77D20EEB6E2919E0B86A388F1CB` |
| `../scripts/contracts/contract-documents.ts` | `F127868C0E384720F67704FBF9163CE7B56BEF7187037EBCC58D3464FF5D09A5` |
| `../scripts/validate-contracts.ts` | `4FCE69FE1EE0A9540DE54D2E9D49AAF1E6D135F450EC5C7E429D310D95A30EE9` |
| `../tests/contracts/openapi-contract.spec.ts` | `F7593258DFC73BD1181A50CA7B3C02C0477158676190BAEE2989D721451CDCA1` |
| `../tests/contracts/fixture-contract.spec.ts` | `463709F1D403D0DA1E7B23EC177FD7D1367131436D5FC9A7D435DB1BE6A4D4BD` |
| `../tests/contracts/frontend-capabilities.spec.ts` | `9BE3227FBEC15178B22B8703E1D1D50138DE738856259E849B29CC8736337DE2` |

## 审计管理分页与原子删除合同（2026-10-28，历史冻结记录）

OpenAPI 更新至 **1.8.12**（87 操作 / 42 个 typed POST/PUT/PATCH 写操作）。`GET /api/v1/admin/audit` 保持 `AuditRecord[]` 响应数据，新增且只新增 `page`、`pageSize`、`sortOrder` 三个列表 query 参数；现有筛选仍由 `AuditRequest` 表示，分页信息仍在既有 `Meta`（`page/pageSize/total`）中，不混入筛选请求。

`POST /api/v1/admin/audit/delete` 仅限 ADMIN，单条和批量共用闭合的 `AuditDeleteRequest` / `AuditDeleteResult`。`auditIds` 与 `deletedIds` 均为 1–100 个唯一、非空标识；任一记录不存在即 404 且不执行部分删除。删除不新增 Permission 或 ConfirmationAction；实际操作由服务端记录为 `AUDIT_DELETE`。确定性 fixture 内容未变，schema snapshot、静态参数/RBAC 审计和正反例合同回归已同步。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 `src/contracts/domain-models.ts` 一致） | `4F0F45227B7F848E742575969E9AE181A12989B1D3282E9D2F1542B61D4BDCF3` |
| `contracts/mock-api.openapi.yaml` | `107BE5FE9846B4D8FD07BD8B553C35376F196F3F809412A44CE20EC498F310FA` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `B5733A30ECEFA54C035432B61DCE4EBA10DE393DA177CBB3F8D2A3801FC56EDB` |
| `../scripts/contracts/contract-documents.ts` | `7D8583E81C4ECC5A1478148AADC6F533FB756B05B7E11753D740B848A4B298FE` |
| `../scripts/validate-contracts.ts` | `CB1D970C7175E8F67FBF296C5EF1A689A3527BB71870BC1B25936D44EB8A3E85` |
| `../tests/contracts/openapi-contract.spec.ts` | `EE2459B286EC67C16ACF2AA435154AA92B432A4A6BB224FACC5F3F43A85D8115` |

## 本地批次、阶段与原生 ESM 合同（2026-10-27，历史冻结记录）

OpenAPI 更新至 **1.8.11**（86 操作 / 41 个 typed POST/PUT/PATCH 写操作）。新增本地批次选项、批次报告读取和已确认的报告导出操作；本地批次与既有确定性 mock 批次以联合 schema 并存，既有 fixture 保持有效。报告筛选、终态导出、`BATCH_LEVEL_III_EXPORT` 二次确认和本地服务不可用的 503 响应均纳入合同。

场景身份可选任务阶段 `phases`，其开始/结束边界、唯一标识和不重叠规则由共享运行时校验；`NativeEsmSettings` 进入领域模型，传感器 UI 扩展可选 `esm` 配置。schema snapshot、静态合同审计和 OpenAPI 合同回归与上述变更同步；下方 1.8.10 及更早冻结记录仅保留为历史。

## 激光链路接入合同（2026-10-27，当前冻结记录）

OpenAPI 更新至 **1.8.10**（83 操作 / 40 写操作不变）。读取 `Link` 保持兼容：历史 `LASER` 链路可省略 `laser`；若提供，则必须是闭合的 `LaserLinkParameters`，包含正数收发口径、正数脉宽及唯一支持的光调制 `OOK`。新写入 `LinkWrite` 在 `type=LASER` 且 `enabled` 未明确为 `false` 时必须提供完整 `laser`，并要求 `txPower` 和 `dataRate` 为正数；禁用链路可暂不带光学参数。非 LASER 链路不得携带 `laser`。

`Link.modulation` 继续保留既有 `BPSK/QPSK` 传输字段，不能控制光学引擎；光调制以 `laser.modulation` 为准。光波长由既有 `frequency`（MHz）换算，不新增重复波长字段，且不扩展全局 telemetry/SNBER 枚举。运行时和合同均不为真实用户、旧数据库或新建设备推导默认光学参数；fixture 的 `L-LASER-04` 仅作为冻结的合成回归样例，不是设备默认值。旧读取回归通过删除该样例的 `laser` 属性验证。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 `src/contracts/domain-models.ts` 一致） | `4A5648290D268CF11254CB2CA9A2C94A661C2F4DA80E06C99617B8D1F8B8E96F` |
| `contracts/mock-api.openapi.yaml` | `9793AF37C8A54B5DFB7CB327EFC36DF3EC4D7494DE821547BC49B8AC80D2B430` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `D5F7A71577DA727359A9602DAD7B0344B8ED3A36EE585A9B05398CFA381CCDA2` |
| `../scripts/contracts/contract-documents.ts` | `EC08857AEA3424DCAB47AC9F2A4E5FB061AA593526BB54604861F127E782310A` |
| `../tests/contracts/laser-contract.spec.ts` | `0FCC848AEFC2FE47E35AA1492ED28BE0A019DB136F70E44CE0477458EB1603DB` |
| `contracts/deterministic-fixtures.json`（冻结的合成回归样例） | `FD6BDAADF64E39756BF3947F8B767DF5D00643BECC319C1D3701A826F2B93288` |

## 高空前出中继节点数量上限（2026-10-13，历史冻结记录）

OpenAPI 更新至 **1.8.9**（83 操作 / 40 写操作不变），`ScenarioConfig.platforms` 数量元数据与共享运行时校验统一允许最多 2 个 `FORWARD_RELAY_NODE`。默认配置仍为 1 个，其位置只读约束、其他类型上限和信息节点总容量 50 个不变；新增、改型、保存及导入共用此规则。领域类型、fixture 和存量数据库未修改；数量语义仍由共享运行时校验执行，schema snapshot 同步更新。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/mock-api.openapi.yaml` | `E1539F2E1A9A6E191898201B90D7A3D295D80F8E6AF358B0088B63E35C7BD951` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `5FC376A1AAC8A51D7DA06AAF58824FC8C3D5FC1D2B6B01E9B6CB8D3BCDE17F88` |

## 环境参数、数传波段与阶段切换规则（2026-10-08，历史冻结记录）

OpenAPI 更新至 **1.8.8**（83 操作 / 40 写操作不变），仅扩展组件 schema：`Environment` 新增云层高度、云中液态水密度与海面区域 `seaPolygon`；`Link.band`（C/L）仅允许 `DATALINK` 携带；`ScenarioLinkSettings.switchRules` 引用新组件 `LinkSwitchRule`，距离条件必须带 `distanceThresholdM` 且不得带 `jammerId`，干扰条件反之。新字段均可缺省，旧场景读取不受影响。运行时校验另行要求规则目标链路与端点业务同方向，该约束跨对象引用，不在 schema 中表达。同步领域类型、schema snapshot 与合同负例；fixture 未改。回退须同时恢复合同、领域类型与共享校验。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 `src/contracts/domain-models.ts` 一致） | `D2F28B2ED31448351C69AFD62B73313BF14A4327DEAF6AAE4A78C915A4CB8921` |
| `contracts/mock-api.openapi.yaml` | `5EB5BD5C88E25460B439E6610667027FB873FCAFA1F26ACDF04998A5BA6CE00B` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `A21625FC9F02523170D69F361C2D6ACAAD13B10FA7FFB548380B05C3898D697F` |
| `contracts/deterministic-fixtures.json`（未修改） | `C1BB07FCF492F44E9BC99D3BDF5E6D4540DDCBA790A767B9E0D6B6123ED91A6B` |

## 全局重置权限（2026-09-29，历史冻结记录）

按已确认产品口径，`POST /api/v1/reset` 仅 ADMIN 可调用；OPERATOR 返回 403 并记录拒绝审计。OpenAPI 更新至 **1.8.7**，`x-rbac` 与 403 错误响应同步冻结；schema snapshot 仅包含组件 schema，本次不变。旧客户端即使显示重置入口也会被服务端拒绝，升级后在清理本地投影前判断权限。回退须同时恢复前后端权限口径与合同。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/mock-api.openapi.yaml` | `7A9C017C0755C5E91ED66EC1121CBB963538BBD40E584CC6A550115C0F9B021C` |
| `../scripts/contracts/openapi-schema.snapshot.ts`（未修改） | `7CB1C293F8C051FC44C930AF5C95B6D69E77D0C29DAE21B700692CFD7F37C580` |

## 场景修订与运行编号（2026-09-28，历史冻结记录）

经用户授权，OpenAPI 更新为 **1.8.6 / 83 操作 / 40 写操作**：场景 `PUT` 的 `ScenarioDraftUpdate.expectedRevision` 必填，缺失返回 422，不匹配当前修订返回 409；新建运行不复用编号，初始夹具 `RUN-001` 保留为演示读取证据，不代表后续创建结果。可变场景的警告确认绑定创建时修订号，旧修订确认不能用于新脚本预览。同步领域类型、schema snapshot 与合同负例测试；fixture、数据库结构和其他业务合同未改。旧客户端须先升级为携带当前修订号再写入；回退时须同步恢复写入合同与服务端判定。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 `src/contracts/domain-models.ts` 一致） | `743512B23EDB971F1CF62F9713AE00AFA2A71EDE42D10FD099209284A3856E90` |
| `contracts/mock-api.openapi.yaml` | `B9D80DE10F9E150075208DD8C2B89ED36F061DC785098B5940A64D5496831583` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `7CB1C293F8C051FC44C930AF5C95B6D69E77D0C29DAE21B700692CFD7F37C580` |
| `contracts/deterministic-fixtures.json`（未修改） | `C1BB07FCF492F44E9BC99D3BDF5E6D4540DDCBA790A767B9E0D6B6123ED91A6B` |

## 已接通设备参数写入边界（2026-09-27，历史冻结记录）

经用户授权，OpenAPI 更新为 **1.8.5 / 83 操作 / 40 写操作**：写入场景中的 `jammers[].defaultPower` 与 `sensors[].detectionRange` 必须大于 0，读取旧场景仍允许 0；仅 `ScenarioConfigWrite` 收紧，不修改设备读取模型、业务夹具或数据库。写入方须同步升级；回退时须同步恢复写入 schema 与校验规则。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/mock-api.openapi.yaml` | `B5C523721E79E08E29CA551B670E42617E3680DB69773F70E396F2F3ECA31963` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `275778FEC03FA6D6224D541D7D1AA4C39EC3524A5941419A4FB47EB681043056` |
| `contracts/domain-models.ts`（未修改） | `985F2BD4909B4AE3BBAEB68CCB5239174D1BDA27CF9C630C6F0759095F786EF1` |
| `contracts/deterministic-fixtures.json`（未修改） | `C1BB07FCF492F44E9BC99D3BDF5E6D4540DDCBA790A767B9E0D6B6123ED91A6B` |

## 通用服务端异常响应（2026-09-27，历史冻结记录）

经用户授权，OpenAPI 更新为 **1.8.4 / 83 操作 / 40 写操作**：82 条 REST 操作增加引用 `ErrorEnvelope` 的通用 500 响应；WebSocket 升级与关闭协议不变。意外服务端异常返回脱敏的 `INTERNAL_ERROR`，请求 JSON 解析错误仍为 400 `INVALID_REQUEST`，业务启动失败仍使用 `START_FAILED`。同步领域错误码、schema snapshot 和每操作错误状态审计；不修改业务数据模型、fixture 或存量数据。前后端同步升级；回退时同步恢复错误码和合同。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 `src/contracts/domain-models.ts` 完全一致） | `985F2BD4909B4AE3BBAEB68CCB5239174D1BDA27CF9C630C6F0759095F786EF1` |
| `contracts/mock-api.openapi.yaml` | `21365D9872F5A1CEA20F106BDDFB8005A30233548EF23200E33E9B10B41DDC1E` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `0966E70BF66D085CF1B28F3E9E4D3EEB9C58C8BD008D87FD9123F51643866E78` |
| `contracts/deterministic-fixtures.json`（未修改） | `C1BB07FCF492F44E9BC99D3BDF5E6D4540DDCBA790A767B9E0D6B6123ED91A6B` |

## 场景读写兼容边界（2026-09-24，历史记录）

用户授权最小读写合同拆分，OpenAPI **1.8.3 / 83 操作 / 40 写操作**：`InformationDemand` 读取保留历史非空文本，`ScenarioLinkSettings` 读取兼容无 FIBER 的完整旧四类优先级和 enabledTypes。新增 Write schema，由 `ScenarioConfigWrite` 强制四种业务枚举及完整五类设置。领域类型、运行时校验、schema snapshot 和冻结审计同步；fixture 不改，不迁移或重写存量数据库。

上线顺序：先部署兼容读取和严格写入版本，再由用户明确编辑旧场景。旧记录不被自动转换为新枚举。回退到不兼容读取的旧程序可能再次无法打开旧库，应保留本兼容版本；不通过删除或重置数据回退。混合版本部署时以新写入校验为准，不保证旧写入端执行新规则。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/mock-api.openapi.yaml` | `C3FDE6CA5BB7F4820EC92BD69FD4CED3015D5810D627E0F1FEF89A7CE01363C7` |
| `contracts/domain-models.ts`（与 `src/contracts/domain-models.ts` 完全一致） | `BA39D8A5CDF88E8CA4A3B63C5C49EDF7DE4D322A6F858E58B6E2ABBDAA8A63C8` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `A27E1BEABB97D5BEDE77835B99846E454C39414DB3271816D13FED700CAC218C` |

## 本机 mission 错误响应补齐（2026-09-24，历史记录）

经用户授权，OpenAPI 更新为 **1.8.2 / 83 操作 / 40 写操作**：命令接口补充 422（脚本不可无损生成）、503（本机进程启动/停止失败），全局 reset 补充 409（本机运行期间拒绝重置）。三项均引用既有 `ErrorEnvelope`；同步错误响应冻结清单及删除响应的负例测试。不改变领域模型、fixture、需求范围或 schema 结构，因此完整 schema snapshot 保持原值。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/mock-api.openapi.yaml` | `BC96BD2ED809C15200196210BE5865D0C817D54CF6C528C955938446CFF2725C` |
| `../scripts/contracts/openapi-schema.snapshot.ts`（结构未改） | `ED1B20DC17EA565F1BC7793793FAA595DEBC95AE65EC55D71A8587D2D0F48397` |

## 装备引用场景同步冻结（2026-09-21，历史记录）

用户确认保存装备时同步已登记引用场景：非空带宽、功率、速率、调制和 BER 阈值覆盖，具体频率保留并检查新范围，锁定／引用失效／版本冲突／校验失败整次拒绝。SQLite 同一连接跨库事务保存装备、历史、引用版本与场景修订，历史归档、模板及未引用场景不变。引用登记本身不覆盖参数。此前“不自动更新场景”仅是历史范围，现由本授权替代；主数据登记语义不变。

OpenAPI **1.8.1 / 83 操作 / 40 写操作**，仅版本和 PUT 行为说明变更，无新字段或接口；领域模型、schema snapshot 与 fixture 均未改变。新代码不在启动时迁移存量场景；回退程序不自动回退已同步数据，应保留兼容版本及用户授权备份。跨库同步要求文件回滚日志模式，不能保证原子性时明确拒绝，不修改数据库模式。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 src 副本一致，未改） | `BA5B7725EB772BFDB893E26DB9BE8550C81E58C22C89E5801CDB093B08E8D58A` |
| `contracts/mock-api.openapi.yaml` | `BF0A0195E0D274A47CE47E0453949D0899430F63AB538502335F05CBFB3D2055` |
| `../scripts/contracts/openapi-schema.snapshot.ts`（未改） | `ED1B20DC17EA565F1BC7793793FAA595DEBC95AE65EC55D71A8587D2D0F48397` |
| `contracts/deterministic-fixtures.json`（未改） | `6D0776F84EE4D767F4050AD8B4C9BD3C7D55C6DA2904D01403D379601955EAF0` |
| `../多手段无人集群通联技术软件-前端开发需求基线.md`（V1.1.46） | `2F2694B6750B1F6B71D0B0ED04B8C527BE0F01B22354EE0270FADCB3A185D592` |

## SQLite 完整备份与计划冻结（2026-09-21，历史记录）

用户确认包含历史归档，关键配置按白名单备份、排除凭据，国产数据库暂缓。OpenAPI **1.8.0 / 83 操作 / 40 个 POST、PUT、PATCH**；兼容扩展备份名称／范围及 `GET/PUT /api/v1/admin/backup-plan`，保留管理员和备份／恢复的一次性确认。领域模型镜像、完整 schema snapshot、操作和错误响应审计同步，业务 fixture 未改。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 src 副本一致） | `BA5B7725EB772BFDB893E26DB9BE8550C81E58C22C89E5801CDB093B08E8D58A` |
| `contracts/mock-api.openapi.yaml` | `D6A2EC2DB8B5F1C2D828BC4AFE1CB1F51ECFE4BC2D5618F399681E0E76831A2A` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `ED1B20DC17EA565F1BC7793793FAA595DEBC95AE65EC55D71A8587D2D0F48397` |
| `contracts/deterministic-fixtures.json`（本次未改） | `6D0776F84EE4D767F4050AD8B4C9BD3C7D55C6DA2904D01403D379601955EAF0` |
| `../多手段无人集群通联技术软件-前端开发需求基线.md`（V1.1.45） | `AEA382DBE553B483CF3F5E6748A736457DA2675E492F76C1769D0D626DD833A3` |

新增独立 `runtime-config.db`，只保存事件／位置 CSV 路径及当前部署的同项环境基线；不复制 `.env.local` 或任意环境变量。多库备份采用受控 SQLite 包，在同一锁定点捕获主库、装备、角色权限、主数据、历史归档和配置。恢复只替换白名单业务表数据，审计及文件读取记录保留，计划和备份目录不回退；旧会话和运行失效。恢复需文件回滚日志模式，拒绝 WAL／MEMORY／OFF，不暗改日志模式。所有验证仅使用临时数据库。

旧主库备份保留查看但不可作为完整系统恢复来源，旧包不迁移或删除。回退旧程序保留全部新库和包，仅停止新计划；旧程序不能读取完整包，不能借此声称旧版具备多库恢复能力。配置恢复即时生效，同环境重启保留；明确修改 `.env.local` 路径后下一次启动采用新路径。原始 CSV 不备份，已登记归档包含完整解析数据。账号密码散列属于账号数据，仍受备份保护；未包含明文配置凭据，但包未加密，只可用于非敏感开发数据。加密、国产适配及跨机器灾难恢复另行验收。

## 主数据真实内容与版本引用冻结（2026-09-21，历史记录）

用户确认“主数据真实内容、持久化、版本与引用保护”，采用显式登记场景／模板版本关系，不自动应用参数。OpenAPI **1.7.0 / 81 操作 / 39 个 POST、PUT、PATCH**。MasterData 旧读兼容，新写强制内容；增加类型化条目、实际历史与引用模型及三项接口。完整 schema snapshot、操作三元组、错误响应和字面量审计同步；不改既有业务夹具。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 src 副本一致） | `AB51F51E185D991CB229EF140FC735341787AE03F19DDF9C1A1CDD5F77CCCE99` |
| `contracts/mock-api.openapi.yaml` | `B57A66C6B60973FCF52A35A401BD969C32DF19CAA473E4013D47B4D6ACD0D68D` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `3468250754298D4EEC767B42C8C903243DF6A2ECF17DD1BE807C7E60EDCEBAA8` |
| `contracts/deterministic-fixtures.json`（本次未改） | `6D0776F84EE4D767F4050AD8B4C9BD3C7D55C6DA2904D01403D379601955EAF0` |
| `../多手段无人集群通联技术软件-前端开发需求基线.md`（V1.1.44） | `6E567D6509BA073E46856B75DD60641DF3945BBAAB823847BCB805B731D411B4` |

本机正常启动时在主库同目录新增独立 `master-data.db`，空库起步；已有场景、模板、账号和装备不迁移、不覆盖。只保留真实保存版本；显式历史引用阻止删除，不因目标后续变化自动解除。无引用项删除后保留历史、编号不复用。该独立主数据存储尚未纳入旧主库备份／恢复，需独立保护；回滚程序不删除新库。接口登记不等于参数已经应用，也不宣称已自动发现全部业务引用。

## 系统状态接入的路由元数据同步（2026-09-21，历史记录）

系统运行状态复用已有本机 `/api/v1/data-exchange/monitor`、LocalMonitorSnapshot 和 dataExchangeStore；接口版本仍为 **1.6.0 / 78 操作 / 38 个 POST、PUT、PATCH**。仅同步 fixture 中 `/admin` 的 Store 依赖及对应审计清单，不修改冻结业务证据、领域模型或 OpenAPI schema。旧 `/admin/health` 留作兼容，不作为真实状态页的数据来源；未监测项不显示正常。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 src 副本一致，未改） | `1E984DFC08A89EC9DD63C01072F3DD385AD229D83012F27B7227E53FBD7C06FC` |
| `contracts/mock-api.openapi.yaml`（未改） | `3E85B09B2FE5F7E1B8AF2EFF275916B8A4323B629690B94E784F3D09B5237F9C` |
| `../scripts/contracts/openapi-schema.snapshot.ts`（未改） | `B0DE7DDF64E2F73AD920E53E342553E7FA76881E05C8B6A62615C83AAEC6639E` |
| `contracts/deterministic-fixtures.json`（仅上述路由依赖变更） | `6D0776F84EE4D767F4050AD8B4C9BD3C7D55C6DA2904D01403D379601955EAF0` |
| `../多手段无人集群通联技术软件-前端开发需求基线.md`（V1.1.43，未改） | `FE4032819DD74588F0DF33020E7C7F9CE4982B79BADC5BF67808B18C0C4B9F21` |

## 真实快照归档兼容扩展冻结（2026-09-21，历史记录）

用户确认阶段 2：管理员手动登记当前有效快照，兼容扩展接口、独立存储和合同。OpenAPI **1.6.0，78 操作 / 38 个 POST、PUT、PATCH**。新增 LocalArchiveRecord 及真实列表／登记／读取接口；回放与评估共用同一归档，报告导出可指定 archiveId。旧 ArchiveRecord 与纯 Mock 路径保留兼容，真实归档页不再消费演示归档。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 src 副本一致） | `1E984DFC08A89EC9DD63C01072F3DD385AD229D83012F27B7227E53FBD7C06FC` |
| `contracts/mock-api.openapi.yaml` | `3E85B09B2FE5F7E1B8AF2EFF275916B8A4323B629690B94E784F3D09B5237F9C` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `B0DE7DDF64E2F73AD920E53E342553E7FA76881E05C8B6A62615C83AAEC6639E` |
| `contracts/deterministic-fixtures.json`（本次未修改） | `2908EDEE19C38B318282999A1D8BF5B8EA19C5318E4170C1258D953BB5783B84` |
| `../多手段无人集群通联技术软件-前端开发需求基线.md`（V1.1.43，本次未修改） | `FE4032819DD74588F0DF33020E7C7F9CE4982B79BADC5BF67808B18C0C4B9F21` |

本机启动时在主库同目录新增独立 `archives.db`，保存解析快照及报告，不复制原始 CSV，不改主库／装备／账号／模板；归档明确未绑定场景或运行。两次来源哈希一致才可登记，重复登记幂等返回原记录。归档损坏拒绝读取，不回退最新文件。该库尚未纳入现有主库备份／恢复，需独立保留；不自动删除历史。回滚旧程序仅停止使用新接口和新库，不删除已登记数据。当前结构为初版，只新增表，无既有归档迁移。

## 前端能力兼容扩展冻结（2026-09-21，历史记录）

用户授权补齐前端模块并兼容扩展接口与 SQLite。OpenAPI **1.5.0，75 操作 / 37 个 POST、PUT、PATCH**。新增装备可选带宽/功率/速率、真实保存版本与引用登记，以及自定义角色/菜单分配。旧装备字段可缺省；未分配账号维持原权限。没有真实质量、阶段或批次数据的视图统一显示“暂无数据”，不植入结果。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 src 副本一致） | `F02A30F6ECEA593C2302091CF82DD7D7700C6668F352134FED3A376596900BEF` |
| `contracts/mock-api.openapi.yaml` | `6483030100B9CCC6C968C40665F0A08198F7A3F6C516F7AFFEFB27D1107F078C` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `BF1671EAF761222B35B84632A1232615CFB38E2911313DD45BB0DFB1D5982BD9` |
| `contracts/deterministic-fixtures.json`（本次未修改） | `2908EDEE19C38B318282999A1D8BF5B8EA19C5318E4170C1258D953BB5783B84` |
| `../多手段无人集群通联技术软件-前端开发需求基线.md`（V1.1.43） | `FE4032819DD74588F0DF33020E7C7F9CE4982B79BADC5BF67808B18C0C4B9F21` |

迁移为启动时按需建表：equipment.db 新增历史/引用表，独立 access-control.db 保存空初始配置，不 ALTER 账号/场景表、不自动分配角色或更新场景。两库均不纳入原主库备份，部署前须分别保留。兼容指新程序读取旧数据；写入新参数后不保证旧程序能读取扩展 JSON。回滚须恢复配套版本与扩展前备份，已启用角色限制时不可直接回滚为旧权限实现。

PDF 入口为浏览器“打印当前视图／另存 PDF”，不是 Node 生成 PDF，也不返回 generated:true；Node 仍仅生成受控 HTML/CSV。验证范围和未通过项以推进表最新记录为准。

## 本地报告合同增量冻结（2026-09-20，历史记录）

用户要求本地运行数据统计及真实导出。按兼容增量扩展 Report/导出响应，OpenAPI **1.4.0，71 操作 / 35 个 POST、PUT、PATCH**。本机入口只用两份真实 CSV；纯 Mock 保持原有报告与无文件验证。本地 HTML/CSV 已实现，PDF、历史归档和缺少数据支撑的质量指标不作为已完成能力。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 src 副本一致） | `AF62C23E4BD4244B63F0B519845F3757940D1FE68C18CB9D10A4FFEE13AF75AC` |
| `contracts/mock-api.openapi.yaml` | `A4EAC298D96C583067BD6E294F281689F7D07FD1867C6D72DAE2D15108420B14` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `339DAFCB68E0FE3EC5B2292BB49FC985A9D4EF885CA980E69053975E8CDAE2F0` |
| `contracts/deterministic-fixtures.json`（未修改） | `2908EDEE19C38B318282999A1D8BF5B8EA19C5318E4170C1258D953BB5783B84` |

## 装备参数合同增量冻结（2026-09-20，历史记录）

用户授权空库起步、新增装备模型/读写接口/SQLite 表，随后确认补充管理员二次确认删除。OpenAPI 升级至 **1.3.1（71 操作 / 35 个 POST、PUT、PATCH）**；新增内容见 `04-mock-api.md`。本机装备库独立于主库，既有备份恢复不包含它；纯 Mock 不持久化，也不植入演示装备。本文历史纯 Mock 非目标不否定本次显式授权的本机扩展。

| 文件 | 本次 SHA-256 |
|---|---|
| `contracts/domain-models.ts`（与 src 副本一致） | `8ED1C53B979C0DF3840C23EA6D786017189F5359EAA05EE9D6CECA322AA6C05F` |
| `contracts/mock-api.openapi.yaml` | `9B74E85E0B7392D274A463A2E0D2CBCC381EDFB331C5FAF09B1C4911CDC95C84` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `BBA3A3D467D0708E2BD07FD211E25546DC81AB907F49AF56A84C5AC65A10F9DA` |
| `contracts/deterministic-fixtures.json`（本次未修改） | `2908EDEE19C38B318282999A1D8BF5B8EA19C5318E4170C1258D953BB5783B84` |

以上增量值保留作为历史证据；当前合同采用本文最上方系统状态接入的路由元数据同步值。

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
| 3 | `多手段无人集群通联技术软件-前端开发需求基线.md`（V1.1.42，补充本地报告及真实 HTML/CSV 导出；其他待验收项保留） | `61B2E26996D80BBB90ADD0B89042CC76929DF130AE64236D8AC4B523F0EDBD46` | 面向前端/Node.js Mock 的需求解释、来源决策、需求/测试 ID 和实施门禁 |
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

### 2026-10-29 链路基础数据参数来源（历史冻结记录，OpenAPI 1.9.2）

新增/编辑链路可记录装备或通用基础数据的版本化参数来源；旧场景省略该字段仍可读取。通用数据只按合同字段名和单位映射，枚举必须显式选择 `entryKey`，未知或单位不符条目不自动套用。设备的频段范围、带宽、功率、速率、默认调制与 BER 阈值键仅可由设备库维护；通信体制和参数字典的新写入不得重复这些键，历史读取保持兼容，枚举仍保存受控文本选项。链路工作频点、接收配置及增益／噪声等公共参数仍按明确字段和单位映射。新增只读 GET `/api/v1/scenarios/parameter-catalog`，共 81 个 operation、39 个 POST/PUT/PATCH；目录闭合性由保存服务核对。本轮不改正式数据或 fixture。

- `contracts/domain-models.ts`（与源码镜像一致）：`8A2E39B5EABA8F70F5130FB371A8CE1023BA731DACE9D2B1696660D4F54DA81B`
- `contracts/mock-api.openapi.yaml`：`2AA27E11B80985A8BC58D7BF0513E96C040F73A3095782AAA449D90E0CB26D2C`
- `scripts/contracts/openapi-schema.snapshot.ts`：`B417D47BB7537B68DEAD505E2648214E7B554B7F6FE24D7B398B4736565C4920`

### 2026-10-29 装备链路写入规则与类型匹配（当前冻结记录，OpenAPI 1.9.3）

`EquipmentParameter` 保持历史读取兼容，不枚举或推断未知历史 `type`。新增仅供装备新增／更新请求组合的 `EquipmentLinkWriteParameters`：卫星、微波、数传、激光和光纤设备分别收紧调制、发射功率和数据速率；激光仅允许 `OOK` 且功率大于 0，卫星功率上限为 1000 W，其余已知类型为 100 W。频率和带宽继续只要求正有限值，频率范围成对填写及下限不得大于上限仍由服务端跨字段校验，未杜撰 10 GHz／1 GHz 上限。

新增引用只允许与目标链路类型匹配的明确通信设备；未知历史类型不能作为新引用。已保存的历史引用仅限参数来源和值均未变更时兼容。操作数仍为 81，typed POST／PUT／PATCH 写操作仍为 39；领域模型与确定性 fixture 本轮未修改。

| 文件 | 当前 SHA-256 |
|---|---|
| `contracts/mock-api.openapi.yaml` | `70BD84CB4248EF61BCEB183BA39F7083B57EDC9688F0D685AB47EE68309F2136` |
| `../scripts/contracts/openapi-schema.snapshot.ts` | `83FF5E7F2B8FD6C8F7969E6649D99A51BC4899B900BE31D6B6D6C9D662AC3827` |
| `../scripts/contracts/contract-documents.ts` | `AC972B9C9424B6F2D03C17D90801177635D3E80553525D5734773D4E49D50150` |
| `../tests/contracts/equipment-contract.spec.ts` | `BBBFB7F9D560467449430B63FB4552B1DC00B2306586DFCB462EF5BC8893BF75` |
| `../tests/contracts/openapi-contract.spec.ts` | `2E263783B4599088F27AA618AF39B07E884351F85365DB45F73B9D7AB311F62C` |
