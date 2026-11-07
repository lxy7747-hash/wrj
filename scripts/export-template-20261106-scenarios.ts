import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMissionPackage } from '../server/scripts/mission-generator.js'
import { createRenamedTemplateScenario } from '../tests/fixtures/template-scenario.js'
import { inspectScenarioConfig } from '../src/features/scenarios/scenario-validation.js'
import { createScenarioSnapshot } from '../src/features/scenarios/scenario-snapshot.js'
import { readDeviceParameters } from '../src/features/scenarios/template-defaults.js'
import { readJammerParameters } from '../src/features/scenarios/jammer-settings.js'

const base = createRenamedTemplateScenario()
const config = base.config
const aircraft = config.platforms.find(platform => platform.id === 'PLAT-003')
const forward = config.links.find(link => link.id === 'c_forward_uav2')
const reverse = config.links.find(link => link.id === 'c_return_uav2')
const businesses = config.informationDemand.filter(demand => demand.id.startsWith('uav2_'))
assert(aircraft && forward && reverse && config.linkSettings?.hotLinks, 'config：基础夹具缺少作业无人机、C 链路或热链')
assert.equal(businesses.length, 4, 'informationDemand：基础无人机须有四类业务')
for (let k = 0; k < 45; k++) {
  const platform = structuredClone(aircraft)
  platform.id = `PLAT-${String(k + 6).padStart(3, '0')}`
  platform.name = `任务无人机 ${String(k + 3).padStart(2, '0')}`
  for (const point of [platform.initialPosition, ...platform.waypoints,
    ...platform.loiterWaypoints ?? [], ...platform.returnPlan?.waypoints ?? []]) {
    point.longitude += (k % 9) * 0.02
    point.latitude += Math.floor(k / 9) * 0.02
  }
  config.platforms.push(platform)
  const forwardId = `c_forward_${platform.id}`, reverseId = `c_return_${platform.id}`
  config.links.push({ ...structuredClone(forward), id: forwardId, targetPlatformId: platform.id },
    { ...structuredClone(reverse), id: reverseId, sourcePlatformId: platform.id })
  config.linkSettings.hotLinks.forward.push(['fiber_forward', forwardId])
  config.linkSettings.hotLinks.reverse.push([reverseId, 'fiber_return'])
  for (const original of businesses) {
    const demand = structuredClone(original)
    demand.id = original.id.replace(/^uav2_/u, `${platform.id}_`)
    if (demand.sourcePlatformId === aircraft.id) demand.sourcePlatformId = platform.id
    demand.destinationPlatformIds = demand.destinationPlatformIds.map(id => id === aircraft.id ? platform.id : id)
    config.informationDemand.push(demand)
  }
}
for (const platform of config.platforms) platform.linkIds = []
for (const link of config.links) for (const platform of config.platforms) {
  if ([link.sourcePlatformId, link.targetPlatformId, link.relayPlatformId].includes(platform.id)) platform.linkIds.push(link.id)
}

const description = '4 类共 50 个信息节点（后方 1、指挥车 1、中继 1、作业无人机 47），另保留 4 个卫星／干扰支撑实体。使用 11-06 模板默认值（雷达功率 1000 W）；交给对接方的 TXT 已删除三个旧天线定义和地面站 weapon prophet_jammer 块，本地运行包仍保留；干扰功率及带宽遵守 V1.2 GNZB-15 / XNZB-10。'
const scenarios = [
  ['SCN-TEMPLATE-20261106-01', '11-06 模板对齐验证（50 节点，默认）', '基线 / GNZB-08：公共基础不变，完整航线和模板实例命名；地面宽带压制 1 W / 200 MHz，机载 0.1 W / 100 MHz。'],
  ['SCN-TEMPLATE-20261106-02', '11-06 模板对齐验证（50 节点，瞄准式干扰）', 'GNZB-15 第 4 步：地面瞄准式 1 W / 5 MHz，对准 C 上行 4500 MHz；机载保持宽带压制 0.1 W / 100 MHz。'],
  ['SCN-TEMPLATE-20261106-03', '11-06 模板对齐验证（50 节点，链路计算 1 秒）', 'XNZB-06 第 1 步：仅将链路计算更新周期设为 1 秒；地面宽带压制 1 W / 200 MHz，机载 0.1 W / 100 MHz。'],
].map(([id, name, purpose]) => {
  const draft = structuredClone(base)
  Object.assign(draft.config.scenario, { id, name, description: `${description}${purpose}` })
  assert(draft.config.linkSettings?.linkCalc, `${id} linkSettings.linkCalc：基础夹具缺少链路计算配置`)
  draft.config.linkSettings.messageIntervalS = 5
  draft.config.linkSettings.linkCalc.updateIntervalS = 5
  draft.config.jammers = draft.config.jammers.map(readJammerParameters)
  draft.config.deviceParameters = readDeviceParameters(draft.config)
  return draft
})

