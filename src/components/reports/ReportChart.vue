<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, RadarChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { ECharts } from 'echarts/core'
import { formatDateTime } from '../../features/shared/date-time'
import { reportTime } from '../../features/reports/local-report'
import { buildLineChartPoints, formatChartMinutesSeconds, formatLineChartTooltip } from '../../features/reports/chart-tooltip'

echarts.use([LineChart, BarChart, RadarChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer])

const props = withDefaults(defineProps<{
  title: string
  unit: string
  rows: Array<{ label: string; value: number; time?: number; breakBefore?: boolean; displayValue?: string }>
  radar?: boolean
  line?: boolean
  stepEnd?: boolean
  sourceRange?: string
  generatedTime?: string
  /** 质量曲线使用 ECharts；历史 SVG 实现保留给其他图表和兼容测试。 */
  useEcharts?: boolean
  showPointList?: boolean
  invalidValue?: number
  hideSource?: boolean
  /** 折线图横轴使用报表已应用的时间范围。 */
  xMin?: number
  xMax?: number
  scopeSummary?: string
}>(), { useEcharts: false, showPointList: true, hideSource: false })

const MAX_RENDER_POINTS = 5000
const rawRows = computed(() => {
  let gap = false
  return props.rows.flatMap(row => {
    if (!Number.isFinite(row.value) || row.value === props.invalidValue) { gap = true; return [] }
    const point = props.line && gap ? { ...row, breakBefore: true } : row
    gap = false
    return [point]
  })
})

/** 强制点：首/末、极值、断点及其前一点。 */
function forcedIndices(all: Array<{ value: number; breakBefore?: boolean }>): Set<number> {
  if (!all.length) return new Set()
  let min = 0, max = 0
  all.forEach((row, index) => { if (row.value < all[min]!.value) min = index; if (row.value > all[max]!.value) max = index })
  const forced = new Set<number>([0, all.length - 1, min, max])
  all.forEach((row, index) => { if (row.breakBefore) { forced.add(index); if (index > 0) forced.add(index - 1) } })
  return forced
}
const lineViews = computed(() => {
  const all = rawRows.value
  if (all.length <= MAX_RENDER_POINTS) return [all]
  const forced = forcedIndices(all)
  if (forced.size > MAX_RENDER_POINTS) {
    // 强制点超单图预算：按稳定顺序分段渲染多图（每图 ≤ 预算），不丢点、不跨真实断点连线。
    const ordered = [...forced].sort((left, right) => left - right)
    const pages: typeof all[] = []
    for (let index = 0; index < ordered.length; index += MAX_RENDER_POINTS) pages.push(ordered.slice(index, index + MAX_RENDER_POINTS).map(pointIndex => all[pointIndex]!))
    return pages
  }
  const chosen = new Set(forced)
  const room = MAX_RENDER_POINTS - chosen.size
  const step = all.length / (room + 1)
  for (let n = 1; n <= room; n += 1) chosen.add(Math.min(all.length - 1, Math.round(step * n)))
  return [[...chosen].sort((left, right) => left - right).map(index => all[index]!)]
})
function metrics(rows: Array<{ label: string; value: number; time?: number; breakBefore?: boolean }>) {
  const values = rows.map(row => row.value)
  const minimum = Math.min(...values), maximum = Math.max(...values), span = (maximum - minimum) || 1
  const times = rows.map((row, index) => row.time ?? index)
  const startTime = props.xMin ?? Math.min(...times), endTime = props.xMax ?? Math.max(...times)
  const timeSpan = Math.max(1e-12, endTime - startTime)
  const points = rows.map((row, index) => {
    const x = rows.length === 1 && startTime === endTime ? 160 : 40 + ((row.time ?? index) - startTime) / timeSpan * 230
    const y = 190 - (row.value - minimum) / span * 150
    return { x, y, label: row.label, value: row.value }
  })
  const segments: string[] = [], current: string[] = []
  rows.forEach((row, index) => { if (row.breakBefore && current.length) { segments.push(current.join(' ')); current.length = 0 } current.push(`${points[index]!.x.toFixed(2)},${points[index]!.y.toFixed(2)}`) })
  if (current.length) segments.push(current.join(' '))
  return { minimum, maximum, startTime, endTime, points, segments }
}
const views = computed(() => props.line ? lineViews.value.map(rows => ({ rows, ...metrics(rows) })) : [])

const rows = rawRows
const maximum = computed(() => props.radar ? 100 : Math.max(1, ...rows.value.map(row => row.value)))
const barMinimum = computed(() => Math.min(0, ...rows.value.map(row => row.value)))
const barRange = computed(() => Math.max(1, Math.max(0, ...rows.value.map(row => row.value)) - barMinimum.value))
const barZero = computed(() => -barMinimum.value / barRange.value * 100)
function point(index: number, ratio: number): string {
  const angle = index * Math.PI * 2 / rows.value.length - Math.PI / 2
  return `${150 + 90 * ratio * Math.cos(angle)},${120 + 90 * ratio * Math.sin(angle)}`
}
const polygon = computed(() => rows.value.map((row, index) => point(index, row.value / maximum.value)).join(' '))

