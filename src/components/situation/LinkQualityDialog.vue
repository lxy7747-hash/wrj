<script setup lang="ts">
import { computed } from 'vue'
import type { Link } from '../../contracts/domain-models'
import {
  LINK_TYPE_LABELS,
  formatBer,
  type SituationLinkView,
} from '../../features/situation/situation-model'

const props = defineProps<{
  modelValue: boolean
  link: SituationLinkView | null
  configuredLink?: Link | null
  fileLink?: { linkId: string; sourceName: string; destinationName: string; typeLabel: string; registeredAt: number; deviceStatus: string } | null
}>()

defineEmits<{ 'update:modelValue': [value: boolean] }>()

const uiStatusLabel = computed(() => ({
  UP: '正常',
  DEGRADED: '劣化',
  DOWN: '中断',
})[props.link?.status ?? 'UP'])

const canonicalStatusLabel = computed(() => ({
  UP: '正常',
  DOWN: '中断',
})[props.link?.canonicalStatus ?? 'UP'])

const freshnessLabel = computed(() => (props.link?.ageMs === 0 ? '新鲜' : '存在延迟'))
const stale = computed(() => props.link !== null && props.link.ageMs > 0)

/**
 * 把链路状态原因转换为中文说明。
 * @param reason 固定帧中的原因码或中文原因。
 * @returns 可直接展示的中文说明。
 * @sideeffect 无副作用。
 */