const spot = scenarios[1]!.config
const alignedLink = spot.links.find(link => link.enabled && link.type === 'DATALINK' && link.band === 'C' && link.direction === 'FORWARD' && link.frequency === 4500)
assert(alignedLink, `${spot.scenario.id} links：缺少已启用的 C 上行 4500 MHz 链路`)
Object.assign(spot.jammers[0]!, { type: 'SPOT', bandwidth: 5, frequency: alignedLink.frequency })
scenarios[2]!.config.linkSettings!.linkCalc!.updateIntervalS = 1

// 先校验整批并在内存中序列化；任何场景或脚本断言失败都不创建目录、不写文件。
const snapshots: { id: string; content: string }[] = []
let invalid = false
for (const [index, draft] of scenarios.entries()) {
  const id = draft.config.scenario.id
  const { result } = inspectScenarioConfig(draft.config, 'write')
  if (result.errors.length) {
    invalid = true
    for (const issue of result.errors) console.error(`${id} ${issue.fieldPath || 'config'}：${issue.message}`)
    continue
  }
  try {
    const counts = Object.fromEntries(['REAR_COMMAND_NODE', 'GROUND_CLUSTER_COMMAND_NODE', 'FORWARD_RELAY_NODE', 'AIRBORNE_MISSION_CLUSTER']
      .map(type => [type, draft.config.platforms.filter(platform => platform.type === type).length]))
    assert.deepEqual(Object.values(counts), [1, 1, 1, 47], 'platforms：信息节点须为 1+1+1+47')
    assert.equal(draft.config.platforms.length, 54, 'platforms：须保留 4 个支撑实体')
    assert.equal(draft.config.links.length, 96, 'links：须为 96 条')
    assert.equal(draft.config.links.filter(link => link.type === 'FIBER').length, 2, 'links：须为 2 条光纤')
    assert.equal(draft.config.links.filter(link => link.type === 'DATALINK' && link.band === 'C').length, 94, 'links：须为 94 条 C 链路')
    assert.equal(draft.config.linkSettings!.hotLinks!.forward.length, 47, 'linkSettings.hotLinks.forward：须为 47 条')
    assert.equal(draft.config.linkSettings!.hotLinks!.reverse.length, 47, 'linkSettings.hotLinks.reverse：须为 47 条')
    assert.equal(draft.config.informationDemand.length, 188, 'informationDemand：须为 188 项')
    assert(draft.config.scenario.description.length <= 512, 'scenario.description：说明不能超过 512 字')
    assert(index !== 1 || !result.warnings.some(issue => issue.code === 'JAMMER_SPOT_FREQUENCY_UNMATCHED'), 'jammers[0].frequency：瞄准式频率未对准链路')
    const { files } = buildMissionPackage(draft)
    const definitions = files['comm_PerDefinition.txt']!, jammerScript = files['comm_platform_JAMMER.txt']!
    const rear = files['comm_platform_REAR.txt']!
    for (const name of ['MICRO_UAV_OMNI_ANTENNA', 'MICRO_REAR_PLATFORM_DIR_ANTENNA', 'OMNI_ANTENNA_HIGHGAIN']) {
      assert(!new RegExp(`^antenna_pattern ${name}(?:\\s|$)`, 'mu').test(definitions), `comm_PerDefinition.txt：残留 ${name} 定义`)
    }
    assert(!jammerScript.includes('weapon prophet_jammer'), 'comm_platform_JAMMER.txt：残留地面站武器块')
    const radarBlocks = [...jammerScript.matchAll(/sensor detection_radar[\s\S]*?end_sensor/gu)]
    assert.equal(radarBlocks.length, 2, 'comm_platform_JAMMER.txt：应包含两类侦测雷达')
    for (const [radarIndex, [block]] of radarBlocks.entries()) {
      assert(/^\s*power 1000 W$/mu.test(block), `comm_platform_JAMMER.txt.sensors[${radarIndex}].power：应为 1000 W`)
    }
    const { jammers } = JSON.parse(rear.match(/jammer_param (.+)\n/u)![1]!)
    assert.equal(jammers.length, 2, 'jammer_param.jammers：应包含两台干扰设备')
    for (const [jammerIndex, source] of draft.config.jammers.entries()) {
      assert.equal(source.radarPower, 1000, `jammers[${jammerIndex}].radarPower：快照须显式保存 1000 W`)
      assert.deepEqual({ mode: jammers[jammerIndex].mode, power_w: jammers[jammerIndex].power_w,
        weapon_power_w: jammers[jammerIndex].weapon_power_w, weapon_bandwidth_mhz: jammers[jammerIndex].weapon_bandwidth_mhz,
        spot_bandwidth_mhz: jammers[jammerIndex].spot_bandwidth_mhz },
      { mode: source.type === 'SPOT' ? 'spot' : 'broadband', power_w: 1000,
        weapon_power_w: source.defaultPower, weapon_bandwidth_mhz: source.bandwidth,
        spot_bandwidth_mhz: source.type === 'SPOT' ? 5 : 20 }, `jammer_param.jammers[${jammerIndex}]：参数与快照不一致`)
    }
    for (const [file, content] of Object.entries(files)) {
      if (file.endsWith('.txt')) assert(!/PLAT-|SUP-/u.test(content), `${file}：残留原平台编号`)
    }
    const uavNames = Array.from({ length: 48 }, (_, i) => `mission_uav_${String(i + 1).padStart(2, '0')}`)
    assert.deepEqual([...files['comm_platform_INS.txt']!.matchAll(/^platform (mission_uav_\d+) /gmu)].map(match => match[1]),
      uavNames, 'comm_platform_INS.txt：须从中继 mission_uav_01 连续编号至 mission_uav_48')
    assert.deepEqual(JSON.parse(rear.match(/relay_uav_names (.+)\n/u)![1]!), ['mission_uav_01'], 'relay_uav_names：中继实例名不正确')
    for (const key of ['fw_sit_dst', 'fw_tgt_dst']) {
      const value = rear.match(new RegExp(`Array<string> ${key}\\s*= \\{([^}]*)\\};`, 'u'))
      assert(value, `${key}：缺少前向目的地数组`)
      assert.deepEqual([...value[1]!.matchAll(/"([^"]+)"/gu)].map(match => match[1]), uavNames.slice(1), `${key}：须有 47 个作业无人机目的地`)
    }
    for (const key of ['hot_link_fw', 'hot_link_ret']) {
      const routes = JSON.parse(rear.match(new RegExp(`${key} (.+)\\n`, 'u'))![1]!)
      assert.equal(Object.keys(routes).length, 47, `${key}：须有 47 条热链`)
    }
    const interval = index === 2 ? 1 : 5
    assert(rear.includes(`add processor link_calc WSF_LINK_CALC_PROCESSOR\n    update_interval ${interval} sec`), 'linkSettings.linkCalc.updateIntervalS：脚本周期不一致')
    snapshots.push({ id, content: `${JSON.stringify(createScenarioSnapshot(draft), null, 2)}\n` })
    console.log(JSON.stringify({ scenarioId: id, checks: { writeValidation: 'PASS', scale50Nodes: 'PASS', removedDefinitions: 'PASS',
      radarPower1000W: 'PASS', nativePlatformIdsAbsent: 'PASS', uavNamesAndRoutes: 'PASS', jammerParameters: 'PASS', updateInterval: 'PASS' },
    counts: { ...counts, totalPlatforms: 54, links: 96, forwardHotLinks: 47, reverseHotLinks: 47, businesses: 188 },
    updateIntervalS: interval, jammers: jammers.map(({ mode, power_w, weapon_power_w, weapon_bandwidth_mhz, spot_bandwidth_mhz }: Record<string, unknown>) =>
      ({ mode, power_w, weapon_power_w, weapon_bandwidth_mhz, spot_bandwidth_mhz })),
    ...(index === 1 ? { spotFrequencyMatched: 'PASS', alignedLink: { id: alignedLink.id, type: alignedLink.type, frequencyMHz: alignedLink.frequency } } : {}) }, null, 2))
  } catch (error) {
    invalid = true
    console.error(`${id} ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (invalid) {
  process.exitCode = 1
} else {
  const directory = fileURLToPath(new URL('../output/scenarios-20261106/', import.meta.url))
  await mkdir(directory, { recursive: true })
  for (const { id, content } of snapshots) {
    const path = join(directory, `${id}.json`)
    await writeFile(path, content, 'utf8')
    console.log(`已导出：${path}`)
  }
}
