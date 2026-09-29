# 候选 AFSIM 脚本与 CSV 字段映射表

整理日期：2026-09-22。

## 当前权威口径（2026-09-28）

以下按现行 `server/scripts/mission-generator.ts`、包内 `mapping.json` 与 `tests/server/mission-execution.spec.ts` 判定。后文第 1～19 节记录历次候选和历史缺口，出现矛盾时以本节及第 20～21 节的现行实现为准。**写入脚本不等于真实引擎效果已验证**：普通生成请求不运行 mission，`mapping.json.engineValidated` 始终为 `false`；实机验证仅覆盖列明的测试场景，须以对应 `execution.json`、日志和实际 CSV 为证。

| 参数或能力 | 当前分类 | 具体边界与证据 |
|---|---|---|
| 场景开始时刻、时长，平台初始位置、航点路线与卫星轨道模板 | 真实引擎已验证的有限样例 | 生成 `start_date/start_time/end_time`、平台/运动脚本；实机用例核对起始时刻、末时刻、航点位置与卫星高度。`arrivalTime` 没有引擎硬约束，不把配置到达时刻当实测到达时刻。 |
| 微波、数传、卫星、光纤通信设备，业务周期发送，多目标与同目标备选链路，高空/卫星单跳转发 | 真实引擎已验证的有限样例 | 生成设备与消息脚本；实机用例核对收发、两跳转发与目标接收。频率、带宽、功率、速率、天线增益写入设备参数；这些用例不证明物理层质量、BER 或任意组合的性能。优先级在生成期选择主链路，不是运行时质量选路。 |
| 雷达侦测候选、干扰设备、定时启停与距离门控、海况和降雨 | 写入脚本；部分实机样例验证 | 生成 `WSF_RADAR_SENSOR`、干扰 weapon/processor、`global_environment` 等。实机已核对定时启停和部分事件；没有验证所有天气/干扰参数的物理效果、探测概率或真实 SNR/BER。 |
| `scenario.timeStep`、`output.writeInterval`、`environment.simClockSpeed` | 写入脚本，但效果边界受限 | `scenario.timeStep` 映射为 mover `update_interval`；`position.csv` 由 `MOVER_UPDATED` 触发写入。`output.writeInterval` 当前写入业务发送处理器的 `update_interval`，**不独立控制位置采样周期**。位置记录实际间隔须以 AFSIM 2.9.0 的同平台 CSV 实测为准，不能据配置值推断。`clock_rate` 虽写入，在当前 mission `-es` 模式下不改变墙钟倍速。 |
| 场景编号/名称/描述、修订号、配置快照；链路调制、BER 阈值、业务 QoS、冷却时间、ESM 扩展方向/概率 | 仅元数据或项目侧规则 | `input.json`、`mapping.json` 保存身份与配置；部分字段用于生成前选择或校验，但无已确认的同名引擎参数或效果证据。不能把配置误码概率充作测量 BER，也不能把保存成功充作引擎生效。 |
| 链路质量 CSV、链路切换 CSV；激光通信、信道编码及非零增益修正等 | 当前不支持或明确阻断 | 缺完整真实测量时，开启 `output.linkQualityEnabled` 或 `output.linkSwitchEnabled` 即按字段路径拒绝生成；不输出伪造的规范 CSV。其他未核实的设备/参数按生成器字段级校验拒绝，不静默改写成替代模型。 |

参数生效的唯一运行证据链为：保存的场景修订 → 生成包的 `input.json`/`mapping.json` 与脚本 → 本次独占运行的 `execution.json` 和日志 → 实际输出文件。`RUN-001`、`F-00042` 属冻结演示证据，不是后续每次新建运行的固定编号或真实测量。

2026-09-28 本机 AFSIM 2.9.0 隔离实验：同一平台 `AIR-01`、时长 20 秒，分别生成 `(timeStep, writeInterval)=(1,5)、(2,5)、(1,10)` 的独立脚本并运行，三次均正常退出。脚本中两台 mover 的 `update_interval` 分别为 1/2/1 秒，业务发送处理器分别为 5/5/10 秒，位置观察器均为 `MOVER_UPDATED`；三份原始 `position.csv` 中该平台的 `TIME` 均为整数秒 0～20，且 0～19 秒后各有约 0.0008 秒的额外记录，不能视为稳定的 5 秒或 10 秒位置采样。该有限样例也不能推出所有运动模型和场景的统一采样周期。原始脚本、引擎日志、CSV 和逐项摘要保存在本机 Git 忽略的 `output/afsim-sampling-20260928/`，不属于冻结合同。

## 1. 范围与结论

本表只比较字段含义、关联方式和单位，不比较具体高度、位置、时间或其他配置数值，也不要求两套文件属于同一次运行。

- 候选脚本目录：`H:\Project\newWrj\afsim_script_cl\afsim_script`。
- 当前数据目录：`H:\Project\newWrj\output`，仅使用其中的 `position.csv` 和 `scenario_events.csv`，不以脚本目录自带的 output 替代。
- 脚本是输入与行为定义，CSV 是运行输出；字段可以建立映射，不代表能够从 CSV 完整还原脚本。
- 本表是对接参考，不修改或重新冻结现有合同，不将候选脚本认定为正式生成标准。

对应程度：**直接对应**表示身份或含义明确对应；**转换对应**表示需要转换单位或格式；**结果对应**表示只能观察执行结果，不能直接还原输入；**未提供**表示当前实际记录没有可用字段，不能用表头声明或默认值冒充数据。

## 2. 节点与位置

位置输出依据 `observers.txt` 中的 `MoverUpdated`；现行生成脚本使用 `MOVER_UPDATED` 观察器触发写入，字段固定为 `TIME,NAME,LON,LAT,ALT,SPEED,HEADING`。这不是由 `output.writeInterval` 独立定时的位置采样器，实际相邻 `TIME` 间隔须用 AFSIM 2.9.0 实测。节点实例定义主要位于 `comm_platform_INS.txt`，模型定义位于各 `comm_platform_*.txt`。

| 含义 | 脚本来源 | position.csv | scenario_events.csv | 对应程度与处理规则 |
|---|---|---|---|---|
| 节点英文标识 | `platform <名称> <平台类型>`；`aPlatform.Name()` | `NAME` | `platform`；关联事件另用 `source_platform`、`destination_platform` | 直接对应；以英文标识关联，中文名称只用于展示 |
| 节点平台类型 | 平台实例引用的 `platform_type` 名称 | 无 | `PLATFORM_ADDED/INITIALIZED` 的 `type` | 直接对应；不能把其他事件的 `type` 一律当成平台类型 |
| 阵营 | `side` | 无 | 平台事件中的 `side` | 直接对应；不能根据节点名称推断 |
| 仿真时刻 | `TIME_NOW`、事件执行时刻 | `TIME` | 数据行的 `time` | 直接对应，单位秒；界面可格式化为分、秒，不改变原始数值 |
| 经度 | `position` 中的经度；`Longitude()` | `LON` | 具有位置字段的事件中的 `lon` | 转换对应，十进制度；脚本含 E/W 方位时转换为带符号数值 |
| 纬度 | `position` 中的纬度；`Latitude()` | `LAT` | 具有位置字段的事件中的 `lat` | 转换对应，十进制度；脚本含 N/S 方位时转换为带符号数值 |
| 高度 | `altitude`；`Altitude()` | `ALT` | 具有位置字段的事件中的 `alt` | 转换对应，CSV 使用米；脚本公里转换为米 |
| 速度 | `speed`；`Speed()` | `SPEED` | 运动事件中的 `ned_speed` | 转换对应，CSV 使用米/秒；节乘以 `1852 / 3600`，公里/小时除以 `3.6` |
| 航向 | `heading`；`Heading()` | `HEADING`，度 | 适用事件中的 `heading`，弧度 | 转换对应；事件弧度乘以 `180 / π`，不能将两种 CSV 的航向单位混用 |
| 初始位置 | 实例 `position` 或路线起点，并受运动模型初始化影响 | 每个节点首条有效位置记录 | `PLATFORM_INITIALIZED` 的位置字段 | 结果对应；是实际初始化结果，不是输入指令逐字回显 |
| 航点与运动路线 | `route`、`label`、`goto`、`FollowRoute` | 连续位置记录 | 相关运动事件 | 结果对应；不能从采样点完整恢复航点、标签、循环或切换条件 |
| 卫星轨道 | `orbital_state` 等轨道设置 | 卫星位置、速度等结果 | 平台及运动结果 | 结果对应；两个 CSV 没有完整轨道配置字段 |

注意：脚本常按“纬度、经度”书写 `position`，而 position.csv 按“经度、纬度”排列。映射必须按字段，不按出现顺序直接复制。

## 3. 通信设备与通信关联

通信定义主要位于无人机、指挥车、后方平台及卫星模型文件中。设备身份使用 **节点英文标识 + 通信设备编号**，同名设备可以属于不同节点。

