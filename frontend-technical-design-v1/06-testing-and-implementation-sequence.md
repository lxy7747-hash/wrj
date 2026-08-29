# 06 测试策略与后续实现顺序

## 测试分层与强制门禁

| 层 | 工具 | 最小覆盖 | 合并门禁 |
|---|---|---|---|
| Type/schema | TypeScript、AJV、Vitest | ScenarioConfig、五 SRS 接口、API/WS envelope、fixture 全量 | `tsc --noEmit`；正/负 schema；类型名/枚举/单位快照一致 |
| State/store | Vitest | capability、simulation UI/canonical、link UI/canonical、confirmation、replay、batch、config lock | 每条合法边和非法边；reset 后深相等；核心 unit line/branch ≥90% |
| RBAC | Vitest、Supertest | 角色×route×endpoint×敏感 action | UI guard 与 server reject 均有证据；last-admin 和 Level III 组合覆盖 |
| Component | Vue Test Utils | 29 capability 目的地、7 interface 目的地、共享表单/表格/对话框 | 六态、键盘、错误/空状态、fieldPath、单位、无颜色唯一语义 |
| Contract/API | Supertest、`ws` test client | OpenAPI 每个 operation、error catalog、5 个 canonical topics | 成功/错误 envelope；127.0.0.1；序号/gap/close 1008/reconnect；禁止副作用 |
| E2E | Playwright | 11 routes、主链、数据交换、回放、报告、admin 拒绝、reset | Chromium；1920×1080 与 1366×768；除负向登录场景中明确白名单的 401/423 浏览器资源错误外，console error=0。HTTP 404=0；非回环请求=0 |

覆盖率分母中的核心包括：全部 stores、状态 transition/predicate、RBAC、canonical/UI projection、API/WS adapters、schema/business validators。生成的 schema 类型和纯展示样式可单列，不得用排除规则掩盖未测试业务分支。

## 必测用例

### 类型与 schema

1. SCN-001 通过；`scene` 输出、未知 schemaVersion、缺字段、重复 ID、悬空引用失败。
2. SRS §3.5.3 表 22 字段逐名锁定：尤其是 `targetPlatformId/frequency/bandwidth/txPower/antennaGain/dataRate/direction`、平台关联数组、jammer/sensor 字段和五个平铺 output 字段；归一化别名出现在 canonical JSON 时失败。
3. 坐标、时间窗和 waypoint 顺序边界逐一测试；duration/timeStep/frequency/bandwidth 的 0 值失败，txPower/defaultPower/dataRate/detectionRange 的 0 值通过、负值失败；BER/概率范围失败时给出 fieldPath。
4. 四类业务信息节点各至少 1 个；四类业务信息节点合计 50 个通过，第 51 个返回 `NODE_LIMIT_EXCEEDED` 且草稿不改变；通信卫星和地面固定式干扰侦测站不计入容量，且不能用于凑足四类覆盖。
5. 四类链路 `SAT/MICROWAVE/DATALINK/LASER` 和两类干扰设备 `BARRAGE/SPOT` 均有独立可编辑夹具；ESM 传感器不计作第二类干扰设备；`informationDemand` 空数组失败。
6. 五个 SRS interface 的 required keys 与 `domain-models.ts` 一致；稀疏兼容输入不能污染 canonical 输出。
7. 三个 CSV literal constant 的字段名/顺序逐字符锁定；DEGRADED row 未投影时 adapter 拒绝。
8. 完整 `deterministic-fixtures.json` 通过 OpenAPI `DeterministicFixtures`；删除任一 platform/link 字段、scene entity taxonomy/capacity evidence、loss/noise/candidate/sync/jammer evidence 或改变同帧时间均失败。

### 状态与投影

- 六态 capability：验证前不得 EXECUTING；ERROR 重试；EMPTY 不显示旧数据。
- simulation：START 必须选择运行模式并锁配置；PAUSE/RESUME/STEP/STOP/SET_SPEED 合法性与倍速正数边界；STOPPED→canonical IDLE；ERROR/COMPLETED 清锁。
- link：连续帧/滞回；F-00042 的 L-MW-01=UP，L-DL-03 UI DEGRADED/canonical DOWN。
- confirmation：场景 WARNING 继续、官方模板删除、仿真停止和敏感管理员动作均覆盖确认/取消；过期、重新认证、重复确认、reset 全部失效；场景存在 ERROR 时不得以确认绕过。
- replay：load/play/pause/seek/single-frame/back/speed/end/corrupt；不修改 RUN-001。
- batch：12 run/report 一一对应；partial/cancel/illegal transition；聚合只来自同 12 行。

### RBAC 决策表

