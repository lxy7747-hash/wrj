export interface LineChartRowInput {
  value: number
  time?: number
  breakBefore?: boolean
}

export type LineChartPoint =
  | [number, number | null]
  | { value: [number, number]; symbol: 'circle'; symbolSize: number }

export interface EChartsTooltipItem {
  axisValue?: unknown
  value?: unknown
  data?: unknown
  marker?: string
  seriesName?: string
}

/** 将秒数格式化为「XX分xx秒」（两位补零，小数秒保留最多 3 位），供折线图悬浮提示展示。 */
export function formatChartMinutesSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '暂无数据'
  const sign = seconds < 0 ? '-' : ''
  const rounded = Math.round(Math.abs(seconds) * 1000) / 1000
  const minutes = Math.floor(rounded / 60)
  const remainder = Number((rounded % 60).toFixed(3))
  const wholeSeconds = Math.floor(remainder)
  const frac = Number((remainder - wholeSeconds).toFixed(3))
  const minText = String(minutes).padStart(2, '0')
  const secText = frac > 0
    ? `${String(wholeSeconds).padStart(2, '0')}${String(frac).slice(1)}`
    : String(wholeSeconds).padStart(2, '0')
  return `${sign}${minText}分${secText}秒`
}

/** 生成 ECharts 折线点序列：断点占位放在相邻两点的中点，避免与有效采样点共用横坐标。 */
export function buildLineChartPoints(data: readonly LineChartRowInput[]): LineChartPoint[] {
  const points: LineChartPoint[] = []
  data.forEach((row, index) => {
    const time = row.time ?? index
    if (index > 0 && row.breakBefore) {
      const prevTime = data[index - 1]!.time ?? (index - 1)
      const gapTime = time > prevTime ? (prevTime + time) / 2 : time
      points.push([gapTime, null])
    }
    const isolated = (index === 0 || row.breakBefore) && (index === data.length - 1 || data[index + 1]?.breakBefore)
    points.push(isolated ? { value: [time, row.value], symbol: 'circle', symbolSize: 6 } : [time, row.value])
  })
  return points
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function extractPointCoords(item: EChartsTooltipItem): { x: number; y: number } | null {
  const raw = Array.isArray(item.value)
    ? item.value
    : (item.data && typeof item.data === 'object' && Array.isArray((item.data as { value?: unknown }).value)
      ? (item.data as { value: unknown[] }).value
      : null)
  const x = raw ? Number(raw[0]) : Number(item.axisValue)
  const y = raw ? raw[1] : item.value
  if (!Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) return null
  return { x, y }
}

/** 格式化折线图悬浮提示：横轴时刻按「XX分xx秒」展示，过滤掉断点产生的 null 占位，绝不出现「null 秒」。 */
export function formatLineChartTooltip(params: unknown, unit: string): string {
  const items: EChartsTooltipItem[] = Array.isArray(params)
    ? params
    : (params && typeof params === 'object' ? [params as EChartsTooltipItem] : [])
  const valid = items
    .map(item => {
      const coords = extractPointCoords(item)
      return coords ? { item, ...coords } : null
    })
    .filter((entry): entry is { item: EChartsTooltipItem; x: number; y: number } => entry !== null)
  if (!valid.length) return ''
  const header = formatChartMinutesSeconds(valid[0]!.x)
  const unitSuffix = unit ? ` ${escapeHtml(unit)}` : ''
  const lines = valid.map(({ item, y }) => {
    const marker = typeof item.marker === 'string' ? item.marker : ''
    const label = item.seriesName && !/^series\d+$/u.test(item.seriesName) ? `${escapeHtml(item.seriesName)}：` : ''
    return `<div>${marker}${label}<strong>${y}${unitSuffix}</strong></div>`
  })
  return `<div style="font-variant-numeric:tabular-nums"><div style="margin-bottom:4px">${escapeHtml(header)}</div>${lines.join('')}</div>`
}
