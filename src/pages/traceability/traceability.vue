<script setup lang="ts">
import { onMounted } from 'vue'
import { useTraceabilityStore } from '../../stores/traceability'

const store = useTraceabilityStore()
onMounted(() => { if (store.metadata === null) void store.loadMetadata() })
</script>

<template>
  <section class="page traceability-page" aria-labelledby="page-traceability">
    <h2 id="page-traceability">需求追踪</h2>
    <p>29 项能力与 7 类接口使用同一份接口目录；进入说明可查看对应功能入口和合同边界。</p>
    <el-input v-model="store.query" aria-label="筛选需求或接口" placeholder="搜索编号、名称或模块" clearable />
    <el-alert v-if="store.state === 'ERROR'" :title="store.message" type="error" :closable="false" />
    <el-button :loading="store.state === 'LOADING'" @click="store.loadMetadata()">刷新目录</el-button>
    <p role="status">共 {{ store.rows.length }} 项</p>
    <el-table :data="store.rows" row-key="id" data-testid="traceability-table" empty-text="没有匹配的需求或接口">
      <el-table-column prop="kind" label="类别" width="75" />
      <el-table-column prop="id" label="需求或接口编号" min-width="340" />
      <el-table-column prop="name" label="名称" min-width="240" />
      <el-table-column prop="group" label="模块" min-width="180" />
      <el-table-column label="定位" width="110" fixed="right">
        <template #default="{ row }"><router-link :to="store.resolveDestination(row.destination)!">查看说明</router-link></template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.traceability-page { overflow: auto; }
.el-input { max-width: 32rem; margin: 0 var(--space-3) var(--space-3) 0; }
p { color: var(--console-text-muted); }
a { color: var(--console-cyan); text-underline-offset: 3px; }
</style>
