<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { DetectionEvent, SimulationMode, SwitchEvent } from '../../contracts/domain-models'
import LinkQualityDialog from '../../components/situation/LinkQualityDialog.vue'
import MetricPanel from '../../components/situation/MetricPanel.vue'
import OfflineSituationMap from '../../components/situation/OfflineSituationMap.vue'
import SimulationToolbar from '../../components/situation/SimulationToolbar.vue'
import type { SituationMapFocusTarget } from '../../components/situation/situation-map-controller'
import {
  LINK_TYPE_LABELS,
  formatBer,
  formatSimulationTime,
  getJammerTypeLabel,
  getPlatformName,
  selectSituationLinks,
  selectSituationMetrics,
  type SituationLinkView,
} from '../../features/situation/situation-model'
import { useSimulationStore } from '../../stores/simulation'
import { useTelemetryStore } from '../../stores/telemetry'

type SummaryTab = 'nodes' | 'links' | 'interference' | 'timing'

const BUSINESS_NODE_CAPACITY = 50
const BUSINESS_NODE_TYPES = new Set([
  'REAR_COMMAND_NODE', 'FORWARD_RELAY_NODE', 'GROUND_CLUSTER_COMMAND_NODE', 'AIRBORNE_MISSION_CLUSTER',
])
const summaryTabs: ReadonlyArray<{ key: SummaryTab; label: string }> = [
  { key: 'nodes', label: '节点' },
  { key: 'links', label: '链路' },
  { key: 'interference', label: '干扰' },
  { key: 'timing', label: '时序' },
]

const activeTab = ref<SummaryTab>('nodes')
const simulationStore = useSimulationStore()
const telemetryStore = useTelemetryStore()
const {
  uiStatus: simulationStatus,
  currentTime: simulationTime,
  speedMultiplier: simulationSpeed,
  mode: simulationMode,
  configurationLockState,
  resultMessage: simulationFeedback,
  pending: simulationPending,
} = storeToRefs(simulationStore)
const {
  frame,
  events,
  capabilityState: telemetryCapabilityState,
  connectionState,
  resultMessage: telemetryFeedback,
} = storeToRefs(telemetryStore)
const stopDialogVisible = ref(false)
const selectedNodeId = ref('')
const selectedLink = ref<SituationLinkView | null>(null)
const linkDialogVisible = ref(false)
const sceneSummaryCollapsed = ref(false)
const telemetryPanelCollapsed = ref(false)
const mapFocusTarget = ref<SituationMapFocusTarget | null>(null)

onMounted(async () => {
  await simulationStore.resetProjection()
  if (await telemetryStore.loadFrame()) telemetryStore.connect()
})

onBeforeUnmount(() => telemetryStore.disconnectAndReset())

watch(frame, (nextFrame) => {
  if (nextFrame === null) {
    selectedNodeId.value = ''
    return
  }
  if (!nextFrame.platforms.some((platform) => platform.platformId === selectedNodeId.value)) {
    selectedNodeId.value = nextFrame.platforms[0]?.platformId ?? ''
  }
}, { immediate: true })

const situationLinks = computed(() => frame.value === null ? [] : selectSituationLinks(frame.value))
const situationMetrics = computed(() => frame.value === null ? null : selectSituationMetrics(frame.value, events.value))
const displayedBusinessPlatforms = computed(() => (frame.value?.platforms ?? []).filter(
  (platform) => BUSINESS_NODE_TYPES.has(platform.type),
))
const supportingPlatforms = computed(() => (frame.value?.platforms ?? []).filter(
  (platform) => !BUSINESS_NODE_TYPES.has(platform.type),
))
const jammers = computed(() => (frame.value?.platforms ?? []).flatMap((platform) => platform.jammers))
const detectionEvent = computed(() => events.value.find(
  (event): event is DetectionEvent => event.type === 'DETECTION',
))
const maximumLinkAgeMs = computed(() => Math.max(0, ...situationLinks.value.map((link) => link.ageMs)))
const frameFreshnessLabel = computed(() => (maximumLinkAgeMs.value === 0 ? '新鲜' : '存在延迟'))
const connectionLabel = computed(() => ({
  DISCONNECTED: '未连接',
  CONNECTING: '连接中',
  SUBSCRIBED: '实时已订阅',
  RETRYING: '重新连接中',
  FAILED: '连接失败',
}[connectionState.value]))

