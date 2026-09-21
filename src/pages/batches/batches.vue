<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import BatchRunTable from '../../components/batches/BatchRunTable.vue'
import type { Batch } from '../../contracts/domain-models'
import { useBatchStore } from '../../stores/batch'

const batchStore = useBatchStore()
const router = useRouter()
const { batch, runs, aggregateReport, selectedRunId, capabilityState, resultMessage, validationIssues } = storeToRefs(batchStore)
const powerText = computed(() => batchStore.form.powersW.join(', '))
const distanceText = computed(() => batchStore.form.distancesKm.join(', '))

const selectedRun = computed(() => runs.value.find((run) => run.runId === selectedRunId.value) ?? null)
const combinationCount = computed(() => batchStore.form.powersW.length * batchStore.form.distancesKm.length)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(capabilityState.value))
const canStart = computed(() => batch.value?.state === 'QUEUED')
const canCancel = computed(() => batch.value?.state === 'QUEUED' || batch.value?.state === 'RUNNING')

/** 将批次状态转换为中文。 */
function batchStateLabel(state: Batch['state'] | undefined): string {
  return ({
    DRAFT: '草稿', VALIDATING: '校验中', QUEUED: '已排队', RUNNING: '运行中', COMPLETED: '已完成',
    PARTIAL_FAILURE: '部分失败', CANCELLED: '已取消', ERROR: '错误',
  } as const)[state ?? 'DRAFT']
}

/** 返回批次状态对应的 Element Plus 标签类型。 */
function batchStateType(state: Batch['state'] | undefined): 'success' | 'warning' | 'danger' | 'info' {
  if (state === 'COMPLETED') return 'success'
  if (state === 'PARTIAL_FAILURE' || state === 'ERROR') return 'danger'
  if (state === 'QUEUED' || state === 'RUNNING') return 'warning'
  return 'info'
}

/** 校验当前批量参数矩阵并更新可见反馈。 */
function validateForm(): void {
  batchStore.validate()
}

/** 创建新的 BATCH-001 排队任务。 */
async function createBatch(): Promise<void> {
  await batchStore.create()
}

/** 启动当前排队批次并加载确定性对比结果。 */
async function startBatch(): Promise<void> {
  await batchStore.command('START')
}

/** 取消当前排队或运行中的批次。 */
async function cancelBatch(): Promise<void> {
  await batchStore.command('CANCEL')
}

/** 跳转评估报表并选择当前批次的三级聚合报告。 */
async function openAggregateReport(): Promise<void> {
  if (aggregateReport.value === null) return
  await router.push({ path: '/reports', query: { reportId: aggregateReport.value.reportId } })
}

onMounted(() => { void batchStore.loadComparison() })
onBeforeUnmount(() => batchStore.resetToSafeEmpty())
</script>

<template>
  <section class="batches-page" aria-labelledby="batches-title">
    <header class="batches-page__header">
