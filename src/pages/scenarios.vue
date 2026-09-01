<script setup lang="ts">
import { computed, onMounted, ref, toRaw } from 'vue'
import { storeToRefs } from 'pinia'
import type { CapabilityState, Platform, PlatformType } from '../contracts/domain-models'
import {
  BUSINESS_INFORMATION_NODE_TYPES,
  SUPPORTING_ENTITY_TYPES,
  inspectScenarioConfig,
  isBusinessInformationNodeType,
} from '../features/scenarios/scenario-validation'
import { PLATFORM_TYPE_LABELS } from '../features/situation/situation-model'
import { useScenarioStore } from '../stores/scenario'

const scenarioStore = useScenarioStore()
const { draft, dirty, panelState, resultMessage, validation } = storeToRefs(scenarioStore)
const activeTab = ref('scenario')
const platformDialogVisible = ref(false)
const editingPlatformIndex = ref<number | null>(null)
const platformEditor = ref<Platform | null>(null)
const platformEditorError = ref('')
const platformFeedback = ref('')

const deploymentDomainLabels = {
  ground: '地面',
  air: '空中',
  space: '天基',
} as const
const businessTypeOptions = BUSINESS_INFORMATION_NODE_TYPES.map((value) => ({ value, label: PLATFORM_TYPE_LABELS[value] }))
const supportingTypeOptions = SUPPORTING_ENTITY_TYPES.map((value) => ({ value, label: PLATFORM_TYPE_LABELS[value] }))

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
const businessNodeCount = computed(() => draft.value?.config.platforms.filter((platform) => isBusinessInformationNodeType(platform.type)).length ?? 0)
const supportingEntityCount = computed(() => (draft.value?.config.platforms.length ?? 0) - businessNodeCount.value)

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
 * 生成当前场景内未占用的平台 ID。
 * @param prefix 业务节点或支撑实体使用的 ID 前缀。
 * @returns 首个未被使用的三位序号 ID。
 * @remarks 只读取当前草稿，不修改平台集合。
 */
function nextPlatformId(prefix: 'PLAT-' | 'SUP-'): string {
  const ids = new Set(draft.value?.config.platforms.map((platform) => platform.id) ?? [])
  let index = 1
  while (ids.has(`${prefix}${String(index).padStart(3, '0')}`)) index += 1
  return `${prefix}${String(index).padStart(3, '0')}`
}

/**
 * 打开新增场景实体对话框。
 * @param classification 新实体属于业务信息节点还是支撑实体。
 * @returns 无返回值。
 * @sideEffects 达到容量上限时只显示中文提示；否则创建独立编辑副本并打开对话框。
 */
function openNewPlatform(classification: 'business' | 'supporting'): void {
  if (draft.value === null) return
  if (classification === 'business' && businessNodeCount.value >= 50) {
    platformFeedback.value = '业务信息节点已达 50 个，不能继续新增。'
    return
  }
  const business = classification === 'business'
  const id = nextPlatformId(business ? 'PLAT-' : 'SUP-')
  editingPlatformIndex.value = null
  platformEditor.value = {
    id,
    name: business ? `新增业务信息节点 ${id}` : `新增支撑实体 ${id}`,
    type: business ? 'REAR_COMMAND_NODE' : 'COMMUNICATION_SATELLITE',
    category: business ? 'ground' : 'space',
    initialPosition: { longitude: 0, latitude: 0, altitude: business ? 0 : 550000 },
    waypoints: [],
    linkIds: [],
    sensorIds: [],
    jammerIds: [],
  }
  platformEditorError.value = ''
  platformFeedback.value = ''
  platformDialogVisible.value = true
}

/**
 * 打开现有场景实体编辑对话框。
 * @param platform 需要编辑的平台数据。
 * @param index 平台在当前草稿集合中的位置。
 * @returns 无返回值。
 * @sideEffects 创建平台深拷贝，避免取消编辑时污染草稿。
 */
function openPlatformEditor(platform: Platform, index: number): void {
  editingPlatformIndex.value = index
  platformEditor.value = structuredClone(toRaw(platform))
  platformEditorError.value = ''
  platformFeedback.value = ''
  platformDialogVisible.value = true
}

/**
 * 向当前平台编辑副本追加一个零值航点。
 * @returns 无返回值。
 * @sideEffects 仅修改对话框中的平台副本，尚不修改场景草稿。
 */
function addWaypoint(): void {
  platformEditor.value?.waypoints.push({ longitude: 0, latitude: 0, altitude: 0, speed: 0, arrivalTime: 0 })
}