const echartsEnabled = computed(() => props.useEcharts && import.meta.env.MODE !== 'test')
const chartHeight = computed(() => props.radar ? 330 : 230)
const chartEl = ref<HTMLElement | null>(null)
let refreshOptions: (() => void) | undefined
function echartsOption(): Record<string, unknown> {
  const data = rows.value
  if (props.radar) return {
    animation: false,
    tooltip: { trigger: 'item' },
    radar: { indicator: data.map(row => ({ name: row.label, max: 100 })), radius: '62%', center: ['50%', '50%'], axisName: { color: '#9eb4cb', fontSize: 12 } },
    series: [{ type: 'radar', data: [{ value: data.map(row => row.value), name: props.title }],
      areaStyle: { color: 'rgba(111, 195, 255, 0.2)' }, lineStyle: { color: '#6fc3ff' }, itemStyle: { color: '#6fc3ff' } }],
  }
  if (props.line) {
    const points = buildLineChartPoints(data)
    const xMin = props.xMin ?? 0
    const xMax = props.xMax ?? (data.length ? (data.at(-1)!.time ?? data.length - 1) : xMin)
    return {
      animation: false,
      grid: { left: 12, right: 18, top: 30, bottom: 28, containLabel: true },
      tooltip: { trigger: 'axis', formatter: (params: unknown) => formatLineChartTooltip(params, props.unit) },
      xAxis: {
        type: 'value',
        min: xMin,
        max: xMax,
        splitLine: { show: false },
        axisLabel: { color: '#9eb4cb', fontSize: 10, formatter: (value: number) => reportTime(value) },
        axisPointer: { label: { formatter: (params: { value: unknown }) => formatChartMinutesSeconds(Number(params.value)) } },
        axisLine: { lineStyle: { color: '#526a82' } },
      },
      yAxis: { type: 'value', minInterval: props.stepEnd ? 1 : undefined, name: props.unit, nameLocation: 'end', nameGap: 8, nameTextStyle: { color: '#9eb4cb', fontSize: 10 }, axisLabel: { color: '#9eb4cb', fontSize: 10, margin: 6 }, splitLine: { lineStyle: { color: 'rgba(158, 180, 203, 0.18)' } } },
      series: [{ type: 'line', data: points, step: props.stepEnd ? 'end' : false, symbol: 'none', connectNulls: false, lineStyle: { color: '#6fc3ff', width: 2 }, itemStyle: { color: '#6fc3ff' } }],
    }
  }
  return {
    animation: false,
    grid: { left: 12, right: 18, top: 30, bottom: 28, containLabel: true },
    tooltip: { trigger: 'axis', valueFormatter: (value: unknown, index: number) => data[index]?.displayValue ?? (value == null ? '暂无数据' : `${String(value)} ${props.unit}`) },
    xAxis: { type: 'category', data: data.map(row => row.label), splitLine: { show: false }, axisLabel: { color: '#9eb4cb', fontSize: 10 }, axisLine: { lineStyle: { color: '#526a82' } } },
    yAxis: { type: 'value', name: props.unit, nameLocation: 'end', nameGap: 8, nameTextStyle: { color: '#9eb4cb', fontSize: 10 }, axisLabel: { color: '#9eb4cb', fontSize: 10, margin: 6 }, splitLine: { lineStyle: { color: 'rgba(158, 180, 203, 0.18)' } } },
    series: [{ type: 'bar', barMaxWidth: '60%', itemStyle: { color: '#6fc3ff' },
      data: data.map(row => row.displayValue === undefined ? row.value : { value: row.value,
        label: { show: true, position: row.value < 0 ? 'bottom' : 'top', color: '#9eb4cb', formatter: () => row.displayValue } }),
    }],
  }
}
watch(chartEl, (host, _previous, onCleanup) => {
  if (!host) return
  let instance: ECharts | undefined
  let renderedWidth = 0, renderedHeight = 0
  let updateOptions = true
  const syncChart = (): void => {
    if (chartEl.value !== host) return
    const width = host.clientWidth, height = chartHeight.value
    if (width <= 0) return
    if (!instance) {
      instance = echarts.init(host, undefined, { renderer: 'svg', width, height })
      updateOptions = true
    } else if (width !== renderedWidth || height !== renderedHeight) instance.resize({ width, height })
    renderedWidth = width
    renderedHeight = height
    if (updateOptions) {
      instance.setOption(echartsOption(), true)
      updateOptions = false
    }
  }
  refreshOptions = () => { updateOptions = true; syncChart() }
  const onResize = () => syncChart()
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onResize)
  if (observer) observer.observe(host)
  else window.addEventListener('resize', onResize)
  syncChart()
  onCleanup(() => {
    observer?.disconnect()
    if (!observer) window.removeEventListener('resize', onResize)
    instance?.dispose()
    refreshOptions = undefined
  })
}, { flush: 'post' })
watch(() => [props.rows, props.radar, props.line, props.stepEnd, props.invalidValue, props.xMin, props.xMax, props.unit, props.title],
  () => refreshOptions?.(), { deep: true, flush: 'post' })
