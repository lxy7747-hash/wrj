<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DetectionEvent, SwitchEvent } from '../contracts/domain-models'
import LinkQualityDialog from '../components/situation/LinkQualityDialog.vue'
import MetricPanel from '../components/situation/MetricPanel.vue'
import OfflineSituationMap from '../components/situation/OfflineSituationMap.vue'
import SimulationToolbar, { type LocalSimulationStatus } from '../components/situation/SimulationToolbar.vue'
import {
  LINK_TYPE_LABELS,
  PLATFORM_TYPE_LABELS,
  SITUATION_EVENTS_F00042,
  SITUATION_FRAME_F00042,
  SITUATION_LINKS_F00042,
  SITUATION_METRICS_F00042,
  formatBer,
  formatSimulationTime,
  type SituationLinkView,
} from '../features/situation/situation-model'

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
const simulationStatus = ref<LocalSimulationStatus>('STOPPED')
const simulationTime = ref(0)
const simulationSpeed = ref(1)
const simulationMode = ref('single')
const stopDialogVisible = ref(false)
const selectedNodeId = ref(SITUATION_FRAME_F00042.platforms[0]?.platformId ?? '')
const selectedLink = ref<SituationLinkView | null>(null)
const linkDialogVisible = ref(false)

const configurationLocked = computed(() => simulationStatus.value !== 'STOPPED')
const businessPlatforms = computed(() => SITUATION_FRAME_F00042.platforms.filter(
  (platform) => BUSINESS_NODE_TYPES.has(platform.type),
))
const supportingPlatforms = computed(() => SITUATION_FRAME_F00042.platforms.filter(
  (platform) => !BUSINESS_NODE_TYPES.has(platform.type),
))
const jammers = computed(() => SITUATION_FRAME_F00042.platforms.flatMap((platform) => platform.jammers))
const detectionEvent = computed(() => SITUATION_EVENTS_F00042.find(
  (event): event is DetectionEvent => event.type === 'DETECTION',
))
const modeLabel = computed(() => ({
  single: '单次仿真', batch: '批量仿真', scan: '参数扫描', replay: '历史回放',
})[simulationMode.value] ?? '单次仿真')
const maximumLinkAgeMs = computed(() => Math.max(...SITUATION_LINKS_F00042.map((link) => link.ageMs)))
const frameFreshnessLabel = computed(() => (maximumLinkAgeMs.value === 0 ? '新鲜' : '存在延迟'))

/**
 * 开始或继续本地确定性仿真状态机。
 * @returns 无返回值。
 * @sideeffect 将本地运行状态改为运行中并锁定配置摘要。
 */
function startSimulation(): void {
  simulationStatus.value = 'RUNNING'
}

/**
 * 暂停本地确定性仿真状态机。
 * @returns 无返回值。
 * @sideeffect 仅在运行中将状态改为暂停，固定遥测帧不变。
 */
function pauseSimulation(): void {
  if (simulationStatus.value === 'RUNNING') simulationStatus.value = 'PAUSED'
}

/**
 * 执行一次本地单步。
 * @returns 无返回值。
 * @sideeffect 仿真时钟增加一秒并保持暂停，固定遥测帧不变。
 */
function stepSimulation(): void {
  if (simulationStatus.value === 'RUNNING') return
  simulationTime.value += 1
  simulationStatus.value = 'PAUSED'
}

/**
 * 打开停止操作确认框。
 * @returns 无返回值。
 * @sideeffect 修改停止确认框的可见状态。
 */
function requestStop(): void {
  if (simulationStatus.value !== 'STOPPED') stopDialogVisible.value = true
}

/**
 * 确认停止本地仿真状态机。
 * @returns 无返回值。
 * @sideeffect 停止运行、清零本地时钟、解锁配置摘要并关闭确认框。
 */
function confirmStop(): void {
  simulationStatus.value = 'STOPPED'
  simulationTime.value = 0
  stopDialogVisible.value = false
}

/**
 * 更新本地仿真倍速选择。
 * @param speed 用户选择的倍速。
 * @returns 无返回值。
 * @sideeffect 修改本地倍速显示，不启动计时器或运行服务。
 */
function updateSpeed(speed: number): void {
  simulationSpeed.value = speed
}