/**
 * 删除当前平台编辑副本中的指定航点。
 * @param index 航点在编辑副本中的位置。
 * @returns 无返回值。
 * @sideEffects 仅修改对话框中的平台副本，尚不修改场景草稿。
 */
function removeWaypoint(index: number): void {
  platformEditor.value?.waypoints.splice(index, 1)
}

/**
 * 将平台编辑副本写入当前场景草稿。
 * @returns 校验并写入成功时返回 `true`，否则返回 `false`。
 * @sideEffects 成功时新增或替换一个平台、标记草稿未保存并关闭对话框。
 */
function applyPlatformEditor(): boolean {
  if (draft.value === null || platformEditor.value === null) return false
  platformEditor.value.id = platformEditor.value.id.trim()
  platformEditor.value.name = platformEditor.value.name.trim()
  if (platformEditor.value.id === '' || platformEditor.value.name === '') {
    platformEditorError.value = '场景实体 ID 和名称均为必填项。'
    return false
  }
  const candidate = structuredClone(toRaw(draft.value.config))
  const editedPlatform = structuredClone(toRaw(platformEditor.value))
  if (editingPlatformIndex.value === null) candidate.platforms.push(editedPlatform)
  else candidate.platforms[editingPlatformIndex.value] = editedPlatform
  const issue = inspectScenarioConfig(candidate).result.errors.find((item) => (
    item.fieldPath.startsWith('platforms') || item.code === 'PLATFORM_REFERENCE_NOT_FOUND'
  ))
  if (issue !== undefined) {
    platformEditorError.value = issue.message
    return false
  }

  draft.value.config.platforms = candidate.platforms
  markDirty()
  platformDialogVisible.value = false
  platformFeedback.value = editingPlatformIndex.value === null ? '场景实体已新增，保存草稿后生效。' : '场景实体已更新，保存草稿后生效。'
  return true
}

/**
 * 删除未被其他配置引用的场景实体。
 * @param platform 需要删除的平台。
 * @param index 平台在当前草稿集合中的位置。
 * @returns 删除成功时返回 `true`，被容量或引用规则阻止时返回 `false`。
 * @sideEffects 成功时从草稿移除平台并设置未保存标记；失败时草稿保持不变。
 */
function removePlatform(platform: Platform, index: number): boolean {
  if (draft.value === null) return false
  if (isBusinessInformationNodeType(platform.type) && businessNodeCount.value <= 1) {
    platformFeedback.value = '场景至少需要保留一个业务信息节点。'
    return false
  }
  const config = draft.value.config
  const referenced = config.links.some((link) => link.sourcePlatformId === platform.id || link.targetPlatformId === platform.id)
    || config.jammers.some((jammer) => jammer.platformId === platform.id)
    || config.sensors.some((sensor) => sensor.platformId === platform.id)
    || config.informationDemand.some((demand) => demand.sourcePlatformId === platform.id || demand.destinationPlatformIds.includes(platform.id))
  if (referenced) {
    platformFeedback.value = '该场景实体仍被链路、设备或信息需求引用，不能删除。'
    return false
  }
  config.platforms.splice(index, 1)
  markDirty()
  platformFeedback.value = '场景实体已删除，保存草稿后生效。'
  return true
}

/**
 * 读取平台类型的中文业务名称。
 * @param type 场景实体类型枚举值。
 * @returns 对应的文档中文名称。
 * @remarks 只读取既有类型映射。
 */
function platformTypeLabel(type: PlatformType): string {
  return PLATFORM_TYPE_LABELS[type]
}

/**
 * 重新加载确定性场景草稿。
 * @returns 加载流程结束后兑现且不返回值的 Promise。
 * @sideEffects 调用场景 Store，并以服务端草稿替换当前页面数据。
 */
async function loadScenario(): Promise<void> {
  await scenarioStore.loadScenario()
}

/**
 * 保存当前场景草稿并同步平台区域反馈。
 * @returns 保存流程结束后兑现且不返回值的 Promise。
 * @sideEffects 调用场景 Store；成功时把平台区域提示更新为已保存状态。
 */
