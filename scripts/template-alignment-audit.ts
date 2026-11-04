import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectScenarioConfig } from '../src/features/scenarios/scenario-validation.js'

/** 只读体检，不创建数据库、不补默认值、不改写场景或修订。 */
export function auditTemplateScenarios(databasePath: string) {
  const db = new DatabaseSync(resolve(databasePath), { readOnly: true })
  try {
    return db.prepare('SELECT id, config_json FROM scenarios ORDER BY id').all().map(row => {
      try {
        const inspection = inspectScenarioConfig(JSON.parse(String(row.config_json)), 'write')
        return { scenarioId: String(row.id), valid: inspection.result.valid, errors: inspection.result.errors, warnings: inspection.result.warnings }
      } catch {
        return { scenarioId: String(row.id), valid: false, errors: [{ severity: 'ERROR', code: 'SCENARIO_JSON_INVALID', fieldPath: 'config', message: '场景JSON不能解析或校验。' }], warnings: [] }
      }
    })
  } finally { db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('用法：tsx scripts/template-alignment-audit.ts <场景数据库路径>')
  console.log(JSON.stringify({ readOnly: true, scenarios: auditTemplateScenarios(process.argv[2]) }, null, 2))
}