<!--      <div>-->
<!--        <p class="eyebrow">参数遍历与批次编排</p>-->
<!--        <h2 id="batches-title">批量仿真</h2>-->
<!--        <p>按固定顺序组合功率和通信距离，生成 12 个运行及其报告。</p>-->
<!--      </div>-->
      <div class="batches-page__actions">
        <el-tag :type="batchStateType(batch?.state)" effect="plain">{{ batchStateLabel(batch?.state) }}</el-tag>
        <el-button :disabled="!aggregateReport || pending" @click="openAggregateReport">查看聚合报告</el-button>
      </div>
    </header>

    <main class="batches-page__body">
      <el-card class="batch-form" shadow="never" aria-label="批量参数配置">
        <template #header>
          <div class="panel-title"><strong>批量参数配置</strong><span>{{ combinationCount }} 个组合</span></div>
        </template>
        <el-form label-position="top">
          <el-form-item label="场景编号">
            <el-input :model-value="batchStore.form.scenarioId" readonly data-testid="batch-scenario" />
          </el-form-item>
          <el-form-item label="发射功率（W，逗号分隔）">
            <el-input :model-value="powerText" readonly data-testid="batch-powers" />
          </el-form-item>
          <el-form-item label="通信距离（km，逗号分隔）">
            <el-input :model-value="distanceText" readonly data-testid="batch-distances" />
          </el-form-item>
          <div class="batch-form__order">
            <span>组合顺序</span><el-tag type="info" effect="plain">功率优先、距离递增</el-tag>
          </div>
        </el-form>
        <el-alert
          v-if="validationIssues.length"
          type="error"
          :closable="false"
          :title="validationIssues.join('；')"
        />
        <div class="batch-form__actions">
          <el-button :disabled="pending" @click="validateForm">校验参数</el-button>
          <el-button type="primary" data-testid="batch-create" :loading="capabilityState === 'EXECUTING'" @click="createBatch">创建批次</el-button>
        </div>
      </el-card>

      <section class="batch-results" aria-label="批量运行结果">
        <div class="batch-state-card">
          <div><span>批次编号</span><strong>{{ batch?.batchId ?? '—' }}</strong></div>
          <div><span>运行/报告</span><strong>{{ runs.length }} / {{ batch?.reportIds.length ?? 0 }}</strong></div>
          <div><span>聚合报告</span><strong>{{ aggregateReport?.reportId ?? '—' }}</strong></div>
          <div class="batch-state-card__commands">
            <el-button type="primary" data-testid="batch-start" :disabled="!canStart || pending" @click="startBatch">启动批次</el-button>
            <el-button :disabled="!canCancel || pending" @click="cancelBatch">取消批次</el-button>
          </div>
        </div>

        <el-skeleton v-if="capabilityState === 'LOADING' || capabilityState === 'VALIDATING'" :rows="8" animated />
        <el-result v-else-if="capabilityState === 'ERROR' && !batch" icon="error" title="批量仿真不可用" :sub-title="resultMessage">
          <template #extra><el-button type="primary" @click="batchStore.loadComparison()">重新加载</el-button></template>
        </el-result>
        <template v-else-if="runs.length">
          <div class="batch-results__table">
            <BatchRunTable :runs="runs" :selected-run-id="selectedRunId" @select="selectedRunId = $event" />
          </div>
          <div v-if="selectedRun" class="batch-results__selection" data-testid="batch-selection">
            <strong>{{ selectedRun.runId }} / {{ selectedRun.reportId }}</strong>
            <span>功率 {{ selectedRun.powerW }} W</span>
            <span>距离 {{ selectedRun.distanceKm }} km</span>
            <span>连通率 {{ selectedRun.connectivityRate }}%</span>
            <span>平均 SNR {{ selectedRun.avgSnrDb }} dB</span>
          </div>
        </template>
        <el-empty v-else description="创建并启动批次后显示对比结果" />
      </section>
    </main>
  </section>
</template>

<style scoped>
.batches-page {
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  color: var(--console-text);
  background: var(--console-bg-elevated);
}

.batches-page__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--console-border);
}

.batches-page__header h2 {
  margin: 0.15rem 0 0;
  font-size: 1.25rem;
}

.batches-page__header p:last-child {
  margin: 0.25rem 0 0;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.batches-page__actions,
.batch-form__actions,
.batch-form__order,
.panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}

.batches-page__body {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(17rem, 21rem) minmax(0, 1fr);
  gap: 0.75rem;
  padding: 0.75rem;
}

.batch-form,
.batch-results {
  min-height: 0;
  border: 1px solid var(--console-border);
  background: var(--console-surface);
}

.batch-form :deep(.el-card__header),
.batch-form :deep(.el-card__body) {
  padding: 0.8rem;
}

.panel-title span,
.batch-form__order span,
.batch-state-card span,
.batch-results__selection span {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.batch-form__order {
  margin-bottom: 0.8rem;
}

.batch-form__actions {
  justify-content: flex-end;
  margin-top: 0.8rem;
}

.batch-results {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border-radius: 6px;
  overflow: hidden;
}

.batch-state-card {
  display: grid;
  grid-template-columns: repeat(3, minmax(8rem, 1fr)) auto;
  gap: 0.5rem;
  padding: 0.65rem;
  border-bottom: 1px solid var(--console-border);
}

.batch-state-card > div:not(.batch-state-card__commands) {
  display: grid;
  gap: 0.15rem;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--console-border);
  border-radius: 5px;
  background: var(--console-bg-elevated);
}

.batch-state-card__commands {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.batch-results__table {
  min-height: 0;
}

.batch-results__selection {
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
  padding: 0.65rem 0.8rem;
  border-top: 1px solid var(--console-border);
}

@media (max-width: 900px) {
  .batches-page {
    height: auto;
    min-height: 100%;
  }

  .batches-page__header,
  .batches-page__body {
    grid-template-columns: 1fr;
  }

  .batches-page__header {
    align-items: flex-start;
    flex-direction: column;
  }

  .batch-results {
    min-height: 34rem;
  }

  .batch-state-card {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
