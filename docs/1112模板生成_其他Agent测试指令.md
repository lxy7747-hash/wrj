# 1112 固定模板脚本生成 — 其他 Agent 测试指令

> 工作目录：`H:\Project\newWrj\frontend`
>
> 适用对象：接手复核本任务的其他 Agent。
>
> 目标：验证“1112 固定模板 + 受控替换”、倍速下拉、LinkCalc 映射、实例范围失败路径和最终交付包。

---

## 0. 边界与安全要求

### 0.1 先做仓库安全预检

```powershell
cd H:\Project\newWrj\frontend
git status --short --ignored
git check-ignore -v -- map/china-taiwan-260823.pmtiles map/taiwan-strait-satellite.pmtiles
```

预期：两个 PMTiles 都命中 `.gitignore` 的 `/map/` 规则。

### 0.2 不要修改

- `H:\Project\newWrj\场景配置参数对接\afsim_script_lcm_1112\afsim_script_lcm\`：原始模板目录，只读。
- `output/scripts/script-20261113095332/`：历史输出包，不覆盖、不修补。
- 工作区已有的用户未提交修改。

### 0.3 不要执行

```text
git add .
git add -A
git commit
git push
```

不要删除或覆盖历史输出包。

---

## 1. 快速验证（约 3 分钟）

```powershell
cd H:\Project\newWrj\frontend
npm run typecheck
npm run validate:contracts
npx vitest run --config vitest.config.ts tests/server/template-alignment.spec.ts tests/server/mission-generator.spec.ts tests/server/laser-generator.spec.ts tests/server/local-runtime.spec.ts tests/server/script-file.spec.ts tests/server/script-projection.spec.ts
npx vitest run --config vitest.config.ts tests/components/scenarios.spec.ts tests/components/template-scenario-fields.spec.ts
```

预期：

```text
typecheck：0 错误
validate:contracts：4 个 PASS
核心生成器 6 个文件：47 个用例通过
倍速界面 2 个文件：59 个用例通过
```

---

## 2. 全量测试

```powershell
cd H:\Project\newWrj\frontend
npm test
```

预期：

```text
单元测试：101 个文件，1693 通过
契约测试：21 个文件，355 通过
服务端测试：88 个文件，1002 通过、18 跳过、0 失败
```

### 2.1 已修复的 4 项

`tests/server/no-side-effects.spec.ts` 与 `tests/server/real-data-smoke.spec.ts` 的 4 项失败已在
2026-11-13 修复并纳入回归，不再作为已知失败列出。修复依据和原始数据证据见
[1112服务端测试失败项修复记录.md](1112服务端测试失败项修复记录.md)。

新增回归用例：

```powershell
npx vitest run --config vitest.config.ts tests/server/admin-clock.spec.ts tests/components/file-message-links.spec.ts tests/server/afsim-event-csv.spec.ts
```

预期：`admin-clock` 3 项、`file-message-links` 18 项、`afsim-event-csv` 17 项全部通过。

### 2.2 偶发超时

`tests/server/deploy-background.spec.ts` 在全量并发下偶发超时，单独重跑应通过：

```powershell
npx vitest run --config vitest.config.ts tests/server/deploy-background.spec.ts
```

---

## 3. 模板哈希核验

```powershell
cd H:\Project\newWrj\frontend
$src = "H:\Project\newWrj\场景配置参数对接\afsim_script_lcm_1112\afsim_script_lcm"
Get-ChildItem tests\fixtures\afsim-template-1112 -File | ForEach-Object {
  $a = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
  $b = (Get-FileHash (Join-Path $src $_.Name) -Algorithm SHA256).Hash
  "{0}: {1}" -f $_.Name, ($(if ($a -eq $b) { "SAME" } else { "DIFF" }))
}
```

预期：10 个文件全部 `SAME`。

也可以直接跑：

```powershell
npx vitest run --config vitest.config.ts tests/server/template-alignment.spec.ts
```

该用例同时校验：

- 仓库副本与源模板逐字节一致；
- 运行时资源解码后与仓库副本一致；
- 清单 SHA-256 与运行时常量一致。

---

## 4. 生成新包并核验 10 个 TXT

### 4.1 生成

```powershell
cd H:\Project\newWrj\frontend
npx tsx scripts/generate-1112-template-package.ts
$pkg = Get-ChildItem output\scripts -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Output "PKG=$($pkg.FullName)"
```

预期输出类似：

```text
已生成脚本包：H:\Project\newWrj\frontend\output\scripts\script-<时间戳>\comm_SimSetup.txt
PKG=H:\Project\newWrj\frontend\output\scripts\script-<时间戳>
```

### 4.2 固定区域核验

```powershell
cd H:\Project\newWrj\frontend
$pkg = Get-ChildItem output\scripts -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
npx tsx tmp/verify-package.ts $pkg.FullName
```

预期：

```text
FIXED-OK ad_hoc_comm.txt
FIXED-OK comm_PerDefinition.txt
FIXED-OK comm_platform_COMMAND_VEHICLE.txt
FIXED-OK comm_platform_INS.txt
FIXED-OK comm_platform_JAMMER.txt
FIXED-OK comm_platform_MISSION_UAV.txt
FIXED-OK comm_platform_REAR.txt
FIXED-OK comm_platform_SAT.txt
FIXED-OK comm_SimSetup.txt
FIXED-OK observers.txt
laser_link: false
jamming_range: false
```

如果 `tmp/verify-package.ts` 不存在，直接运行：

```powershell
npx vitest run --config vitest.config.ts tests/server/template-alignment.spec.ts
```

---

## 5. 手工抽查新包

```powershell
cd H:\Project\newWrj\frontend
$pkg = Get-ChildItem output\scripts -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1