| 含义 | 脚本来源 | 事件及 CSV 字段 | 对应程度与处理规则 |
|---|---|---|---|
| 通信设备编号 | `comm <设备编号> <设备类型>` | `COMM_TURNED_ON/OFF.system`；消息事件的 `comm`；关联事件的 `source_comm/destination_comm` | 直接对应；不同事件使用不同列名 |
| 通信设备模型类型 | `comm` 声明中的类型，如 `WSF_RADIO_TRANSCEIVER` | `COMM_TURNED_ON/OFF.system_type` | 直接对应；该事件的 `type` 可能是通用类别 `Comm`，不是设备模型名 |
| 设备启停 | `TurnOn()`、`TurnOff()` 及设备初始化状态 | `COMM_TURNED_ON/OFF`、`time`、`platform`、`system` | 结果对应；记录实际启停时刻，不直接还原触发条件 |
| 关联源端 | 平台通信设备及其网络配置 | `LINK_ADDED_TO_MANAGER.source_platform/source_comm/source_address` | 直接对应节点及设备；地址是运行时标识，不假定为平台编号 |
| 关联目标端 | 平台通信设备及其网络配置 | `LINK_ADDED_TO_MANAGER.destination_platform/destination_comm/destination_address` | 同上 |
| 关联登记时刻 | 通信管理器登记行为 | 关联数据行前两列中的时间、事件类型 | 结果对应；本数据的关联表头省略这两个公共列，解析时需补齐 |
| 网络名称 | `network_name` | 当前关联记录没有直接的同名字段 | 未提供；不能用运行时地址代替网络名称 |
| 通信频率、带宽 | 通信设备 `transmitter/receiver.frequency/bandwidth` | 当前实际通信记录没有完整回显 | 未提供；`COMM_FREQUENCY_CHANGED` 的表头存在不等于当前有该事件数据；也不能借用干扰频率填充通信频率 |
| 通信功率、天线增益、噪声系数 | `power`、`antenna_pattern/peak_gain`、`noise_figure` | 当前实际记录没有完整回显 | 未提供；保留为输入参数 |
| 传输速率、误码概率设置 | `transfer_rate`、`bit_error_probability` | 当前实际记录没有对应配置回显或完整质量时序 | 未提供；不能用消息大小代替传输速率，也不能将配置值当实测 BER |

卫星、微波、数传、光纤等中文分类不是 CSV 统一输出的 `linkType` 字段，需要结合设备编号、设备模型和项目已确认映射展示。登记的通信关联不等于当前消息路径，更不等于链路质量正常。

## 4. 消息与业务

消息行为依据平台脚本中的 `WsfMessage`、`SetType`、`SetSizeInBits`、`SendMessage` 等调用。

| 含义 | 脚本来源 | 事件及 CSV 字段 | 对应程度与处理规则 |
|---|---|---|---|
| 消息类型 | `SetType(...)` | `MESSAGE_TRANSMITTED/RECEIVED.message_type` | 直接对应；不能自动等同于前端业务枚举，需另建明确映射 |
| 单条消息大小 | `SetSizeInBits(...)` | `message_size` | 直接对应，单位 bit；转字节除以 8，转十进制 MB 再除以 1,000,000 |
| 发送节点、设备 | 调用 `SendMessage` 的平台和设备 | `MESSAGE_TRANSMITTED.platform/comm` | 直接对应 |
| 实际接收节点、设备 | 消息到达的接收端 | `MESSAGE_RECEIVED.platform/comm` | 直接对应；不是从发送记录臆测出来的接收结果 |
| 运行时消息标识 | 引擎分配 | `message_serial_number`、`data_tag` | 输出侧字段；不可直接作为用户配置的业务编号，跨跳关联需验证其语义 |
| 消息目标 | `SendMessage` 的目标平台、设备参数 | 当前发送记录没有完整的显式目标字段 | 不能直接回显；不能仅凭登记关联推断实际收发路径 |
| 子类型、附加业务数据 | `SetSubType`、`SetAuxData` | 当前文件未完整回显这些输入 | 未提供；不从 `message_type` 中猜测 |
| 发送周期、条件、转发逻辑 | `execute at_interval_of`、条件分支、消息处理器 | 多条发送、接收记录及其时间 | 结果对应；观察到的间隔不等于完整配置规则 |
| 单报文／单帧信息量 | 当前界面的 `informationDemand[].volumeMb`；脚本消息大小设置 | 单条 `message_size` | 单位可转换，但需确认是否分包；不能把单报文／单帧配置误称为业务总量，统计累计量另需区分重发和转发 |

## 5. 干扰与侦测

主要依据 `comm_platform_JAMMER.txt` 和实例中的设备控制脚本。

| 含义 | 脚本来源 | 事件及 CSV 字段 | 对应程度与处理规则 |
|---|---|---|---|
| 干扰节点编号 | 干扰平台实例名称 | `JAMMING_REQUEST_INITIATED.platform` | 直接对应 |
| 干扰设备编号 | `weapon <编号> WSF_RF_JAMMER` | 干扰请求中的 `weapon`；设备启停中的 `system` | 直接对应；与节点编号组合使用 |
| 干扰设备模型类型 | `weapon` 的模型类型 | `WEAPON_TURNED_ON/OFF.system_type` | 直接对应 |
| 当前干扰模式 | `mode`、`SelectMode` | 干扰请求中的 `current_mode` | 直接对应模式标识；中文名称使用明确映射 |
| 干扰中心频率 | 干扰器 `transmitter.frequency` | 干扰请求中的 `frequency` | 转换对应，事件使用 Hz；转 MHz 除以 1,000,000 |
| 干扰带宽 | 干扰器 `transmitter.bandwidth` | 干扰请求中的 `bandwidth` | 转换对应，事件使用 Hz |
| 干扰目标 | 干扰请求目标 | `target_platform` | 条件对应；当前记录可为空，空值表示未提供目标，不补造目标 |
| 请求开始、设备启停 | 模式选择、启停及触发逻辑 | `JAMMING_REQUEST_INITIATED`、`WEAPON_TURNED_ON/OFF` 与 `time` | 结果对应；设备开启不等于已经发起干扰请求，不能混为同一种状态 |
| 干扰功率 | 干扰器 `transmitter.power` | 当前实际请求记录没有功率字段 | 未提供；不得从频率或带宽推算 |
| 探测范围、扫描设置 | `minimum_range/maximum_range`、`frame_time`、`SetFOV_Range` | 当前实际记录没有完整回显 | 未提供；地图范围需要有另外明确的配置来源 |
| 探测结果、SNR 等 | 传感器或质量计算输出 | 文件声明了 `SENSOR_DETECTION_CHANGED` 等相关列，但当前无相应实际事件记录 | 未提供；仅有表头不能作为真实数据 |

当前文件的 `WEAPON_TURNED_ON/OFF` 表头与数据行存在已知扩展列错位。项目解析器对这些事件只消费可确认字段，不读取 `heading` 起的姿态列；本表不将这些错位列列为可靠映射。

## 6. 时间、环境与输出设置

| 含义 | 脚本来源 | CSV 对应 | 对应程度与处理规则 |
|---|---|---|---|
| 仿真起止日期与时刻 | `start_date/start_time/end_time` | `SIMULATION_STARTING/COMPLETE` 中的 `time/year/month/day/hour/minute/second` | 结果对应；CSV 未声明时区，不能直接追加 UTC 标记或自行认定北京时间 |
| 位置采样机制 | `scenario.timeStep` → 运动器 `update_interval`；`MOVER_UPDATED` 观察器写出位置 | 同一平台相邻位置记录的 `TIME` | 结果对应；`output.writeInterval` 不独立控制该回调，实际记录间隔须以 AFSIM 2.9.0 实测为准 |
| 海况、降雨、云层等 | `global_environment` | 两个 CSV 当前没有完整配置字段 | 未提供；仍以输入配置为准 |
| 输出文件位置 | `csv_event_output.file`、观察器 `mOutputFile` | 文件本身 | CSV 数据行不保存完整文件路径；生成与读取端需要另行约定 |
| 实际链路质量 | 引擎或质量计算模块 | 当前两个 CSV 没有可用的完整 SNR/BER 时序 | 未提供；设备开启、消息收到、登记关联均不能替代 SNR/BER |

## 7. 对接使用规则

1. 保留原始英文编号；平台按编号关联，设备按“平台编号 + 设备编号”关联，中文名称不作为关联键。
2. 按事件类型读取各自的字段声明；不能对整个 scenario_events.csv 套用一张固定列顺序表。
3. 统一单位后再映射，重点防止经纬度顺序、度/弧度、Hz/MHz、米/公里、bit/Byte 混用。
4. 区分输入配置、运行状态和统计结果；没有实际记录的字段显示“暂无数据”，不以示例值补齐。
5. 本表只证明字段映射可建立，不证明当前 CSV 由这份候选脚本生成，不涉及具体参数值一致性。

## 8. 核对来源

- [场景入口 comm_SimSetup.txt](H:/Project/newWrj/afsim_script_cl/afsim_script/comm_SimSetup.txt)
- [节点实例 comm_platform_INS.txt](H:/Project/newWrj/afsim_script_cl/afsim_script/comm_platform_INS.txt)
- [无人机模型及消息行为](H:/Project/newWrj/afsim_script_cl/afsim_script/comm_platform_MISSION_UAV.txt)
- [干扰设备模型](H:/Project/newWrj/afsim_script_cl/afsim_script/comm_platform_JAMMER.txt)
- [公共参数定义](H:/Project/newWrj/afsim_script_cl/afsim_script/comm_PerDefinition.txt)
- [位置输出定义 observers.txt](H:/Project/newWrj/afsim_script_cl/afsim_script/observers.txt)
- [当前 position.csv](H:/Project/newWrj/output/position.csv)
- [当前 scenario_events.csv](H:/Project/newWrj/output/scenario_events.csv)
- [现有事件解析器](../src/features/data-exchange/afsim-event-log.ts)：辅助核实单位、公共列补齐及已知声明错位，不以解析器派生字段冒充源 CSV 字段。

