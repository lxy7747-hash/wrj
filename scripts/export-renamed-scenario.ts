import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRenamedTemplateScenario } from '../tests/fixtures/template-scenario.js'
import { inspectScenarioConfig } from '../src/features/scenarios/scenario-validation.js'
import { createScenarioSnapshot } from '../src/features/scenarios/scenario-snapshot.js'

const draft = createRenamedTemplateScenario()
draft.config.scenario.id = 'SCN-RENAMED-20261104'
draft.config.scenario.name = '实例命名验证场景'
draft.config.scenario.description = '验证 comm_platform_INS 实例命名：中继为 mission_uav_01，平台 ID 与实例名冲突'

const { result } = inspectScenarioConfig(draft.config, 'write')
if (!result.valid) {
  for (const error of result.errors) console.error(`${error.fieldPath || 'config'}：${error.message}`)
  process.exitCode = 1
} else {
  const outputPath = fileURLToPath(new URL('../output/renamed-scenario.json', import.meta.url))
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(createScenarioSnapshot(draft), null, 2)}\n`, 'utf8')
  console.log(`场景校验通过，已导出：${outputPath}`)
}