| Action | OPERATOR | ADMIN | 附加条件 |
|---|---|---|---|
| 业务读取、临时场景、仿真、回放、普通 Level II 状态导出 | allow | allow | 登录认证 |
| 官方模板维护、主数据、用户角色 | deny | allow | 删除需引用检查 |
| `/admin` route | redirect+denial | allow | endpoint 仍重验 |
| 备份/恢复、全量配置、审计受控导出 | deny | allow | 一次性二次确认 |
| Level III 批次比较导出 | view only/deny export | allow | 二次确认；generated=false |
| 删除/降级当前或最后管理员 | deny | deny | `LAST_ADMIN_GUARD` |

### 确定性 reset transcript

测试启动后执行并保存响应 A：

1. `POST /api/v1/reset`，断言 `REQ-RESET-001`、冻结时间、nextSequence=1。
2. 读取 SCN-001→TASK-001→RUN-001→F-00042。
3. 从 frame 验证 L-MW-01/L-DL-03、DET-042、SW-003；沿 RUN-001 读取 REPLAY-001、RPT-001、ARCH-001。
   F-00042、DET-042、SW-003 的有效 `simulationTime/time` 均为 42；`sourceRegistryTime` 只保存原型旧展示值，绝不参与同帧计算。
4. 读取 BATCH-001，验证 RUN-B01…RUN-B12 与 RPT-B01…RPT-B12 顺序一一对应并指向 RPT-BATCH-001。
5. 修改草稿、运行状态、回放游标、确认上下文和 WS sequence，再 reset；重复 1–4 得响应 B。
6. 删除传输连接对象后 A 与 B 深相等；所有引用 closure 零 orphan，所有 timestamp 均为 fixture 常量。

reset 所有权测试必须证明 `InteractionsPage` 只调用一次 `uiStore.resetAllProjections()`。顺序 spy 依次断言：WS/计时器清理、确认失效、单次 reset API、九个业务 store 顺序 reset/load、UI 清理；在每个步骤注入失败，均应得到 reset ERROR、WS 断开、计时器清除、确认失效和九个业务 store 的安全空态，不得出现半初始化数据。

### 网络与副作用

在测试中拦截 `fetch`, XHR, WebSocket, image/font/tile 请求；host 不是 `127.0.0.1` 或静态 app origin 时立即失败。mock 启动后检查监听地址。对 `fs`, SQLite module, `child_process`, crypto 和 export generator 设置 fail-fast spy；调用所有 endpoints 后调用次数保持 0。检查工作目录文件清单与哈希不变。

OpenAPI 静态审计逐 operation 检查：唯一 operationId；30 个 POST/PUT/PATCH 均有非空 typed requestBody；除 login 外每个 operation 均引用 `DemoRole`；每个 2xx JSON response 均指向独立 typed envelope 且 `data` 再指向具体业务 schema；path 参数全部声明；场景 WARNING 继续、官方模板删除、仿真停止以及 backup/restore/audit/full-config 的确认缺失均声明 428。任何 `{}` 业务 data schema 都直接失败。

### E2E 路由清单

| Route | 核心断言 |
|---|---|
| `/login` | 三种认证结果；ADMIN 与 OPERATOR 分别登录；无 token/cookie |
| `/situation` | F-00042 同帧地图/面板/弹窗；仿真状态/锁 |
| `/scenarios` | 完整编辑、校验、批量 import/undo/reset、模板 RBAC、脚本预览 |
| `/batches` | 12 行、参数、状态与 report pair |
| `/reports` | RUN/BATCH source 原子切换；Level II/III 权限和确认 |
| `/replays` | REPLAY-001 控件、事件、corrupt/empty overlay |
| `/admin` | operator 重定向；ADMIN 主数据/用户/备份/审计/归档/健康 |
| `/blueprint` | 29 cards、7 interface anchors、8 decisions |
| `/admin/data-exchange` | 系统管理下的 CSV/JSON/WebSocket/AFSIM 四项能力、7 类接口合同、零连接边界 |
| `/traceability` | 29+7 行过滤与 destination navigation |
| `/interactions` | 六态 gallery、错误目录、closed-loop duplicate、reset |

所有十一条路由分别在 1920×1080 和 1366×768 截图比较。小视口允许数据表内部滚动，但导航、主 action、错误和确认按钮必须可见/可键盘到达；无重叠、截断或脱离 viewport 的 modal。

阶段化 E2E 口径：

- P1 只验证 11 条路由的页面壳、主导航、匿名重定向及 OPERATOR/ADMIN 权限矩阵，不断言 P2–P8 尚未实现的业务功能。
- P2–P7 随对应能力实现补充业务主链、六态、错误路径和权限操作断言。
- P8 汇总全部路由及业务链路，执行完整双视口集成验收。

## 后续实现顺序