## 9. 当前场景配置加入后的三方对照

本节核对当前 `ScenarioConfig`、`ScenarioDraft.uiExtensions`、页面绑定和 `buildPreview()`，不修改这些实现。下表中的字段路径默认相对 `draft.config`；UI 扩展明确以 `draft.uiExtensions` 开头。

“有字段可转换”仅指数据含义或单位有对应基础，**不表示当前已生成 mission 可执行语法**。现有生成器输出自定义预览语句，落盘时仍标注“Mock 脚本预览，未经真实 AFSIM 运行验证”；当前预检检查预览结构，不是引擎语法验证。

> 注意：本节各表的“当前生成器处理”列是 2026-09-22 的核对快照，之后生成器已按第 14～17 节多次改写。某个字段现在是否已接通，请以第 17 节为准；本节保留原样，用于记录当时的缺口判断。

### 9.1 场景基础与环境

| 当前配置字段／界面含义 | 候选脚本对应位置 | CSV 输出对应 | 当前生成器处理 | 对接判断 |
|---|---|---|---|---|
| `scenario.id/name/description`：场景编号、名称、描述 | `simulation_name` 可承载名称；编号、描述需保留元数据 | 当前无可靠的场景编号／名称回显 | 输出编号、名称，未输出描述 | 不用为适配 CSV 删除这些管理字段；运行结果与场景绑定需另有记录 |
| `scenario.startTime`：开始时间，界面按 UTC+8 编辑、配置存 UTC | `start_date/start_time` | 仿真开始、结束事件的日期字段 | 原样输出 ISO 字符串 | 有字段可转换；脚本日期时区口径仍须确认，不能直接丢弃时区 |
| `scenario.duration`：界面分钟、配置秒 | `end_time` | `SIMULATION_COMPLETE.time` | 输出 `duration ...s` | 有字段可转换；改为真实脚本的结束时间规则，不改界面单位 |
| `scenario.timeStep`：时间步长 | 当前生成器映射为 mover `update_interval` | 位置和事件时间间隔仅为结果 | 历史候选曾写 `time_step`；现行生成器写 mover `update_interval` | 不能将所有运动器、传感器、消息周期统一替换成这个值，也不能据此直接宣称 position.csv 的实测记录间隔 |
| `scenario.environment.simClockSpeed`：时钟倍速 | `clock_rate` | 不直接回显 | 未输出 | 已有字段但生成遗漏；具备候选映射，待执行语义验证 |
| `scenario.environment.seaState/rainRateMmPerHour` | `global_environment.sea_state/rain_rate` | 当前无完整回显 | 输出到自定义 `environment` 行 | 有字段可转换；需生成真实环境区段和单位 |
| `scenario.environment.temperatureC/humidityPercent/rainLossDbPerKm/multipathEnabled` | 候选脚本未提供同义逐项赋值规则；传播模型与这些值不能简单画等号 | 当前无完整回显 | 输出到自定义 `environment` 行 | 输入已有，物理模型绑定待确认，不能声称已生效 |
| `scenario.environment.rainCloudAttenuation`：云雨档位 | 候选脚本使用雨强、云高、液态水密度等物理参数 | 无对应配置回显 | 未输出 | 档位到物理参数没有已确认换算表，不自行补数值 |
| `scenario.environment.transmissionDistance`：海峡宽度 | 未找到明确对应参数 | 无对应字段；位置计算的节点间距离不是海峡宽度 | 未输出 | 保留配置，不误映射成通信距离或探测范围 |

### 9.2 节点、卫星、编队与航点

| 当前配置字段／界面含义 | 候选脚本对应位置 | CSV 输出对应 | 当前生成器处理 | 对接判断 |
|---|---|---|---|---|
| `platforms[].id`：节点编号 | `platform` 实例名称及脚本中的平台引用 | `NAME/platform/source_platform/destination_platform` | 输出平台编号 | 可以作为统一英文关联键；所有设备、消息和脚本引用须同步生成，不能遗留示例节点名 |
| `platforms[].name`：中文展示名称 | 可另存展示元数据，不替代实例名称 | CSV 未提供中文名称 | 未输出 | 继续由项目保存中文映射，不要求 CSV 同名 |
| `platforms[].type/category`：实体类型、部署域 | `platform_type` 与运动模型；部署域不是实例的同名字段 | 平台事件 `type`；位置文件无类型 | 原样输出前端枚举与 `domain` | 需显式模型映射，不直接把前端枚举当 AFSIM 模型名；见第 10 节 |
| `platforms[].satelliteType`：天通／神通 | `TIAN_TONG_SAT/SHEN_TONG_SAT` | 平台事件 `type` | 未输出平台子类型 | 字段已有、模型选择未接通；仅保留 `COMMUNICATION_SATELLITE` 会丢失子类型语义 |
| `platforms[].initialPosition.longitude/latitude/altitude` | `position/altitude` 或路线起点 | `LON/LAT/ALT` 和初始化事件位置 | 输出经度、纬度、高度三元组 | 有字段可转换，注意脚本纬度在前；不改存储字段名 |
| `platforms[].waypoints[].longitude/latitude/altitude/speed` | `route` 中的点位、高度、速度 | 位置序列及速度 | 输出自定义 `waypoint` 行 | 有字段可转换；正式生成路线并处理初始位置与首航点关系 |
| `platforms[].waypoints[].arrivalTime`：到达时间 | 候选路线示例没有同名到达时间约束 | 位置 `TIME` 是实际采样时刻 | 输出 `arrival` | 需明确速度与到达时间冲突时的控制规则，不能把预期到达时间冒充实际采样时间 |
| 批量数量、编队原点与间距 | 多个 `platform` 实例及其坐标 | 多个节点的独立记录 | 页面已展开为多个 `platforms[]`，生成器逐项遍历 | 数量、间距不是单独持久化的编队合同；不得再展开一次，也不自动套用示例中继机／任务机角色 |
| `platforms[].linkIds/sensorIds/jammerIds` | 平台内部设备及相关引用 | 设备／关联事件中的节点、设备身份 | 不直接生成这些反向关联数组 | 属于项目内引用关系，生成时用来检查归属，不要求输出同名数组 |
| 当前无平台 `side`、独立初始 `heading` 字段 | `side/heading` | 事件 `side`、位置 `HEADING` 等 | 无对应输出 | 若要求可配置则存在输入缺口；也可另行确认模板规则，不能从中文名称或位置自行推断 |

### 9.3 业务与链路

| 当前配置字段／界面含义 | 候选脚本对应位置 | CSV 输出对应 | 当前生成器处理 | 对接判断 |
|---|---|---|---|---|
| `links[].id`：链路编号 | 需映射为两个端点的通信设备或设备引用 | CSV 没有与前端链路编号天然相同的字段 | 用链路编号生成一条自定义 `comm` | 一个链路 ID 不能直接等同于任一端的设备 ID |
| `links[].sourcePlatformId/targetPlatformId` | 通信设备所属平台及消息目标 | 关联的源／目标平台字段 | 输出平台级源、目标 | 平台端点已有；缺少显式 `sourceCommId/targetCommId`，需确定稳定设备分配规则 |
| `links[].type`：卫星／微波／数传／激光 | 各模型的 `sat_link*`、`microwave_link`、C/L 波段设备等 | 设备编号、设备类型；无统一 `linkType` | 原样输出枚举 | 数传需要区分 C/L 波段和上下行设备；激光不能当光纤，当前 `LinkType` 无 `FIBER` |
| `links[].frequency/bandwidth/txPower/dataRate` | `transmitter/receiver` 的频率、带宽，发射功率，`transfer_rate` | 当前通信记录未完整回显；干扰频率不属于通信设备 | 已输出在自定义 `comm` 行 | 字段和单位已有；需转换为设备区段，并明确两端发射／接收参数如何配置 |
| `links[].antennaGain.tx/rx` | 天线方向图及发射／接收端绑定 | 当前无完整回显 | 仅 JSON 注释 | 生成规则未接通；不能只留在注释中 |
| `links[].antennaGainCorrectionDb/antiJammingGainDb/spatialIsolationDb/modulation/coding` | 候选脚本未建立这些前端参数到引擎模型的完整映射 | 当前无完整回显 | 仅 JSON 注释 | 字段已有但规则待确认；`coding=null` 与明确 `UNCODED` 继续区分 |
| `links[].berThreshold` | 需真实判定／切换逻辑读取 | 当前无 BER 时序 | 仅 JSON 注释 | 不等于脚本固定 `bit_error_probability`；阈值、配置误码概率和实测 BER 不可互换 |
| `links[].direction`、`informationDemand[].direction` | 发送方、接收方和对应设备选择 | 消息发送／接收事件 | 链路、业务 JSON 注释 | 方向字段已有；目前页面从链路同步业务方向和端点，不是 CSV 字段直接复制 |
| `links[].enabled`、`linkSettings.enabledSatellites`、`links[].relayPlatformId` | 设备及卫星选择、路由／转发行为 | 启停与实际消息事件 | 已用于预览过滤链路及关联业务；中继信息保留在注释 | 保留已确认过滤语义；过滤预览不等于已实现引擎设备启停或卫星转发 |
| `linkSettings.priority/switchCooldownS` | 真实选路／切换处理器 | 当前事件没有完整策略配置回显 | 仅 JSON 注释 | 不能直接照搬候选脚本的定时启停来代表优先级、冷却生效 |
| `informationDemand[].informationType` | `SetType`、业务处理分支 | `message_type` | 输出业务中文类型 | 需确认中文业务到消息类型的映射；不能将“视频”直接当 `RECON_DATA` |
| `informationDemand[].volumeMb`：单报文／单帧信息量 | `SetSizeInBits` | `message_size`，bit | 输出 `volume ...MB` | 未分包时可按 MB × 1,000,000 × 8 转换；需确认整数位数及分包规则，不是业务累计量 |
| `informationDemand[].frequencyHz`：次／秒或帧／秒 | 消息周期执行逻辑 | 发送事件时间序列 | 输出 `frequency ...Hz` | 周期发送候选转换为 `1 / frequencyHz` 秒；频次为零及首次发送时机需明确，不能直接除零 |
| `informationDemand[].sourcePlatformId/destinationPlatformIds/linkId/enabled` | 发送平台、目标设备、消息启用条件 | 收发事件和登记关联 | 输出平台级目的地；按自身开关及关联链路过滤 | 保留现有联动；目标设备解析、多个目的地的消息发送规则未接通 |
| `informationDemand[].priority/maxLatencyMs/minDataRateMbps` | 调度、排队、时延约束等实现 | 当前没有完整配置回显 | 输出自定义字段 | 不能把这些约束仅写入 TXT 就视为引擎执行；最低业务速率也不等于设备 `transfer_rate` |

