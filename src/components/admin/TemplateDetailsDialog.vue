<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ScenarioTemplate } from '../../contracts/domain-models'
import { readLinkEnabled } from '../../features/scenarios/link-settings'
import { scenarioPlatformLabel } from '../../features/scenarios/scenario-basic'
import { formatDateTime } from '../../features/shared/date-time'
import { JAMMER_TYPE_LABELS, LINK_TYPE_LABELS, PLATFORM_TYPE_LABELS } from '../../features/situation/situation-model'

const props = defineProps<{ template: ScenarioTemplate | null }>()
const emit = defineEmits<{ close: [] }>()
const activeTab = ref('overview')
const config = computed(() => props.template?.config)

watch(() => props.template?.templateId, () => {
  activeTab.value = 'overview'
})

function platformLabel(id: string): string {
  return scenarioPlatformLabel(config.value?.platforms ?? [], id)
}

function configuredStatus(enabled: boolean | undefined): string {
  if (enabled === undefined) return '未配置'
  return enabled ? '启用' : '停用'
}

const devices = computed(() => {
  if (!config.value) return []
  const extensions = props.template?.uiExtensions
  const jammerStates = new Map(extensions?.jammers.map(item => [item.jammerId, item.enabled]))
  const sensorStates = new Map(extensions?.sensors.map(item => [item.sensorId, item.enabled]))

  return [
    ...config.value.jammers.map(item => ({
      id: item.id, platform: platformLabel(item.platformId), type: JAMMER_TYPE_LABELS[item.type],
      status: configuredStatus(jammerStates.get(item.id)),
    })),
    ...config.value.sensors.map(item => ({
      id: item.id, platform: platformLabel(item.platformId), type: '传感器',
      status: configuredStatus(sensorStates.get(item.id)),
    })),
  ]
})
</script>

<template>
  <el-dialog
    :model-value="template !== null"
    class="scenario-dialog"
    modal-class="template-detail-overlay"
    body-class="template-detail-body"
    title="模板详情"
    width="min(900px, calc(100vw - 2rem))"
    append-to-body
    @update:model-value="!$event && emit('close')"
  >
    <div v-if="template && config" class="template-detail-content" data-testid="template-detail">
      <h4 class="template-detail-name">{{ template.name }}</h4>
      <el-tabs v-model="activeTab" class="template-detail-tabs">
        <el-tab-pane name="overview" label="概况">
          <el-descriptions :column="2" border class="template-overview" data-testid="template-detail-overview">
            <el-descriptions-item label="模板编号">{{ template.templateId }}</el-descriptions-item>
            <el-descriptions-item label="版本">{{ template.version }}</el-descriptions-item>
            <el-descriptions-item label="场景名称">{{ config.scenario.name }}</el-descriptions-item>
            <el-descriptions-item label="场景编号">{{ config.scenario.id }}</el-descriptions-item>
            <el-descriptions-item label="场景说明" :span="2">
              <span class="template-description">{{ config.scenario.description || '—' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="开始时间（UTC+8）">{{ formatDateTime(config.scenario.startTime) }}</el-descriptions-item>
            <el-descriptions-item label="运行模式">{{ config.scenario.realtime === false ? '非实时' : '实时' }}</el-descriptions-item>
            <el-descriptions-item label="时长">{{ config.scenario.duration }} 秒</el-descriptions-item>
            <el-descriptions-item label="时间步长">{{ config.scenario.timeStep }} 秒</el-descriptions-item>
            <el-descriptions-item label="节点 / 链路">{{ config.platforms.length }} / {{ config.links.length }}</el-descriptions-item>
            <el-descriptions-item label="干扰设备 / 传感器">{{ config.jammers.length }} / {{ config.sensors.length }}</el-descriptions-item>
            <el-descriptions-item label="历史引用">{{ template.referenceCount }}</el-descriptions-item>
          </el-descriptions>
          <template v-if="config.scenario.phases?.length">
            <h4 class="template-phase-title">任务阶段</h4>
            <el-table :data="config.scenario.phases" row-key="id" size="small">
              <el-table-column label="名称" prop="name" min-width="150" show-overflow-tooltip />
              <el-table-column label="开始（秒）" prop="startTimeS" min-width="100" />
              <el-table-column label="结束（秒）" prop="endTimeS" min-width="100" />
            </el-table>
          </template>
        </el-tab-pane>

        <el-tab-pane name="nodes" label="节点" lazy>
          <el-table :data="config.platforms" row-key="id" size="small" empty-text="没有配置节点" data-testid="template-detail-nodes">
            <el-table-column label="节点名称" prop="name" min-width="170" show-overflow-tooltip />
            <el-table-column label="节点类型" min-width="145">
              <template #default="{ row }">{{ PLATFORM_TYPE_LABELS[row.type as keyof typeof PLATFORM_TYPE_LABELS] }}</template>
            </el-table-column>
            <el-table-column label="航点数量" min-width="90">
              <template #default="{ row }">{{ row.waypoints.length }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane name="links" label="链路" lazy>
          <el-table :data="config.links" row-key="id" size="small" empty-text="没有配置链路" data-testid="template-detail-links">
            <el-table-column label="链路类型" min-width="125">
              <template #default="{ row }">{{ LINK_TYPE_LABELS[row.type as keyof typeof LINK_TYPE_LABELS] }}</template>
            </el-table-column>
            <el-table-column label="源节点" min-width="130" show-overflow-tooltip>
              <template #default="{ row }">{{ platformLabel(row.sourcePlatformId) }}</template>
            </el-table-column>
            <el-table-column label="中继节点" min-width="130" show-overflow-tooltip>
              <template #default="{ row }">{{ row.relayPlatformId ? platformLabel(row.relayPlatformId) : '—' }}</template>
            </el-table-column>
            <el-table-column label="目标节点" min-width="130" show-overflow-tooltip>
              <template #default="{ row }">{{ platformLabel(row.targetPlatformId) }}</template>
            </el-table-column>
            <el-table-column label="方向" width="70">
              <template #default="{ row }">{{ row.direction === 'FORWARD' ? '前向' : '返向' }}</template>
            </el-table-column>
            <el-table-column label="配置状态" width="90">
              <template #default="{ row }">{{ configuredStatus(readLinkEnabled(row, config.linkSettings)) }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane name="devices" label="设备" lazy>
          <el-table :data="devices" size="small" empty-text="没有配置设备" data-testid="template-detail-devices">
            <el-table-column label="设备编号" prop="id" min-width="140" show-overflow-tooltip />
            <el-table-column label="所属节点" prop="platform" min-width="150" show-overflow-tooltip />
            <el-table-column label="设备类型" prop="type" min-width="120" />
            <el-table-column label="配置状态" prop="status" min-width="90" />
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
    <template #footer>
      <el-button data-testid="close-template-detail" @click="emit('close')">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.template-detail-overlay),
:global(.template-detail-overlay > .el-overlay-dialog) { overflow: hidden; }
:global(.scenario-dialog > .el-dialog__body.template-detail-body) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.template-detail-content,
.template-detail-tabs {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.template-detail-name,
.template-detail-tabs :deep(.el-tabs__header) { flex-shrink: 0; }

.template-detail-tabs :deep(.el-tabs__content) {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.template-detail-tabs :deep(.el-tab-pane) {
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.template-detail-name { margin: 0 0 8px; font-size: 16px; overflow-wrap: anywhere; }
.template-overview :deep(.el-descriptions__content) { overflow-wrap: anywhere; }
.template-description { white-space: pre-wrap; }
.template-phase-title { margin: 16px 0 8px; font-size: 14px; }
</style>
