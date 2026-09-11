<script setup lang="ts">
import { ref, toRaw, watch } from 'vue'
import type { InformationDemand, Link, LinkType, Platform } from '../../contracts/domain-models'
import { LINK_PARAMETER_DEFAULTS } from '../../features/scenarios/link-settings'
import { changeBusinessDirection } from '../../features/scenarios/business-defaults'
import BusinessEditorDialog from './BusinessEditorDialog.vue'
import { scenarioPlatformLabel } from '../../features/scenarios/scenario-basic'

type LinkTypeOption = { value: LinkType, label: string }

const props = defineProps<{
  modelValue: boolean
  link: Link | null
  editing: boolean
  showIds?: boolean
  error: string
  pending: boolean
  locked: boolean
  platforms: readonly Platform[]
  linkTypeOptions: readonly LinkTypeOption[]
  linkDirectionLabels: Record<Link['direction'], string>
  minimumStep: number
  demand?: InformationDemand | null
}>()

const emit = defineEmits<{
  'update:modelValue': [visible: boolean]
  apply: [link: Link, demand?: InformationDemand]
  opened: []
  'frequency-input': [value: number | undefined]
  'bandwidth-input': [value: number | undefined]
}>()

const editor = ref<Link | null>(null)
const business = ref<InformationDemand | null>(null)

/** 改为非卫星链路时清除旧版中继引用；type 为新类型，新链路不生成此历史字段。 */
function changeType(type: LinkType): void {
  if (editor.value?.relayPlatformId && type !== 'SAT') editor.value.relayPlatformId = null
}

/** 保存编码选择；空字符串转为“未指定”，value 为选项或用户录入的后端编码标识。 */
function changeCoding(value: string | null | undefined): void {
  if (editor.value) editor.value.coding = (value ?? '').trim() || null
}

/** 确认当前链路及其启停副本；取消或校验失败时不写入原场景。 */
function apply(): void {
  if (editor.value === null || props.pending || props.locked) return
  const demand = business.value ? {
    ...structuredClone(toRaw(business.value)),
    linkId: editor.value.id.trim(),
    sourcePlatformId: editor.value.sourcePlatformId,
    destinationPlatformIds: [editor.value.targetPlatformId],
    direction: editor.value.direction,
  } : undefined
  emit('apply', editor.value, demand)
}

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  editor.value = props.link === null ? null : { ...LINK_PARAMETER_DEFAULTS, ...structuredClone(toRaw(props.link)) }
  business.value = props.demand ? { enabled: true, ...structuredClone(toRaw(props.demand)) } : null
}, { immediate: true })