### 9.4 干扰与侦测

| 当前配置字段／界面含义 | 候选脚本对应位置 | CSV 输出对应 | 当前生成器处理 | 对接判断 |
|---|---|---|---|---|
| `jammers[].id/platformId/type` | 平台内 `weapon` 编号和 `mode` | `platform/weapon/current_mode` | 输出自定义 `jammer` 行 | 编号、归属可对应；`BARRAGE/SPOT/SWEEP` 到模式标识需显式绑定，不原样作为引擎类型 |
| `jammers[].defaultPower/frequency/bandwidth` | 干扰发射机参数 | 请求的 `frequency/bandwidth`；当前无功率回显 | 输出自定义参数 | 字段已有、需生成真实设备区段；MHz 转输出 Hz，不伪造功率测量值 |
| `jammingEnabled`、`draft.uiExtensions.jammers[].enabled` | 总体和单设备启用规则 | 设备启停及干扰请求事件 | 已决定是否输出预览干扰器行 | 过滤规则已有，真实启用／停用机制尚未生成 |
| `jammers[].autoDetect/detectionRange/triggerTimeS` | 探测触发、距离检查、定时执行 | 触发后的事件，仅部分含目标 | 范围写自定义行；自动探测、触发时间仅 JSON 注释 | 自动探测与定时触发的优先关系待确认；范围不能直接代替干扰有效距离 |
| `draft.uiExtensions.jammers[].direction/duration` | 方向控制、持续时间与停止逻辑 | 当前无完整配置回显 | 仅 JSON 注释 | 字段已有但执行规则未接通，不用固定示例启停时间替代 |
| `sensors[].id/platformId/frequencyRange/detectionRange` | 平台内传感器配置 | 有实际侦测事件时可关联设备和目标；当前无相应记录 | 输出自定义 `sensor` 行 | 候选脚本使用 `WSF_RADAR_SENSOR`，不能直接当成前端 ESM；频率范围也不等于单发射频率 |
| `draft.uiExtensions.sensors[].type/direction/probability/enabled` | 侦测模型、方向、概率和启用设置 | 当前无完整结果 | 未读取这些扩展 | ESM 模型及参数规则待确认；不能把概率直接当作每次检测结果 |

### 9.5 输出与结果身份

| 当前配置字段／界面含义 | 候选脚本对应位置 | CSV 输出对应 | 当前生成器处理 | 对接判断 |
|---|---|---|---|---|
| `output.directory` | 事件 `file`、观察器 `mOutputFile` | 文件所在位置，不在数据列中 | 输出自定义路径字段 | 需生成统一运行输出目录；不是预览 TXT 落盘目录，不能混用 |
| `output.writeInterval` | 现行生成器的业务发送处理器 `update_interval`；非位置观察器周期 | 位置记录时间间隔仅为结果 | 写入业务处理器 `update_interval`，未给 `MOVER_UPDATED` 观察器设置独立周期 | 当前不独立控制 position.csv 位置采样；实际间隔须按同平台 `TIME` 实测，不能把它当作所有引擎事件的发生间隔 |
| `output.eventsEnabled` | `csv_event_output` 事件开关 | 实际存在的事件类型 | 输出自定义布尔值 | 已有开关、真实事件配置未生成 |
| `output.linkQualityEnabled/linkSwitchEnabled` | 需要明确的质量及切换证据输出 | 当前两个 CSV 不提供完整质量与决策证据 | 输出自定义布尔值 | 不能用设备启停代替质量判定或完整切换决策 |
| `schemaVersion`、草稿 `revision/locked/officialLibraryChanged`、确认与脚本编号 | 应用管理元数据 | 当前 CSV 未携带 | 版本、修订部分写入预览和文件头 | 不要求用户为 CSV 补填；正式运行需另建场景修订与产物绑定，不伪造输出中的场景／运行编号 |

## 10. 缺口与待确认规则

以下不是自动扩展界面的清单。应先确认哪些由稳定模板提供，哪些确实需要用户配置。

| 缺口 | 已知现状 | 最小处理方向，尚未实施 |
|---|---|---|
| 平台模型映射 | 前端业务类型与引擎模型名称不同 | 候选关系：`REAR_COMMAND_NODE → REAR_COMM_PLATFORM`、`GROUND_CLUSTER_COMMAND_NODE → COMMAND_VEHICLE_PLATFORM`、`AIRBORNE_MISSION_CLUSTER → MISSION_UAV_PLATFORM`；须由脚本提供方确认，不作为冻结映射 |
| 中继角色 | 前端有 `FORWARD_RELAY_NODE`；候选脚本把一架 `MISSION_UAV_PLATFORM` 用作中继 | 不能直接合并两种业务类型；需明确中继模型及行为来源 |
| 卫星及干扰模型 | 已有卫星子类型和两类干扰平台 | 天通／神通及地面／机载可建立显式候选模型映射；不复制示例轨道、位置、设备编号作为通用默认值 |
| 通信设备身份及共享 | 当前链路主要引用平台，没有两端设备字段 | 先约定设备编号、C/L 波段上下行选择及设备复用规则；例如同平台多条链路参数不同时，不能全部写进一个同名设备 |
| 光纤与激光 | CSV 有 `fiber_link`，前端只有 `LASER` 而无 `FIBER` | 两者不能混用；若要配置光纤，须另行授权扩展类型与合同 |
| 阵营、航向、轨道与射频模板参数 | 场景未提供所有候选脚本参数 | 分清用户可配项与经确认的模板参数；缺字段不等于都要新增表单 |
| 天线、噪声、极化与云层参数 | 前端没有完整对应输入，候选脚本包含部分固定定义 | 明确模板来源和适用模型，不自行制造所谓通用物理默认值 |
| 业务、干扰和侦测执行规则 | 多个输入仅成为预览字段、注释或完全未输出 | 先确认消息、分包、周期、触发及 ESM 模型规则，再生成执行逻辑；不照搬示例剧情 |
| 引擎版本与依赖 | 候选入口依赖多个 include 文件，现有预览 TXT 不具备同样依赖结构 | 确认当前 mission 对应的正式脚本版本，生成时包含必要依赖并验证引用闭合 |

只属于输出、无需加入用户输入表单的字段包括：运行时地址、消息序号、实际事件发生时刻、实际位置采样、实际检测及链路质量结果。平台英文编号、中文名称和输入配置仍由项目正常保存，不要求逐字改成 CSV 列名。

## 11. 建议实施顺序与验证边界

1. 先确认候选脚本版本、平台模型和通信设备映射，以及哪些模板参数可复用；本表不替代这些确认。
2. 第一批转换已有明确输入：平台编号、模型选择、位置／路线、频率、带宽、功率、设备速率和独立输出目录。暂不新增 UI 字段。
3. 第二批处理有规则缺口的业务发送、启停、干扰、侦测和选路配置；未接通的参数明确报告，不以 JSON 注释冒充生效。
4. 经授权在独立目录用最小场景验证：生成脚本及依赖 → 当前 mission 实际执行 → 本次 CSV 可解析 → 编号、设备和单位闭合。不得覆盖现有 output 数据。
5. 自动化应分别验证生成文本规则、引用闭合和真实运行结果；前端现有预览预检通过不能替代 mission 执行验证。

本轮完成的是三方对照与生成缺口核对，没有运行 mission、实现生成器、修改界面或冻结合同，也没有新增未经确认的功能。

## 12. 本轮代码核对来源