/** 重新加载完整帧，并在成功后恢复实时订阅。 */
async function retryTelemetry(): Promise<void> {
  if (await telemetryStore.loadFrame()) telemetryStore.connect()
}

/**
 * 切换场景配置悬浮面板的折叠状态。
 * @returns 无返回值。
 * @sideeffect 修改左侧悬浮面板状态并联动地图控件的左侧留白。
 */
function toggleSceneSummary(): void {
  sceneSummaryCollapsed.value = !sceneSummaryCollapsed.value
}

/**
 * 切换链路、干扰与事件悬浮面板的折叠状态。
 * @returns 无返回值。
 * @sideeffect 修改右侧悬浮面板状态并联动地图控件的右侧留白。
 */
function toggleTelemetryPanel(): void {
  telemetryPanelCollapsed.value = !telemetryPanelCollapsed.value
}

/**
 * 创建并开始仿真，或继续当前暂停运行。
 * @returns 操作完成后兑现且不返回值的 Promise。
 * @sideeffect 通过 simulationStore 调用 Mock API，并同步运行状态和场景配置锁。
 */
async function startSimulation(): Promise<void> {
  await simulationStore.start()
}

/**
 * 暂停当前仿真运行。
 * @returns 操作完成后兑现且不返回值的 Promise。
 * @sideeffect 通过 simulationStore 发送 PAUSE 命令并更新运行投影。
 */
async function pauseSimulation(): Promise<void> {
  await simulationStore.pause()
}

/**
 * 对暂停运行执行一个场景时间步。
 * @returns 操作完成后兑现且不返回值的 Promise。
 * @sideeffect 通过 simulationStore 发送 STEP 命令并更新规范仿真时刻。
 */
async function stepSimulation(): Promise<void> {
  await simulationStore.step()
}

/**
 * 打开停止操作确认框。
 * @returns 无返回值。
 * @sideeffect 修改停止确认框的可见状态。
 */
function requestStop(): void {
  if (simulationStatus.value === 'RUNNING' || simulationStatus.value === 'PAUSED') stopDialogVisible.value = true
}

/**
 * 创建并消费一次性确认后停止当前仿真。
 * @returns 停止流程完成后兑现且不返回值的 Promise。
 * @sideeffect 成功时停止运行、清零规范时钟、解除配置锁并关闭确认框。
 */
async function confirmStop(): Promise<void> {
  if (await simulationStore.stop()) stopDialogVisible.value = false
}

/**
 * 更新仿真倍速选择并在运行期间同步到 Mock 服务。
 * @param speed 用户选择的倍速。
 * @returns 操作完成后兑现且不返回值的 Promise。
 * @sideeffect 调用 simulationStore 更新本地选择或发送 SET_SPEED 命令。
 */
async function updateSpeed(speed: number): Promise<void> {
  await simulationStore.setSpeed(speed)
}

/**
 * 更新下一次 START 使用的运行模式。
 * @param mode 合同定义的运行模式。
 * @returns 无返回值。
 * @sideeffect 只更新 simulationStore 中的模式选择。
 */
function updateMode(mode: SimulationMode): void {
  simulationStore.setMode(mode)
}

/**
 * 打开所选链路的质量详情。
 * @param link 来自固定帧的链路视图。
 * @returns 无返回值。
 * @sideeffect 更新所选链路并打开详情框。
 */
function openLinkDetails(link: SituationLinkView): void {
  selectedLink.value = link
  linkDialogVisible.value = true
}

/**
 * 创建地图定位请求。
 * @param kind 节点、链路或干扰设备定位类型。
 * @param targetId 对应业务对象的唯一标识。
 * @returns 无返回值。
 * @sideeffect 创建新的请求对象并传给地图组件，同一条目可重复触发定位。
 */
function requestMapFocus(kind: SituationMapFocusTarget['kind'], targetId: string): void {
  mapFocusTarget.value = { kind, targetId }
}

/**
 * 从左侧摘要选择信息节点并定位地图。
 * @param platformId 平台唯一标识。
 * @returns 无返回值。
 * @sideeffect 更新当前选中节点并发出节点定位请求。
 */
function focusNodeOnMap(platformId: string): void {
  selectedNodeId.value = platformId
  requestMapFocus('node', platformId)
}

