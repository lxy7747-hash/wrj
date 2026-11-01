<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { apiFetch } from '../../features/shared/api-fetch'
import { resolveMockOrigin } from '../../stores/auth'
import { unwrapSuccessData } from '../../stores/api-envelope'

interface ConsoleLog { text: string; bytes: number; truncated: boolean; timeoutMs: number | null }

const props = defineProps<{ runId: string; running: boolean }>()
const visible = ref(false)
const log = ref<ConsoleLog | null>(null)
const error = ref('')
const loading = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let request: AbortController | undefined

function isConsoleLog(value: unknown): value is ConsoleLog {
  const row = value as ConsoleLog
  return typeof row === 'object' && row !== null && typeof row.text === 'string' && Number.isSafeInteger(row.bytes)
    && typeof row.truncated === 'boolean' && (row.timeoutMs === null || Number.isSafeInteger(row.timeoutMs))
}

/** 读取本次运行控制台日志尾部；运行中且弹窗打开时每 2 秒刷新，关闭弹窗即停止轮询。 */
async function load(): Promise<void> {
  clearTimeout(timer)
  request?.abort()
  const current = new AbortController()
  request = current
  loading.value = true
  try {
    const response = await apiFetch(`${resolveMockOrigin()}/api/v1/simulations/${encodeURIComponent(props.runId)}/console`, { signal: current.signal, cache: 'no-store' })
    const body: unknown = await response.json()
    if (request !== current) return
    const data = unwrapSuccessData(body)
    if (!response.ok || !isConsoleLog(data)) throw new Error((body as { error?: { message?: string } })?.error?.message ?? '控制台日志响应不正确。')
    log.value = data
    error.value = ''
  } catch (reason) {
    if (request === current && !current.signal.aborted) error.value = reason instanceof Error ? reason.message : '控制台日志读取失败。'
  } finally {
    if (request === current) {
      loading.value = false
      if (visible.value && props.running) timer = setTimeout(() => { void load() }, 2_000)
    }
  }
}

function open(): void {
  visible.value = true
  log.value = null
  error.value = ''
  void load()
}

function close(): void {
  visible.value = false
  clearTimeout(timer)
  request?.abort()
}

watch(() => props.runId, () => { if (visible.value) open() })
watch(() => props.running, running => { if (visible.value && !running) void load() })
onBeforeUnmount(close)
</script>

<template>
  <el-button size="small" data-testid="mission-console-open" @click="open">进程日志</el-button>
  <el-dialog :model-value="visible" title="mission 进程日志" width="min(960px, calc(100vw - 32px))" append-to-body data-testid="mission-console-dialog" @close="close">
    <p class="console-meta" aria-live="polite">
      运行 {{ runId }}{{ running ? ' · 运行中，每 2 秒刷新' : ' · 已结束' }}
      <template v-if="log"> · 日志 {{ log.bytes }} 字节{{ log.truncated ? '（仅显示末尾 64 KiB）' : '' }} · 运行超时：{{ log.timeoutMs ? `${log.timeoutMs / 1000} 秒后自动终止` : '未启用' }}</template>
    </p>
    <el-alert v-if="error" type="error" :title="error" :closable="false" show-icon data-testid="mission-console-error" />
    <pre v-else class="console-text" tabindex="0" aria-label="mission 控制台输出" data-testid="mission-console-text">{{ log ? (log.text || '暂无输出') : loading ? '正在读取…' : '' }}</pre>
    <template #footer><el-button :loading="loading" @click="load">刷新</el-button><el-button type="primary" @click="close">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
.console-meta { margin: 0 0 8px; color: var(--el-text-color-secondary); font-size: 13px; }
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