</script>

<template>
  <section class="report-chart" :class="{ 'report-chart--radar': radar }" :aria-label="title">
    <h4>{{ title }}<small v-if="unit">（{{ unit }}）</small></h4>
    <p v-if="!hideSource && (sourceRange || generatedTime)">{{ sourceRange }}<span v-if="generatedTime"> · 生成时刻 {{ formatDateTime(generatedTime) }}</span></p>
    <p v-if="line && scopeSummary !== undefined" class="report-chart__summary">当前范围统计 <strong>{{ scopeSummary }}</strong></p>
    <el-empty v-if="!rows.length" description="暂无数据" :image-size="60" />
    <div v-else-if="echartsEnabled" ref="chartEl" class="report-chart__canvas" role="img" :aria-label="title" :style="{ height: `${chartHeight}px` }" />
    <template v-else-if="radar">
      <!-- 仅比较同量纲的连通率，不把缺失值当零，也不构造综合评分。 -->
      <p v-if="rows.length < 3">有效链路不足三条，按数值展示连通率。</p>
      <svg v-else viewBox="0 0 300 240" role="img" :aria-label="`${title}，范围 0–100%`">
        <circle cx="150" cy="120" r="90" fill="none" stroke="currentColor" opacity="0.3" />
        <line v-for="(row, index) in rows" :key="row.label" x1="150" y1="120" :x2="point(index, 1).split(',')[0]" :y2="point(index, 1).split(',')[1]" stroke="currentColor" opacity="0.3" />
        <polygon :points="polygon" fill="var(--console-cyan)" fill-opacity="0.2" stroke="var(--console-cyan)" />
      </svg>
      <ol><li v-for="row in rows" :key="row.label">{{ row.label }}：{{ row.value }} {{ unit }}</li></ol>
    </template>
    <template v-else-if="line">
      <div v-for="(view, viewIndex) in views" :key="viewIndex" class="line-chart-segment" :data-segment="viewIndex">
        <svg viewBox="0 0 300 230" role="img" :aria-label="`${title}，第 ${viewIndex + 1} 段，纵轴 ${view.minimum} 至 ${view.maximum} ${unit}`">
          <line x1="40" y1="20" x2="40" y2="190" stroke="currentColor" opacity="0.45" />
          <line x1="40" y1="190" x2="280" y2="190" stroke="currentColor" opacity="0.45" />
          <text x="2" y="27" font-size="10">{{ view.maximum }}</text><text x="2" y="190" font-size="10">{{ view.minimum }}</text>
          <text x="40" y="207" font-size="10">{{ view.startTime }}</text><text x="245" y="207" font-size="10">{{ view.endTime }} 秒</text>
          <polyline v-for="(segment, index) in view.segments" :key="index" :points="segment" fill="none" stroke="var(--console-cyan)" stroke-width="2" />
          <circle v-for="(pt, index) in view.points" :key="`${viewIndex}-${index}`" :cx="pt.x" :cy="pt.y" r="3" fill="var(--console-cyan)">
            <title>{{ pt.label }}：{{ pt.value }} {{ unit }}</title>
          </circle>
        </svg>
        <ol v-if="showPointList"><li v-for="(pt, index) in view.points" :key="`${viewIndex}-l-${index}`">{{ pt.label }}：{{ pt.value }} {{ unit }}</li></ol>
      </div>
    </template>
    <div v-else class="bars">
      <div v-for="row in rows" :key="row.label" class="bar-row">
        <span>{{ row.label }}</span>
        <div class="bar-track">
          <div :style="{ left: `${(Math.min(0, row.value) - barMinimum) / barRange * 100}%`, width: `${Math.abs(row.value) / barRange * 100}%` }" />
          <i v-if="barMinimum < 0" class="bar-zero" :style="{ left: `${barZero}%` }" aria-hidden="true" />
        </div>
        <strong>{{ row.displayValue ?? `${row.value} ${unit}` }}</strong>
      </div>
    </div>
  </section>
</template>

<style scoped>
.report-chart { min-width: 0; width: 100%; max-width: 100%; overflow-wrap: anywhere; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 6px; }
.report-chart--radar { display: flex; flex-direction: column; align-items: center; text-align: center; }
.report-chart__canvas { min-width: 0; width: 100%; }
.report-chart__summary { margin: 0 0 8px; color: var(--el-text-color-secondary); }
h4 { margin: 0 0 12px; } small { font-weight: normal; }
svg { display: block; max-width: 360px; width: 100%; }
.line-chart-segment { margin-bottom: 8px; }
.bars { display: grid; gap: 10px; }
.bar-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 0.5fr); gap: 12px; align-items: center; }
.bar-track { position: relative; background: var(--el-fill-color); height: 12px; border-radius: 4px; }
.bar-track div { position: absolute; background: var(--console-cyan); height: 100%; border-radius: 4px; }
.bar-zero { position: absolute; top: -2px; bottom: -2px; border-left: 1px solid var(--console-text-muted); }
</style>
