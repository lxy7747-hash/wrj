/** 从本次脚本预览的 mapping.json 注释段读取生成器的字段级事实，不在前端重复推断生成结果。 */
export type ScriptExecutionStatusEntry = { fieldPath: string; detail: string }
export type ScriptExecutionStatus = { emitted: ScriptExecutionStatusEntry[]; retainedSnapshot: ScriptExecutionStatusEntry[]; dependencyUnconfirmed: ScriptExecutionStatusEntry[] }

function entries(value: unknown): ScriptExecutionStatusEntry[] | null {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'object' && item !== null && typeof item.fieldPath === 'string' && typeof item.detail === 'string')) return null
  return value as ScriptExecutionStatusEntry[]
}

/** 预览中的 mapping.json 每行以 // 前缀保存，去除注释后严格验证最小结构。 */
export function readScriptExecutionStatus(preview: string): ScriptExecutionStatus | null {
  const lines = preview.split('\n')
  const start = lines.indexOf('// ===== mapping.json =====')
  if (start < 0) return null
  const section = lines.slice(start + 1, lines.findIndex((line, index) => index > start && line.startsWith('// ===== ')) < 0 ? undefined : lines.findIndex((line, index) => index > start && line.startsWith('// ===== ')))
  const jsonStart = section.findIndex(line => line === '// {')
  if (jsonStart < 0) return null
  try {
    const parsed: unknown = JSON.parse(section.slice(jsonStart).map(line => line.startsWith('// ') ? line.slice(3) : line).join('\n'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const status = (parsed as { executionStatus?: unknown }).executionStatus
    if (typeof status !== 'object' || status === null) return null
    const value = status as { emitted?: unknown; retainedSnapshot?: unknown; dependencyUnconfirmed?: unknown }
    const emitted = entries(value.emitted); const retainedSnapshot = entries(value.retainedSnapshot); const dependencyUnconfirmed = entries(value.dependencyUnconfirmed)
    return emitted === null || retainedSnapshot === null || dependencyUnconfirmed === null ? null : { emitted, retainedSnapshot, dependencyUnconfirmed }
  } catch { return null }
}

/** 逐行展示生成器记录的 fieldPath 与处理状态；解析失败不使用前端猜测作为替代。 */
export function formatScriptExecutionLog(preview: string): string[] {
  const status = readScriptExecutionStatus(preview)
  if (status === null) return ['未能读取本次预览中的 mapping.json.executionStatus；请重新生成预览，不能据此判断配置是否已写入执行包。']
  const sections: Array<[string, ScriptExecutionStatusEntry[]]> = [['已写入执行', status.emitted], ['仅保留快照', status.retainedSnapshot], ['依赖待确认', status.dependencyUnconfirmed]]
  return sections.flatMap(([label, items]) => items.map(item => `[${label}] ${item.fieldPath}：${item.detail}`))
}