/**
 * 更新本地运行模式选择。
 * @param mode 用户选择的运行模式代码。
 * @returns 无返回值。
 * @sideeffect 修改本地模式反馈，不创建任务或运行进程。
 */
function updateMode(mode: string): void {
  simulationMode.value = mode
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
 * 返回链路状态的中文标签。
 * @param link 来自固定帧的链路视图。
 * @returns 同时表达界面状态和规范状态的中文文本。
 * @sideeffect 无副作用。
 */
function linkStatusLabel(link: SituationLinkView): string {
  if (link.status === 'DEGRADED') return '劣化 / 规范中断'
  return link.status === 'UP' ? '正常' : '中断'
}

/**
 * 返回干扰设备类型的中文名称。
 * @param jammerId 固定帧干扰设备标识。
 * @returns 宽带压制或点频干扰名称。
 * @sideeffect 无副作用。
 */
function jammerTypeLabel(jammerId: string): string {
  return jammerId.includes('WB') ? '宽带压制干扰' : '点频干扰'
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
      @start="startSimulation"
      @pause="pauseSimulation"
      @step="stepSimulation"
      @stop="requestStop"
      @update:speed="updateSpeed"
      @update:mode="updateMode"
    />

    <div class="situation-page__workspace">
      <aside class="scene-summary" aria-label="场景配置摘要">
        <div class="panel-heading">
          <div><strong>场景配置摘要</strong></div>
          <router-link to="/scenarios">进入场景配置</router-link>
        </div>

        <div class="scene-summary__state" :class="{ locked: configurationLocked }" aria-live="polite">
          <strong>{{ configurationLocked ? '配置已锁定' : '配置可查看' }}</strong>
          <span>{{ modeLabel }} · {{ configurationLocked ? '运行期间不可编辑' : '本页不提供编辑' }}</span>
        </div>

        <div class="scene-summary__capacity">
          <span>业务信息节点容量</span>
          <strong data-testid="business-node-capacity">{{ SITUATION_METRICS_F00042.businessNodeCount }} / {{ BUSINESS_NODE_CAPACITY }}</strong>
          <small>支撑实体 {{ SITUATION_METRICS_F00042.supportingEntityCount }} 个，不计入上限</small>
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
              <h3>4 类业务信息节点</h3>
              <ul>
                <li v-for="platform in businessPlatforms" :key="platform.platformId">
                  <span>{{ PLATFORM_TYPE_LABELS[platform.type] }}</span><small>{{ platform.platformId }}</small>
                </li>
              </ul>
            </div>
            <div class="summary-group">
              <h3>2 类支撑实体</h3>
              <ul>
                <li v-for="platform in supportingPlatforms" :key="platform.platformId">
                  <span>{{ PLATFORM_TYPE_LABELS[platform.type] }}</span><small>{{ platform.platformId }}</small>
                </li>
              </ul>
            </div>
          </template>

          <div v-else-if="activeTab === 'links'" class="summary-group">
            <h3>4 类信息链路</h3>
            <ul>
              <li v-for="link in SITUATION_LINKS_F00042" :key="link.linkId">
                <span>{{ LINK_TYPE_LABELS[link.type] }}</span><small>{{ link.linkId }}</small>
              </li>
            </ul>
          </div>

          <div v-else-if="activeTab === 'interference'" class="summary-group">
            <h3>2 种干扰设备</h3>
            <ul>
              <li v-for="jammer in jammers" :key="jammer.jammerId">
                <span>{{ jammerTypeLabel(jammer.jammerId) }}</span>
                <small>{{ jammer.active ? '活动' : '待机' }} · {{ jammer.power }} W</small>
              </li>
            </ul>
          </div>

          <div v-else class="summary-group">
            <h3>固定帧时序</h3>
            <dl class="timing-list">
              <div><dt>帧标识</dt><dd>{{ SITUATION_FRAME_F00042.frameId }}</dd></div>
              <div><dt>任务 / 运行</dt><dd>{{ SITUATION_FRAME_F00042.taskId }} / {{ SITUATION_FRAME_F00042.runId }}</dd></div>
              <div><dt>仿真时刻</dt><dd>{{ SITUATION_FRAME_F00042.simulationTime }} s</dd></div>
              <div><dt>帧序号</dt><dd>{{ SITUATION_FRAME_F00042.sequence }}</dd></div>
            </dl>
          </div>
        </div>

        <div class="scene-summary__boundary">本页展示固定帧数据；场景录入、校验和脚本预览在“场景配置”中实施。</div>
      </aside>

      <main class="situation-center">
        <MetricPanel :metrics="SITUATION_METRICS_F00042" />
        <OfflineSituationMap
          :links="SITUATION_LINKS_F00042"
          :selected-node-id="selectedNodeId"
          @select-node="selectedNodeId = $event"
          @select-link="openLinkDetails"
        />
      </main>

      <aside class="telemetry-panel" aria-label="链路、干扰与事件">
        <section class="telemetry-section telemetry-section--links" :data-frame-id="SITUATION_FRAME_F00042.frameId">
          <div class="panel-heading">
            <div><strong>全链路状态</strong><span>{{ SITUATION_LINKS_F00042.length }} 条</span></div><small>点击查看详情</small>
          </div>
          <div class="link-table-wrap">
            <table class="link-table">
              <thead><tr><th>链路</th><th>SNR / BER</th><th>状态</th></tr></thead>
              <tbody>
                <tr
                  v-for="link in SITUATION_LINKS_F00042"
                  :key="link.linkId"
                  tabindex="0"
                  role="button"
                  :data-link-id="link.linkId"
                  @click="openLinkDetails(link)"
                  @keydown.enter="openLinkDetails(link)"
                >
                  <td><strong>{{ link.linkId }}</strong><small>{{ LINK_TYPE_LABELS[link.type] }}</small></td>
                  <td><strong>{{ link.snrDb.toFixed(2) }} dB</strong><small>{{ formatBer(link.ber) }}</small></td>
                  <td><span :class="`link-status link-status--${link.status.toLowerCase()}`">{{ linkStatusLabel(link) }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="telemetry-section telemetry-section--jammer">
          <div class="panel-heading"><div><strong>干扰 / 感知</strong><span>{{ jammers.length }} 台设备</span></div></div>
          <div class="jammer-list">
            <article v-for="jammer in jammers" :key="jammer.jammerId" :class="{ active: jammer.active }">
              <div><strong>{{ jammerTypeLabel(jammer.jammerId) }}</strong><span>{{ jammer.active ? '活动' : '待机' }}</span></div>
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
          <div class="panel-heading"><div><strong>同帧事件</strong><span>{{ SITUATION_EVENTS_F00042.length }} 条</span></div></div>
          <ol class="event-list">
            <li v-for="event in SITUATION_EVENTS_F00042" :key="event.eventId">
              <div><time>{{ formatSimulationTime(event.time) }}</time><strong>{{ event.type === 'DETECTION' ? '侦测' : '链路切换' }}</strong></div>
              <p>{{ eventDescription(event) }}</p><small>{{ event.eventId }} · {{ event.frameId }}</small>
            </li>
          </ol>
        </section>
      </aside>
    </div>

    <footer class="situation-footer" :data-frame-id="SITUATION_FRAME_F00042.frameId">
      <span><i class="footer-dot"></i>未连接运行服务</span>
      <span>固定帧 {{ SITUATION_FRAME_F00042.frameId }}</span>
      <span>数据时刻 {{ SITUATION_FRAME_F00042.simulationTime }} s</span>
      <span>帧序号 {{ SITUATION_FRAME_F00042.sequence }}</span>
      <span data-testid="frame-freshness">最大数据年龄 {{ maximumLinkAgeMs }} ms · {{ frameFreshnessLabel }}</span>
      <strong>4 类业务信息节点 · 4 类链路 · 2 种干扰设备</strong>
    </footer>

    <LinkQualityDialog v-model="linkDialogVisible" :link="selectedLink" />
    <el-dialog v-model="stopDialogVisible" title="确认停止仿真" width="min(26rem, calc(100vw - 2rem))">
      <p class="stop-dialog-copy">停止后本地仿真时钟将清零，场景配置摘要将解除锁定。固定帧 F-00042 不会改变。</p>
      <template #footer>
        <el-button @click="stopDialogVisible = false">取消</el-button>
        <el-button type="danger" data-testid="confirm-stop" @click="confirmStop">确认停止</el-button>
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
.situation-page__workspace { display: grid; min-width: 0; min-height: 0; grid-template-columns: 16rem minmax(0, 1fr) 20rem; }
.scene-summary, .telemetry-panel { min-width: 0; min-height: 0; overflow: hidden; background: #081927; }
.scene-summary { display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr) auto; border-right: 1px solid var(--console-border); }
.telemetry-panel { display: grid; grid-template-rows: minmax(11rem, 1.25fr) minmax(10rem, 1fr) minmax(9rem, .85fr); border-left: 1px solid var(--console-border); }
.panel-heading { display: flex; min-height: 2.25rem; align-items: center; justify-content: space-between; gap: .5rem; padding: .4rem .65rem; border-bottom: 1px solid var(--console-border); background: rgba(16,40,58,.72); }
.panel-heading>div { display: flex; min-width: 0; align-items: center; gap: .45rem; }
.panel-heading strong { font-size: .76rem; }
.panel-heading span, .panel-heading small, .panel-heading a { color: var(--console-text-muted); font-size: .64rem; }
.panel-heading a { color: var(--console-cyan); text-decoration: none; }
.scene-summary__state, .scene-summary__capacity { display: grid; gap: .15rem; margin: .5rem .6rem 0; padding: .45rem .55rem; border: 1px solid var(--console-border); border-radius: 5px; background: rgba(66,216,255,.05); }
.scene-summary__state.locked { border-color: rgba(246,184,75,.5); background: rgba(246,184,75,.07); }
.scene-summary__state strong, .scene-summary__capacity strong { color: var(--console-cyan); font-size: .7rem; }
.scene-summary__state.locked strong { color: var(--console-amber); }
.scene-summary__state span, .scene-summary__capacity span, .scene-summary__capacity small { color: var(--console-text-muted); font-size: .61rem; }
.scene-summary__capacity { grid-template-columns: 1fr auto; }
.scene-summary__capacity small { grid-column: 1 / -1; }
.scene-summary__tabs { display: grid; grid-template-columns: repeat(4,1fr); margin: .5rem .6rem 0; border: 1px solid var(--console-border); border-radius: 5px; overflow: hidden; }
.scene-summary__tabs button { min-height: 1.75rem; border: 0; border-right: 1px solid var(--console-border); color: var(--console-text-muted); background: var(--console-bg-elevated); font-size: .67rem; cursor: pointer; }
.scene-summary__tabs button:last-child { border-right: 0; }
.scene-summary__tabs button.active { color: var(--console-cyan); background: rgba(66,216,255,.1); }
.scene-summary__content { min-height: 0; overflow-y: auto; padding: .5rem .6rem; }
.summary-group + .summary-group { margin-top: .55rem; }
.summary-group h3 { margin: 0 0 .3rem; color: var(--console-text-muted); font-size: .65rem; font-weight: 600; }
.summary-group ul, .event-list { display: grid; gap: .28rem; margin: 0; padding: 0; list-style: none; }
.summary-group li { display: grid; gap: .12rem; padding: .38rem .45rem; border-left: 2px solid var(--console-border-strong); color: var(--console-text); background: rgba(16,40,58,.48); font-size: .66rem; }
.summary-group li small { color: var(--console-text-muted); font-family: Consolas,monospace; font-size: .58rem; }
.timing-list { display: grid; gap: .3rem; margin: 0; }
.timing-list div { display: grid; gap: .12rem; padding: .4rem; background: rgba(16,40,58,.48); }
.timing-list dt { color: var(--console-text-muted); font-size: .6rem; }
.timing-list dd { margin: 0; font-family: Consolas,monospace; font-size: .66rem; }
.scene-summary__boundary { padding: .5rem .6rem; border-top: 1px solid var(--console-border); color: var(--console-text-muted); background: var(--console-bg-elevated); font-size: .6rem; line-height: 1.45; }
.situation-center { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0,1fr); }
.telemetry-section { min-height: 0; overflow: hidden; border-bottom: 1px solid var(--console-border); }
.telemetry-section:last-child { border-bottom: 0; }
.telemetry-section--links, .telemetry-section--events { display: grid; grid-template-rows: auto minmax(0,1fr); }
.telemetry-section--jammer { display: grid; grid-template-rows: auto minmax(0,1fr) auto; }
.link-table-wrap, .event-list, .jammer-list { min-height: 0; overflow-y: auto; }
.link-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.link-table th { position: sticky; z-index: 1; top: 0; padding: .35rem .4rem; color: var(--console-text-muted); background: #0b1e2d; font-size: .6rem; text-align: left; }
.link-table td { padding: .42rem .4rem; border-top: 1px solid rgba(29,64,88,.65); font-size: .64rem; cursor: pointer; }
.link-table tr:hover td, .link-table tr:focus td { background: rgba(66,216,255,.06); }
.link-table td strong, .link-table td small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-table td small { margin-top: .12rem; color: var(--console-text-muted); font-size: .56rem; }
.link-status { display: inline-flex; padding: .18rem .35rem; border: 1px solid currentColor; border-radius: 999px; font-size: .56rem; line-height: 1.2; }
.link-status--up { color: var(--console-teal); }
.link-status--degraded { color: var(--console-amber); }
.link-status--down { color: var(--console-danger); }
.jammer-list { display: grid; gap: .35rem; padding: .45rem .6rem; }
.jammer-list article { padding: .4rem .45rem; border: 1px solid var(--console-border); border-radius: 5px; background: rgba(16,40,58,.48); }
.jammer-list article.active { border-color: rgba(255,102,122,.55); }
.jammer-list article>div:first-child { display: flex; align-items: center; justify-content: space-between; }
.jammer-list article strong { font-size: .65rem; }
.jammer-list article span { color: var(--console-text-muted); font-size: .58rem; }
.jammer-list article.active span { color: var(--console-danger); }
.jammer-list dl { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: .3rem; margin: .35rem 0; }
.jammer-list dt { color: var(--console-text-muted); font-size: .55rem; }
.jammer-list dd { margin: .08rem 0 0; font-family: Consolas,monospace; font-size: .6rem; }
.power-bar { height: .22rem; overflow: hidden; border-radius: 999px; background: var(--console-border); }
.power-bar i { display: block; height: 100%; background: var(--console-danger); }
.detection-state { margin: 0; padding: .4rem .6rem; border-top: 1px solid var(--console-border); color: var(--console-amber); font-size: .6rem; }
.event-list { padding: .45rem .6rem; }
.event-list li { padding: .38rem .45rem; border-left: 2px solid var(--console-border-strong); background: rgba(16,40,58,.48); }
.event-list li>div { display: flex; justify-content: space-between; gap: .5rem; }
.event-list time, .event-list small { color: var(--console-text-muted); font-family: Consolas,monospace; font-size: .56rem; }
.event-list strong { color: var(--console-cyan); font-size: .6rem; }
.event-list p { margin: .22rem 0; color: var(--console-text); font-size: .6rem; line-height: 1.35; }
.situation-footer { display: flex; min-height: 2rem; align-items: center; gap: 1rem; padding: .35rem .7rem; border-top: 1px solid var(--console-border); color: var(--console-text-muted); background: #06131f; font-family: Consolas,"Microsoft YaHei",monospace; font-size: .62rem; white-space: nowrap; }
.situation-footer span:first-child { display: inline-flex; align-items: center; gap: .3rem; }
.situation-footer strong { overflow: hidden; margin-left: auto; color: var(--console-teal); text-overflow: ellipsis; }
.footer-dot { width: .42rem; height: .42rem; border-radius: 50%; background: var(--console-text-dim); }
.stop-dialog-copy { margin: 0; color: var(--console-text-muted); line-height: 1.7; }
@media (max-width: 1500px) {
  .situation-page__workspace { grid-template-columns: 14rem minmax(0,1fr) 18rem; }
  .situation-footer { gap: .65rem; }
}
@media (max-width: 1100px) {
  .situation-page__workspace { grid-template-columns: 12rem minmax(0,1fr) 15rem; }
  .situation-footer span:nth-child(3), .situation-footer span:nth-child(4) { display: none; }
}
@media (max-width: 760px) {
  .situation-page { height: auto; }
}
</style>