/**
 * 从左侧摘要选择信息链路并定位地图。
 * @param linkId 链路唯一标识。
 * @returns 无返回值。
 * @sideeffect 发出链路范围定位请求，不自动打开链路详情弹框。
 */
function focusLinkOnMap(linkId: string): void {
  requestMapFocus('link', linkId)
}

/**
 * 从左侧摘要选择干扰设备并定位地图。
 * @param jammerId 干扰设备唯一标识。
 * @param platformId 搭载干扰设备的平台唯一标识。
 * @returns 无返回值。
 * @sideeffect 选中干扰设备所在平台并发出干扰范围定位请求。
 */
function focusInterferenceOnMap(jammerId: string, platformId: string): void {
  selectedNodeId.value = platformId
  requestMapFocus('interference', jammerId)
}

/**
 * 返回链路状态的中文标签。
 * @param link 来自固定帧的链路视图。
 * @returns 链路界面状态的中文文本。
 * @sideeffect 无副作用。
 */
function linkStatusLabel(link: SituationLinkView): string {
  if (link.status === 'DEGRADED') return '劣化'
  return link.status === 'UP' ? '正常' : '中断'
}

/**
 * 返回干扰设备类型的中文名称。
 * @param jammerId 固定帧干扰设备标识。
 * @param platformId 搭载干扰设备的平台标识。
 * @returns 包含机载或地面部署位置的干扰设备名称。
 * @sideeffect 无副作用。
 */
function jammerTypeLabel(jammerId: string, platformId: string): string {
  const location = frame.value?.platforms
    .find((platform) => platform.platformId === platformId)?.type === 'AIRBORNE_MISSION_CLUSTER'
    ? '机载'
    : '地面'
  return `${location}${getJammerTypeLabel(jammerId)}干扰设备`
}

/**
 * 生成同帧事件的中文描述。
 * @param event 固定帧侦测或链路切换事件。
 * @returns 事件摘要文本。
 * @sideeffect 无副作用。
 */
function eventDescription(event: DetectionEvent | SwitchEvent): string {
  if (event.type === 'DETECTION') {
    return `${event.sensorId} 发现 ${event.targetPlatformId}，发现概率 ${(event.detectionProbability * 100).toFixed(0)}%`
  }
  return `${event.oldLinkId} 切换至 ${event.newLinkId}，决策已接受`
}
</script>

