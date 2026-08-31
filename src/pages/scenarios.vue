<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import type { CapabilityState } from '../contracts/domain-models'
import { useScenarioStore } from '../stores/scenario'

const scenarioStore = useScenarioStore()
const { draft, dirty, panelState, resultMessage, validation } = storeToRefs(scenarioStore)

const stateLabels: Record<CapabilityState, string> = {
  LOADING: '加载中',
  VALIDATING: '校验中',
  EXECUTING: '保存中',
  SUCCESS: '已就绪',
  EMPTY: '未加载',
  ERROR: '处理失败',
}

/**
 * 判断页面当前是否处于不可重复操作的处理阶段。
 * @returns 加载、校验或保存中返回 `true`。
 * @remarks 只读取 Store 状态，不发起请求或修改草稿。
 */
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(panelState.value))

const BEIJING_UTC_OFFSET_MS = 8 * 60 * 60 * 1000
const RFC3339_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

/** 将 RFC 3339 时间转换为北京时间的分钟精度日期时间。 */
function toBeijingDateTime(value: string): string {
  if (value === '') return ''
  const match = RFC3339_DATE_TIME.exec(value)
  if (match === null) return value
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]!) return value
  const date = new Date(value.replace('t', 'T').replace(/z$/, 'Z'))
  if (Number.isNaN(date.getTime())) return value
  const beijing = new Date(date.getTime() + BEIJING_UTC_OFFSET_MS)
  const pad = (part: number) => String(part).padStart(2, '0')
  const beijingYear = beijing.getUTCFullYear()
  const formattedYear = beijingYear < 0
    ? `-${String(Math.abs(beijingYear)).padStart(4, '0')}`
    : String(beijingYear).padStart(4, '0')
  return `${formattedYear}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}T${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}`
}

/** 将北京时间转换为秒精度 UTC RFC 3339；无效文本或日历值原样保留供校验。 */
function beijingDateTimeToUtc(value: string): string {
  if (value === '') return ''
  const parts = /^(\d{4,5})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (parts === null) return value
  const [, year, month, day, hour, minute] = parts.map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year!, month! - 1, day!)
  date.setUTCHours(hour! - 8, minute!, 0, 0)
  const utcYear = date.getUTCFullYear()
  if (utcYear < 0 || utcYear > 9999 || toBeijingDateTime(date.toISOString()) !== value) return value
  return date.toISOString().replace('.000Z', 'Z')
}

/**
 * 在 UTC RFC 3339 时间和北京时间输入格式之间转换。
 * @returns 当前输入框使用的北京时间分钟精度文本。
 * @remarks 写入时将北京时间转换为 UTC，更新草稿开始时间并标记存在未保存修改。
 */
const startTimeBeijing = computed({
  get: () => toBeijingDateTime(draft.value?.config.scenario.startTime ?? ''),
  set: (value: string | null) => {
    if (draft.value === null) return
    draft.value.config.scenario.startTime = beijingDateTimeToUtc(value ?? '')
    scenarioStore.markDirty()
  },
})

const useStartTimeDatePicker = computed(() => {
  const value = startTimeBeijing.value
  if (value === '') return true
  const year = Number(value.slice(0, value.indexOf('-')))
  return year >= 1000 && year <= 9999 && beijingDateTimeToUtc(value) !== value
})

/**
 * 读取指定合同字段的首条中文错误。
 * @param fieldPath 场景配置中的字段路径。
 * @returns 对应错误消息；没有错误时返回空字符串。
 * @remarks 只读取当前校验结果，不修改表单或错误集合。
 */
function issueMessage(fieldPath: string): string {
  return validation.value.errors.find((issue) => issue.fieldPath === fieldPath)?.message ?? ''
}

/**
 * 标记表单字段已经发生修改。
 * @returns 无返回值。
 * @sideEffects 调用场景 Store 清除旧字段错误并设置未保存标记。
 */
function markDirty(): void {
  scenarioStore.markDirty()
}

/**
 * 重新加载确定性场景草稿。
 * @returns 加载流程结束后兑现且不返回值的 Promise。
 * @sideEffects 调用场景 Store，并以服务端草稿替换当前页面数据。
 */
