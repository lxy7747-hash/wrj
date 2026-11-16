/**
 * 用与 1112 模板实例兼容的场景生成全新交付脚本包。
 *
 * 用法：npx tsx scripts/generate-1112-template-package.ts [输出根目录]
 * 默认输出到 output/scripts/script-YYYYMMDDHHmmss；不覆盖历史包。
 */
import { resolve } from 'node:path'
import { createTemplateScenario } from '../tests/fixtures/template-scenario'
import { ScriptProjection } from '../server/scripts/projection'
import { writeScriptText } from '../server/local/script-file'

const root = resolve(process.argv[2] ?? 'output/scripts')
const draft = createTemplateScenario()
// 交付示例使用默认 x2；倍速规则由场景字段 realtime / environment.simClockSpeed 决定。
const script = new ScriptProjection().preview(draft)
const entry = await writeScriptText(root, script, draft.revision, draft)
process.stdout.write(`已生成脚本包：${entry}\n`)
