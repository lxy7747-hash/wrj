<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { EngineLinkSegment, EnginePathNode, LinkType, Link } from '../../contracts/domain-models'
import { useRuntimeQualityStore } from '../../stores/runtime-quality'
import { useSimulationStore } from '../../stores/simulation'
import { formatSimulationTime, LINK_TYPE_LABELS } from '../../features/situation/situation-model'
import { includesEngineSimulationTime, resolveEngineSwitchHighlights, type EngineRouteResolution } from '../../features/situation/engine-route-highlights'

const props = defineProps<{ section: 'quality' | 'decisions' | 'jammers' | 'events'; selectedLinkId?: string; links?: Pick<Link, 'id' | 'type' | 'sourcePlatformId' | 'targetPlatformId'>[] }>()
const quality = useRuntimeQualityStore()
const simulation = useSimulationStore()
const nodeFilter = ref('')
const linkFilter = ref('')
const typeFilter = ref<LinkType | ''>('')
const timeRangeStart = ref<number | undefined>()
const timeRangeEnd = ref<number | undefined>()
const value = (v: string | number | null | undefined, unit = '') => v == null || v === '' ? '暂无数据' : `${typeof v === 'number' ? Number(v.toPrecision(8)) : v}${unit}`
const name = (id: string | null) => (simulation.run?.fileSource ? undefined : simulation.selectedScene?.config.platforms.find(p => p.id === id)?.name) ?? value(id)
const path = (nodes: EnginePathNode[]) => nodes.length ? nodes.map(n => `${name(n.platformId)}（入：${value(n.inPort)}；出：${value(n.outPort)}）`).join(' → ') : '暂无数据'
const labels: Record<string, string> = { UP: '正常', DEGRADED: '劣化', DOWN: '中断', UNKNOWN: '未知',
  BARRAGE: '宽带压制', SPOT: '瞄准式', SWEEP: '扫频', DETECTED: '已探测', ON: '开启', OFF: '关闭', JAM_ON: '起扰',
  beyond_weitch: '超视距切换', ber_switch: '链路劣化切换', alarm_switch: '链路告警切换', into_detect: '进入探测圈',
  into_jamm: '进入干扰圈', release_detect: '离开探测圈', release_jamm: '离开干扰圈', esm_info: '敌方探测消息', bey_switch: '超视距切换' }
const label = (v: string | null | undefined) => v == null ? '暂无数据' : labels[v] ?? v
const losses: [keyof EngineLinkSegment['losses'], string][] = [['freeSpaceDb', '自由空间'], ['seaMultipathDb', '海面多径'],
  ['atmosphericDb', '大气'], ['rainDb', '雨衰'], ['cloudDb', '云衰'], ['cloudRainDb', '云雨合并'], ['jammingDb', '干扰'], ['totalDb', '总复合（原值）']]

const configuredLinks = computed(() => props.links ?? simulation.selectedScene?.config.links ?? [])
const segmentLinkIds = computed(() => new Set(quality.engineFrame?.links.flatMap(link => link.linkIds) ?? []))
const selectableLinks = computed(() => configuredLinks.value.filter(link => segmentLinkIds.value.has(link.id)))
const unboundSegments = computed(() => [...new Map((quality.engineFrame?.links ?? [])
  .filter(segment => !selectableLinks.value.some(link => segment.linkIds.includes(link.id)))
  .map(segment => [segment.linkId, segment])).values()])
const selectableTypes = computed(() => [...new Set(selectableLinks.value.map(link => link.type))])
const selectableNodes = computed(() => [...new Set((quality.engineFrame?.links ?? []).flatMap(link => [link.sourcePlatformId, link.targetPlatformId]).filter((id): id is string => id !== null))])
const selectedType = (link: EngineLinkSegment): LinkType[] => link.linkIds.flatMap(id => configuredLinks.value.filter(configured => configured.id === id).map(configured => configured.type))
const displayedStatus = (link: EngineLinkSegment) => link.error ? 'UNKNOWN' : link.status
const segmentKey = (link: EngineLinkSegment) => JSON.stringify([quality.engineFrame?.runId, quality.engineFrame?.engineEpoch,
  link.linkId, link.sourcePlatformId, link.sourcePort, link.targetPlatformId, link.targetPort])
