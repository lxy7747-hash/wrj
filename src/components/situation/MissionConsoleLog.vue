<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { apiFetch } from '../../features/shared/api-fetch'
import { resolveMockOrigin } from '../../stores/auth'
import { unwrapSuccessData } from '../../stores/api-envelope'
import { useTelemetryStore } from '../../stores/telemetry'
import type { MissionLogUpdate } from '../../contracts/domain-models'

interface ConsoleLog { text: string; bytes: number; truncated: boolean; timeoutMs: number | null }

const props = defineProps<{ runId: string; running: boolean }>()
const visible = ref(false)
const log = ref<ConsoleLog | null>(null)
const error = ref('')
const loading = ref(false)
let request: AbortController | undefined
let pendingChunks: { bytes: number; chunkCount: number; nextIndex: number; ignored: boolean } | undefined
let subscribedCount = 0
let logEpoch = 0
const telemetry = useTelemetryStore()
const diagnostics = computed(() => telemetry.engineDiagnostics.filter(item => item.runId === props.runId))

function isConsoleLog(value: unknown): value is ConsoleLog {
  const row = value as ConsoleLog
  return typeof row === 'object' && row !== null && typeof row.text === 'string' && Number.isSafeInteger(row.bytes)
    && typeof row.truncated === 'boolean' && (row.timeoutMs === null || Number.isSafeInteger(row.timeoutMs))
}

/** HTTP 只用于首次加载、手动刷新和 WS 重连后的补偿；运行中的增量来自 mission.log。 */
async function load(requiredBytes = 0): Promise<void> {
  request?.abort()
  const current = new AbortController()
  request = current
  const requestEpoch = logEpoch
  loading.value = true
  try {
    const response = await apiFetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(props.runId)}/console`, { signal: current.signal, cache: 'no-store' })
    const body: unknown = await response.json()
    if (request !== current || requestEpoch !== logEpoch) return
    const data = unwrapSuccessData(body)
    if (!response.ok || !isConsoleLog(data)) throw new Error((body as { error?: { message?: string } })?.error?.message ?? '控制台日志响应不正确。')
    // A response started before a live WS update can arrive later.  Never let
    // that older source-tail snapshot overwrite a newer observation.
    if (data.bytes < requiredBytes) {
      // The source reported a newer WS interval, but this single recovery read
      // was older.  Do not poll indefinitely across file rotation; the user can
      // refresh and the next WS record may provide a replacement snapshot.
      error.value = '控制台补偿快照尚未覆盖最新实时日志，请刷新后重试。'
      return
    }
    if (log.value === null || data.bytes >= log.value.bytes) {
      log.value = data
      if (pendingChunks !== undefined && pendingChunks.bytes <= data.bytes) pendingChunks.ignored = true
    }
    error.value = ''
  } catch (reason) {
    if (request === current && !current.signal.aborted) error.value = reason instanceof Error ? reason.message : '控制台日志读取失败。'
  } finally {
    if (request === current) loading.value = false
  }
}

function applyLogUpdate(update: MissionLogUpdate): void {
  if (!visible.value || update.runId !== props.runId) return
  const current = log.value
  if (update.chunkIndex === 0) {
    // Replacement means file rotation/truncation or a changed tail.  It must
    // win even if its new file is shorter than the prior source.
    const completeAlreadyLoaded = !update.replace && current !== null && current.bytes >= update.endByteOffset
    const overlapNeedsRecovery = !update.replace && current !== null
      && current.bytes > update.startByteOffset && current.bytes < update.endByteOffset
    const gapNeedsRecovery = !update.replace && ((current === null && update.startByteOffset > 0)
      || (current !== null && current.bytes < update.startByteOffset))
    const ignored = completeAlreadyLoaded || overlapNeedsRecovery || gapNeedsRecovery
    pendingChunks = { bytes: update.bytes, chunkCount: update.chunkCount, nextIndex: 1, ignored }
    logEpoch += 1
    request?.abort()
    if (overlapNeedsRecovery || gapNeedsRecovery) {
      void load(update.endByteOffset)
      return
    }
    if (ignored) return
    log.value = update.replace || current === null
      ? { text: update.text, bytes: update.bytes, truncated: update.truncated, timeoutMs: current?.timeoutMs ?? null }
      : { ...current, text: current.text + update.text, bytes: update.bytes, truncated: update.truncated }
    if (update.chunkCount === 1) pendingChunks = undefined
    return
  }
  const pending = pendingChunks
  if (pending === undefined || pending.bytes !== update.bytes || pending.chunkCount !== update.chunkCount || pending.nextIndex !== update.chunkIndex) return
  pending.nextIndex += 1
  if (!pending.ignored && log.value !== null) {
    log.value = { ...log.value, text: log.value.text + update.text, bytes: update.bytes, truncated: update.truncated }
  }
  if (update.chunkIndex + 1 === update.chunkCount) pendingChunks = undefined
}

function open(): void {
  logEpoch += 1
  visible.value = true
  log.value = null
  pendingChunks = undefined
  error.value = ''
  void load()
}

function close(): void {
  logEpoch += 1
  visible.value = false
  request?.abort()
}

watch(() => props.runId, () => { if (visible.value) open() })
watch(() => props.running, running => { if (visible.value && !running) void load() })
watch(() => telemetry.missionLogUpdates, updates => {
  const update = updates.at(-1)
  if (update !== undefined) applyLogUpdate(update)
}, { flush: 'sync' })
watch(() => telemetry.connectionState, state => {
  if (state !== 'SUBSCRIBED') return
  if (visible.value && subscribedCount > 0) void load()
  subscribedCount += 1
})
onBeforeUnmount(close)
</script>

<template>
  <el-button size="small" data-testid="mission-console-open" @click="open">进程日志</el-button>
  <el-dialog :model-value="visible" title="mission 进程日志" width="min(960px, calc(100vw - 32px))" append-to-body data-testid="mission-console-dialog" @close="close">
    <p class="console-meta" aria-live="polite">
      运行 {{ runId }}{{ running ? ' · 运行中，实时增量通过 WebSocket 更新' : ' · 已结束' }}
      <template v-if="log"> · 日志 {{ log.bytes }} 字节{{ log.truncated ? '（仅显示末尾 64 KiB）' : '' }} · 运行超时：{{ log.timeoutMs ? `${log.timeoutMs / 1000} 秒后自动终止` : '未启用' }}</template>
    </p>
    <el-alert v-for="(diagnostic, index) in diagnostics" :key="`${diagnostic.state}-${diagnostic.message}-${index}`" type="info" :title="diagnostic.message" :closable="false" show-icon class="engine-diagnostic" data-testid="mission-engine-diagnostic" />
    <el-alert v-if="error" type="error" :title="error" :closable="false" show-icon data-testid="mission-console-error" />
    <pre v-else class="console-text" tabindex="0" aria-label="mission 控制台输出" data-testid="mission-console-text">{{ log ? (log.text || '暂无输出') : loading ? '正在读取…' : '' }}</pre>
    <template #footer><el-button :loading="loading" @click="load">刷新</el-button><el-button type="primary" @click="close">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
.console-meta { margin: 0 0 8px; color: var(--el-text-color-secondary); font-size: 13px; }
.engine-diagnostic { margin: 0 0 8px; }
.console-text {
  max-height: 60vh;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-fill-color-darker);
  color: var(--el-text-color-primary);
  font: 12px/1.5 Consolas, "SFMono-Regular", monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
