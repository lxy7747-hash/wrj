# 01 前端架构

## 系统边界

后续实现采用单机三段结构：Vue SPA 负责交互与展示；本机 Express/WS mock 负责合同模拟；冻结 JSON 夹具是唯一事实源。浏览器只访问同一工作站的 `127.0.0.1`。前端不直接接触文件、SQLite、操作系统进程或 AFSIM；这些能力在本版本只显示输入、输出、状态与拒绝原因。

数据方向固定为：`deterministic-fixtures.json → mock REST/WS → API adapters → Pinia stores → route pages/components`。组件不得直接请求 API，不得跨 store 修改状态，不得从当前时间或随机数计算期望值。

## 分层和依赖规则

| 层 | 后续目录建议 | 职责 | 禁止依赖 |
|---|---|---|---|
| Bootstrap | `src/app` | Router、Pinia、Element Plus、全局错误边界 | 业务页面私有组件 |
| Pages | `src/pages` | 路由编排、读取 store、触发 action | 直接 `fetch`/WebSocket |
| Features | `src/features` | 29 项能力组件、表单、状态卡、对话框 | 其他 feature 内部文件 |
| Stores | `src/stores` | 状态所有权、转换、请求协调、去重 | DOM、Leaflet 实例 |
| Contracts | `src/contracts` | 复制类型合同、AJV schema、API DTO | Vue/Pinia |
| Adapters | `src/adapters` | REST/WS、canonical/UI 投影、错误归一化 | 页面组件 |
| Visualization | `src/visualization` | 离线 Leaflet 图层与图表 view-model | 网络图块、业务写操作 |

依赖仅可向下。所有跨层写操作经 store action；所有后端数据先通过 schema 验证。未知必填字段或版本不兼容时进入 `ERROR`，不可静默补默认值。

全局 reset 是唯一例外编排点但不改变依赖方向：页面只调用 `uiStore.resetAllProjections()`；uiStore 通过各业务 store 的公开 reset/load action 协调关闭 WS、清理计时器、失效确认、调用 reset endpoint、顺序重载和最终 UI 清理。uiStore 不直接修改或复制 canonical 业务 state；失败时九个业务 store 全部回到安全空态，禁止半初始化。

## 信任边界

`X-Demo-Role`、假用户名和二次确认只用于可重复演示，不是安全机制。前端 route guard 提供用户体验，mock RBAC 再执行合同级拒绝；两者都不能被描述为生产授权。错误展示只公开 `code/message/fieldPath/correlationId`，不得泄露秘密、系统绝对路径或命令行。所有后续真实文件、进程、数据库和加密集成都位于本包范围外。

## 状态机

### 能力卡状态

`LOADING → VALIDATING → EXECUTING → SUCCESS | EMPTY | ERROR`。允许 `ERROR → LOADING` 重试、`EMPTY → LOADING` 刷新。请求开始即清除旧错误；校验失败直接 `VALIDATING → ERROR`；无记录必须使用 `EMPTY`，不能伪装成功。每张能力卡同时显示当前状态、最后成功夹具 ID、错误代码/fieldPath 和重试入口。

T-XQ-011、T-XQ-012、T-XQ-013 的固定帧传播损耗、SNR/BER 及链路状态判定证据没有计算任务入口，状态流为 `LOADING → VALIDATING → SUCCESS | EMPTY | ERROR`；不得为凑齐六态显示无来源的 `EXECUTING`。

### 仿真 UI 与 canonical 投影

UI：`IDLE → RUNNING ↔ PAUSED → STOPPED`，`RUNNING|PAUSED → COMPLETED`，任意执行态可进入 `ERROR`；`STOPPED|COMPLETED|ERROR → IDLE` 仅由 reset。canonical 只允许 `IDLE/RUNNING/PAUSED/COMPLETED/ERROR`。adapter 将 UI `STOPPED` 投影为 canonical `IDLE`，UI store 继续通过 `SimulationRun.uiStatus=STOPPED` 保留终止语义；不可把 `STOPPED` 写入 SRS 字段。

### 链路 UI 与 canonical 投影

UI：`UP ↔ DEGRADED ↔ DOWN`；状态改变必须满足连续帧和滞回规则并记录 reason。canonical 只允许 `UP/DOWN`。`DEGRADED` 依据 BER 与阈值投影：`ber < berThreshold` 为 `UP`，否则 `DOWN`；F-00042 中 L-DL-03 明确投影为 `DOWN`。CSV adapter 只能接收投影后的值。

### 二次确认

`CLOSED → AWAITING_CONFIRMATION → CONFIRMED | CANCELLED | EXPIRED | ERROR`。confirmationId 仅用一次；角色变化、reset、重复提交或过期使上下文失效。校验只有警告时，脚本预览/生成前必须取得 `SCENARIO_WARNING_CONTINUE` 确认；官方模板删除、仿真停止等破坏性操作也必须确认。Level III 批次报告、备份恢复、全量配置与受控审计导出还必须在 mock 再校验 ADMIN 和 confirmationId。

### 回放

`EMPTY → LOADING → PAUSED ↔ PLAYING`；`PAUSED|PLAYING → SEEKING → PAUSED`；播放到末尾为 `COMPLETED`；校验失败为 `CORRUPT`，其他失败为 `ERROR`。单帧、倒退和倍速只改变内存游标，不改变 RUN-001 原始快照。

### 批次

`DRAFT → VALIDATING → QUEUED → RUNNING → COMPLETED | PARTIAL_FAILURE | ERROR`；`QUEUED|RUNNING → CANCELLED`。BATCH-001 的冻结夹具直接呈现 `COMPLETED`，12 个 run/report 对必须一一对应；聚合报告只从同一 12 行 registry 计算。

### 配置锁

`UNLOCKED → LOCKING → LOCKED → UNLOCKING → UNLOCKED`，失败进入 `ERROR`。仿真 START 成功前完成加锁；STOP/COMPLETED/ERROR 清理后解锁。锁定期间所有场景写操作返回 `CONFIG_LOCKED`，读取、报告和回放保持可用。

### 仿真控制参数

仿真命令必须覆盖开始、暂停、继续、单步、停止和倍速。`START` 同时携带运行模式：单次交互式、批量参数遍历、参数扫描或历史回放；`SET_SPEED` 携带大于 0 的倍速值。命令的可用性由当前状态、配置校验和单实例约束共同决定，非法组合返回 `INVALID_TRANSITION`，不得静默忽略。

## 确定性与时间

所有响应元信息、事件、KPI、序号和水印时间均来自 fixture，最早时间为 `2026-08-06T08:00:00Z`。requestId 使用固定操作表或单调内存计数，reset 后回到同一值。禁止 `Date.now()`、`Math.random()`、UUID、机器路径、locale 排序或浮点非确定舍入进入快照结果。

## 八项来源决策摘要

完整登记见追踪矩阵：canonical 使用 `scenario`、三 CSV、SRS 五态/SRS 两态；UI 使用六态/三态；通信只回环；场景实体类型区分四类业务信息节点 `REAR_COMMAND_NODE/FORWARD_RELAY_NODE/GROUND_CLUSTER_COMMAND_NODE/AIRBORNE_MISSION_CLUSTER` 与两类支撑实体 `COMMUNICATION_SATELLITE/GROUND_JAMMER_DETECTION_STATION`；普通报告 Level II，批次比较 Level III；五个 SRS 接口是 canonical superset，详细设计稀疏接口仅兼容投影。
