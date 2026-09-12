<script setup lang="ts">
import { formatDateTime } from '../../features/shared/date-time'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { WsTopic } from '../../contracts/domain-models'
import { resolveMockOrigin } from '../../stores/auth'
import { useDataExchangeStore } from '../../stores/data-exchange'
import { useTelemetryStore } from '../../stores/telemetry'

const emit = defineEmits<{ tools: [target: string]; refresh: [] }>()
const store = useDataExchangeStore()
const telemetry = useTelemetryStore()
const topicLabels: Record<WsTopic, string> = {
  'simulation.frame': '仿真帧', 'runtime.state': '运行状态', 'link.metric': '链路指标',
  'jammer.event': '干扰事件', 'switch.event': '切换事件',
}
interface ExchangeRecord { id: number; time: string; topic: string; size: number; status: '通过' | '忽略' | '拒绝' }
interface Sample { rate: number; duration: number }
const records = ref<ExchangeRecord[]>([])
const samples = ref<Sample[]>([])
const received = ref(0)
const rejected = ref(0)
const bytes = ref(0)
const durationSum = ref(0)
const maxDuration = ref(0)
let bucketBytes = 0
let bucketCount = 0
let bucketDuration = 0
let sampledAt = performance.now()
let timer: ReturnType<typeof setInterval> | undefined
let monitorTicks = 0
const fileOperationLabels = { INITIAL_NODES: '初始节点读取', POSITIONS: '位置增量读取', LOCAL_REPLAY: '文件历史读取' }

const connectionLabel = computed(() => ({
  DISCONNECTED: '未连接', CONNECTING: '连接中', SUBSCRIBED: '已订阅', RETRYING: '重连中', FAILED: '连接失败',
})[telemetry.connectionState])
const connectionTone = computed(() => telemetry.connectionState === 'SUBSCRIBED' ? 'success'
  : telemetry.connectionState === 'FAILED' ? 'danger' : 'muted')
const serviceLabel = computed(() => ({
  EMPTY: '未检查', LOADING: '检查中', SUCCESS: store.monitor ? '本机服务正常' : 'Mock 服务可达', ERROR: '请求失败',
})[store.monitorState])
const serviceTone = computed(() => store.monitorState === 'SUCCESS' ? 'success' : store.monitorState === 'ERROR' ? 'danger' : 'muted')
const databaseLabel = computed(() => store.monitorState === 'ERROR' ? '状态未知'
  : store.monitorState === 'LOADING' ? '检查中' : store.monitor?.database === 'HEALTHY' ? '检查通过'
    : store.monitor?.database === 'ERROR' ? '检查失败' : store.monitorState === 'SUCCESS' ? '未接入（Mock）' : '未检查')
const wsAddress = new URL('/ws/v1', resolveMockOrigin())
wsAddress.protocol = wsAddress.protocol === 'https:' ? 'wss:' : 'ws:'
const rate = computed(() => samples.value.at(-1)?.rate ?? 0)
const averageDuration = computed(() => received.value === 0 ? 0 : durationSum.value / received.value)
const passRate = computed(() => received.value === 0 ? '—' : `${((received.value - rejected.value) / received.value * 100).toFixed(1)}%`)
const topics = computed(() => Object.entries(topicLabels).map(([id, label]) => ({ id, label, sequence: telemetry.topicSequences[id as WsTopic] })))
const files = computed(() => [
  ...store.csvContracts.map((contract) => ({ name: contract.name, version: contract.version,
    status: store.csvResult?.contractName === contract.name ? (store.csvResult.valid ? '校验通过' : '校验失败') : '待校验', target: 'de-cap-csvdx' })),
  ...(store.scenarioContract === null ? [] : [{ name: '场景 JSON', version: store.scenarioContract.version,
    status: store.jsonState === 'SUCCESS' ? '解析通过' : store.jsonState === 'ERROR' ? '解析失败' : '待解析', target: 'de-cap-jsonjx' }]),
])
const charts = computed(() => [
  { key: 'rate' as const, title: '实时接收吞吐', unit: 'KB/s', maximum: Math.max(1, ...samples.value.map((sample) => sample.rate)) },
  { key: 'duration' as const, title: '消息处理耗时', unit: 'ms', maximum: Math.max(1, ...samples.value.map((sample) => sample.duration)) },
])