async function loadScenario(): Promise<void> {
  await scenarioStore.loadScenario()
}

onMounted(() => {
  if (draft.value === null) void loadScenario()
})
</script>

<template>
  <section class="page scenario-page" aria-labelledby="scenarios-title">
    <header class="scenario-header">
      <div>
        <p class="eyebrow">P2 / 场景配置</p>
        <h2 id="scenarios-title">场景管理</h2>
        <p class="scenario-header__description">编辑场景基础信息、环境参数和仿真时序，并保存为本机草稿。</p>
      </div>
      <div class="scenario-header__actions">
        <el-tag :type="panelState === 'ERROR' ? 'danger' : dirty ? 'warning' : 'success'">
          {{ dirty ? '未保存' : stateLabels[panelState] }}
        </el-tag>
        <span v-if="draft" class="console-chip">修订 {{ draft.revision }}</span>
        <el-button v-if="panelState === 'ERROR' && !dirty" :loading="pending" @click="loadScenario">
          重新加载
        </el-button>
        <el-button
          type="primary"
          :disabled="draft === null || draft?.locked || !dirty"
          :loading="pending"
          data-testid="save-scenario"
          @click="scenarioStore.saveScenario"
        >
          保存草稿
        </el-button>
      </div>
    </header>

    <el-alert
      v-if="panelState === 'ERROR'"
      class="scenario-feedback"
      type="error"
      :closable="false"
      :title="resultMessage"
      show-icon
    />

    <div v-if="pending && draft === null" class="console-placeholder" aria-live="polite">
      正在加载场景草稿…
    </div>

    <el-form
      v-else-if="draft"
      class="scenario-form"
      :model="draft.config.scenario"
      label-position="top"
      :disabled="pending || draft.locked"
      data-testid="scenario-editor"
    >
      <section class="console-panel scenario-section" aria-labelledby="scenario-basic-title">
        <div class="section-heading">
          <div>
            <p class="section-kicker">基础信息</p>
            <h3 id="scenario-basic-title">场景标识</h3>
          </div>
          <span class="section-note">场景编号由系统维护</span>
        </div>
        <div class="form-grid form-grid--basic">
          <el-form-item label="场景编号" :error="issueMessage('scenario.id')">
            <el-input v-model="draft.config.scenario.id" disabled data-testid="scenario-id" />
          </el-form-item>
          <el-form-item label="场景名称" :error="issueMessage('scenario.name')">
            <el-input
              v-model="draft.config.scenario.name"
              maxlength="128"
              data-testid="scenario-name"
              @update:model-value="markDirty"
            />
          </el-form-item>
          <el-form-item class="form-grid__wide" label="场景描述" :error="issueMessage('scenario.description')">
            <el-input
              v-model="draft.config.scenario.description"
              type="textarea"
              :rows="3"
              maxlength="512"
              show-word-limit
              data-testid="scenario-description"
              @update:model-value="markDirty"
            />
          </el-form-item>
        </div>
      </section>

      <section class="console-panel scenario-section" aria-labelledby="scenario-timing-title">
        <div class="section-heading">
          <div>
            <p class="section-kicker">时序参数</p>
            <h3 id="scenario-timing-title">仿真时间</h3>
          </div>
          <span class="section-note">时长和步长单位均为秒</span>
        </div>
        <div class="form-grid form-grid--timing">
          <el-form-item label="开始时间" :error="issueMessage('scenario.startTime')">
            <div class="scenario-start-time" data-testid="scenario-start-time">
              <el-date-picker
                v-if="useStartTimeDatePicker"
                v-model="startTimeBeijing"
                type="datetime"
                format="YYYY-MM-DD HH:mm"
                value-format="YYYY-MM-DDTHH:mm"
                placeholder="请选择开始时间"
                style="width: 100%"
              />
              <el-input v-else v-model="startTimeBeijing" />
            </div>
          </el-form-item>
          <el-form-item label="仿真时长（秒）" :error="issueMessage('scenario.duration')">
            <el-input-number
              v-model="draft.config.scenario.duration"
              controls-position="right"
              data-testid="scenario-duration"
              @update:model-value="markDirty"
            />
          </el-form-item>
          <el-form-item label="时间步长（秒）" :error="issueMessage('scenario.timeStep')">
            <el-input-number
              v-model="draft.config.scenario.timeStep"
              controls-position="right"
              data-testid="scenario-time-step"
              @update:model-value="markDirty"
            />
          </el-form-item>
        </div>
      </section>

      <section class="console-panel scenario-section" aria-labelledby="scenario-environment-title">
        <div class="section-heading">
          <div>
            <p class="section-kicker">环境参数</p>
            <h3 id="scenario-environment-title">传播环境</h3>
          </div>
          <span class="section-note">按详细设计中的环境字段录入</span>
        </div>
        <div class="form-grid form-grid--environment">
          <el-form-item label="海况等级" :error="issueMessage('scenario.environment.seaState')">
            <el-input-number v-model="draft.config.scenario.environment.seaState" controls-position="right" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item label="温度（℃）" :error="issueMessage('scenario.environment.temperatureC')">
            <el-input-number v-model="draft.config.scenario.environment.temperatureC" controls-position="right" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item label="相对湿度（%）" :error="issueMessage('scenario.environment.humidityPercent')">
            <el-input-number v-model="draft.config.scenario.environment.humidityPercent" controls-position="right" data-testid="scenario-humidity" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item label="降雨率（mm/h）" :error="issueMessage('scenario.environment.rainRateMmPerHour')">
            <el-input-number v-model="draft.config.scenario.environment.rainRateMmPerHour" controls-position="right" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item label="雨衰（dB/km）" :error="issueMessage('scenario.environment.rainLossDbPerKm')">
            <el-input-number v-model="draft.config.scenario.environment.rainLossDbPerKm" controls-position="right" @update:model-value="markDirty" />
          </el-form-item>
          <el-form-item class="multipath-field" label="多径效应">
            <el-switch
              v-model="draft.config.scenario.environment.multipathEnabled"
              inline-prompt
              active-text="启用"
              inactive-text="关闭"
              data-testid="scenario-multipath"
              @update:model-value="markDirty"
            />
          </el-form-item>
        </div>
      </section>
    </el-form>
  </section>
