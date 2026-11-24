import type { MissionResultParameters } from '../results/mission-result'
import { LINK_TYPE_LABELS } from '../situation/situation-model'

export interface RunParameterComparisonRow {
  key: string
  group: '场景' | '链路' | '干扰机'
  id?: string
  type?: string
  index?: number
  field: string
  reference: string
  current: string
  changed: boolean
}

type SavedParameter = MissionResultParameters['links' | 'jammers'][number]
type Field<T> = readonly [key: keyof T, label: string, unit?: string]

function displayValue(value: unknown, unit?: string): string {
  if (value === undefined) return '未记录'
  if (typeof value === 'string' && Object.hasOwn(LINK_TYPE_LABELS, value)) {
    return LINK_TYPE_LABELS[value as keyof typeof LINK_TYPE_LABELS]
  }
  return unit === undefined ? String(value) : String(value) + ' ' + unit
}

function compareItems<T extends SavedParameter>(
  group: '链路' | '干扰机',
  reference: T[],
  current: T[],
  fields: readonly Field<T>[],
): RunParameterComparisonRow[] {
  const indexed = (items: T[]) => new Map(items.map((item, index) => [item.id, { item, index }] as const))
  const beforeById = indexed(reference)
  const afterById = indexed(current)
  const rows: RunParameterComparisonRow[] = []

  for (const id of new Set([...afterById.keys(), ...beforeById.keys()])) {
    const before = beforeById.get(id)
    const after = afterById.get(id)
    const entry = after ?? before
    if (entry === undefined) continue
    const context = {
      group, id, index: entry.index,
      ...('type' in entry.item ? { type: entry.item.type } : {}),
    }
    for (const [key, field, unit] of fields) {
      const previousValue = before?.item[key]
      const currentValue = after?.item[key]
      rows.push({
        ...context, key: group + '/' + id + '/' + field, field,
        reference: displayValue(previousValue, unit), current: displayValue(currentValue, unit),
        changed: previousValue !== currentValue,
      })
    }
  }
  return rows
}

export function compareRunParameters(reference: MissionResultParameters, current: MissionResultParameters): RunParameterComparisonRow[] {
  const countFields = [['platformCount', '节点数'], ['linkCount', '链路数'], ['jammerCount', '干扰机数']] as const
  return [
    ...countFields.map<RunParameterComparisonRow>(([key, field]) => ({
      key: '场景/' + field, group: '场景', field,
      reference: String(reference[key]), current: String(current[key]), changed: reference[key] !== current[key],
    })),
    ...compareItems('链路', reference.links, current.links, [
      ['type', '链路类型'],
      ['frequencyMHz', '频率', 'MHz'],
      ['bandwidthMHz', '带宽', 'MHz'],
      ['txPowerW', '发射功率', 'W'],
    ]),
    ...compareItems('干扰机', reference.jammers, current.jammers, [
      ['frequencyMHz', '频率', 'MHz'],
      ['bandwidthMHz', '带宽', 'MHz'],
      ['defaultPowerW', '默认功率', 'W'],
    ]),
  ]
}
