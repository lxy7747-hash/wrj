# 前端技术设计包 V1.1

本目录是后续 Vue/Node 实现的技术设计基线，只含文档与机器可读合同。它依据两份上位 Word 文档和已评审通过的《前端开发需求基线》保留 29 项能力、7 类接口、11 条路由、权限边界、状态投影和确定性夹具关系；HTML 原型仅用于页面和交互说明，不得覆盖文档需求。本目录不包含应用脚手架、依赖、脚本、服务端/客户端实现或构建产物。

当前前端需求基线为 **V1.1.47**，SHA-256：`D8B09CCB3AB92F0569A3831DAA810C2284BAF389EB9E1C0797FC8D44A4CA458B`。本次仅将输出参数的操作权移至项目配置文件；下方历史冻结记录的旧哈希保持原样，机器合同未因此变更。

## 场景修订与运行编号（2026-09-28，当前冻结记录）

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