/**
 * 将最近 60 次采样转换为折线；横轴为页面观察时间，纵轴按当前指标最大值缩放。
 * @param key 接收速率或同步消息处理耗时。
 * @param maximum 当前图表的纵轴上限。
 * @returns 原生 SVG 使用的坐标串；不补造历史样本。
 */
function chartPoints(key: keyof Sample, maximum: number): string {
  return samples.value.map((sample, index) => `${12 + index / 59 * 576},${112 - sample[key] / maximum * 100}`).join(' ')
}

/** 将字节数转为易读大小；统计的是重编码后的 JSON 文本，不包含网络协议开销。 */
function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`
}

/** 清空本页监控缓存；退出登录或全局重置时不保留上一任务的消息记录。 */
function resetMonitor(): void {
  records.value = []
  samples.value = []
  received.value = rejected.value = bytes.value = durationSum.value = maxDuration.value = 0
  bucketBytes = bucketCount = bucketDuration = 0
  sampledAt = performance.now()
}

// 只观察既有消息入口，不另建连接、不改变序号校验；离页自动解除观察。
const stopObserving = telemetry.$onAction(({ name, args, after }) => {
  if (name === 'resetToSafeEmpty') { after(resetMonitor); return }
  if (name !== 'acceptEnvelope') return
  const value = args[0]
  const envelope = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const topic = String(envelope.topic ?? '')
  const knownTopic = Object.hasOwn(topicLabels, topic)
  const duplicate = knownTopic && typeof envelope.sequence === 'number'
    && envelope.sequence <= telemetry.topicSequences[topic as WsTopic]
  let size = 0
  try { size = new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength } catch { /* 非 JSON 输入仍由原有校验拒绝。 */ }
  const startedAt = performance.now()
  after((accepted) => {
    const duration = performance.now() - startedAt
    received.value += 1
    if (!accepted) rejected.value += 1
    bytes.value += size
    durationSum.value += duration
    maxDuration.value = Math.max(maxDuration.value, duration)
    bucketBytes += size
    bucketCount += 1
    bucketDuration += duration
    records.value = [{ id: received.value, time: formatDateTime(new Date()),
      topic: knownTopic ? topicLabels[topic as WsTopic] : '未知消息', size,
      status: !accepted ? '拒绝' : duplicate ? '忽略' : '通过' }, ...records.value].slice(0, 50)
  })
})

onMounted(() => {
  void store.loadMonitor()
  timer = setInterval(() => {
    if (++monitorTicks % 5 === 0) void store.loadMonitor()
    const now = performance.now()
    const elapsedSeconds = Math.max((now - sampledAt) / 1000, 0.001)
    if (received.value > 0) {
      samples.value = [...samples.value, { rate: bucketBytes / 1024 / elapsedSeconds,
        duration: bucketCount === 0 ? 0 : bucketDuration / bucketCount }].slice(-60)
    }
    bucketBytes = bucketCount = bucketDuration = 0
    sampledAt = now
  }, 1000)
})
onUnmounted(() => { clearInterval(timer); stopObserving(); store.clearMonitor() })

/** 复用遥测快照及订阅入口；失败保留原有中文错误，不启动真实引擎。 */
async function connect(): Promise<void> {
  if (telemetry.frame === null && !await telemetry.loadFrame()) return
  telemetry.connect()
}
</script>

<template>
  <div class="exchange-monitor" data-testid="exchange-monitor">
    <div class="monitor-status-grid" aria-label="数据交换状态概览">
      <article v-for="card in [
        { label: '本地服务', value: serviceLabel, tone: serviceTone, path: 'M4 3h16v7H4z M4 14h16v7H4z M7 6h1 M7 17h1 M11 6h6 M11 17h6' },
        { label: 'WebSocket', value: connectionLabel, tone: connectionTone, path: 'M8 5h11v11 M19 5l-6 6 M16 19H5V8 M5 19l6-6' },
        { label: 'AFSIM 引擎', value: '未接入', tone: 'muted', path: 'M9 3h6l1 4 4 2v6l-4 2-1 4H9l-1-4-4-2V9l4-2z M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0' },
        { label: 'SQLite', value: databaseLabel, tone: store.monitor?.database === 'HEALTHY' ? 'success' : store.monitor?.database === 'ERROR' ? 'danger' : 'muted', path: 'M4 6a8 3 0 1 0 16 0a8 3 0 1 0-16 0 M4 6v12a8 3 0 0 0 16 0V6 M4 12a8 3 0 0 0 16 0' },
        { label: '接收速率', value: `${rate.toFixed(1)} KB/s`, tone: 'accent', path: 'M2 12h5l3-8 4 16 3-8h5' },
        { label: '本页收包数', value: received, tone: 'accent', path: 'M4 20V10h3v10 M11 20V4h3v16 M18 20v-7h3v7' },
      ]" :key="card.label" class="monitor-status">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="card.path" /></svg>
        <div><span>{{ card.label }}</span><strong :class="`tone-${card.tone}`">{{ card.value }}</strong></div>
      </article>
    </div>

    <el-alert v-if="telemetry.capabilityState === 'ERROR'" :title="telemetry.resultMessage" type="error" :closable="false" show-icon />
    <el-alert v-if="store.monitorMessage" :title="store.monitorMessage" type="error" :closable="false" show-icon data-testid="local-monitor-error" />

    <div class="monitor-workspace">
      <section class="monitor-panel monitor-channels" aria-label="接口通道状态">
        <header><h3>接口通道状态</h3><span class="panel-caption">本机回环</span></header>
        <div class="channel-list">
          <div><span>HTTP API</span><strong :class="`tone-${serviceTone}`">{{ serviceLabel }}</strong></div>
          <div><span>WebSocket /ws</span><strong :class="`tone-${connectionTone}`">{{ connectionLabel }}</strong></div>
        </div>
        <h4>消息主题 <span>最后序号</span></h4>
        <div class="channel-list">
          <div v-for="topic in topics" :key="topic.id" :title="topic.id"><span>{{ topic.label }}</span><strong>{{ topic.sequence || '—' }}</strong></div>
        </div>
        <h4>数据文件合同 <span>版本 / 校验</span></h4>
        <div v-if="files.length" class="file-list">
          <button v-for="file in files" :key="file.name" type="button" @click="emit('tools', file.target)">
            <span>{{ file.name }}</span><small>{{ file.version }}</small><span :class="file.status.endsWith('失败') ? 'tone-danger' : 'tone-muted'">{{ file.status }}</span>
          </button>
        </div>
        <p v-else class="monitor-note">{{ store.loadState === 'ERROR' ? '合同加载失败，请刷新重试。' : '正在等待合同数据。' }}</p>
      </section>

      <div class="monitor-charts">
        <section v-for="chart in charts" :key="chart.key" class="monitor-panel" :aria-label="chart.title">
          <header><h3>{{ chart.title }}</h3><span class="panel-caption">{{ chart.unit }} · 最近 60 次采样</span></header>
          <div class="monitor-plot" :class="{ 'monitor-plot--violet': chart.key === 'duration' }">
            <span class="monitor-axis-max">{{ chart.maximum.toFixed(1) }}</span>
            <svg viewBox="0 0 600 125" preserveAspectRatio="none" role="img" :aria-label="`${chart.title}曲线`">
              <path class="monitor-grid" d="M12 12H588 M12 37H588 M12 62H588 M12 87H588 M12 112H588 M12 12V112 M156 12V112 M300 12V112 M444 12V112 M588 12V112" />
              <polyline v-if="samples.length > 1" :points="chartPoints(chart.key, chart.maximum)" class="monitor-curve" />
              <circle v-else-if="samples.length === 1" cx="12" :cy="112 - samples[0][chart.key] / chart.maximum * 100" r="3" class="monitor-point" />
            </svg>
            <p v-if="received === 0" class="monitor-plot-empty">{{ telemetry.connectionState === 'SUBSCRIBED' ? '等待本页消息采样' : '连接通道后显示采样曲线' }}</p>
            <div class="monitor-axis"><span>0</span><span>页面观察时间 / 秒</span><span>60</span></div>
          </div>
          <dl v-if="chart.key === 'rate'" class="monitor-metrics">
            <div><dt>累计接收</dt><dd>{{ formatBytes(bytes) }}</dd></div>
            <div><dt>收到消息</dt><dd>{{ received }}</dd></div>
            <div><dt>拒绝消息</dt><dd class="tone-danger">{{ rejected }}</dd></div>
          </dl>
          <dl v-else class="monitor-metrics">
            <div><dt>平均处理</dt><dd>{{ averageDuration.toFixed(2) }} <small>ms</small></dd></div>
            <div><dt>最高耗时</dt><dd>{{ maxDuration.toFixed(2) }} <small>ms</small></dd></div>
            <div><dt>校验通过率</dt><dd>{{ passRate }}</dd></div>
          </dl>
        </section>
      </div>

      <section class="monitor-panel monitor-records" aria-label="最近交换记录">
        <header><h3>最近交换记录</h3><span class="panel-caption">{{ records.length }} / 50 条</span></header>
        <el-table :data="records" size="small" height="100%" empty-text="暂无交换记录，请连接通道" data-testid="exchange-records">
          <el-table-column prop="time" label="接收时刻" width="180" />
          <el-table-column prop="topic" label="数据类型" min-width="85" />
          <el-table-column label="大小" width="82"><template #default="{ row }">{{ formatBytes(row.size) }}</template></el-table-column>
          <el-table-column label="状态" width="64"><template #default="{ row }"><el-tag size="small" effect="plain" :type="row.status === '拒绝' ? 'danger' : row.status === '忽略' ? 'info' : 'success'">{{ row.status }}</el-tag></template></el-table-column>
        </el-table>
        <footer><span>本页记录缓存</span><el-progress :percentage="records.length * 2" :show-text="false" :stroke-width="4" /></footer>
      </section>
    </div>

    <section class="monitor-panel" aria-label="本地文件读取记录" data-testid="local-file-monitor">
      <header><h3>本地文件读取记录</h3><span class="panel-caption">{{ store.monitor ? 'SQLite 历史最近 50 次' : '本机读取记录' }} · 每 5 秒刷新</span><el-button :loading="store.monitorState === 'LOADING'" @click="store.loadMonitor()">刷新监控</el-button></header>
      <el-table :data="store.monitor?.records ?? []" max-height="240" row-key="sequence" empty-text="暂无实际文件读取记录" data-testid="local-file-records">
        <el-table-column label="完成时间" min-width="170"><template #default="{ row }">{{ formatDateTime(row.completedAt) }}</template></el-table-column>
        <el-table-column prop="fileName" label="文件" min-width="160" />
        <el-table-column label="读取用途" min-width="130"><template #default="{ row }">{{ fileOperationLabels[row.operation as keyof typeof fileOperationLabels] }}</template></el-table-column>
        <el-table-column label="结果" width="100"><template #default="{ row }">{{ row.status === 'ERROR' ? '读取失败' : row.issueCount > 0 ? '含异常行' : '读取成功' }}</template></el-table-column>
        <el-table-column label="耗时（ms）" width="110"><template #default="{ row }">{{ row.durationMs.toFixed(2) }}</template></el-table-column>
        <el-table-column label="快照记录数" width="105"><template #default="{ row }">{{ row.recordCount ?? '—' }}</template></el-table-column>
        <el-table-column label="异常行数" width="95"><template #default="{ row }">{{ row.issueCount ?? '—' }}</template></el-table-column>
        <el-table-column label="错误码" min-width="170"><template #default="{ row }">{{ row.errorCode ?? '—' }}</template></el-table-column>
      </el-table>
      <p class="monitor-footnote">检查时间：{{ store.monitor ? formatDateTime(store.monitor.checkedAt) : '—' }}。仅记录原有节点、位置和历史文件读取，不触发额外读取；快照记录数不是本次新增行数。</p>
    </section>

    <section class="monitor-panel monitor-connection" aria-label="连接详情">
      <header><h3>连接详情</h3><span class="panel-caption">Mock 数据通道</span></header>
      <div class="connection-content">
        <dl>
          <div><dt>本地服务</dt><dd>{{ resolveMockOrigin() }}</dd></div>
          <div><dt>WebSocket</dt><dd>{{ wsAddress.toString() }}</dd></div>
          <div><dt>当前任务 / 帧</dt><dd>{{ telemetry.frame ? `${telemetry.frame.taskId} / ${telemetry.frame.frameId}` : '未加载' }}</dd></div>
          <div><dt>消息版本</dt><dd>1.0</dd></div>
        </dl>
        <div class="connection-actions">
          <el-button v-if="telemetry.connectionState !== 'SUBSCRIBED'" type="primary" :loading="['CONNECTING', 'RETRYING'].includes(telemetry.connectionState) || telemetry.capabilityState === 'LOADING'" :disabled="telemetry.connectionBlocked" @click="connect">连接通道</el-button>
          <el-button v-else :loading="telemetry.capabilityState === 'LOADING'" @click="telemetry.recoverFromGap()">重新同步</el-button>
          <el-button :loading="store.loadState === 'LOADING'" @click="emit('refresh')">刷新状态</el-button>
        </div>
      </div>
    </section>
    <p class="monitor-footnote">消息统计仅含本页 Mock 遥测通道；大小为 JSON 文本估算，耗时为同步校验与投影耗时（非网络时延）。SQLite 为只读健康检查，文件记录来自本机实际读取并存入独立 SQLite 记录库，重启保留；AFSIM 引擎未接入。</p>
  </div>
</template>

<style scoped>
.exchange-monitor { display: flex; min-height: 0; flex: 1 0 auto; flex-direction: column; gap: 12px; }
.monitor-status-grid { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.monitor-status, .monitor-panel { border: 1px solid var(--console-border); border-radius: 4px; background: var(--console-bg-elevated); }
.monitor-status { display: flex; align-items: center; gap: 14px; min-width: 0; padding: 16px; background: linear-gradient(120deg, var(--console-surface-raised), var(--console-bg-elevated)); }
.monitor-status svg { width: 30px; height: 30px; flex-shrink: 0; fill: none; stroke: var(--console-text-muted); stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.monitor-status span, dt, .panel-caption { color: var(--console-text-muted); font-size: 12px; }
.monitor-status strong { display: block; margin-top: 5px; font-size: 17px; font-variant-numeric: tabular-nums; }
.tone-success { color: var(--console-teal); }
.tone-danger { color: var(--console-danger); }
.tone-muted { color: var(--console-text-muted); }
.tone-accent { color: var(--console-cyan); }
.monitor-workspace { display: grid; grid-template-columns: minmax(240px, .85fr) minmax(300px, 1.35fr) minmax(328px, 1fr); grid-template-rows: minmax(0, 1fr); gap: 12px; flex: 1; min-height: 360px; }
.monitor-panel { min-width: 0; overflow: hidden; }
.monitor-channels { overflow-y: auto; }
.monitor-panel > header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--console-border); }
h3 { margin: 0; color: var(--console-text); font-size: 14px; }
h4 { display: flex; justify-content: space-between; gap: 8px; margin: 0; padding: 6px 14px; color: var(--console-text-muted); font-size: 12px; background: var(--console-surface); border-block: 1px solid var(--console-border); }
h4 span { font-weight: 400; }
.channel-list { padding: 4px 14px; }
.channel-list > div { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 22px; font-size: 12px; }
.channel-list strong { font-weight: 500; font-variant-numeric: tabular-nums; }
.file-list { padding: 4px 10px; }
.file-list button { display: grid; grid-template-columns: minmax(0, 1fr) 26px 56px; align-items: center; gap: 4px; width: 100%; padding: 4px; border: 0; border-bottom: 1px solid var(--console-border); color: var(--console-text); background: transparent; text-align: left; font: inherit; font-size: 12px; cursor: pointer; }
.file-list button:hover { background: var(--console-surface-raised); }
.file-list button:focus-visible { outline: 1px solid var(--console-cyan); }
.file-list button > span:first-child { overflow-wrap: anywhere; }
.monitor-note, .monitor-footnote { color: var(--console-text-muted); font-size: 12px; line-height: 1.6; }
.monitor-note { margin: 8px 14px 12px; }
.monitor-footnote { margin: 0; }
.monitor-charts { display: grid; grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 12px; min-width: 0; }
.monitor-charts .monitor-panel { display: flex; flex-direction: column; }
.monitor-plot { position: relative; flex: 1; display: flex; flex-direction: column; min-height: 80px; padding: 8px 14px 6px 38px; color: var(--console-cyan); }
.monitor-plot--violet { color: #ab92ef; }
.monitor-plot svg { width: 100%; height: 0; flex: 1; min-height: 40px; }
.monitor-grid { fill: none; stroke: var(--console-border); stroke-width: .7; stroke-dasharray: 3 5; }
.monitor-curve { fill: none; stroke: currentColor; stroke-width: 1.7; vector-effect: non-scaling-stroke; }
.monitor-point { fill: currentColor; }
.monitor-axis-max { position: absolute; top: 18px; left: 8px; color: var(--console-text-muted); font-size: 12px; }
.monitor-axis { display: flex; justify-content: space-between; gap: 8px; color: var(--console-text-muted); font-size: 12px; }
.monitor-plot-empty { position: absolute; inset: 0; display: grid; place-content: center; margin: 0; color: var(--console-text-muted); font-size: 12px; pointer-events: none; }
.monitor-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 0; border-top: 1px solid var(--console-border); }
.monitor-metrics > div { padding: 9px 12px; border-right: 1px solid var(--console-border); }
.monitor-metrics > div:last-child { border: 0; }
dd { margin: 5px 0 0; color: var(--console-text); font-variant-numeric: tabular-nums; }
.monitor-metrics dd { font-size: 17px; }
small { font-size: 12px; }
.monitor-records { display: flex; flex-direction: column; min-height: 0; }
.monitor-records > .el-table { flex: 1; min-height: 0; }
.monitor-records :deep(.el-table__cell) { padding-block: 12px; }
.monitor-records :deep(.cell) { padding-inline: 9px; font-size: 12px; }
.monitor-records footer { display: flex; align-items: center; gap: 12px; padding: 12px; border-top: 1px solid var(--console-border); color: var(--console-text-muted); font-size: 12px; }
.monitor-records .el-progress { flex: 1; }
.connection-content { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; padding: 14px; }
.connection-content dl { display: flex; flex-wrap: wrap; gap: 16px 24px; margin: 0; }
.connection-content dd { font-size: 12px; overflow-wrap: anywhere; }
.connection-actions { display: flex; gap: 8px; }
.connection-actions .el-button { margin: 0; }
@media (max-width: 1400px) {
  .monitor-status { gap: 10px; padding: 12px; }
  .monitor-status svg { width: 24px; height: 24px; }
  .monitor-status strong { font-size: 15px; }
  .monitor-workspace { grid-template-columns: minmax(218px, .8fr) minmax(280px, 1.2fr) minmax(320px, 1fr); }
}
@media (max-width: 1100px) {
  .monitor-status-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .monitor-workspace { grid-template-columns: minmax(220px, 1fr) minmax(300px, 1.5fr); grid-template-rows: auto; }
  .monitor-channels { overflow: visible; }
  .monitor-records { grid-column: 1 / -1; height: 300px; }
}
@media (max-width: 680px) {
  .monitor-status-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .monitor-workspace { grid-template-columns: minmax(0, 1fr); }
  .monitor-charts { min-height: 480px; }
}
</style>