watch(() => editor.value?.direction, direction => {
  if (direction && business.value) changeBusinessDirection(business.value, direction, Boolean(props.demand?.linkId))
})
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    class="link-editor-dialog"
    :title="editing ? '编辑链路' : '新增链路'"
    width="min(760px, calc(100vw - 2rem))"
    top="5vh"
    destroy-on-close
    append-to-body
    data-testid="link-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @opened="emit('opened')"
  >
    <el-alert v-if="error" class="platform-feedback" type="error" :closable="false" :title="error" show-icon />
    <el-form v-if="editor" class="link-editor-form" :model="editor" label-position="top" :disabled="pending || locked">
      <section class="link-editor-section" aria-labelledby="link-basic-title">
        <h4 id="link-basic-title" class="link-editor-section__title">基本信息</h4>
        <div class="link-editor-grid">
          <el-form-item label="链路类型">
            <el-select v-model="editor.type" style="width: 100%" data-testid="link-type" @change="changeType">
              <el-option v-for="option in linkTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="当前链路">
            <el-switch v-model="editor.enabled" active-text="启用" inactive-text="停用" data-testid="link-enabled" />
          </el-form-item>
          <el-form-item v-show="showIds" label="链路 ID"><el-input v-model="editor.id" :disabled="editing" data-testid="link-id" /></el-form-item>
        </div>
      </section>

      <section class="link-editor-section" aria-labelledby="link-endpoint-title">
        <h4 id="link-endpoint-title" class="link-editor-section__title">端点配置</h4>
        <div class="link-editor-grid">
          <el-form-item label="源平台">
            <el-select v-model="editor.sourcePlatformId" filterable style="width: 100%" data-testid="link-source">
              <el-option v-for="platform in platforms" :key="platform.id" :label="scenarioPlatformLabel(platforms, platform.id, showIds)" :value="platform.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="目标平台">
            <el-select v-model="editor.targetPlatformId" filterable style="width: 100%" data-testid="link-target">
              <el-option v-for="platform in platforms" :key="platform.id" :label="scenarioPlatformLabel(platforms, platform.id, showIds)" :value="platform.id" />
            </el-select>
          </el-form-item>
        </div>
      </section>

      <section class="link-editor-section" aria-labelledby="link-communication-title">
        <h4 id="link-communication-title" class="link-editor-section__title">通信参数</h4>
        <div class="link-editor-grid">
          <el-form-item label="频率（MHz）"><el-input-number v-model="editor.frequency" :min="Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="link-frequency" @input="emit('frequency-input', $event)" /></el-form-item>
          <el-form-item label="带宽（MHz）"><el-input-number v-model="editor.bandwidth" :min="Number.MIN_VALUE" :step="minimumStep" controls-position="right" data-testid="link-bandwidth" @input="emit('bandwidth-input', $event)" /></el-form-item>
          <el-form-item label="发射功率（W）"><el-input-number v-model="editor.txPower" :min="0" controls-position="right" data-testid="link-power" /></el-form-item>
          <el-form-item label="数据速率（Mbps）"><el-input-number v-model="editor.dataRate" :min="0" controls-position="right" data-testid="link-data-rate" /></el-form-item>
          <el-form-item label="发射天线增益（dBi）"><el-input-number v-model="editor.antennaGain.tx" controls-position="right" data-testid="link-tx-gain" /></el-form-item>
          <el-form-item label="接收天线增益（dBi）"><el-input-number v-model="editor.antennaGain.rx" controls-position="right" data-testid="link-rx-gain" /></el-form-item>
          <el-form-item label="天线增益修正值（dB）"><el-input-number v-model="editor.antennaGainCorrectionDb" controls-position="right" data-testid="link-gain-correction" /></el-form-item>
          <el-form-item label="波形抗干扰增益（dB）"><el-input-number v-model="editor.antiJammingGainDb" :min="0" controls-position="right" data-testid="link-anti-jamming-gain" /></el-form-item>
          <el-form-item label="空域隔离量（dB）"><el-input-number v-model="editor.spatialIsolationDb" :min="0" controls-position="right" data-testid="link-spatial-isolation" /></el-form-item>
        </div>
      </section>

      <section class="link-editor-section" aria-labelledby="link-quality-title">
        <h4 id="link-quality-title" class="link-editor-section__title">质量与方向</h4>
        <div class="link-editor-grid">
          <el-form-item label="调制方式">
            <el-select v-model="editor.modulation" style="width: 100%" data-testid="link-modulation">
              <el-option label="BPSK" value="BPSK" /><el-option label="QPSK" value="QPSK" />
            </el-select>
          </el-form-item>
          <el-form-item label="通信方向">
            <el-select v-model="editor.direction" style="width: 100%" data-testid="link-direction">
              <el-option v-for="(label, value) in linkDirectionLabels" :key="value" :label="label" :value="value" />
            </el-select>
          </el-form-item>
          <el-form-item class="link-editor-field--wide" label="信道编码类型">
            <el-select :model-value="editor.coding ?? ''" filterable allow-create clearable default-first-option
              placeholder="选择无编码，或输入后端约定编码标识" data-testid="link-coding" @update:model-value="changeCoding">
              <el-option label="无编码" value="UNCODED" />
              <el-option v-if="editor.coding && editor.coding !== 'UNCODED'" :label="editor.coding" :value="editor.coding" />
            </el-select>
          </el-form-item>
          <el-form-item class="link-editor-field--wide" label="BER 阈值">
            <div class="link-editor-threshold">
              <el-input-number v-model="editor.berThreshold" :min="0" :max="1" :step="0.000001" controls-position="right" data-testid="link-ber-threshold" />
              <span>取值范围 0–1</span>
            </div>
          </el-form-item>
        </div>
      </section>
      <section v-if="business" class="link-editor-section" aria-labelledby="link-business-title">
        <h4 id="link-business-title" class="link-editor-section__title">业务参数</h4>
        <BusinessEditorDialog :key="business.id" embedded :model-value="true" :demand="business"
          :editing="Boolean(demand?.linkId)" :disabled="pending || locked" :platforms="platforms" error="" />
      </section>
    </el-form>
    <template #footer>
      <el-button data-testid="cancel-link" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="pending || locked" data-testid="apply-link" @click="apply">确认</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.link-editor-dialog) {
  display: flex;
  flex-direction: column;
  max-height: 90vh;
}

:global(.link-editor-dialog .el-dialog__body) {
  min-height: 0;
  overflow-y: auto;
}

.platform-feedback {
  margin-bottom: 1rem;
}

.link-editor-form {
  display: grid;
  gap: 0.5rem;
}

.link-editor-section {
  min-width: 0;
}

.link-editor-section__title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0 0 0.375rem;
  color: var(--console-cyan);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
}

.link-editor-section__title::after {
  flex: 1;
  border-top: 1px solid var(--console-border);
  content: '';
}

.link-editor-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 1rem;
}

.link-editor-grid :deep(.el-form-item) {
  margin-bottom: 0.375rem;
}

.link-editor-grid :deep(.el-form-item__label) {
  margin-bottom: 0.25rem;
  line-height: 1.25rem;
}

.link-editor-grid :deep(.el-input-number) {
  width: 100%;
}

.link-editor-field--wide {
  grid-column: 1 / -1;
}

.link-editor-threshold {
  display: grid;
  align-items: center;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
  width: 100%;
}

.link-editor-threshold span {
  color: var(--console-text-muted);
  font-size: 0.75rem;
}

@media (max-width: 600px) {
  .link-editor-grid,
  .link-editor-threshold {
    grid-template-columns: 1fr;
  }

  .link-editor-field--wide {
    grid-column: auto;
  }
}
</style>