async function saveScenario(): Promise<void> {
  if (await scenarioStore.saveScenario()) platformFeedback.value = '场景草稿已保存。'
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
        <p class="scenario-header__description">编辑场景基础信息、环境参数、仿真时序、平台和航点，并保存为本机草稿。</p>
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
          @click="saveScenario"
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
      <el-tabs v-model="activeTab" class="scenario-tabs">
        <el-tab-pane label="场景基础" name="scenario">
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
        </el-tab-pane>

        <el-tab-pane label="平台与航点" name="platforms">
          <section class="console-panel scenario-section" aria-labelledby="scenario-platform-title">
            <div class="section-heading">
              <div>
                <p class="section-kicker">平台与航点</p>
                <h3 id="scenario-platform-title">场景实体配置</h3>
              </div>
              <div class="platform-counts" aria-label="场景实体数量">
                <el-tag type="primary">业务信息节点 {{ businessNodeCount }} / 50</el-tag>
                <el-tag>支撑实体 {{ supportingEntityCount }}</el-tag>
              </div>
            </div>

            <el-alert
              v-if="platformFeedback"
              class="platform-feedback"
              :type="platformFeedback.includes('不能') || platformFeedback.includes('至少') ? 'error' : 'success'"
              :closable="false"
              :title="platformFeedback"
              show-icon
            />

            <el-table :data="draft.config.platforms" stripe data-testid="platform-table">
              <el-table-column prop="id" label="场景实体 ID" min-width="130" />
              <el-table-column prop="name" label="名称" min-width="180" show-overflow-tooltip />
              <el-table-column label="分类" width="120">
                <template #default="{ row }">
                  {{ isBusinessInformationNodeType(row.type) ? '业务信息节点' : '支撑实体' }}
                </template>
              </el-table-column>
              <el-table-column label="场景实体类型" min-width="180">
                <template #default="{ row }">{{ platformTypeLabel(row.type) }}</template>
              </el-table-column>
              <el-table-column label="部署域" width="90">
                <template #default="{ row }">{{ deploymentDomainLabels[row.category] }}</template>
              </el-table-column>
              <el-table-column label="航点" width="70" align="center">
                <template #default="{ row }">{{ row.waypoints.length }}</template>
              </el-table-column>
              <el-table-column label="操作" fixed="right" width="140">
                <template #default="{ row, $index }">
                  <el-button link type="primary" :disabled="pending || draft.locked" :data-testid="`edit-platform-${$index}`" @click="openPlatformEditor(row, $index)">编辑</el-button>
                  <el-popconfirm title="确认删除该场景实体？" confirm-button-text="删除" cancel-button-text="取消" @confirm="removePlatform(row, $index)">
                    <template #reference><el-button link type="danger" :disabled="pending || draft.locked" :data-testid="`delete-platform-${$index}`">删除</el-button></template>
                  </el-popconfirm>
                </template>
              </el-table-column>
            </el-table>

            <div class="platform-actions">
              <el-button type="primary" :disabled="pending || draft.locked" data-testid="add-business-platform" @click="openNewPlatform('business')">新增业务信息节点</el-button>
              <el-button :disabled="pending || draft.locked" data-testid="add-supporting-platform" @click="openNewPlatform('supporting')">新增支撑实体</el-button>
            </div>
          </section>
        </el-tab-pane>
      </el-tabs>
    </el-form>

    <el-dialog
      v-model="platformDialogVisible"
      :title="editingPlatformIndex === null ? '新增场景实体' : '编辑场景实体'"
      width="min(920px, 92vw)"
      destroy-on-close
      append-to-body
      data-testid="platform-dialog"
    >
      <el-alert v-if="platformEditorError" class="platform-feedback" type="error" :closable="false" :title="platformEditorError" show-icon />
      <el-form v-if="platformEditor" :model="platformEditor" label-position="top" :disabled="pending || draft?.locked">
        <div class="platform-editor-grid">
          <el-form-item label="场景实体 ID">
            <el-input v-model="platformEditor.id" :disabled="editingPlatformIndex !== null" data-testid="platform-id" />
          </el-form-item>
          <el-form-item label="名称">
            <el-input v-model="platformEditor.name" data-testid="platform-name" />
          </el-form-item>
          <el-form-item label="场景实体类型">
            <el-select v-model="platformEditor.type" style="width: 100%" data-testid="platform-type">
              <el-option-group label="业务信息节点">
                <el-option v-for="option in businessTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-option-group>
              <el-option-group label="支撑实体（不计入50个业务信息节点）">
                <el-option v-for="option in supportingTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-option-group>
            </el-select>
          </el-form-item>
          <el-form-item label="部署域">
            <el-select v-model="platformEditor.category" style="width: 100%" data-testid="platform-category">
              <el-option v-for="(label, value) in deploymentDomainLabels" :key="value" :label="label" :value="value" />
            </el-select>
          </el-form-item>
        </div>

        <h4 class="editor-subtitle">初始位置</h4>
        <div class="position-grid">
          <el-form-item label="经度（°）"><el-input-number v-model="platformEditor.initialPosition.longitude" :min="-180" :max="180" controls-position="right" data-testid="platform-longitude" /></el-form-item>
          <el-form-item label="纬度（°）"><el-input-number v-model="platformEditor.initialPosition.latitude" :min="-90" :max="90" controls-position="right" data-testid="platform-latitude" /></el-form-item>
          <el-form-item label="高度（m）"><el-input-number v-model="platformEditor.initialPosition.altitude" :min="0" controls-position="right" data-testid="platform-altitude" /></el-form-item>
        </div>

        <h4 class="editor-subtitle">关联 ID</h4>
        <div class="position-grid">
          <el-form-item label="链路">
            <el-select v-model="platformEditor.linkIds" multiple collapse-tags style="width: 100%">
              <el-option v-for="link in draft?.config.links ?? []" :key="link.id" :label="link.id" :value="link.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="传感器">
            <el-select v-model="platformEditor.sensorIds" multiple collapse-tags style="width: 100%">
              <el-option v-for="sensor in draft?.config.sensors ?? []" :key="sensor.id" :label="sensor.id" :value="sensor.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="干扰器">
            <el-select v-model="platformEditor.jammerIds" multiple collapse-tags style="width: 100%">
              <el-option v-for="jammer in draft?.config.jammers ?? []" :key="jammer.id" :label="jammer.id" :value="jammer.id" />
            </el-select>
          </el-form-item>
        </div>

        <div class="waypoint-heading">
          <h4 class="editor-subtitle">航点（{{ platformEditor.waypoints.length }}）</h4>
          <el-button size="small" :disabled="pending || draft?.locked" data-testid="add-waypoint" @click="addWaypoint">新增航点</el-button>
        </div>
        <el-table :data="platformEditor.waypoints" empty-text="暂无航点" data-testid="waypoint-table">
          <el-table-column label="经度（°）" min-width="130"><template #default="{ row, $index }"><el-input-number v-model="row.longitude" :min="-180" :max="180" controls-position="right" :data-testid="`waypoint-longitude-${$index}`" /></template></el-table-column>
          <el-table-column label="纬度（°）" min-width="130"><template #default="{ row, $index }"><el-input-number v-model="row.latitude" :min="-90" :max="90" controls-position="right" :data-testid="`waypoint-latitude-${$index}`" /></template></el-table-column>
          <el-table-column label="高度（m）" min-width="130"><template #default="{ row, $index }"><el-input-number v-model="row.altitude" :min="0" controls-position="right" :data-testid="`waypoint-altitude-${$index}`" /></template></el-table-column>
          <el-table-column label="速度（m/s）" min-width="130"><template #default="{ row, $index }"><el-input-number v-model="row.speed" :min="0" controls-position="right" :data-testid="`waypoint-speed-${$index}`" /></template></el-table-column>
          <el-table-column label="到达时间（s）" min-width="140"><template #default="{ row, $index }"><el-input-number v-model="row.arrivalTime" :min="0" controls-position="right" :data-testid="`waypoint-arrival-${$index}`" /></template></el-table-column>
          <el-table-column label="操作" width="70"><template #default="{ $index }"><el-button link type="danger" :disabled="pending || draft?.locked" :data-testid="`delete-waypoint-${$index}`" @click="removeWaypoint($index)">删除</el-button></template></el-table-column>
        </el-table>
      </el-form>
      <template #footer>
        <el-button data-testid="cancel-platform" @click="platformDialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="pending || draft?.locked" data-testid="apply-platform" @click="applyPlatformEditor">确认</el-button>
      </template>
    </el-dialog>
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

.scenario-tabs :deep(.el-tab-pane) {
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

.platform-counts,
.platform-actions,
.waypoint-heading {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.platform-counts,
.platform-actions {
  flex-wrap: wrap;
}

.platform-actions {
  margin-top: 1rem;
}

.platform-feedback {
  margin-bottom: 1rem;
}

.platform-editor-grid,
.position-grid {
  display: grid;
  gap: 0 1rem;
}

.platform-editor-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.position-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.editor-subtitle {
  margin: 0.5rem 0 0.75rem;
  color: var(--console-text);
}

.waypoint-heading {
  justify-content: space-between;
}

.waypoint-heading .editor-subtitle {
  margin-bottom: 0.5rem;
}

.scenario-page :deep(.el-table .el-input-number) {
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
  .form-grid--environment,
  .platform-editor-grid,
  .position-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .form-grid--basic,
  .form-grid--timing,
  .form-grid--environment,
  .platform-editor-grid,
  .position-grid {
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