- [场景领域字段](../src/contracts/domain-models.ts)：ScenarioConfig、Platform、Link、InformationDemand、Jammer、Sensor 和 UI 扩展。
- [场景页面](../src/pages/scenarios/scenarios.vue)：界面绑定、批量实例展开、关联业务同步。
- [平台编辑器](../src/components/scenarios/PlatformEditorDialog.vue)：类型、卫星子类型、编队及航点输入。
- [链路编辑器](../src/components/scenarios/LinkEditorDialog.vue)与[业务编辑器](../src/components/scenarios/BusinessEditorDialog.vue)：参数单位、单报文／单帧语义。
- [链路启停规则](../src/features/scenarios/link-settings.ts)：链路及卫星参与过滤。
- [当前预览生成器](../server/scripts/projection.ts)：实际读取和输出的字段，以及预检范围。
- [TXT 写入器](../server/local/script-file.ts)与[本机服务配置](../server/local.ts)：TXT 写入行为及独立目录，不等同于仿真输出或引擎执行。

## 13. 平台与设备映射核实结果及实施选择

本节将第 10 节的缺口收敛成可讨论的映射清单。模型名称和设备清单已从候选脚本核实；设备分配已由用户确认，其余业务适用性及建议仍待确认。已确认设计不等于生成器已经实现。

### 13.1 平台候选映射

| 场景配置 | 候选模型 | 确认边界 |
|---|---|---|
| 后方指挥节点 `REAR_COMMAND_NODE` | `REAR_COMM_PLATFORM` | 候选模型是后方通信平台；需确认是否承载本项目“后方指挥”角色，不仅按名字相近认定 |
| 地面无人集群指挥车 `GROUND_CLUSTER_COMMAND_NODE` | `COMMAND_VEHICLE_PLATFORM` | 可建立候选映射；不复制其中硬编码的无人机名称、消息内容和定时剧情 |
| 空中无人作业集群 `AIRBORNE_MISSION_CLUSTER` | `MISSION_UAV_PLATFORM` | 当前界面批量操作已经展开实体；每条平台记录对应一个实例，不再次扩展数量 |
| 高空前出中继 `FORWARD_RELAY_NODE` | 无独立对应模型 | 脚本按实例名将普通无人机设为中继，不等于已有可直接复用的高空中继模型 |
| 通信卫星 + `TIANTONG` | `TIAN_TONG_SAT` | 子类型映射明确；轨道与转发配置仍须确认，不能只换类型名 |
| 通信卫星 + `SHENTONG` | `SHEN_TONG_SAT` | 同上；模型自带消息处理，不代表适用于任意新场景 |
| 地面干扰节点 `GROUND_JAMMER_DETECTION_STATION` | `GROUND_JAMMER_STATION` | 平台映射可建立；前端每台干扰设备另建对应武器实例，不固定为只有一台示例设备 |
| 机载干扰平台 `AIRBORNE_JAMMER_PLATFORM` | `AIRBORNE_JAMMER_PLATFORM` | 名称相同仍需按配置生成设备；不自动执行示例干扰条件 |

### 13.2 已核实的设备清单

| 候选平台模型 | 脚本已有通信设备编号 |
|---|---|
| `REAR_COMM_PLATFORM` | `sat_link_a`、`sat_link_b`、`microwave_link`、`fiber_link` |
| `COMMAND_VEHICLE_PLATFORM` | `c_band_uplink`、`c_band_downlink`、`l_band_uplink`、`l_band_downlink`、`fiber_link` |
| `MISSION_UAV_PLATFORM` | `sat_link`、`microwave_link`、`c_band_uplink`、`c_band_downlink`、`l_band_uplink`、`l_band_downlink` |
| `TIAN_TONG_SAT`、`SHEN_TONG_SAT` | 各自的 `sat_link` |
| 两类干扰平台 | 这两个候选模型中未声明 `comm` 设备，不能替它们臆造通信能力 |

重要区别：这份清单说明模板里有什么，不表示当前任意平台间链路都可以直接绑定。场景校验允许的端点组合，可能超过这些候选模型现有设备组合。

- `sat_link_a/b` 的声明未给出天通／神通绑定，不按后缀自动分配卫星。
- `DATALINK + FORWARD/REVERSE` 仍不足以唯一选择 C 或 L 波段；方向也不代表自动交换用户选择的源、目标。
- `fiber_link` 不是 `LASER`；候选模型清单没有可直接替代光纤的激光设备。
- 设备分配已确认采用每条链路独立设备，避免不同链路覆盖同一设备的参数；不沿用候选模板中的跨链路共享设备假设。

### 13.3 选择及确认状态

1. **高空中继**：建议后续复用无人机模型中适用的运动／通信基础，单独生成中继角色，保留界面已有位置和航点限制，不复制任务机剧情。需要确认该角色方案及实际中继处理逻辑；未确认前不声明该类型已支持真实导出。
2. **设备分配，已确认**：用户明确选择“每条链路生成独立通信设备”。同一节点参与多条配置链路时，为各链路生成独立设备，不共享设备编号、参数或启停状态；无需新增设备选择表单。该决定明确采用独立设备语义，不复现多个链路竞争同一台设备的资源限制。
3. **本批支持范围**：建议先接入已确认的平台／设备组合；C/L 波段选择、卫星 A/B 绑定、光纤、激光和 ESM 等未确认部分，真实导出时给出明确字段错误，保留草稿保存与现有展示，不静默跳过，不显示“全部生成成功”。该建议不代表这些能力被删除或永久不做。

下一次实施应以已确认选择为边界。未确认模型与设备关系前，本轮不修改生成器、不将候选规则写入冻结合同，也不运行 mission 验证。

### 13.4 独立设备的已确认边界

- 直连链路的源、目标节点分别拥有服务于该链路的端点设备；另一条链路即使端点相同，也不复用这组设备。
- 节点编号和链路编号继续保留；设备由生成器分配，并保留“链路 → 平台及设备”的对应关系。编号格式、引擎字符限制和碰撞处理属于后续实现，不在此伪称已完成。
- 修改某条链路的设备参数或关闭该链路，不覆盖其他链路设备的参数或启停状态；节点级、场景级操作仍按其明确作用范围处理。
- 设备仍属于现有节点，不增加地图节点，不自动新增装备参数库记录，也不要求操作员维护设备表单。
- 独立设备不代表无干扰、链路必通或质量固定，也不自动构成中继转发。显式中继卫星涉及几跳、各跳设备及消息转发规则仍需单独确定，不从一条端到端链路臆造路径。
- 本次只记录已确认规则；高空中继模型、数传频段／设备选择和其他待确认事项不因本次选择而自动获准。

## 14. 第一版候选生成器（2026-09-22）

第 9～13 节保留前期核对和决策记录。本节记录后续实际实现，不把候选脚本当作已通过引擎验收的正式模型。

- 现有保存、预览、确认和本机 TXT 接口保持原入口；本机写入器从服务端已保存的草稿生成验证包，客户端不能指定文件内容或路径。纯 Mock 仍不写文件。
- 范围：无航点的后方指挥节点／空中无人作业集群，以及不含中继的微波设备。按输入写入平台英文编号、初始坐标、高度、仿真时长、频率 MHz、带宽 MHz、功率 W、设备速率 Mbps、天线增益 dB；位置采样回调沿用候选观察器的七列字段。
- 每条参与链路各生成源、目标设备和独立网络；标点采用无损编码，不把不同链路编号替换成同一个名字。停用链路及其关联业务不参与，不删除配置。设备独立不代表没有无线干扰或已经连通。
- 输出在 `frontend/output/scripts/script-*/` 独占目录：`mission.txt` 入口、`platforms.txt`、`observers.txt`、`mapping.json`、`input.json`、`README.txt`，并保留原 Mock 预览 TXT。依赖不引用候选脚本所在的本机绝对路径。仿真输出预留在本包 `output/`，不覆盖现有运行 CSV。
- 本批**没有完整业务仿真能力**。启用的业务发送、干扰／侦测设备、航点、其他平台／链路类型、中继、编码和未接通的增益修正会阻断生成，返回 422 和字段路径；场景保存仍已完成。为了生成包，不应删除真实业务配置。
- `mapping.json` 明确 `engineValidated: false`。调制、BER 阈值、天气、开始日期／时区、timeStep、时钟倍速和选路优先级仅留在输入快照中，没有映射为引擎行为。天线采用候选全向图形，未填充未知的极化／噪声／衰减参数，不能用此包评估链路质量。
- 未运行 mission，未生成仿真 CSV，未重启常驻服务，未修改冻结合同；候选模型适用性、完整参数映射和引擎实际接受性仍待验证。下一步应先审阅最小包，再经授权用独立输出目录运行 mission，而不是宣称完整生成器已完成。

本轮验证：生成器／文件接口／原脚本投影 3 文件 **24/24**；场景组件／Store 2 文件 **133/133**；`npm run typecheck`、`npm run validate:contracts`、`npm run build` 通过。未运行全量 P0、覆盖率或浏览器 E2E；以上不替代 mission 实机验收。

## 15. 生成包 → mission 实际执行（2026-09-23）