Get-Content (Join-Path $pkg.FullName "comm_SimSetup.txt") | Select-String "realtime|clock_rate"

Select-String -Path (Join-Path $pkg.FullName "comm_platform_REAR.txt") -Pattern "Array<string> fw_sit_dst|Array<string> fw_tgt_dst"

Select-String -Path (Join-Path $pkg.FullName "comm_platform_MISSION_UAV.txt") -Pattern "Array<string> relayNames|Array<string> rt_video_dsts|Array<string> rt_status_dsts|bool isRelay"
```

预期：

```text
realtime
clock_rate 2

Array<string> fw_sit_dst  = { "mission_uav_02", "mission_uav_03" };\\
Array<string> fw_tgt_dst  = { "mission_uav_02", "mission_uav_03" };\\

Array<string> relayNames = { "mission_uav_01" };//
Array<string> rt_video_dsts = { "rear_comm_vehicle" };
Array<string> rt_status_dsts = { "rear_comm_vehicle" };
bool isRelay = false;
```

---

## 6. 旧 54 平台包动态实例验证

```powershell
cd H:\Project\newWrj\frontend
npx tsx -e "import {readFileSync} from 'node:fs'; import {buildMissionPackage} from './server/scripts/mission-generator.ts'; const d=JSON.parse(readFileSync('output/scripts/script-20261113095332/metadata/input.json','utf8')); try{const p=buildMissionPackage(d); console.log('GENERATED:', [...p.files['comm_platform_INS.txt'].matchAll(/^platform (mission_uav_\\d+) MISSION_UAV_PLATFORM$/gmu)].map(m=>m[1]).join(','))}catch(e){console.log('REJECTED:', e.message)}"
```

预期：

```text
GENERATED: mission_uav_01,mission_uav_02,...,mission_uav_48
```

要求：mission_uav 实例段按场景配置动态生成，54 平台包可生成；其他固定实例（后方车/指挥车/卫星/干扰站）仍来自模板。边界与风险：模板 JAMMER 脚本固定引用 mission_uav_02/03；60/64 节点的真实引擎性能尚未实测。






---

## 7. 倍速七种输出验证

```powershell
cd H:\Project\newWrj\frontend
npx tsx tmp/probe-speed.ts
```

预期：

```text
full => //realtime | clock_rate 32 | manifest: full
x1 => realtime | clock_rate 1 | manifest: x1
x2 => realtime | clock_rate 2 | manifest: x2
x4 => realtime | clock_rate 4 | manifest: x4
x8 => realtime | clock_rate 8 | manifest: x8
x16 => realtime | clock_rate 16 | manifest: x16
x32 => realtime | clock_rate 32 | manifest: x32
legacy-nonrealtime-2 => //realtime | clock_rate 2 | manifest: legacy
legacy-realtime-3 => realtime | clock_rate 3 | manifest: legacy
```

重点：

- `full` 与 `x32` 的 `clock_rate` 都是 32；
- `full` 必须是 `//realtime`；
- `x32` 必须是 `realtime`；
- 两者不能合并。