1. **合同基线**：复制 types，采用 OpenAPI 2020-12 schema 与 fixture loader；AJV 直接验证 `DeterministicFixtures`，先通过 type/schema/evidence/timing closure tests。
2. **Mock 内核**：实现固定 clock/requestId、success/error envelope、内存 projection、reset、loopback bind；通过无副作用测试。
3. **Auth/RBAC/router shell**：实现两个受支持角色的独立认证、十一路由与 guards；通过 route×role 表。
4. **核心 adapters/stores**：依次 auth/ui、scenario、simulation/telemetry、batch/report/replay、admin/traceability；每个状态机先测后接 UI。
5. **场景与合同页面**：scenario editor、validation、template、script preview、blueprint/traceability/interactions。
6. **运行态势与 WS**：离线 Leaflet、frame consistency、simulation controls、topics/reconnect。
7. **批次/报告/回放**：同源选择、12 行 registry、Level III confirmation、只读 replay。
8. **Admin 可见合同**：master/user/backup/audit/archive/health，不增加任何真实持久化能力。
9. **集成与 E2E**：两个 viewport、网络封锁、a11y/键盘、reset transcript、coverage 门禁。

后一步只有在前一步门禁通过后开始；合同变化先更新类型/OpenAPI/fixture/追踪与测试，再修改实现。

## 每项功能 Definition of Done

一项 capability/interface 只有同时满足以下条件才算完成：

- 追踪行中的 route、page/component、store、type、endpoint/topic、fixture、test 均已实现且命名一致。
- 六态完整可见，SUCCESS/EMPTY/ERROR 不复用旧内容，错误有 code 与 fieldPath（适用时）。
- canonical/UI 投影只发生在声明 adapter；单位、枚举、ID 与 frame/task ownership 不漂移。
- OPERATOR/ADMIN 的 allow/deny 与 mock 二次校验一致；敏感操作的确认、引用和 last-admin guard 有负例。
- component、store、contract test 通过；核心覆盖率阈值满足；相关路由 E2E 按上述 P1、P2～P7、P8 三阶段在双 viewport 通过。
- 除负向登录场景中 /api/v1/auth/login 返回预期 401/423 时由浏览器产生的对应资源错误外，无其他 console error。白名单必须按具体场景精确匹配状态码，不允许忽略或模糊过滤其他控制台错误。无未处理 promise；所有场景 HTTP 404=0、非回环请求=0，且无网络地图资源、文件/SQLite/进程/加密/导出副作用。
- fixture reset 可重复，相关 ID 引用闭合，结果不依赖系统时间、随机数、机器或 locale。
- 文档与机器合同同步更新；未引入本包非目标中的生产能力。
- 后续代码对非显然业务规则、来源决策、状态转换和安全边界添加必要注释，不注释显而易见语法。

## 发布前证据包

保留类型检查、schema/contract、unit coverage、Supertest/WS、Playwright 双视口、网络请求清单、监听地址、fixture closure 和 source hash 的机器输出。任何失败都必须在发布记录中显示具体测试 ID 与 error code，不得以人工浏览替代自动门禁。

## 可重复只读合同审计命令

在设计包目录执行以下命令；它们不创建文件。当前合同审查先执行前两条和内嵌 Node schema walker；后续按计划安装 AJV 后执行第三条正式 2020-12 校验。具体 Node.js 版本不由本项目固定，命令须在本机可用且依赖兼容的 Node.js 环境执行。

```powershell
node --experimental-strip-types --check .\contracts\domain-models.ts
node -e "const f=require('fs'); JSON.parse(f.readFileSync('.\\contracts\\mock-api.openapi.yaml')); JSON.parse(f.readFileSync('.\\contracts\\deterministic-fixtures.json')); console.log('JSON PASS')"
node -e "const f=require('fs'),Ajv=require('ajv/dist/2020'),a=JSON.parse(f.readFileSync('.\\contracts\\mock-api.openapi.yaml')),d=JSON.parse(f.readFileSync('.\\contracts\\deterministic-fixtures.json')),rw=x=>Array.isArray(x)?x.map(rw):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,k==='$ref'&&typeof v==='string'?v.replace('#/components/schemas/','#/$defs/'):rw(v)])):x,s=rw({$schema:'https://json-schema.org/draft/2020-12/schema',$ref:'#/$defs/DeterministicFixtures',$defs:a.components.schemas}),j=new Ajv({allErrors:true,strict:false}); if(!j.validate(s,d)){console.error(j.errors);process.exit(1)} console.log('FIXTURE SCHEMA PASS')"
```

OpenAPI 静态审计需再枚举 `paths` 下的 `get/post/put/delete/patch`：断言 operationId 唯一；写 operation 的 `requestBody.content.application/json.schema.$ref` 非空且唯一；除 login 外 `parameters` 包含 `#/components/parameters/DemoRole`；每个非 101 的 2xx response 指向独立 envelope，且该 envelope 的 `data.$ref` 不是空 schema。fixture 语义审计按 ID 集合验证 platform/link/sensor/jammer/event/run/report/archive/batch 引用，并断言 frame、link、platform、event、同步证据的有效仿真时刻均为 42。