- 保存仍只持久化场景并生成 TXT，不自动执行。选用场景后点击态势页“开始”，本机 Node 通过既有 START 接口读取已保存修订，复用同一生成器创建独占执行包，再运行 `mission.exe -es mission.txt`。不执行浏览器传入的路径，也不复用可能已手工改写的旧 TXT。
- 默认可执行文件为 `frontend` 同级 `Release/Release/mission.exe`；可在 `.env.local` 用绝对路径 `MISSION_EXECUTABLE_PATH` 覆盖。工作目录为 `frontend/output/mission-runs/mission-*/`，入口、依赖、输入快照、`mission-console.log`、`execution.json` 和本次 `output/` 均在此目录。原 `newWrj/output` 不被覆盖。
- 使用实际 PID、启动/结束时间和退出码。退出码 0 后完成并解锁，启动或执行失败显示错误并解锁；停止需要原一次性确认且仅结束本次拥有的进程。启动/运行期间拒绝全局重置和备份恢复，正常关闭服务时清理拥有的进程。
- `-es` 为非实时事件推进，不按前端倍速运行。本批没有真实暂停/继续/倍速接口，这些命令明确拒绝，不用 Mock 状态冒充执行。所选场景页面轮询完整运行状态，离页/登出停止轮询；新 CSV 暂不自动接入地图、指标或历史回放。
- 支持范围仍为第 14 节的基础节点与微波设备，不扩展业务发包、卫星、中继、干扰、侦测或航点。`mapping.json` 的 `engineValidated: false` 是生成时标记；每次执行以 `execution.json` 和日志为证，不能推导全部参数、链路质量或完整业务已验收。
- 实测本机 mission（WSF 2.9.0）：经保存配置 → 创建运行 → START 的完整 API 链路，独立 3 秒基础场景返回退出码 **0**，日志包含 `Simulation complete`，真实生成七列 `position.csv` 及含设备启用记录的 `scenario_events.csv`，并完成解锁。使用内存场景和临时目录，不操作用户数据库。可复验：设置 `MISSION_SMOKE_EXECUTABLE` 后运行 `tests/server/mission-execution.spec.ts`；不设置时该原生引擎用例显式跳过，其他测试不依赖本机 AFSIM 安装。

本轮验证：包含真实引擎的聚焦回归 **9 文件 177/177**；全量服务端 **30 文件、396 通过、1 跳过**（默认跳过的原生引擎用例已在聚焦回归中实际通过）；类型检查、合同审计、生产构建、`git diff --check` 通过。未运行全量 P0、覆盖率及浏览器 E2E，不沿用历史数字。

## 16. 业务发送与真实接收（2026-09-23）

本节补充第 14～15 节尚未接通的业务发送，不改变其中其他模型边界。

- 按用户确认：启用且频次大于零的业务从仿真起点发送，随后按 `1/频次` 周期发送；结束时刻不再新发，频次为零不发送。报文大小按十进制 `MB × 8,000,000` 四舍五入为整数 bit，不分包；保留配置的信息类型和业务编号，不把“视频”替换成示例类型。
- 根据关联链路、配置源/目标和方向绑定独立通信设备，不因返向标签自动交换端点。旧版未关联业务仅在每个目的地都有唯一匹配的已启用直连链路时生成；歧义或缺少路径明确拒绝，不臆造路由。停用业务、停用链路不发包，配置仍保留。
- 通过 `WSF_SCRIPT_PROCESSOR` 调用真实 `WsfMessage` / `SendMessage`。起点采用同一仿真时刻的排队调度，让所有端点完成网络登记，不增加任意启动延时。发送请求不等于成功送达，接收结果以引擎 `MESSAGE_RECEIVED` 为准。
- 本机实测 `SetSizeInBits` 的整数上限为 **2,147,483,647 bit**，超过会被引擎截断；生成器改为显式拒绝，避免静默改变报文。单次预计发送请求另设 **100 万次**执行资源上限，超过时定位频次字段；不是修改冻结的业务频次合同。
- 优先级、最大时延、最低业务速率保留在输入和映射记录，明确 `engineEnforced: false`；目前没有已确认的引擎调度保障，不改写设备速率或伪造时延来满足要求。
- 发现 mission 脚本异常可能仍退出 0：运行器同时检查日志错误与 `Simulation complete`，不再仅凭退出码宣称成功。
- 原生引擎回归覆盖前向、返向和零频次；短场景实际生成预期数量及时间的发送/接收事件，验证中文信息类型、位数和端点设备。完整 API 回归覆盖保存 → 确认 → TXT → START → mission 完成，保存包与实际执行脚本一致。使用内存场景和临时目录，不修改用户数据库或原 CSV。
- 剩余范围：卫星、中继、其他平台/链路、干扰、侦测和航点仍未接通；新运行 CSV 暂不自动接入地图/历史回放。不能将本次直连业务验证称为完整场景或链路质量验收。

本轮实际验证：含原生 mission 的聚焦回归 **5 文件 50/50**；设置 `MISSION_SMOKE_EXECUTABLE` 后全量 `npm run test:server` **30 文件 410/410，无跳过**；`npm run typecheck`、`npm run validate:contracts`、`git diff --check` 通过。本轮未运行全量 P0、覆盖率、生产构建和浏览器 E2E；未暂存、提交或推送。

## 17. 平台、卫星、航点、干扰启停与环境参数（2026-09-23）

本节承接第 16 节，只接通第 9～13 节已有明确规则的字段；不新增 UI 字段，不修改冻结合同，也不把未确认项换成相近模型。

### 17.1 本批接通

- **平台模型**：新增 `GROUND_CLUSTER_COMMAND_NODE → COMMAND_VEHICLE_PLATFORM`（第 13.1 节候选映射），运动模型 `WSF_GROUND_MOVER`。它与既有后方指挥节点、空中无人作业集群及两类干扰平台共用同一套平台／设备生成规则，不复制候选模型中硬编码的无人机名称、消息内容和定时剧情。
- **通信卫星**：`COMMUNICATION_SATELLITE` 按 `satelliteType` 选择候选模型——`TIANTONG → TIAN_TONG_SAT`（GEO，`semi_major_axis 42164 km`）、`SHENTONG → SHEN_TONG_SAT`（LEO，`7000 km`／`inclination 60 deg`／`raan 80 deg`），运动模型 `WSF_SPACE_MOVER`，并写入候选模型的 `orbital_state`；历元取配置的仿真开始时刻，使轨道与 `start_date` 使用同一日期口径。卫星位置由轨道决定，实例不写 `position`／`altitude`，配置的初始经纬高不进入脚本。候选模型自带的转发剧情与设备编号未复制。
- **卫星链路**：`links[].type = SAT` 按第 13.4 节已确认的“每条链路生成独立设备”规则生成两端设备，不复用候选模型的 `sat_link_a/b` 命名，因此不需要卫星 A/B 绑定选择；但链路至少要有一端是通信卫星，否则按 `links[i].type` 阻断。
- **侦测设备**：`sensors[]` 按已确认选择生成候选脚本的**主动雷达** `WSF_RADAR_SENSOR`。`frequencyRange` 取中心频率作为 `transmitter.frequency`、`max−min` 作为 `receiver.bandwidth`，`detectionRange` 作为 `maximum_range`；波束视场、帧周期、发射功率、噪声系数与最小距离沿用候选模型给定值。界面扩展的 `ESM` 类型、`direction` 与 `probability` 只写入 `mapping.json`，不映射为引擎参数——本机引擎没有直接接受检测概率的输入指令（`detection_probability` 只是脚本 API），唯一的检测阈值参数 `detection_threshold` 是 dB，与本项目的 0–1 比率之间缺少虚警率假设。
- **数传链路**：`links[].type = DATALINK` 按已确认选择固定为 **C 波段**，由 `direction` 决定上下行角色（`FORWARD → UPLINK`、`REVERSE → DOWNLINK`），并按候选脚本的合同固定值写入 `bit_error_probability 0.00001`；L 波段未使用。设备频率、带宽与功率仍取自配置，不使用候选模型的示例数值。
- **高空中继**：`FORWARD_RELAY_NODE` 按已确认选择复用 `MISSION_UAV_PLATFORM` 生成（`WSF_AIR_MOVER`），`mapping.json` 标注 `relayRole: true`。本轮不生成中继转发行为，因此该节点当前只是普通空中端点。
- **航点运动**：`platforms[].waypoints[]` 生成候选 `route` 区段。路线首点固定为 `initialPosition`——运动器会把平台起点设为路线首点，不写就会丢掉配置的初始位置。每个航点的 `speed` 作用于抵达该航点的那一段，末点速度不参与推进；`speed` 为 0 时按 `platforms[i].waypoints[j].speed` 阻断，避免引擎静默停在起点。`arrivalTime` 不作为引擎约束，`mapping.json` 记录 `arrivalTimeS` 与 `arrivalTimeEnforced: false`，实际到达时刻以引擎位置采样为准。
- **干扰完整启停**：不再写 weapon 的常开 `on`。`jammingEnabled` 与单设备 `enabled` 决定是否生成启停动作；`triggerTimeS` 作为引擎绝对触发时刻（`at_time <秒> sec absolute`，起点触发使用引擎允许的最小正时刻 `0.001`），在该时刻 `TurnOn()` 并 `SelectMode(<映射模式>)`；配置的持续时间在同一处理器生成第二个 `TurnOff()`。关闭时刻晚于仿真结束时只保留启动动作，不写永不执行的关闭。
- **环境、时钟与开始时刻**：`environment.seaState/rainRateMmPerHour` 生成 `global_environment` 区段（`sea_state`、`rain_rate <值> mm/hr`）；`environment.simClockSpeed` 生成 `clock_rate`；`scenario.startTime` 生成 `start_date <三字母月份> <两位日> <四位年>` 与 `start_time <时:分:秒.毫秒>`。候选脚本入口用的正是这一格式（`start_date sep 15 2025`、`start_time 00:00:00.0`）；全称月份和“年在前”写法都会被引擎拒绝。脚本没有时区标记，因此按配置存储的 UTC 分量原样写入，界面按 UTC+8 编辑的口径未换算，`mapping.json` 记 `convention: AS_STORED_UTC`。事件输出同时启用 `SIMULATION_STARTING/COMPLETE`，其回显的年月日时分秒是运行结果与配置开始时刻绑定的唯一证据。

