import type {
  ApiErrorCode,
  ScenarioDraft,
  ScriptContract,
  ValidationIssue,
  ValidationResult,
} from '../../src/contracts/domain-models.js'
import { buildMissionPackage, SCENARIO_PREVIEW_FILE } from './mission-generator.js'

export type ScriptProjectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 422; fieldPath?: string; message: string }

const GENERATED_TIME = '2026-08-06T08:03:02Z'

/** 使用 FNV-1a 将文本转换为稳定的非加密 Mock 校验和。 */
function fnv1aMockChecksum(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `FNV1A-MOCK-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

/** 将生成包中的 JSON 仅作为预览注释附加，不把参数快照伪装为 AFSIM 语法。 */
function commentedJsonSection(name: string, guidance: string, content: string): string {
  return [`// ===== ${name} =====`, `// ${guidance}`,
    ...content.trimEnd().split('\n').map(line => `// ${line}`), ''].join('\n')
}

/** 从生成器构建可展开的真实 scenario.txt 及其依赖内容，不访问文件或启动进程。 */
function buildPreview(draft: ScenarioDraft): string {
  const generated = buildMissionPackage(draft)
  const generatedFiles: Record<string, string> = generated.files
  const files = [SCENARIO_PREVIEW_FILE, ...generated.manifest.scriptFiles.filter(name => name !== SCENARIO_PREVIEW_FILE)]
  const nativeSections = files.map((name) => `// ===== ${name} =====\n${generatedFiles[name] ?? ''}`)
  const snapshots = [
    commentedJsonSection('mapping.json', '生成映射快照：仅列出本次实际写入原生脚本的实体、通信和业务。', generatedFiles['mapping.json'] ?? '{}'),
    commentedJsonSection('input.json', '配置快照：未映射字段不代表引擎生效；生成预览未执行引擎校验。', generatedFiles['input.json'] ?? '{}'),
  ]
  return [...nativeSections, ...snapshots].join('\n')
}

function previewLocation(preview: string, offset: number): { line: number; column: number } {
  const prefix = preview.slice(0, offset)
  return { line: prefix.split('\n').length, column: offset - prefix.lastIndexOf('\n') }
}

/** 只检查原生脚本段；注释中的 JSON 快照和说明不参与 AFSIM 块结构判断。 */
function inspectNativeStructure(preview: string, addError: (code: string, message: string, line: number, column?: number) => void): void {
  const openings: number[] = []
  let quoted = false
  let escaped = false
  for (let index = 0; index < preview.length; index += 1) {
    const character = preview[index]!
    if (escaped) { escaped = false; continue }
    if (quoted && character === '\\') { escaped = true; continue }
    if (character === '"') { quoted = !quoted; continue }
    if (!quoted && character === '/' && preview[index + 1] === '/') {
      const lineEnd = preview.indexOf('\n', index)
      if (lineEnd < 0) break
      index = lineEnd
      continue
    }
    if (quoted) continue
    if (character === '{') openings.push(index)
    if (character === '}') {
      if (openings.length > 0) openings.pop()
      else {
        const location = previewLocation(preview, index)
        addError('SCRIPT_STRUCTURE_INVALID', '原生脚本存在未匹配的右花括号。', location.line, location.column)
        return
      }
    }
  }
  if (openings.length > 0) {
    const location = previewLocation(preview, preview.length)
    addError('SCRIPT_STRUCTURE_INVALID', '原生脚本存在未闭合的块结构。', location.line, location.column)
  }
}

/** 对与本机生成包同源的 scenario.txt 预览执行入口、依赖和输出路径预检。 */
export function inspectScriptPreview(preview: string): ValidationResult {
  const lines = preview.split('\n')
  const errors: ValidationIssue[] = []
  const addError = (code: string, message: string, line: number, column = 1): void => {
    errors.push({ severity: 'ERROR', code, message: `第 ${line} 行，第 ${column} 列：${message}`, fieldPath: `preview[${line}:${column}]` })
  }
  if (lines[0] !== `// ===== ${SCENARIO_PREVIEW_FILE} =====`) addError('SCRIPT_HEADER_INVALID', '脚本入口结构不正确。', 1)
  if (!lines.some(line => line === 'include_once comm_SimSetup.txt')) addError('SCRIPT_ENTRY_INVALID', '缺少 comm_SimSetup.txt 入口引用。', 1)
  if (!lines.some(line => line === '// ===== comm_SimSetup.txt =====')) addError('SCRIPT_ENTRY_INVALID', '缺少 comm_SimSetup.txt 原生脚本段。', 1)
  if (!lines.some(line => /^start_date \S+ \d+ \d+$/.test(line))) addError('SCRIPT_AFSIM_HEADER_INVALID', '缺少 AFSIM start_date 头。', 1)
  for (const name of ['comm_PerDefinition.txt', 'comm_platform_INS.txt', 'observers.txt']) {
    if (!lines.some(line => line === `// ===== ${name} =====`)) addError('SCRIPT_REFERENCE_INVALID', `缺少 ${name} 引用内容。`, 1)
  }
  const outputLine = lines.findIndex((line) => /^   file .+\.aer$/.test(line))
  if (outputLine < 0) addError('SCRIPT_OUTPUT_PATH_INVALID', '缺少有效输出路径合同。', Math.max(1, lines.length - 1))
  inspectNativeStructure(preview, addError)
  return { valid: errors.length === 0, errors, warnings: [] }
}

export class ScriptProjection {
  private scripts = new Map<string, ScriptContract>()
  private nextSequence = 1

  get(scriptId: string): ScriptContract | undefined {
    const script = this.scripts.get(scriptId)
    return script === undefined ? undefined : structuredClone(script)
  }

  /** 生成并保存当前草稿的确定性内存脚本预览。 */
  preview(draft: ScenarioDraft): ScriptContract {
    const preview = buildPreview(draft)
    const script: ScriptContract = {
      scriptId: `SCRIPT-P2-${String(this.nextSequence).padStart(3, '0')}`,
      taskId: 'TASK-001',
      scenarioId: draft.config.scenario.id,
      configVersion: `${draft.config.scenario.id}-v${draft.revision}`,
      target: 'AFSIM 2.9.0',
      checksum: fnv1aMockChecksum(preview),
      preview,
      generatedTime: GENERATED_TIME,
    }
    this.nextSequence += 1
    this.scripts.set(script.scriptId, script)
    return structuredClone(script)
  }

  /** 校验脚本编号、校验和及内存预览结构。 */
  preflight(scriptId: string, checksum: string): ScriptProjectionResult<ValidationResult> {
    const script = this.scripts.get(scriptId)
    if (script === undefined) return { ok: false, code: 'NOT_FOUND', status: 422, fieldPath: 'scriptId', message: '未找到指定脚本预览。' }
    if (checksum !== script.checksum) return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'checksum', message: '脚本校验和不匹配。' }
    return { ok: true, data: inspectScriptPreview(script.preview) }
  }

  /** 清除脚本预览并恢复确定性编号。 */
  reset(): void {
    this.scripts.clear()
    this.nextSequence = 1
  }
}
