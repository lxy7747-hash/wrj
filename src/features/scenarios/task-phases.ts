/** 阶段来自已保存的任务计划；不从仿真输出猜测阶段或人为均分时间。 */
export function taskPhaseIssue(value: unknown, duration = Infinity): { fieldPath: string; message: string } | null {
  if (value === undefined) return null
  const issue = (fieldPath: string, message: string) => ({ fieldPath: `scenario.phases${fieldPath}`, message })
  if (!Array.isArray(value) || value.length > 64) return issue('', '任务阶段须为数组，最多64个。')
  const ids = new Set<string>(), ranges: Array<{ start: number; end: number; index: number }> = []
  for (const [index, phase] of value.entries()) {
    if (!phase || typeof phase !== 'object' || Array.isArray(phase) || Object.keys(phase).length !== 4
      || !['id', 'name', 'startTimeS', 'endTimeS'].every(key => Object.hasOwn(phase, key))) return issue(`[${index}]`, '任务阶段结构不正确。')
    if (typeof phase.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(phase.id) || ids.has(phase.id)) return issue(`[${index}].id`, '阶段编号须唯一，为1～64位字母、数字、下划线或连字符。')
    if (typeof phase.name !== 'string' || !phase.name.trim() || phase.name.length > 80) return issue(`[${index}].name`, '阶段名称须为1～80个字符。')
    if (typeof phase.startTimeS !== 'number' || !Number.isFinite(phase.startTimeS) || phase.startTimeS < 0
      || typeof phase.endTimeS !== 'number' || !Number.isFinite(phase.endTimeS) || phase.endTimeS <= phase.startTimeS || phase.endTimeS > duration) return issue(`[${index}].endTimeS`, '阶段时间须在任务总时长内，结束时刻须晚于开始时刻。')
    ids.add(phase.id); ranges.push({ start: phase.startTimeS, end: phase.endTimeS, index })
  }
  ranges.sort((a, b) => a.start - b.start)
  for (let index = 1; index < ranges.length; index++) if (ranges[index]!.start < ranges[index - 1]!.end) return issue(`[${ranges[index]!.index}].startTimeS`, '任务阶段时间区间不能重叠。')
  return null
}