### 17.2 本批仍阻断的项与实测依据

下表依据候选脚本本身（`afsim_script_cl/afsim_script`）与本机引擎实测重新核对，因此修正了第 9～13 节中若干过于笼统的判断：部分项并非“引擎做不到”，而是“项目还没定规则”。

| 缺口 | 候选脚本／引擎实测依据 | 需要先确认的规则 |
|---|---|---|
| 侦测设备的扩展参数 | 主动雷达已接通；但界面扩展的 `ESM` 类型、`direction`、`probability` 没有引擎输入对应项：`detection_probability` 只是脚本 API，`detection_threshold` 是 dB 门限 | `probability` 要变成门限需要一个虚警率假设，尚未提供；`direction` 的方位视场宽度也没有配置来源 |
| 干扰自动探测 | 候选的“自动探测”实际是对硬编码机名 `mission_uav_02/03` 的 `SlantRangeTo` 距离判断（24 海里），`auto_jammer_proc` 是空处理器 | 是否按配置的 `detectionRange` 对全部平台做距离判断（已确认选 A，待实施） |
| 高空中继的转发行为 | 平台已按 `MISSION_UAV_PLATFORM` 生成并标注 `relayRole` | 中继转发行为本身尚未生成 |
| 卫星轨道模板与转发 | 轨道要素取自候选模型并已按子类型接通；但候选模型的 `on_message` 把消息转发到硬编码的 `rear_comm_vehicle`，且配置的 `initialPosition` 不参与轨道 | 轨道模板能否作为通用默认；显式中继卫星的跳数与转发规则（已确认选“固定单跳”，待实施） |
| 数传与激光链路 | 微波、数传、卫星已接通；`fiber_link` 用的是 `WSF_COMM_TRANSCEIVER`（有线收发），而前端 `LinkType` 没有 `FIBER`；`LASER_COMM_ANTENNA`（40 dB、5°×5°）已定义但没有任何 `comm` 引用它 | 光纤与激光需要先扩合同 |
| 编码与修正参数 | 候选 `comm` 的参数是 `transfer_rate`、`channels`、`retransmit_attempts`、`retransmit_delay`、`polarization`、`noise_figure`、`attenuation_model`、`bit_error_probability`，没有信道编码、天线增益修正、抗干扰增益、空间隔离的等价项。其中 `bit_error_probability 0.00001` 是数传设备上的合同固定值（注释写明“写死”），与前端 `berThreshold` 判定阈值不是同一个概念 | 这些参数对应到哪个引擎模型参数 |
| 极化、噪声系数、重传与信道数 | 候选按设备逐项给出（微波 `polarization horizontal`、卫星 `noise_figure 2 dB`、`channels 4`、`retransmit_attempts 3`） | 是否按候选模型模板写入；配置里没有对应输入字段 |
| 动态选路与中继转发 | 引擎有 `WSF_COMM_NETWORK_AD_HOC`（对应候选的 `UAV_MESH_NET`）和 `WSF_COMM_NETWORK_MESH`；当前生成器只写 `network_name`，没有声明 `network` 类型 | 是否声明网络类型并启用 ad-hoc 路由 |
| 业务类型与保障 | 候选用 4 个脚本变量承载信息类型（`forward_situation`／`forward_target`／`back_recon`／`back_status`）与频次、时延要求；这些时延只是脚本变量，不是引擎调度保障 | 已确认选择“限定为 4 个枚举”，但该选择会把前端自由文本（含 `视频` 的帧/报文语义）改成合同枚举，涉及合同、界面与夹具，需单独一批实施 |
| 调制、BER 阈值、timeStep、链路优先级 | 候选脚本没有已确认的单一等价项 | 各自对应的引擎参数 |
| 新运行 CSV 接入地图与历史回放 | 属于前端展示范围，不在生成器内 | 是否实施 |

### 17.3 本轮验证

- 生成器聚焦回归 `tests/server/mission-generator.spec.ts` **42/42**；本机真实引擎用例 `tests/server/mission-execution.spec.ts` **18/18**（需设置 `MISSION_SMOKE_EXECUTABLE`）。
- 真实引擎：夹具场景 `SCN-001` 在停用唯一的激光链路（`L-LASER-04`）及其依赖业务（`INFO-001`，`CMD-01 → UAV-01` 只能走该激光链路）后**完整生成并执行成功**，退出码 0；`platforms.txt` 含 `WSF_RADAR_SENSOR`、`bit_error_probability 0.00001`、`WSF_SPACE_MOVER`；`mapping.json` 中 3 条微波、4 条数传、2 条卫星设备，`excludedLinkIds = ['L-LASER-04']`，1 个平台标注 `relayRole`。这是目前最接近真实场景的一次端到端验证。
- 真实引擎：含航点路线、定时干扰、环境与时钟的最小场景退出码 **0**，日志含 `Simulation complete`；`SIMULATION_STARTING` 回显 **2026-3-5 06:07:08**，与配置的 `2026-03-05T06:07:08.000Z` 一致，证明 `start_date`／`start_time` 真正生效；`scenario_events.csv` 中 `WEAPON_TURNED_ON`／`WEAPON_MODE_ACTIVATED`／`JAMMING_REQUEST_INITIATED` 均落在 `t=1`，`JAMMING_REQUEST_CANCELED`／`WEAPON_TURNED_OFF` 落在 `t=2`；`position.csv` 中该节点经度按航点从 `120.1` 推进。本机引擎对 `WEAPON_TURNED_OFF` 会重复输出同一时刻的记录，断言只核对发生时刻。
- 真实引擎：天通卫星场景退出码 **0**，`position.csv` 中卫星实际高度约 **35786 km**（与候选模型 `semi_major_axis 42164 km` 一致）、纬度接近 0（倾角 0），`COMM_TURNED_ON` 出现卫星设备记录，证明轨道模板与卫星设备真实生效。
- 全量：`npm run test:unit` **51 文件 883/883**、`npm run test:contracts` **8 文件 132/132**、设置 `MISSION_SMOKE_EXECUTABLE` 后 `npm run test:server` **30 文件 434/434**；`npm run typecheck`、`npm run validate:contracts`、`git diff --check` 通过。生产构建在独立输出目录成功（1946 模块）；仓库 `dist/` 因本机批量删除保护无法就地清空，`npm run build` 在本环境退出，与本次改动无关。
- 上一版本曾把 `start_date` 判为“引擎无此指令”，原因是只试了 `2026/09/23` 这种写法并误把 `Bad value` 当作未知指令；本轮按候选脚本入口的实际写法更正，并补了引擎侧回归。
- 顺手修复 `tests/components/scenario-script-file.spec.ts` 的陈旧断言：页面提示自加入“文本生成不等于 mission 执行验证”一行后，该用例未同步，属改动前已存在的失败。
- 未运行全量 P0、覆盖率与浏览器 E2E；未暂存、提交或推送。本批不宣称链路质量、完整业务或整份测试说明验收通过。

### 17.4 本轮确认的规则选择

以下选择由用户逐条确认，作为后续实施边界；未列入的项继续保持阻断。

| 项 | 已确认选择 | 状态 |
|---|---|---|
| 侦测设备模型 | 主动雷达 `WSF_RADAR_SENSOR`（与候选脚本一致） | 已实施 |
| 侦测频率映射 | `frequencyRange` 中心频率作 `frequency`，`max−min` 作 `bandwidth` | 已实施 |
| 侦测扩展参数 | `probability` 映射为检测阈值类参数 | **未实施**：引擎无接受概率的输入指令，`detection_threshold` 是 dB，缺虚警率假设 |
| 数传波段 | 固定 C 波段，`direction` 决定上下行 | 已实施 |
| 数传误码概率 | 按候选合同值写死 `bit_error_probability 0.00001` | 已实施 |
| 中文业务类型 | 限定为候选的 4 个枚举 | **未实施**：会把前端自由文本（含 `视频` 的帧/报文语义）改成合同枚举，涉及合同、界面与夹具，需单独一批 |
| 高空中继 | 复用 `MISSION_UAV_PLATFORM` 生成中继角色 | 已实施（平台与角色标注；转发行为未生成） |
| 中继转发 | 固定单跳（源→卫星→目标） | **未实施** |
| 干扰自动探测 | 按配置 `detectionRange` 对全部平台做距离判断 | **未实施** |
| 干扰目标 | 保持无目标，不补造 | 已按现状 |
| 干扰方向 | 忽略，只保留记录 | 已按现状 |