<template>
  <section id="page-situation" class="situation-page" aria-labelledby="situation-title">
    <h2 id="situation-title" class="situation-page__semantic-title">态势主界面</h2>

    <SimulationToolbar
      :status="simulationStatus"
      :current-time="simulationTime"
      :speed="simulationSpeed"
      :mode="simulationMode"
      :lock-state="configurationLockState"
      :pending="simulationPending"
      :feedback="simulationFeedback"
      @start="startSimulation"
      @pause="pauseSimulation"
      @step="stepSimulation"
      @stop="requestStop"
      @update:speed="updateSpeed"
      @update:mode="updateMode"
    />

    <div
      v-if="frame && situationMetrics"
      class="situation-page__workspace"
      :class="{
        'situation-page__workspace--scene-collapsed': sceneSummaryCollapsed,
        'situation-page__workspace--telemetry-collapsed': telemetryPanelCollapsed,
      }"
    >
      <aside
        class="scene-summary"
        :class="{ 'is-collapsed': sceneSummaryCollapsed }"
        aria-label="场景配置"
        :data-collapsed="sceneSummaryCollapsed"
      >
      <strong class="node-jammer-count">{{ situationMetrics.businessNodeCount }} / {{ BUSINESS_NODE_CAPACITY }}</strong>
        <button
          type="button"
          class="floating-panel__toggle floating-panel__toggle--left"
          data-testid="toggle-scene-summary"
          :aria-expanded="!sceneSummaryCollapsed"
          :aria-label="sceneSummaryCollapsed ? '展开场景配置' : '折叠场景配置'"
          @click="toggleSceneSummary"
        ><span aria-hidden="true">{{ sceneSummaryCollapsed ? '›' : '‹' }}</span></button>
        <div class="panel-heading">
          <div><strong>场景配置</strong></div>
          <router-link to="/scenarios">进入场景配置</router-link>
        </div>

        <div class="scene-summary__tabs" role="tablist" aria-label="场景摘要分类">
          <button
            v-for="tab in summaryTabs"
            :key="tab.key"
            type="button"
            role="tab"
            :aria-selected="activeTab === tab.key"
            :class="{ active: activeTab === tab.key }"
            @click="activeTab = tab.key"
          >{{ tab.label }}</button>
        </div>

        <div class="scene-summary__content" :aria-label="`${summaryTabs.find((tab) => tab.key === activeTab)?.label}摘要`">
          <template v-if="activeTab === 'nodes'">
            <div class="summary-group">
              <h3>信息节点 · {{ situationMetrics.businessNodeCount }} 个</h3>
              <ul>
                <li v-for="platform in displayedBusinessPlatforms" :key="platform.platformId">
                  <button
                    type="button"
                    class="summary-focus-button"
                    :data-testid="`focus-node-${platform.platformId}`"
                    :aria-label="`在地图中定位${platform.name}`"
                    @click="focusNodeOnMap(platform.platformId)"
                  >
                    <span>{{ platform.platformId }}</span><small>{{ platform.name }}</small>
                  </button>
                </li>
              </ul>
            </div>
            <div class="summary-group">
              <h3>支撑实体</h3>
              <ul>
                <li v-for="platform in supportingPlatforms" :key="platform.platformId">
                  <button
                    type="button"
                    class="summary-focus-button"
                    :data-testid="`focus-node-${platform.platformId}`"
                    :aria-label="`在地图中定位${platform.name}`"
                    @click="focusNodeOnMap(platform.platformId)"
                  >
                    <span>{{ platform.platformId }}</span><small>{{ platform.name }}</small>
                  </button>
                </li>
              </ul>
            </div>
          </template>

          <div v-else-if="activeTab === 'links'" class="summary-group">
            <ul>
              <li v-for="link in situationLinks" :key="link.linkId">
                <button
                  type="button"
                  class="summary-focus-button"
                  :data-testid="`focus-link-${link.linkId}`"
                  :aria-label="`在地图中定位${LINK_TYPE_LABELS[link.type]} ${link.sourceName}至${link.destinationName}`"
                  @click="focusLinkOnMap(link.linkId)"
                >
                  <span>{{ link.linkId }}</span><small>{{ LINK_TYPE_LABELS[link.type] }}</small>
                </button>
              </li>
            </ul>
          </div>

          <div v-else-if="activeTab === 'interference'" class="summary-group">
            <ul>
              <li v-for="jammer in jammers" :key="jammer.jammerId">
                <button
                  type="button"
                  class="summary-focus-button"
                  :data-testid="`focus-interference-${jammer.jammerId}`"
                  :aria-label="`在地图中定位${jammerTypeLabel(jammer.jammerId, jammer.platformId)}`"
                  @click="focusInterferenceOnMap(jammer.jammerId, jammer.platformId)"
                >
                  <span>{{ jammerTypeLabel(jammer.jammerId, jammer.platformId) }}</span>
                  <small>{{ jammer.active ? '活动' : '待机' }} · {{ jammer.power }} W</small>
                </button>
              </li>
            </ul>
          </div>

          <div v-else class="summary-group">
            <h3>固定帧时序</h3>
            <dl class="timing-list">
              <div><dt>帧标识</dt><dd>{{ frame.frameId }}</dd></div>
              <div><dt>任务 / 运行</dt><dd>{{ frame.taskId }} / {{ frame.runId }}</dd></div>
              <div><dt>仿真时刻</dt><dd>{{ frame.simulationTime }} s</dd></div>
              <div><dt>帧序号</dt><dd>{{ frame.sequence }}</dd></div>
            </dl>
          </div>
        </div>

      </aside>

      <main class="situation-center" data-testid="situation-center">
        <OfflineSituationMap
          :frame="frame"
          :links="situationLinks"
          :selected-node-id="selectedNodeId"
          :focus-target="mapFocusTarget"
          @select-node="selectedNodeId = $event"
          @select-link="openLinkDetails"
        >
          <template #topbar>
            <MetricPanel :metrics="situationMetrics" />
          </template>
        </OfflineSituationMap>
      </main>

      <aside
        class="telemetry-panel"
        :class="{ 'is-collapsed': telemetryPanelCollapsed }"
        aria-label="链路、干扰与事件"
        :data-collapsed="telemetryPanelCollapsed"
      >
        <button
          type="button"
          class="floating-panel__toggle floating-panel__toggle--right"
          data-testid="toggle-telemetry-panel"
          :aria-expanded="!telemetryPanelCollapsed"
          :aria-label="telemetryPanelCollapsed ? '展开链路、干扰与事件' : '折叠链路、干扰与事件'"
          @click="toggleTelemetryPanel"
        ><span aria-hidden="true">{{ telemetryPanelCollapsed ? '‹' : '›' }}</span></button>
        <section class="telemetry-section telemetry-section--links" :data-frame-id="frame.frameId">
          <div class="panel-heading">
            <div><strong>全链路状态</strong></div>
            <span class="panel-heading__more">异常 {{ situationMetrics.degradedLinkCount + situationMetrics.downLinkCount }} 条</span>
          </div>
          <div class="link-table-wrap">
            <table class="link-table">
              <thead><tr><th>链路</th><th>体制</th><th>SNR</th><th>BER</th><th>状态</th></tr></thead>
              <tbody>
                <tr
                  v-for="link in situationLinks"
                  :key="link.linkId"
                  tabindex="0"
                  role="button"
                  :data-link-id="link.linkId"
                  :class="{ 'is-exception': link.status !== 'UP' }"
                  @click="openLinkDetails(link)"
                  @keydown.enter="openLinkDetails(link)"
                >
                  <td><strong>{{ link.sourceName }}→{{ link.destinationName }}</strong><small>{{ link.linkId }}</small></td>
                  <td>{{ link.type === 'DATALINK' ? '数传' : LINK_TYPE_LABELS[link.type].replace('链路', '') }}</td>
                  <td>{{ link.snrDb.toFixed(2) }}</td>
                  <td>{{ formatBer(link.ber) }}</td>
                  <td><span :class="`link-status link-status--${link.status.toLowerCase()}`">{{ linkStatusLabel(link) }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="telemetry-section telemetry-section--jammer">
          <div class="panel-heading"><div><strong>干扰 / 侦测设备</strong></div><span class="panel-heading__more">{{ jammers.length }} 台</span></div>
          <div class="jammer-list">
            <article v-for="jammer in jammers" :key="jammer.jammerId" :class="{ active: jammer.active }">
              <div><strong>{{ jammerTypeLabel(jammer.jammerId, jammer.platformId) }}</strong><span>{{ jammer.active ? '活动' : '待机' }}</span></div>
              <small>搭载平台：{{ getPlatformName(jammer.platformId, frame) }} · {{ jammer.platformId }}</small>
              <dl>
                <div><dt>功率</dt><dd>{{ jammer.power }} W</dd></div>
                <div><dt>频率</dt><dd>{{ jammer.frequency }} MHz</dd></div>
                <div><dt>带宽</dt><dd>{{ jammer.bandwidth }} MHz</dd></div>
              </dl>
              <div class="power-bar"><i :style="{ width: `${Math.min(jammer.power, 100)}%` }"></i></div>
            </article>
          </div>
          <p v-if="detectionEvent" class="detection-state">
            {{ detectionEvent.sensorId }} 已发现 {{ detectionEvent.targetPlatformId }} · 发现概率 {{ (detectionEvent.detectionProbability * 100).toFixed(0) }}%
          </p>
        </section>

        <section class="telemetry-section telemetry-section--events">
          <div class="panel-heading"><div><strong>同帧事件</strong></div><span class="panel-heading__more">累计 {{ events.length }} 条</span></div>
          <ol class="event-list">
            <li v-for="event in events" :key="event.eventId">
              <div><time>{{ formatSimulationTime(event.time) }}</time><strong>{{ event.type === 'DETECTION' ? '侦测' : '链路切换' }}</strong></div>
              <p>{{ eventDescription(event) }}</p><small>{{ event.eventId }} · {{ event.frameId }}</small>
            </li>
          </ol>
        </section>
      </aside>
    </div>

    <section v-else class="telemetry-empty" aria-live="polite">
      <strong>{{ telemetryCapabilityState === 'LOADING' || telemetryCapabilityState === 'VALIDATING' ? '正在加载态势遥测' : '暂无可用态势遥测' }}</strong>
      <p>{{ telemetryFeedback }}</p>
      <el-button v-if="telemetryCapabilityState === 'ERROR'" type="primary" @click="retryTelemetry">重新加载</el-button>
    </section>

    <footer v-if="frame" class="situation-footer" :data-frame-id="frame.frameId">
      <span><i class="footer-dot"></i>{{ connectionLabel }}</span>
      <span>固定帧 {{ frame.frameId }}</span>
      <span>数据时刻 {{ frame.simulationTime }} s</span>
      <span>帧序号 {{ frame.sequence }}</span>
      <span data-testid="frame-freshness">最大数据年龄 {{ maximumLinkAgeMs }} ms · {{ frameFreshnessLabel }}</span>
      <strong>4 类业务信息节点 · 4 类链路 · 2 种干扰设备</strong>
    </footer>

    <LinkQualityDialog v-model="linkDialogVisible" :link="selectedLink" />
    <el-dialog v-model="stopDialogVisible" title="确认停止仿真" width="min(26rem, calc(100vw - 2rem))">
      <p class="stop-dialog-copy">停止后将清除当前执行状态并解除场景配置锁，固定遥测帧 F-00042 不会改变。</p>
      <template #footer>
        <el-button :disabled="simulationPending" @click="stopDialogVisible = false">取消</el-button>
        <el-button type="danger" :loading="simulationPending" data-testid="confirm-stop" @click="confirmStop">确认停止</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.situation-page {
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 38rem;
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--console-border);
  border-radius: var(--console-radius);
  color: var(--console-text);
  background: var(--console-bg-elevated);
  box-shadow: var(--console-shadow);
}
.situation-page__semantic-title { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.telemetry-empty { display: grid; place-content: center; justify-items: center; gap: .65rem; color: var(--console-text-muted); text-align: center; }
.telemetry-empty strong { color: var(--console-text); }
.telemetry-empty p { margin: 0; }
.situation-page__workspace {
  --scene-panel-clearance: 17.5rem;
  --telemetry-panel-clearance: 24rem;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.scene-summary, .telemetry-panel { position: absolute; z-index: 1100; top: .75rem; bottom: .75rem; min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--console-border); border-radius: 8px; background: rgba(8,25,39,.96); box-shadow: var(--console-shadow); transition: width .18s ease; }
.scene-summary { left: .75rem; display: grid; width: 16rem; grid-template-rows: auto auto minmax(0, 1fr); }
.telemetry-panel { right: .75rem; display: grid; width: 22.5rem; grid-template-rows: minmax(14rem, 1.35fr) minmax(10rem, 1fr) minmax(8rem, .8fr); border-color: #1e3448; background: #0f1f30; }
.floating-panel__toggle { position: absolute; z-index: 2; top: .3rem; display: grid; width: 1.75rem; height: 1.75rem; place-items: center; padding: 0; border: 1px solid var(--console-border-strong); border-radius: 5px; color: var(--console-cyan); background: rgba(7,21,34,.96); font-size: 1.1rem; line-height: 1; cursor: pointer; }
.floating-panel__toggle--left { right: .35rem; }
.floating-panel__toggle--right { left: .35rem; }
.scene-summary > .panel-heading { padding-right: 2.65rem; }
.telemetry-panel > .telemetry-section:first-of-type .panel-heading { padding-left: 2.65rem; }
.scene-summary.is-collapsed > :not(.floating-panel__toggle), .telemetry-panel.is-collapsed > :not(.floating-panel__toggle) { display: none; }
.scene-summary.is-collapsed .floating-panel__toggle, .telemetry-panel.is-collapsed .floating-panel__toggle { top: 0; right: auto; left: 0; font-size: 1.5rem; font-weight: 700; text-shadow: 0 0 2px #06111d, 0 0 5px #06111d; }
.panel-heading { display: flex; min-height: 2.25rem; align-items: center; justify-content: space-between; gap: .5rem; padding: .4rem .65rem; border-bottom: 1px solid var(--console-border); background: rgba(16,40,58,.72); }
.panel-heading>div { display: flex; min-width: 0; align-items: center; gap: .45rem; }
.panel-heading strong { font-size: .76rem; }
.panel-heading span, .panel-heading small, .panel-heading a { color: var(--console-text-muted); font-size: var(--console-font-size-min); }
.panel-heading a { color: var(--console-cyan); text-decoration: none; }
.telemetry-panel .panel-heading { min-height: 2.35rem; padding: .55rem .85rem; border-bottom-color: #1e3448; color: #e8f0f8; background: transparent; }
.telemetry-panel .panel-heading strong { color: #e8f0f8; font-size: 13px; }
.telemetry-panel .panel-heading__more { color: #4fd6ff; font-size: 12px; font-weight: 400; }
.scene-summary__tabs { display: grid; grid-template-columns: repeat(4,1fr); margin: .5rem .6rem 0; border: 1px solid var(--console-border); border-radius: 5px; overflow: hidden; }
.scene-summary__tabs button { min-height: 1.75rem; border: 0; border-right: 1px solid var(--console-border); color: var(--console-text-muted); background: var(--console-bg-elevated); font-size: var(--console-font-size-min); cursor: pointer; }
.scene-summary__tabs button:last-child { border-right: 0; }
.scene-summary__tabs button.active { color: var(--console-cyan); background: rgba(66,216,255,.1); }
.scene-summary__content { min-height: 0; overflow-y: auto; padding: .5rem .6rem; }
.summary-group + .summary-group { margin-top: .55rem; }
.summary-group h3 { margin: 0 0 .3rem; color: var(--console-text-muted); font-size: var(--console-font-size-min); font-weight: 600; }
.summary-group ul, .event-list { display: grid; gap: .28rem; margin: 0; padding: 0; list-style: none; }
.summary-group li { border-left: 2px solid var(--console-border-strong); background: rgba(16,40,58,.48); }
.summary-focus-button { display: grid; width: 100%; gap: .12rem; padding: .38rem .45rem; border: 0; color: var(--console-text); background: transparent; font: inherit; font-size: var(--console-font-size-min); text-align: left; cursor: pointer; }
.summary-focus-button:hover { background: rgba(66,216,255,.08); }
.summary-focus-button:focus-visible { outline: 1px solid var(--console-cyan); outline-offset: -1px; background: rgba(66,216,255,.1); }
.summary-group li small { color: var(--console-text-muted); font-family: Consolas,monospace; font-size: var(--console-font-size-min); }
.timing-list { display: grid; gap: .3rem; margin: 0; }
.timing-list div { display: grid; gap: .12rem; padding: .4rem; background: rgba(16,40,58,.48); }
.timing-list dt { color: var(--console-text-muted); font-size: var(--console-font-size-min); }
.timing-list dd { margin: 0; font-family: Consolas,monospace; font-size: var(--console-font-size-min); }
.situation-center { position: relative; display: grid; width: 100%; height: 100%; min-width: 0; min-height: 0; grid-template-rows: minmax(0,1fr); }
.telemetry-section { min-height: 0; overflow: hidden; border-bottom: 1px solid #1e3448; }
.telemetry-section:last-child { border-bottom: 0; }
.telemetry-section--links, .telemetry-section--events { display: grid; grid-template-rows: auto minmax(0,1fr); }
.telemetry-section--jammer { display: grid; grid-template-rows: auto minmax(0,1fr) auto; }
.link-table-wrap, .event-list, .jammer-list { min-height: 0; overflow-y: auto; }
.link-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.link-table th { position: sticky; z-index: 1; top: 0; padding: .45rem .5rem; color: #8fb6d9; background: #102a40; font-size: 12px; font-weight: 600; text-align: left; }
.link-table th:nth-child(1) { width: 28%; }
.link-table th:nth-child(2) { width: 17%; }
.link-table th:nth-child(3) { width: 14%; }
.link-table th:nth-child(4) { width: 17%; }
.link-table th:nth-child(5) { width: 24%; }
.link-table td { padding: .4rem .5rem; border-bottom: 1px solid #16283c; color: #a8bfd4; font-family: Consolas,"Microsoft YaHei",monospace; font-size: 12px; cursor: pointer; }
.link-table tr.is-exception td { color: #ff7b7b; background: #3a1620; }
.link-table tr:hover td, .link-table tr:focus td { background: #16283c; }
.link-table tr.is-exception:hover td, .link-table tr.is-exception:focus td { background: #4a1b27; }
.link-table td strong, .link-table td small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-table td small { margin-top: .1rem; color: #6b8299; font-family: "Microsoft YaHei",sans-serif; font-size: 12px; }
.link-status { display: inline-flex; padding: .1rem .45rem; border-radius: 999px; font-family: "Microsoft YaHei",sans-serif; font-size: 12px; line-height: 1.25; }
.link-status--up { color: #6fd68a; background: #12351f; }
.link-status--degraded { color: #ffb84d; background: #3a2c10; }
.link-status--down { color: #ff7b7b; background: #3a1620; }
.jammer-list { display: block; padding: 0; }
.jammer-list article { padding: .6rem .85rem; border-bottom: 1px solid #1e3448; color: #a8bfd4; background: transparent; }
.jammer-list article>div:first-child { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: .45rem; }
.jammer-list article>div:first-child::before { width: .55rem; height: .55rem; border-radius: 50%; background: #6b8299; content: ""; }
.jammer-list article.active>div:first-child::before { background: #ff5b5b; box-shadow: 0 0 6px rgba(255,91,91,.65); }
.jammer-list article strong { color: #e8f0f8; font-size: 12px; }
.jammer-list article span { color: #8fb6d9; font-size: 12px; }
.jammer-list article>small { display: block; margin-top: .35rem; color: #6b8299; font-size: 12px; }
.jammer-list article.active span { color: #ff7b7b; }
.jammer-list dl { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: .5rem; margin: .5rem 0; }
.jammer-list dt { color: #6b8299; font-size: 12px; }
.jammer-list dd { margin: .1rem 0 0; color: #a8bfd4; font-family: Consolas,monospace; font-size: 12px; }
.power-bar { height: .35rem; overflow: hidden; border-radius: 999px; background: #16283c; }
.power-bar i { display: block; height: 100%; border-radius: inherit; background: #ff5b5b; }
.detection-state { margin: 0; padding: .5rem .85rem; border-top: 1px solid #1e3448; color: #ff7b7b; font-size: 12px; }
.event-list { display: block; padding: .5rem .85rem; }
.event-list li { padding: .4rem 0; border-bottom: 1px dashed #16283c; background: transparent; }
.event-list li:last-child { border-bottom: 0; }
.event-list li>div { display: flex; justify-content: space-between; gap: .5rem; }
.event-list time { color: #4fd6ff; font-family: Consolas,monospace; font-size: 12px; }
.event-list small { color: #6b8299; font-family: Consolas,monospace; font-size: 12px; }
.event-list strong { color: #ffb84d; font-size: 12px; }
.event-list p { margin: .2rem 0; color: #a8bfd4; font-size: 12px; line-height: 1.5; }
.situation-footer { display: flex; min-height: 2rem; align-items: center; gap: 1rem; padding: .35rem .7rem; border-top: 1px solid var(--console-border); color: var(--console-text-muted); background: #06131f; font-family: Consolas,"Microsoft YaHei",monospace; font-size: var(--console-font-size-min); white-space: nowrap; }
.situation-footer span:first-child { display: inline-flex; align-items: center; gap: .3rem; }
.situation-footer strong { overflow: hidden; margin-left: auto; color: var(--console-teal); text-overflow: ellipsis; }
.footer-dot { width: .42rem; height: .42rem; border-radius: 50%; background: var(--console-text-dim); }
.stop-dialog-copy { margin: 0; color: var(--console-text-muted); line-height: 1.7; }
.scene-summary .node-jammer-count{ position: absolute;  top:9px; left:62px; color: var(--console-cyan); font-size: var(--console-font-size-min);}
@media (max-width: 1500px) {
  .situation-page__workspace { --scene-panel-clearance: 15.5rem; --telemetry-panel-clearance: 21.5rem; }
  .scene-summary { width: 14rem; }
  .telemetry-panel { width: 20rem; }
  .situation-footer { gap: .65rem; }
}
@media (max-width: 1100px) {
  .situation-page__workspace { --scene-panel-clearance: 13.5rem; --telemetry-panel-clearance: 19.5rem; }
  .scene-summary { width: 12rem; }
  .telemetry-panel { width: 18rem; }
  .situation-footer span:nth-child(3), .situation-footer span:nth-child(4) { display: none; }
}
.situation-page__workspace--scene-collapsed { --scene-panel-clearance: 3.25rem; --legend-clearance: .75rem; }
.situation-page__workspace--telemetry-collapsed { --telemetry-panel-clearance: 3.25rem; --view-controls-clearance: .75rem; }
.scene-summary.is-collapsed, .telemetry-panel.is-collapsed { bottom: auto; width: 1.75rem; height: 1.75rem; overflow: visible; border-color: transparent; background: transparent; box-shadow: none; }
@media (max-width: 760px) {
  .situation-page { height: auto; }
}
</style>
