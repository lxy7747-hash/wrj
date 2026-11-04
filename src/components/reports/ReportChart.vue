<script setup lang="ts">
import { computed } from 'vue'
import { formatDateTime } from '../../features/shared/date-time'

const props = defineProps<{
  title: string
  unit: string
  rows: Array<{ label: string; value: number; time?: number; breakBefore?: boolean }>
  radar?: boolean
  line?: boolean
  sourceRange?: string
  generatedTime?: string
}>()
const rows = computed(() => props.rows.filter(row => Number.isFinite(row.value)))
const maximum = computed(() => props.radar ? 100 : Math.max(1, ...rows.value.map(row => row.value)))
const barMinimum = computed(() => Math.min(0, ...rows.value.map(row => row.value)))
const barRange = computed(() => Math.max(1, Math.max(0, ...rows.value.map(row => row.value)) - barMinimum.value))
const barZero = computed(() => -barMinimum.value / barRange.value * 100)
const lineMinimum = computed(() => Math.min(...rows.value.map(row => row.value)))
const lineMaximum = computed(() => Math.max(...rows.value.map(row => row.value)))
const lineRange = computed(() => Math.max(1e-12, lineMaximum.value - lineMinimum.value))
const lineStartTime = computed(() => Math.min(...rows.value.map((row, index) => row.time ?? index)))
const lineEndTime = computed(() => Math.max(...rows.value.map((row, index) => row.time ?? index)))
const lineTimeRange = computed(() => Math.max(1e-12, lineEndTime.value - lineStartTime.value))
function lineX(row: { time?: number }, index: number): number {
  const time = row.time ?? index
  return rows.value.length === 1 ? 160 : 40 + (time - lineStartTime.value) / lineTimeRange.value * 230
}
function lineY(row: { value: number }): number { return 190 - (row.value - lineMinimum.value) / lineRange.value * 150 }
const lineSegments = computed(() => {
  const segments: string[] = [], current: string[] = []
  rows.value.forEach((row, index) => {
    if (row.breakBefore && current.length) { segments.push(current.join(' ')); current.length = 0 }
    current.push(`${lineX(row, index).toFixed(2)},${lineY(row).toFixed(2)}`)
  })
  if (current.length) segments.push(current.join(' '))
  return segments
})
function point(index: number, ratio: number): string {
  const angle = index * Math.PI * 2 / rows.value.length - Math.PI / 2
  return `${150 + 90 * ratio * Math.cos(angle)},${120 + 90 * ratio * Math.sin(angle)}`
}
const polygon = computed(() => rows.value.map((row, index) => point(index, row.value / maximum.value)).join(' '))
</script>

<template>
  <section class="report-chart" :aria-label="title">
    <h4>{{ title }}<small>（{{ unit }}）</small></h4>
    <p v-if="sourceRange || generatedTime">{{ sourceRange }}<span v-if="generatedTime"> · 生成时刻 {{ formatDateTime(generatedTime) }}</span></p>
    <el-empty v-if="!rows.length || (radar && rows.length < 3)" description="暂无数据" :image-size="60" />
    <template v-else-if="radar">
      <!-- 仅比较同量纲的连通率，不把缺失值当零，也不构造综合评分。 -->
      <svg viewBox="0 0 300 240" role="img" :aria-label="`${title}，范围 0–100%`">
        <circle cx="150" cy="120" r="90" fill="none" stroke="currentColor" opacity="0.3" />
        <line v-for="(row, index) in rows" :key="row.label" x1="150" y1="120" :x2="point(index, 1).split(',')[0]" :y2="point(index, 1).split(',')[1]" stroke="currentColor" opacity="0.3" />
        <polygon :points="polygon" fill="var(--console-cyan)" fill-opacity="0.2" stroke="var(--console-cyan)" />
      </svg>
      <ol><li v-for="row in rows" :key="row.label">{{ row.label }}：{{ row.value }} {{ unit }}</li></ol>
    </template>
    <template v-else-if="line">
      <svg viewBox="0 0 300 230" role="img" :aria-label="`${title}，纵轴 ${lineMinimum} 至 ${lineMaximum} ${unit}`">
        <line x1="40" y1="20" x2="40" y2="190" stroke="currentColor" opacity="0.45" />
        <line x1="40" y1="190" x2="280" y2="190" stroke="currentColor" opacity="0.45" />
        <text x="2" y="27" font-size="10">{{ lineMaximum }}</text><text x="2" y="190" font-size="10">{{ lineMinimum }}</text>
        <text x="40" y="207" font-size="10">{{ lineStartTime }}</text><text x="245" y="207" font-size="10">{{ lineEndTime }} 秒</text>
        <polyline v-for="(segment, index) in lineSegments" :key="index" :points="segment" fill="none" stroke="var(--console-cyan)" stroke-width="2" />
        <circle v-for="(row, index) in rows" :key="`${row.label}-${index}`" :cx="lineX(row, index)" :cy="lineY(row)" r="3" fill="var(--console-cyan)" />
      </svg>
      <ol><li v-for="(row, index) in rows" :key="`${row.label}-${index}`">{{ row.label }}：{{ row.value }} {{ unit }}</li></ol>
    </template>
    <div v-else class="bars">
      <div v-for="row in rows" :key="row.label" class="bar-row">
        <span>{{ row.label }}</span>
        <div class="bar-track">
          <div :style="{ left: `${(Math.min(0, row.value) - barMinimum) / barRange * 100}%`, width: `${Math.abs(row.value) / barRange * 100}%` }" />
          <i v-if="barMinimum < 0" class="bar-zero" :style="{ left: `${barZero}%` }" aria-hidden="true" />
        </div>
        <strong>{{ row.value }} {{ unit }}</strong>
      </div>
    </div>
  </section>
</template>

<style scoped>
.report-chart { min-width: 0; max-width: 100%; overflow-wrap: anywhere; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 6px; }
h4 { margin: 0 0 12px; } small { font-weight: normal; }
svg { display: block; max-width: 360px; width: 100%; }
.bars { display: grid; gap: 10px; }
.bar-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 0.5fr); gap: 12px; align-items: center; }
.bar-track { position: relative; background: var(--el-fill-color); height: 12px; border-radius: 4px; }
.bar-track div { position: absolute; background: var(--console-cyan); height: 100%; border-radius: 4px; }
.bar-zero { position: absolute; top: -2px; bottom: -2px; border-left: 1px solid var(--console-text-muted); }
</style>
