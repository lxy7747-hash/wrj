import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMissionPackage } from '../server/scripts/mission-generator.js'
import { createRenamedTemplateScenario } from '../tests/fixtures/template-scenario.js'
import { inspectScenarioConfig } from '../src/features/scenarios/scenario-validation.js'
import { createScenarioSnapshot } from '../src/features/scenarios/scenario-snapshot.js'

const scenarios = [
  ['SCN-NAMING-20261105-01', '实例命名验证（基础）', '实例命名基础验证：PLAT-/SUP- 编号映射、中继排在列表后仍为 mission_uav_01、平台编号与实例名冲突；GNZB-15/XNZB-10 使用范围内的宽带压制功率及带宽。'],
  ['SCN-NAMING-20261105-02', '实例命名验证（双中继）', '实例命名双中继验证：两架中继依次为 mission_uav_01、mission_uav_02，作业无人机为 mission_uav_03、mission_uav_04；GNZB-15/XNZB-10 沿用基础场景干扰参数。'],
  ['SCN-JAMMER-20261105-01', '干扰参数验证（瞄准式）', 'GNZB-15：地面站瞄准式带宽 5 MHz，对准首条已启用非激光链路频率；机载宽带压制带宽 400 MHz，功率 1 W（+30 dBm 上限）。'],
  ['SCN-JAMMER-20261105-02', '干扰参数验证（宽带压制）', 'XNZB-10：地面站宽带压制 0.0001 W（-10 dBm 下限）/100 MHz；机载宽带压制 0.01 W（+10 dBm）/200 MHz，覆盖功率下限及不同档位。'],
].map(([id, name, description]) => {
  const draft = createRenamedTemplateScenario()
  Object.assign(draft.config.scenario, { id, name, description })
  return draft
})

const relay = scenarios[1]!.config.platforms.find(platform => platform.type === 'FORWARD_RELAY_NODE')
assert(relay, '基础夹具缺少中继平台')
scenarios[1]!.config.platforms.push({ ...structuredClone(relay), id: 'PLAT-006', name: '第二架中继' })

const spot = scenarios[2]!.config
const alignedLink = spot.links.find(link => link.enabled && link.type !== 'LASER')
assert(alignedLink, '瞄准式场景缺少已启用的非激光链路')
Object.assign(spot.jammers[0]!, { type: 'SPOT', bandwidth: 5, frequency: alignedLink.frequency })
Object.assign(spot.jammers[1]!, { type: 'BARRAGE', defaultPower: 1, bandwidth: 400 })
Object.assign(scenarios[3]!.config.jammers[0]!, { type: 'BARRAGE', defaultPower: 0.0001, bandwidth: 100 })
Object.assign(scenarios[3]!.config.jammers[1]!, { type: 'BARRAGE', defaultPower: 0.01, bandwidth: 200 })

// 整批完成写入校验和脚本自检后才创建目录、写入文件。
let invalid = false
for (const draft of scenarios) {
  const { result } = inspectScenarioConfig(draft.config, 'write')
  for (const error of result.errors) {
    invalid = true
    console.error(`${draft.config.scenario.id} ${error.fieldPath || 'config'}：${error.message}`)
  }
  assert(!result.warnings.some(warning => warning.code === 'JAMMER_SPOT_FREQUENCY_UNMATCHED'),
    `${draft.config.scenario.id}：瞄准式频率未对准链路`)
}
if (invalid) {
  process.exitCode = 1
} else {
  for (const [index, draft] of scenarios.entries()) {
    const generated = buildMissionPackage(draft)
    const instances = [...generated.files['comm_platform_INS.txt']!.matchAll(/^platform (\S+) /gmu)].map(match => match[1])
    const rear = generated.files['comm_platform_REAR.txt']!
    const relays = JSON.parse(rear.match(/relay_uav_names (.+)\n/u)![1]!)
    const { jammers } = JSON.parse(rear.match(/jammer_param (.+)\n/u)![1]!)
    assert.deepEqual(relays, index === 1 ? ['mission_uav_01', 'mission_uav_02'] : ['mission_uav_01'])
    assert.deepEqual([...instances].sort(), generated.manifest.platforms.map(platform => platform.name).sort())
    for (const [file, content] of Object.entries(generated.files)) {
      if (file.endsWith('.txt')) assert(!/PLAT-|SUP-/u.test(content), `${draft.config.scenario.id}/${file} 残留平台编号`)
    }
    for (const [jammerIndex, source] of draft.config.jammers.entries()) {
      assert.deepEqual({ mode: jammers[jammerIndex].mode, power_w: jammers[jammerIndex].power_w,
        bandwidth_hz: jammers[jammerIndex].bandwidth_hz, spot_bandwidth_mhz: jammers[jammerIndex].spot_bandwidth_mhz },
      { mode: source.type === 'SPOT' ? 'spot' : 'broadband', power_w: source.defaultPower,
        bandwidth_hz: source.bandwidth * 1_000_000, spot_bandwidth_mhz: 20 })
    }
    console.log(JSON.stringify({ scenarioId: draft.config.scenario.id, instances, relay_uav_names: relays,
      jammers: jammers.map(({ mode, power_w, bandwidth_hz, spot_bandwidth_mhz }: Record<string, unknown>) =>
        ({ mode, power_w, bandwidth_hz, spot_bandwidth_mhz })), nativePlatformIdsAbsent: true }, null, 2))
  }
  console.log('双中继：仅追加 PLAT-006，复用模板中继航线；未新增链路或业务，写入校验通过。')
  console.log(`瞄准式对准首条已启用非激光链路：${alignedLink.id}（${alignedLink.type}，${alignedLink.frequency} MHz）。`)
  const directory = fileURLToPath(new URL('../output/scenarios-20261105/', import.meta.url))
  await mkdir(directory, { recursive: true })
  for (const draft of scenarios) {
    const outputPath = join(directory, `${draft.config.scenario.id}.json`)
    await writeFile(outputPath, `${JSON.stringify(createScenarioSnapshot(draft), null, 2)}\n`, 'utf8')
    console.log(`场景校验通过，已导出：${outputPath}`)
  }
}