## 18. 剩余缺口补齐批次（2026-09-24）

本节对应第 17.2 / 17.4 节已确认但仍未实施的项；生成器与合同已接通的部分如下，**未运行 mission.exe 实机验收**，`engineValidated` 保持 `false`。

### 18.1 本批落地

| 缺口 | 状态 | 行为 |
|---|---|---|
| 干扰自动探测（选择 A） | 已落地 | `autoDetect=true` 时生成 `at_interval_of 3 sec` 处理器，对全部其他平台 `SlantRangeTo`，距离 ≤ `detectionRange`（米）则 `TurnOn`/`SelectMode`；与定时触发并存时优先自动探测 |
| 中继转发（固定单跳） | 已落地 | `SAT` + `relayPlatformId` 指向通信卫星时生成源/星/目标三端设备与两跳网络，卫星 `on_message` 转发到目标；高空中继平台仍只标注 `relayRole`，不自动转发 |
| 业务四枚举 | 已落地 | 合同 `InformationType` 限定为态势信息/目标指令/侦察信息/状态信息；界面与校验同步；生成拒绝自由文本与视频 |
| 输出路径与质量/切换标志 | 部分落地 | `csv_event_output`/`position.csv` 使用配置 `output.directory`；`linkQualityEnabled` 复用 MESSAGE/SENSOR 事件作代理；`linkSwitchEnabled` 仅记录标志，无专用切换统计事件 |
| timeStep | 部分落地 | `timeStep>0` 映射为运动器 `update_interval`；本行原称“输出采样仍用 writeInterval”不适用于位置输出，现行 `position.csv` 由 `MOVER_UPDATED` 触发；有限场景的实际间隔见文首 AFSIM 2.9.0 实测，不泛化到所有场景 |
| 光纤 | 已落地（生成） | `LinkType` 增加 `FIBER`，生成 `WSF_COMM_TRANSCEIVER` + `WSF_COMM_NETWORK_P2P`；**未做引擎实机验证** |
| 通信参数已核实项 | 部分落地 | 数传 `bit_error_probability` 等既有映射保留；调制/`berThreshold`/编码/增益修正仍只进 mapping 或阻断 |

### 18.2 仍阻断 / 明确不做本批

| 缺口 | 原因 |
|---|---|
| 激光设备 | 候选仅有 `LASER_COMM_ANTENNA`，无已核实 `comm`；生成继续 422 |
| ESM / direction / probability | 候选无 `WSF_ESM`；`detection_threshold` 为 dB 且缺虚警率；仅 mapping 注解 |
| arrivalTime 引擎约束 | 候选 route 无同名约束；`arrivalTimeEnforced: false` |
| clock_rate / 前端倍速生效 | 执行器固定 `mission.exe -es`，事件推进下 `clock_rate` 不改变墙钟；不在本批改为实时推进 |
| 自动选路 / 链路切换统计 | `priority`/`switchCooldownS` 仅快照；无已核实 ad-hoc 切换与专用统计事件 |
| 业务优先级/时延/最低速率保障 | 继续 `engineEnforced: false` |
| 高空中继 UAV 转发 | 确认的单跳规则是源→卫星→目标，不把 `FORWARD_RELAY_NODE` 当转发器 |

### 18.3 验证说明

- 以生成器单测与类型/合同校验为主；不宣称本批路径已通过 mission 实机。
- 若需验证自动探测或卫星单跳转发，应另开独占目录授权运行 mission，并更新 `execution.json` 证据后再改 `engineValidated`。


## 19. 高空中继转发、自动选路与专用质量/切换 CSV（2026-09-24）

> 历史实现记录：以下质量、切换输出方案已由 §20 的用户确认修正替代，不再代表当前支持范围。

承接 §18，补齐“有规则可落地、不依赖未核实 DSL”的三项；仍**未跑 mission.exe**，`engineValidated=false`。

### 19.1 已落地

| 项 | 行为 |
|---|---|
| 高空中继真正转发 | `relayPlatformId` 指向 `FORWARD_RELAY_NODE` 时，与卫星单跳相同：源/中继/目标三端设备 + 两跳网络 + 中继 `on_message` 转发。适用微波/数传；不用于 SAT/FIBER。仅 `relayRole` 标注但未作中继引用的节点仍不转发。 |
| 自动选路 | 未指定 `linkId` 且同端点多链路时，按 `linkSettings.priority` 选最高优先为主路由；`routePlans` 记录有序列表。 |
| 链路切换 | `linkSwitchEnabled` 且存在次选路由时：在**定时干扰** `startTimeS + switchCooldownS` 切换到次优先路由，写出合同表头 `link_switch.csv`（原因 `JAMMER_FAILOVER_PRIORITY`）。自动探测干扰不预排切换时刻。 |
| 链路质量 CSV | `linkQualityEnabled` 时按 `writeInterval` 写 `link_quality.csv`（合同表头）；`Distance=SlantRangeTo`（对中继或目标），调制/门限/功率/增益/速率取配置；PathLoss/SNR/ReceivedPower/JammingPower 留空并在 mapping 标明未测量。 |
| 输出目录 | 上述 CSV 与 events/position 均使用配置 `output.directory`。 |

### 19.2 仍阻断 / 诚实边界

- 激光设备、ESM、虚警率、编码/增益修正引擎映射：不变。
- `-es` 下 `clock_rate`、arrivalTime 硬约束、业务 QoS 硬保障：不变。
- 完整 ad-hoc 路由器协议 / 动态拓扑发现：未生成 `WSF_COMM_ROUTER_PROTOCOL_AD_HOC` 全量配置；选路为生成期 priority 排序 + 干扰触发故障切换。
- 链路质量不是引擎物理层解算结果，不能用于验收真实 SNR/BER。

## 20. 实机回归与输出边界修正（2026-09-24）

- 高空及卫星中继入口通信设备增加 `internal_link`，处理器使用真正的 `default` 消息分支；实机逐项核对源发送、中继接收、中继发送和目标接收，不以正常退出代替转发证据。
- 多目标业务向各目标发送一次；同目标备选链路只走优先级最高者，修正条件括号，不重复广播。
- 用户确认：缺少完整真实质量、切换前后 BER 测量时，分别在 `output.linkQualityEnabled`、`output.linkSwitchEnabled` 阻断生成。不得输出配置 BER、固定 UP、空测量或用零填充的规范 CSV。已删除对应 CSV 写入处理器，因此没有共享文件首次打开截断或伪成功记录；本阶段不执行基于这些假值的切换，主链路优先级选择保留。
- 用户确认：`output.directory` 仅允许本次独占包内的相对目录，支持默认 `./tasks/TASK-001/output` 和自定义嵌套目录；拒绝绝对路径、上级目录和非法路径字符。写包时创建实际目录，启动前完成创建与文件写入。每次运行仍使用独占目录，重复运行不覆盖旧结果。
- 新增/保存执行五类优先级和四种业务类型；读取兼容历史四类优先级与非空业务文本，不重写用户数据。脚本生成仍使用写入校验，旧场景须由用户明确调整后才能生成。
- 真实引擎完整套件本轮 25/25 通过（无跳过，退出码 0），包含两类中继、双目标、同目标多链路、默认/嵌套目录及重复运行；只证明这些用例，不声称质量求解或切换测量已完成。`engineValidated=false` 仍表示普通生成请求未运行引擎。


## 21. 干扰探测范围与干扰范围（2026-09-24）

> 本节记录当时生成器字段映射，不是当前地图功能清单。2026-09-29 文档核对：文件态势已有事件驱动的干扰范围显示；另外，`src/config/map.config.ts` 为 `jammer_station_01` 和 `jammer_airborne_01` 指定半径 50 公里的黄色探测示意圈。后者仅用于地图展示，不来自 CSV 侦测测量，不改变本节场景字段或引擎参数，也不能作为真实 ESM／探测算法的完成证据。

场景配置为每台干扰设备提供两个距离字段（合同单位 **米**；干扰编辑对话框与列表按 **海里** 展示，与既有探测距离一致，1～24 海里）：

| 字段 | UI 标签 | 语义 | 生成行为 |
|---|---|---|---|
| `detectionRange` | 探测范围 | 自动探测发现目标的最大斜距 | `autoDetect` 时对全部其他平台 `SlantRangeTo`；需 `rangeM <= detectionRange` |
| `jammingRange` | 干扰范围 | 干扰有效作用距离 | 自动探测在满足探测范围后，仅当 `rangeM <= jammingRange` 才 `TurnOn`/`SelectMode` |

- 候选 `WSF_RF_JAMMER` **weapon 区段无** `maximum_range`（传感器雷达才有）；故干扰范围**不**写入假造 DSL，只用脚本距离门控。
- 定时启停（`triggerTimeS`）仍按绝对时刻启停，**不**按 `jammingRange` 门控。
- 校验：写模式两字段均须在 1～24 海里；`jammingRange > detectionRange` 仅 **WARNING** `JAMMER_RANGE_ORDER`，非硬错误。默认值均为最大（24 海里）。
- 态势图：本批（2026-09-24）未新增距离圈；后续文件态势显示已变化，见本节开头的当前说明。
- `engineValidated` 保持 `false`（未对本次改动跑 mission.exe）。