const sourceHint = computed(() => {
  const frame = quality.engineFrame
  return frame ? [`源仿真时刻：${frame.simulationTime} s`,
    ...(frame.wallTimeMs == null ? [] : [`上游计时：${frame.wallTimeMs} ms（起点待确认）`]),
    `模型版本：${value(frame.modelVersion)}；调制：${value(frame.modulation)}`,
    '时延单位、总复合损耗口径待确认；按源值展示。',
    '当前只提供本帧测量；时间范围按源仿真时刻筛选，范围外或起始大于结束时为空。'].join('；') : ''
})
const filteredLinks = computed(() => (quality.engineFrame?.links ?? []).filter(link =>
  (!nodeFilter.value || link.sourcePlatformId === nodeFilter.value || link.targetPlatformId === nodeFilter.value)
  && (!linkFilter.value || link.linkId === linkFilter.value || link.linkIds.includes(linkFilter.value))
  && (!typeFilter.value || selectedType(link).includes(typeFilter.value))
  && includesEngineSimulationTime(quality.engineFrame?.simulationTime ?? NaN, timeRangeStart.value, timeRangeEnd.value),
))
watch(() => props.selectedLinkId, value => { linkFilter.value = selectableLinks.value.some(link => link.id === value) || unboundSegments.value.some(link => link.linkId === value) ? value ?? '' : '' }, { immediate: true })
const switchHighlights = (oldNodes: EnginePathNode[], newNodes: EnginePathNode[]) => resolveEngineSwitchHighlights(quality.engineFrame, oldNodes, newNodes)
const resolutionLabel = (title: string, resolution: EngineRouteResolution) => {
  if (resolution.totalHops === 0) return `${title}：路径无可解析段`
  if (resolution.resolvedHops === resolution.totalHops) return `${title}：已唯一关联 ${resolution.linkIds.join('、') || '无'}（${resolution.resolvedHops}/${resolution.totalHops} 段）`
  return `${title}：仅唯一关联 ${resolution.linkIds.join('、') || '无'}（${resolution.resolvedHops}/${resolution.totalHops} 段；其余未匹配或存在歧义）`
}
</script>