</template>

<style scoped>
.scenario-page {
  height: 100%;
  overflow: auto;
}

.scenario-header,
.scenario-header__actions,
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.scenario-header {
  margin-bottom: 1rem;
}

.scenario-header__description,
.section-note {
  margin: 0;
  color: var(--console-text-muted);
}

.scenario-header__actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.scenario-feedback {
  margin-bottom: 1rem;
}

.scenario-form {
  display: grid;
  gap: 1rem;
}

.scenario-section {
  padding: 1.1rem;
}

.section-heading {
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--console-border);
}

.section-heading h3,
.section-kicker {
  margin: 0;
}

.section-kicker {
  margin-bottom: 0.25rem;
  color: var(--console-cyan);
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.section-note {
  font-size: 0.75rem;
}

.form-grid {
  display: grid;
  gap: 0 1rem;
}

.form-grid--basic {
  grid-template-columns: minmax(12rem, 0.7fr) minmax(18rem, 1.3fr);
}

.form-grid--timing {
  grid-template-columns: minmax(16rem, 1.5fr) repeat(2, minmax(11rem, 1fr));
}

.form-grid--environment {
  grid-template-columns: repeat(3, minmax(11rem, 1fr));
}

.form-grid__wide {
  grid-column: 1 / -1;
}

.scenario-form :deep(.el-input-number) {
  width: 100%;
}

.multipath-field :deep(.el-form-item__content) {
  min-height: 32px;
  align-items: center;
}

@media (max-width: 960px) {
  .scenario-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .scenario-header__actions {
    justify-content: flex-start;
  }

  .form-grid--basic,
  .form-grid--timing,
  .form-grid--environment {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .form-grid--basic,
  .form-grid--timing,
  .form-grid--environment {
    grid-template-columns: 1fr;
  }

  .form-grid__wide {
    grid-column: auto;
  }

  .section-heading {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