function reasonLabel(reason: string): string {
  return {
    BER_BELOW_THRESHOLD: '误码率低于阈值',
    BER_THRESHOLD_AND_HYSTERESIS: '误码率超过阈值并满足稳定帧条件',
  }[reason] ?? reason
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    width="min(38rem, calc(100vw - 2rem))"
    class="link-quality-dialog"
    :close-on-click-modal="false"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="link-quality-dialog__header">
        <span>链路质量详情</span>
        <strong>{{ link ? `${link.linkId} · 固定帧 ${link.frameId}` : configuredLink ? `${configuredLink.id} · 所选场景配置` : fileLink ? `${fileLink.linkId} · 本地通信关联` : '链路不存在或已从当前帧移除' }}</strong>
      </div>
    </template>

    <div v-if="!link && fileLink" class="link-quality-dialog__body" data-testid="link-detail-file">
      <p>{{ fileLink.sourceName }} → {{ fileLink.destinationName }}</p>
      <dl class="link-quality-dialog__grid">
        <div><dt>通信体制</dt><dd>{{ fileLink.typeLabel }}</dd></div>
        <div><dt>设备启停证据</dt><dd>{{ fileLink.deviceStatus }}</dd></div>
        <div><dt>最近登记时刻</dt><dd>{{ Math.floor(fileLink.registeredAt / 60) }}分{{ Number((fileLink.registeredAt % 60).toFixed(3)) }}秒</dd></div>
        <div v-for="label in ['干信比', '信噪比 SNR', '误码率 BER', '接收功率', '路径损耗', '时延', '可用率', '质量判定依据', '质量测量时刻']" :key="label"><dt>{{ label }}</dt><dd>暂无数据</dd></div>
      </dl>
    </div>
    <div v-else-if="!link && configuredLink" class="link-quality-dialog__body" data-testid="link-detail-configured">
      <p>{{ configuredLink.sourcePlatformId }} → {{ configuredLink.targetPlatformId }}</p>
      <dl class="link-quality-dialog__grid">
        <div><dt>链路体制</dt><dd>{{ LINK_TYPE_LABELS[configuredLink.type] }}</dd></div>
        <div><dt>配置开关</dt><dd>{{ configuredLink.enabled === false ? '停用' : '启用' }}</dd></div>
        <div><dt>频率</dt><dd>{{ configuredLink.frequency }} MHz</dd></div>
        <div><dt>带宽</dt><dd>{{ configuredLink.bandwidth }} MHz</dd></div>
        <div><dt>发射功率</dt><dd>{{ configuredLink.txPower }} W</dd></div>
        <div><dt>调制方式</dt><dd>{{ configuredLink.modulation }}</dd></div>
        <div><dt>误码率阈值</dt><dd>{{ formatBer(configuredLink.berThreshold) }}</dd></div>
        <div><dt>数据速率</dt><dd>{{ configuredLink.dataRate }} Mbps</dd></div>
        <div v-for="label in ['干信比', '信噪比 SNR', '误码率 BER', '接收功率', '路径损耗', '时延', '可用率', '界面状态', '规范状态', '质量测量时刻']" :key="label"><dt>{{ label }}</dt><dd>暂无数据</dd></div>
      </dl>
      <p class="link-quality-dialog__notice">以上为已保存配置；尚无当前运行结果，未使用历史数据。</p>
    </div>
    <el-empty v-else-if="!link" description="未找到所选链路，未显示历史数据" :image-size="64" data-testid="link-detail-missing" />
    <el-alert
      v-else-if="stale"
      type="warning"
      :closable="false"
      show-icon
      data-testid="link-detail-stale"
      :title="`链路数据已过期 ${link.ageMs} ms，已停止显示历史质量值。`"
    />
    <div v-else class="link-quality-dialog__body" :data-frame-id="link.frameId" data-testid="link-detail-fresh">
      <div class="link-quality-dialog__route">
        <span>{{ link.sourceName }}</span>
        <i aria-hidden="true">→</i>
        <span>{{ link.destinationName }}</span>
      </div>

      <dl class="link-quality-dialog__grid">
        <div><dt>链路体制</dt><dd>{{ LINK_TYPE_LABELS[link.type] }}</dd></div>
        <div><dt>更新时间</dt><dd>{{ link.updatedAt }} s</dd></div>
        <div><dt>信噪比 SNR</dt><dd>{{ link.snrDb.toFixed(2) }} dB</dd></div>
        <div><dt>误码率 BER</dt><dd>{{ formatBer(link.ber) }}</dd></div>
        <div v-for="label in ['干信比', '时延', '可用率']" :key="label"><dt>{{ label }}</dt><dd>暂无数据</dd></div>
        <div><dt>数据年龄</dt><dd>{{ link.ageMs }} ms</dd></div>
        <div><dt>数据新鲜度</dt><dd>{{ freshnessLabel }}</dd></div>
        <div><dt>界面状态</dt><dd :class="`status--${link.status.toLowerCase()}`">{{ uiStatusLabel }}</dd></div>
        <div><dt>规范状态</dt><dd :class="`status--${link.canonicalStatus.toLowerCase()}`">{{ canonicalStatusLabel }}</dd></div>
        <div><dt>阈值版本</dt><dd>{{ link.thresholdVersion ?? '暂无数据' }}</dd></div>
        <div><dt>稳定帧数</dt><dd>{{ link.consecutiveFrames ?? '暂无数据' }}</dd></div>
        <div class="link-quality-dialog__wide"><dt>判定依据</dt><dd>{{ reasonLabel(link.reason) }}</dd></div>
        <template v-if="link.detailed">
          <div><dt>传输距离</dt><dd>{{ (link.detailed.distance / 1000).toFixed(1) }} km</dd></div>
          <div><dt>频率</dt><dd>{{ link.detailed.frequency }} MHz</dd></div>
          <div><dt>带宽</dt><dd>{{ link.detailed.bandwidth }} MHz</dd></div>
          <div><dt>接收功率</dt><dd>{{ link.detailed.receivedPower }} dBm</dd></div>
          <div><dt>误码率阈值</dt><dd>{{ formatBer(link.detailed.berThreshold) }}</dd></div>
          <div><dt>路径损耗</dt><dd>{{ link.detailed.pathLoss }} dB</dd></div>
          <div><dt>数据速率</dt><dd>{{ link.detailed.dataRate }} Mbps</dd></div>
          <div><dt>调制方式</dt><dd>{{ link.detailed.modulation }}</dd></div>
        </template>
        <template v-else><div v-for="label in ['传输距离', '频率', '带宽', '接收功率', '路径损耗', '调制方式']" :key="label"><dt>{{ label }}</dt><dd>暂无数据</dd></div></template>
      </dl>

      <p v-if="!link.detailed" class="link-quality-dialog__notice">
        当前帧仅提供摘要；距离、频率、功率和路径损耗等详细遥测未提供。
      </p>
    </div>
  </el-dialog>
</template>

<style scoped>
.link-quality-dialog__header {
  display: grid;
  gap: 0.15rem;
}

.link-quality-dialog__header span {
  color: var(--console-text);
  font-size: 0.95rem;
  font-weight: 700;
}

.link-quality-dialog__header strong {
  color: var(--console-cyan);
  font-family: Consolas, monospace;
  font-size: var(--console-font-size-min);
}

.link-quality-dialog__route {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--console-border);
  border-radius: 6px;
  color: var(--console-text);
  background: var(--console-bg-elevated);
  text-align: center;
}

.link-quality-dialog__route i {
  color: var(--console-cyan);
  font-style: normal;
}

.link-quality-dialog__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.45rem;
  margin: 0.7rem 0 0;
}

.link-quality-dialog__grid div {
  min-width: 0;
  padding: 0.5rem 0.6rem;
  border-radius: 5px;
  background: rgba(11, 29, 45, 0.74);
}

.link-quality-dialog__grid dt {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.link-quality-dialog__grid dd {
  margin: 0.18rem 0 0;
  color: var(--console-text);
  font-family: Consolas, "Microsoft YaHei", monospace;
  font-size: 0.76rem;
}

.link-quality-dialog__wide {
  grid-column: 1 / -1;
}

.status--up {
  color: var(--console-teal) !important;
}

.status--degraded {
  color: var(--console-amber) !important;
}

.status--down {
  color: var(--console-danger) !important;
}

.link-quality-dialog__notice {
  margin: 0.7rem 0 0;
  padding: 0.55rem 0.65rem;
  border-left: 3px solid var(--console-amber);
  color: var(--console-text-muted);
  background: rgba(246, 184, 75, 0.08);
  font-size: var(--console-font-size-min);
}
</style>
