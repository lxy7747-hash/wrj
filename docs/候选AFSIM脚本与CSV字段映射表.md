# 候选 AFSIM 脚本与 CSV 字段映射表

整理日期：2026-09-22。

## 1. 范围与结论

本表只比较字段含义、关联方式和单位，不比较具体高度、位置、时间或其他配置数值，也不要求两套文件属于同一次运行。

- 候选脚本目录：`H:\Project\newWrj\afsim_script_cl\afsim_script`。
- 当前数据目录：`H:\Project\newWrj\output`，仅使用其中的 `position.csv` 和 `scenario_events.csv`，不以脚本目录自带的 output 替代。
- 脚本是输入与行为定义，CSV 是运行输出；字段可以建立映射，不代表能够从 CSV 完整还原脚本。
- 本表是对接参考，不修改或重新冻结现有合同，不将候选脚本认定为正式生成标准。

对应程度：**直接对应**表示身份或含义明确对应；**转换对应**表示需要转换单位或格式；**结果对应**表示只能观察执行结果，不能直接还原输入；**未提供**表示当前实际记录没有可用字段，不能用表头声明或默认值冒充数据。

## 2. 节点与位置

位置输出依据 `observers.txt` 中的 `MoverUpdated`，字段固定为 `TIME,NAME,LON,LAT,ALT,SPEED,HEADING`。节点实例定义主要位于 `comm_platform_INS.txt`，模型定义位于各 `comm_platform_*.txt`。

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
| 位置采样机制 | 运动器 `update_interval`、`MOVER_UPDATED` 观察器 | 相邻位置记录的 `TIME` | 结果对应；记录间隔不是采样配置字段本身 |
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

### 9.1 场景基础与环境

| 当前配置字段／界面含义 | 候选脚本对应位置 | CSV 输出对应 | 当前生成器处理 | 对接判断 |
|---|---|---|---|---|
| `scenario.id/name/description`：场景编号、名称、描述 | `simulation_name` 可承载名称；编号、描述需保留元数据 | 当前无可靠的场景编号／名称回显 | 输出编号、名称，未输出描述 | 不用为适配 CSV 删除这些管理字段；运行结果与场景绑定需另有记录 |
| `scenario.startTime`：开始时间，界面按 UTC+8 编辑、配置存 UTC | `start_date/start_time` | 仿真开始、结束事件的日期字段 | 原样输出 ISO 字符串 | 有字段可转换；脚本日期时区口径仍须确认，不能直接丢弃时区 |
| `scenario.duration`：界面分钟、配置秒 | `end_time` | `SIMULATION_COMPLETE.time` | 输出 `duration ...s` | 有字段可转换；改为真实脚本的结束时间规则，不改界面单位 |
| `scenario.timeStep`：时间步长 | 运动器、处理器更新间隔等，不存在已确认的单一等价项 | 位置和事件时间间隔仅为结果 | 输出 `time_step` | 不能将所有运动器、传感器、消息周期统一替换成这个值 |
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
| `output.writeInterval` | 位置观察器或其他输出机制的采样规则 | 记录时间间隔仅为结果 | 输出 `interval` | 需实现采样规则；不能把它直接当作所有引擎事件的发生间隔 |
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
