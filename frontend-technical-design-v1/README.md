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
| 3 | `多手段无人集群通联技术软件-前端开发需求基线.md`（V1.1.30，场景变更待复核） | `01DBBC3596B96E505D8688CBD70B2B7B02E3B3A630E188B0D755275125A5EE46` | 面向前端/Node.js Mock 的需求解释、来源决策、需求/测试 ID 和实施门禁 |
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
- 每个 OpenAPI operation 必须保有具体 request/response schema；除公开 login 外均显式要求 `X-Demo-Role`。fixture 必须通过 `DeterministicFixtures` 根 schema。
- UI 生命周期和 canonical 数据不得混写：`STOPPED` 不序列化为 SRS SimulationState；`DEGRADED` 不写入 canonical LinkStatus/CSV。
- 核心 store、状态投影、RBAC 与 adapter 的单元覆盖率不低于 90%。

## 非目标与生产延期项

本阶段不实现真实 AFSIM/插件、SQLite、文件系统、认证会话、密钥/加密、水印、防篡改存储、PDF/HTML/CSV 生成或生产部署。生产阶段需要另行批准：身份提供方、密钥托管、持久化迁移、受控目录、原子文件替换、进程沙箱、审计留存、分类审批、Leaflet 离线图资许可和端口配置。上述事项不得在 mock 中用伪实现暗示已具备安全能力。