<template>
  <section v-if="quality.engineFrame" class="engine-evidence" :class="{ 'engine-evidence--quality': section === 'quality', 'quality-card-panel': section === 'quality' }" :data-testid="`engine-${section}`">
    <div v-if="section === 'quality'" class="quality-card-source">
      <p class="engine-evidence__source">引擎推送 · 帧 {{ quality.engineFrame.frameId }} · {{ formatSimulationTime(quality.engineFrame.simulationTime) }}</p>
      <el-tooltip :content="sourceHint" :popper-style="{ maxWidth: '280px', whiteSpace: 'normal', overflowWrap: 'anywhere' }">
        <button type="button" class="quality-card-info" aria-label="查看引擎数据说明">数据说明</button>
      </el-tooltip>
    </div>
    <template v-else>
    <p class="engine-evidence__source">引擎推送 · 帧 {{ quality.engineFrame.frameId }} · {{ formatSimulationTime(quality.engineFrame.simulationTime) }} · {{ value(quality.engineFrame.simulationTime, ' s') }}</p>
    <p v-if="quality.engineFrame.wallTimeMs != null" class="engine-evidence__note">上游计时 {{ value(quality.engineFrame.wallTimeMs, ' ms') }}（起点待确认）</p>
    </template>
    <template v-if="section === 'quality'">
      <el-form label-position="top" class="engine-evidence__filters quality-card-filters">
        <el-form-item label="节点"><el-select v-model="nodeFilter" clearable placeholder="全部节点"><el-option v-for="node in selectableNodes" :key="node" :label="name(node)" :value="node" /></el-select></el-form-item>
        <el-form-item label="链路类型"><el-select v-model="typeFilter" clearable placeholder="全部类型"><el-option v-for="type in selectableTypes" :key="type" :label="LINK_TYPE_LABELS[type]" :value="type" /></el-select></el-form-item>
        <details class="quality-card-advanced">
          <summary>更多筛选<span v-if="linkFilter || timeRangeStart != null || timeRangeEnd != null">（已应用）</span></summary>
          <el-form-item label="链路"><el-select v-model="linkFilter" clearable placeholder="全部链路 / 引擎段"><el-option v-for="link in selectableLinks" :key="`link:${link.id}`" :label="`${link.id} · ${name(link.sourcePlatformId)} → ${name(link.targetPlatformId)}`" :value="link.id" /><el-option v-for="link in unboundSegments" :key="`segment:${link.linkId}`" :label="`引擎段 ${link.linkId} · ${name(link.sourcePlatformId)} → ${name(link.targetPlatformId)}`" :value="link.linkId" /></el-select></el-form-item>
          <el-form-item label="仿真时间范围（秒）"><div class="engine-evidence__time-range"><el-input-number v-model="timeRangeStart" :min="0" :precision="3" controls-position="right" placeholder="起始" /><span>至</span><el-input-number v-model="timeRangeEnd" :min="0" :precision="3" controls-position="right" placeholder="结束" /></div></el-form-item>
        </details>
      </el-form>
      <div v-if="filteredLinks.length" class="quality-card-list" role="list" aria-label="引擎链路质量">
        <article v-for="link in filteredLinks" :key="segmentKey(link)" class="quality-card" role="listitem" :data-link-id="link.linkId">
          <header class="quality-card-heading">
            <strong>{{ name(link.sourcePlatformId) }} → {{ name(link.targetPlatformId) }}</strong>
            <el-tag :type="displayedStatus(link) === 'UP' ? 'success' : displayedStatus(link) === 'DEGRADED' ? 'warning' : displayedStatus(link) === 'DOWN' ? 'danger' : 'info'">{{ link.error ? '异常（状态未知）' : label(displayedStatus(link)) }}</el-tag>
          </header>
          <p v-if="link.error" class="quality-card-error" role="alert">{{ link.error }}</p>
          <dl class="quality-card-metrics">
            <div><dt>干信比（dB）</dt><dd>{{ value(link.quality.gxbDb) }}</dd></div>
            <div><dt>误码率 BER</dt><dd>{{ value(link.quality.ber) }}</dd></div>
            <div><dt>接收功率（dBm）</dt><dd>{{ value(link.quality.rxPowerDbm) }}</dd></div>
            <div><dt>距离（m）</dt><dd>{{ value(link.distanceM) }}</dd></div>
          </dl>
          <details class="quality-card-details">
            <summary>详细参数</summary>
            <h4>链路信息</h4>
            <dl class="quality-card-fields">
              <div><dt>链路段编号</dt><dd>{{ link.linkId }}</dd></div>
              <div><dt>发送平台 / 端口</dt><dd>{{ value(link.sourceName) }} / {{ value(link.sourcePort) }}</dd></div>
              <div><dt>接收平台 / 端口</dt><dd>{{ value(link.targetName) }} / {{ value(link.targetPort) }}</dd></div>
              <div><dt>关联链路</dt><dd>{{ link.linkIds.join('、') || '暂无数据' }}</dd></div>
              <div><dt>引擎原始状态</dt><dd>{{ value(link.engineStatus) }}</dd></div>
            </dl>
            <h4>损耗明细</h4>
            <dl class="quality-card-fields"><div v-for="[key, title] in losses" :key="key"><dt>{{ title }}损耗（dB）</dt><dd>{{ value(link.losses[key]) }}</dd></div></dl>
            <h4>通信参数</h4>
            <dl class="quality-card-fields">
              <div><dt>接收功率</dt><dd>{{ value(link.quality.rxPowerDbw, ' dBW') }} / {{ value(link.quality.rxPowerDbm, ' dBm') }}</dd></div>
              <div><dt>频率（GHz）</dt><dd>{{ value(link.inputTrace.frequencyGHz) }}</dd></div>
              <div><dt>数据率（Mbps）</dt><dd>{{ value(link.inputTrace.dataRateMbps) }}</dd></div>
              <div><dt>时延（原值，单位待确认）</dt><dd>{{ value(link.quality.delay) }}</dd></div>
              <div><dt>EIRP（dBW）</dt><dd>{{ value(link.inputTrace.eirpDbw) }}</dd></div>
              <div><dt>G/T（dB/K）</dt><dd>{{ value(link.inputTrace.gtDbk) }}</dd></div>
            </dl>
            <h4>干扰来源</h4>
            <p v-if="!link.inputTrace.jammers.length">暂无数据</p>
            <section v-for="(jammer, j) in link.inputTrace.jammers" :key="j" class="quality-card-jammer">
              <strong>{{ name(jammer.platformId) }}</strong>
              <dl class="quality-card-fields">
                <div><dt>距离（m）</dt><dd>{{ value(jammer.distanceM) }}</dd></div>
                <div><dt>EIRP（dBW）</dt><dd>{{ value(jammer.eirpDbw) }}</dd></div>
                <div><dt>损耗（dB）</dt><dd>{{ value(jammer.lossDb) }}</dd></div>
              </dl>
            </section>
          </details>
        </article>
      </div>
      <p v-else>当前帧暂无符合筛选条件的引擎链路段。</p>
    </template>
    <template v-else-if="section === 'decisions'">
      <h4>初始热链</h4>
      <p v-if="!quality.engineFrame.initRouting?.length">暂无数据</p>
      <article v-for="(route, index) in quality.engineFrame.initRouting" :key="index">
        <strong>{{ route.direction === 'FORWARD' ? '前向' : '返向' }} · {{ name(route.sourcePlatformId) }} → {{ name(route.targetPlatformId) }}</strong>
        <p>路径：{{ route.pathId }} · {{ path(route.nodes) }}</p><p>业务：{{ route.transTypes.join('、') || '暂无数据' }}</p>
        <p v-if="route.parameters">路径参数（原值，单位待确认）：时延 {{ value(route.parameters.delay) }} · 传输频次 {{ value(route.parameters.transFrequency) }} · 信息量 {{ value(route.parameters.dataContent) }}</p>
      </article>
      <h4>切换记录</h4><p v-if="!quality.engineSwitches.length">暂无数据</p>
      <article v-for="(item, index) in quality.engineSwitches" :key="index">
        <strong>{{ formatSimulationTime(item.simulationTime) }} · {{ item.route.direction === 'FORWARD' ? '前向' : '返向' }}</strong>
        <p>旧路径：{{ value(item.route.oldPathId) }} · {{ path(item.route.oldNodes) }}</p>
        <p>新路径：{{ item.route.pathId }} · {{ path(item.route.nodes) }}</p>
        <p>业务：{{ item.route.transTypes.join('、') || '暂无数据' }}</p>
        <p v-if="item.route.parameters">路径参数（原值，单位待确认）：时延 {{ value(item.route.parameters.delay) }} · 传输频次 {{ value(item.route.parameters.transFrequency) }} · 信息量 {{ value(item.route.parameters.dataContent) }}</p>
        <template v-if="item.frameId === quality.engineFrame.frameId">
          <p class="engine-evidence__switch-before">{{ resolutionLabel('切换前高亮', switchHighlights(item.route.oldNodes, item.route.nodes).before) }}</p>
          <p class="engine-evidence__switch-after">{{ resolutionLabel('切换后高亮', switchHighlights(item.route.oldNodes, item.route.nodes).after) }}</p>
        </template>
        <p v-else class="engine-evidence__note">历史切换：未保留该帧的设备段关联证据，未使用当前帧推断或高亮。</p>
        <p v-if="!item.route.reasons.length">切换原因：暂无数据</p>
        <p v-for="(reason, r) in item.route.reasons" :key="r">相关链路段：{{ value(reason.linkId) }} · 原因：{{ reason.reasons.map(label).join('、') || '暂无数据' }}</p>
      </article>
      <h4>告警</h4><p v-if="!quality.engineAlarms.length">暂无数据</p>
      <article v-for="(item, index) in quality.engineAlarms" :key="index">{{ formatSimulationTime(item.simulationTime) }} · 路径 {{ value(item.alarm.pathId) }} · 链路段 {{ value(item.alarm.linkId) }} · {{ value(item.alarm.message) }}</article>
    </template>
    <template v-else-if="section === 'jammers'">
      <p v-if="!quality.engineFrame.jammers.length">暂无数据</p>
      <article v-for="(jammer, index) in quality.engineFrame.jammers" :key="index">
        <strong>{{ name(jammer.platformId) }} · {{ label(jammer.deviceStatus) }} · {{ label(jammer.detectStatus) }}</strong>
        <p>干扰功率 {{ value(jammer.powerW, ' W') }} · 频率 {{ value(jammer.frequencyHz, ' Hz') }} · 干扰圈半径 {{ value(jammer.rangeM === null ? null : jammer.rangeM / 1000, ' km') }}</p>
        <p>设备模式 {{ label(jammer.engineMode === 'broadband' ? 'BARRAGE' : jammer.engineMode === 'spot' ? 'SPOT' : jammer.engineMode === 'sweep' ? 'SWEEP' : jammer.engineMode) }}</p>
        <p v-if="jammer.position">干扰站位置：经度 {{ value(jammer.position.longitude, '°') }} · 纬度 {{ value(jammer.position.latitude, '°') }} · 高度 {{ value(jammer.position.altitudeM, ' m') }}</p>
        <p v-if="!jammer.detections.length">探测目标：暂无数据</p>
        <div v-for="(detection, d) in jammer.detections" :key="d">
          <p>探测目标：{{ detection.targetIds.map(name).join('、') || '暂无数据' }}</p>
          <p>探测概率 {{ value(detection.probability === null ? null : detection.probability * 100, '%') }} · 探测范围 {{ value(detection.rangeM === null ? null : detection.rangeM / 1000, ' km') }} · 探测频率 {{ value(detection.frequencyHz, ' Hz') }}</p>
          <p v-if="!detection.targets.length">目标位置：暂无数据</p>
          <p v-for="(target, t) in detection.targets" :key="t">{{ name(target.platformId) }} · 经度 {{ value(target.longitude, '°') }} · 纬度 {{ value(target.latitude, '°') }} · 高度 {{ value(target.altitudeM, ' m') }}</p>
        </div>
        <p v-if="!jammer.actions.length">起扰目标：暂无数据</p>
        <p v-for="(action, a) in jammer.actions" :key="a">{{ label(action.action) }} · 目标 {{ name(action.targetPlatformId) }} · 模式 {{ label(action.mode ?? action.engineMode) }}</p>
      </article>
    </template>
    <template v-else>
      <p v-if="!quality.engineEvents.length">暂无数据</p>
      <article v-for="(item, index) in quality.engineEvents" :key="index">
        <strong>{{ formatSimulationTime(item.simulationTime) }} · {{ label(item.event.type) }}</strong>
        <p>路径：{{ value(item.event.pathId) }}</p><p>任务机：{{ item.event.uavIds.map(name).join('、') || '暂无数据' }} · 干扰站：{{ item.event.jammerIds.map(name).join('、') || '暂无数据' }}</p>
      </article>
    </template>
  </section>
</template>

<style scoped>
.engine-evidence { min-width: 0; color: var(--text-color, #c5dae7); font-size: 12px; overflow-wrap: anywhere; }
.engine-evidence__source { color: #4bd9f2; }
.engine-evidence article { padding: 10px 0; border-bottom: 1px solid #244455; }
.engine-evidence p { margin: 6px 0; }
.engine-evidence__note { color: var(--el-text-color-secondary); }
.engine-evidence__switch-before { color: #f5b942; }
.engine-evidence__switch-after { color: #4bd9f2; }
.engine-evidence__filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.engine-evidence__filters :deep(.el-form-item) { min-width: 0; margin-bottom: 0; }
.engine-evidence__time-range { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 4px; }
.engine-evidence__time-range :deep(.el-input-number) { width: 100%; }
.engine-evidence small { display: block; margin-top: 4px; }
</style>

<style scoped src="./quality-cards.css"></style>
