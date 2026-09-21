<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  title: string
  unit: string
  rows: Array<{ label: string; value: number }>
  radar?: boolean
}>()
const rows = computed(() => props.rows.filter(row => Number.isFinite(row.value)))
const maximum = computed(() => props.radar ? 100 : Math.max(1, ...rows.value.map(row => row.value)))
function point(index: number, ratio: number): string {
  const angle = index * Math.PI * 2 / rows.value.length - Math.PI / 2
  return `${150 + 90 * ratio * Math.cos(angle)},${120 + 90 * ratio * Math.sin(angle)}`
}
const polygon = computed(() => rows.value.map((row, index) => point(index, row.value / maximum.value)).join(' '))
</script>

<template>
  <section class="report-chart" :aria-label="title">
    <h4>{{ title }}<small>（{{ unit }}）</small></h4>
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
    <div v-else class="bars">
      <div v-for="row in rows" :key="row.label" class="bar-row">
        <span>{{ row.label }}</span>
        <div class="bar-track"><div :style="{ width: `${Math.max(0, row.value) / maximum * 100}%` }" /></div>
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
.bar-track { background: var(--el-fill-color); height: 12px; border-radius: 4px; }
.bar-track div { background: var(--console-cyan); height: 100%; border-radius: 4px; }
</style>