---

## 8. 构建验证

```powershell
cd H:\Project\newWrj\frontend
npm run build
npm run build:lan
```

预期：两条命令均成功，`server-dist/server.mjs` 及 chunks 生成。

---

## 9. 测试重点对照

### 9.1 固定区域

除以下区域外，10 个执行 TXT 必须与 1112 模板逐字节一致：

| 文件 | 允许变化区域 |
|---|---|
| `comm_platform_REAR.txt` | `fw_sit_dst`、`fw_tgt_dst` 两个数组元素 |
| `comm_platform_REAR.txt` | `link_calc` 处理器参数块 |
| `comm_platform_MISSION_UAV.txt` | `relayNames`、`rt_video_dsts`、`rt_status_dsts` 三个数组元素 |
| `comm_SimSetup.txt` | `realtime`、`clock_rate` |
| 激光端口 | `laser_link` → `lazer_link` 的必要统一 |

### 9.2 数组约束

- REAR 只允许两个数组：`fw_sit_dst`、`fw_tgt_dst`。
- MISSION_UAV 只允许三个数组和原 `bool isRelay = false;`。
- 禁止新增 `next`、`out`、`in`、`size`、`rt_video_nexts` 等变量。

### 9.3 LinkCalc

必须存在且顺序一致：

```text
update_interval
emergency_threshold
warning_threshold
value_threshold_ber
channel_encoding_scheme
traffic_type
relay_uav_names
hot_link_ret
hot_link_fw
port_params
natural_environment
jammer_param
```

禁止出现：

```text
jamming_range
end_platform_type
```

### 9.4 激光命名

- `comm lazer_link` 存在；
- `port_params` 中 `comm_name` 为 `lazer_link`；
- 全包中不存在 `laser_link`；
- 未修改激光频率、功率、带宽、EIRP、G/T、噪声系数。

---

## 10. 判定口径

### 10.1 通过条件

```text
1. typecheck、validate:contracts 通过
2. 核心生成器 47 个用例通过
3. 倍速界面 59 个用例通过
4. build、build:lan 通过
5. 新包 10 个 TXT 全部 FIXED-OK
6. 输出无 laser_link、无 jamming_range
7. 旧 54 平台包被明确拒绝
8. 全量测试只有第 2.1 节列出的 4 个已知非回归失败
```

### 10.2 未执行项

```text
未执行 AFSIM/LinkCalc 引擎运行验证。
未执行 Playwright e2e。
```

未做引擎运行验证时，不得声称：

- 脚本已能正常仿真；
- 全速设置的实际运行速度已验证；
- LinkCalc 参数已在真实引擎生效。

---

## 11. 复核报告模板

```markdown
## 复核结果

- 执行命令：
- 通过用例数：
- 失败用例数：
- 失败定位：
- 是否属于非回归：
- 新包路径：
- 10 个 TXT 固定区域：
- 是否含 laser_link / jamming_range：
- 是否执行 AFSIM/LinkCalc：
- 其他风险或待确认项：
```
