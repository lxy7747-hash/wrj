<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { LocalArchiveRecord } from '../../contracts/domain-models'
import { useAdminStore } from '../../stores/admin'
import { formatDateTime } from '../../features/shared/date-time'
import DataExchangeStateTag from '../data-exchange/DataExchangeStateTag.vue'

const store = useAdminStore()
const router = useRouter()
const query = ref('')
const selectedId = ref('')
const registering = ref(false)
const name = ref('')
const feedback = computed(() => store.maintenance.archive)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const rows = computed(() => store.localArchives.filter(row => [row.archiveId, row.name, row.createdBy, row.eventFile.fileName, row.positionFile.fileName]
  .some(value => value.toLowerCase().includes(query.value.trim().toLowerCase()))))
const selected = computed(() => rows.value.find(row => row.archiveId === selectedId.value))

async function register(): Promise<void> {
  if (await store.loadLocalArchives(name.value.trim())) {
    registering.value = false
    name.value = ''
    ElMessage.success('真实快照已登记；相同源文件重复登记保留原记录。')
  }
}
function open(row: LocalArchiveRecord, path: '/reports' | '/replays'): void {
  void router.push({ path, query: { archiveId: row.archiveId } })
}
onMounted(() => { void store.loadLocalArchives() })
onBeforeUnmount(() => store.resetMaintenance())
</script>

<template>
  <section class="maintenance-card" aria-label="仿真数据归档" data-testid="archive-panel">
    <header class="maintenance-toolbar">
      <h3>仿真数据管理</h3><DataExchangeStateTag :state="feedback.state" />
      <el-button :disabled="pending" @click="store.loadLocalArchives()">刷新归档</el-button>
      <el-button type="primary" :disabled="pending" data-testid="archive-create" @click="registering = true">登记当前快照</el-button>
    </header>
    <el-input v-model="query" clearable placeholder="检索名称、编号、登记人或来源文件" aria-label="归档检索" />
    <el-alert v-if="feedback.state === 'ERROR' && !registering" :title="feedback.message" type="error" :closable="false" data-testid="archive-feedback" />
    <el-table v-loading="pending" :data="rows" row-key="archiveId" stripe empty-text="暂无数据" data-testid="archive-table">
      <el-table-column prop="name" label="名称" min-width="150" />
      <el-table-column label="登记时间" min-width="180"><template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template></el-table-column>
      <el-table-column prop="createdBy" label="登记人" min-width="90" />
      <el-table-column prop="nodeCount" label="节点数" width="80" />
      <el-table-column prop="positionCount" label="位置记录" width="100" />
      <el-table-column label="数据归属" min-width="160"><template #default>未绑定场景或运行</template></el-table-column>
      <el-table-column label="操作" width="240" fixed="right"><template #default="{ row }">
        <el-button link type="primary" @click="selectedId = row.archiveId">详情</el-button>
        <el-button link type="primary" @click="open(row, '/replays')">历史回放</el-button>
        <el-button link type="primary" @click="open(row, '/reports')">评估报表</el-button>
      </template></el-table-column>
    </el-table>
    <el-dialog v-model="registering" title="登记当前真实快照" width="min(520px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!pending" :show-close="!pending">
      <p>保存当前事件和位置的解析快照及统计报告，不自动绑定场景或运行，不删除或修改原文件。</p>
      <el-form label-position="top" @submit.prevent="register">
        <el-form-item label="归档名称" required><el-input v-model="name" :maxlength="80" :disabled="pending" data-testid="archive-name" /></el-form-item>
      </el-form>
      <el-alert v-if="feedback.state === 'ERROR'" :title="feedback.message" type="error" :closable="false" />
      <template #footer><el-button :disabled="pending" @click="registering = false">取消</el-button><el-button type="primary" :disabled="!name.trim() || pending" :loading="pending" data-testid="archive-save" @click="register">确认登记</el-button></template>
    </el-dialog>
    <el-dialog :model-value="selected !== undefined" title="归档来源详情" width="min(680px, 94vw)" @close="selectedId = ''">
      <el-descriptions v-if="selected" :column="1" border data-testid="archive-detail">
        <el-descriptions-item label="归档编号">{{ selected.archiveId }}</el-descriptions-item>
        <el-descriptions-item label="名称">{{ selected.name }}</el-descriptions-item>
        <el-descriptions-item label="事件来源">{{ selected.eventFile.fileName }}</el-descriptions-item>
        <el-descriptions-item label="事件 SHA-256">{{ selected.eventFile.sha256 }}</el-descriptions-item>
        <el-descriptions-item label="位置来源">{{ selected.positionFile.fileName }}</el-descriptions-item>
        <el-descriptions-item label="位置 SHA-256">{{ selected.positionFile.sha256 }}</el-descriptions-item>
        <el-descriptions-item label="报告">{{ selected.reportId }}</el-descriptions-item>
        <el-descriptions-item label="数据归属">未绑定场景或运行</el-descriptions-item>
      </el-descriptions>
      <template #footer><el-button @click="selectedId = ''">关闭</el-button></template>
    </el-dialog>
  </section>
</template>
