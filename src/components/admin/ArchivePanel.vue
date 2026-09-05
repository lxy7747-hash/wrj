<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { ArchiveRecord } from '../../contracts/domain-models'
import { useAdminStore } from '../../stores/admin'
import DataExchangeStateTag from '../data-exchange/DataExchangeStateTag.vue'

const store = useAdminStore()
const router = useRouter()
const query = ref('')
const selectedId = ref('')
const feedback = computed(() => store.maintenance.archive)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const rows = computed(() => store.archives.filter((record) => Object.values(record).some((value) => value.toLowerCase().includes(query.value.trim().toLowerCase()))))
const selected = computed(() => rows.value.find((record) => record.archiveId === selectedId.value))

/** 展示所选归档的同源编号关系；详情不复制接口数据。 */
function showDetail(row: ArchiveRecord): void { selectedId.value = row.archiveId }

/** 根据归档中的真实报告编号进入既有报表页面。 */
function openReport(): void {
  if (selected.value) void router.push({ path: '/reports', query: { reportId: selected.value.reportId } })
}

onMounted(() => { void store.loadMaintenance('archive') })
onBeforeUnmount(() => store.resetMaintenance())
</script>

<template>
  <section class="maintenance-card" aria-label="仿真数据归档" data-testid="archive-panel">
    <header class="maintenance-toolbar"><h3>仿真数据管理</h3><DataExchangeStateTag :state="feedback.state" /><el-button :disabled="pending" @click="store.loadMaintenance('archive')">刷新归档</el-button></header>
    <el-input v-model="query" clearable placeholder="检索归档、任务、场景、运行、回放或报告编号" aria-label="归档检索" />
    <el-alert :title="feedback.message" :type="feedback.state === 'ERROR' ? 'error' : 'info'" :closable="false" />
    <el-table v-loading="pending" :data="rows" stripe empty-text="暂无匹配归档" data-testid="archive-table">
      <el-table-column prop="archiveId" label="归档" min-width="130" /><el-table-column prop="taskId" label="任务" min-width="130" /><el-table-column prop="scenarioId" label="场景" min-width="130" /><el-table-column prop="runId" label="运行" min-width="130" />
      <el-table-column label="状态" width="100"><template #default>已建立索引</template></el-table-column><el-table-column label="操作" width="90" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="showDetail(row)">详情</el-button></template></el-table-column>
    </el-table>
    <el-dialog :model-value="selected !== undefined" title="归档关联详情" width="min(560px, 94vw)" @close="selectedId = ''">
      <el-descriptions v-if="selected" :column="1" border data-testid="archive-detail"><el-descriptions-item label="归档">{{ selected.archiveId }}</el-descriptions-item><el-descriptions-item label="任务">{{ selected.taskId }}</el-descriptions-item><el-descriptions-item label="场景">{{ selected.scenarioId }}</el-descriptions-item><el-descriptions-item label="运行">{{ selected.runId }}</el-descriptions-item><el-descriptions-item label="回放">{{ selected.replayId }}</el-descriptions-item><el-descriptions-item label="报告">{{ selected.reportId }}</el-descriptions-item></el-descriptions>
      <template #footer><el-button @click="selectedId = ''">关闭</el-button><el-button type="primary" @click="openReport">查看关联报告</el-button></template>
    </el-dialog>
  </section>
</template>
