<script setup lang="ts">
import { RUNTIME_STATUS_LABELS } from '../../features/situation/runtime-quality-view'

const labels = { ...RUNTIME_STATUS_LABELS, NO_DATA: '关闭', DISABLED: '已停用' } as const
defineProps<{ status: keyof typeof labels }>()

const tagTypes = {
  UP: 'success',
  DEGRADED: 'warning',
  DOWN: 'danger',
  UNKNOWN: 'info',
  NO_DATA: 'info',
  DISABLED: 'info',
} as const
</script>

<template>
  <el-tag
    :type="tagTypes[status]"
    effect="dark"
    disable-transitions
    :class="`link-status link-status--${status.toLowerCase()}`"
  >{{ labels[status] }}</el-tag>
</template>

<style scoped>
.link-status {
  height: auto;
  padding: .1rem .45rem;
  border: 0;
  border-radius: 999px;
  font-family: "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.25;
}

.link-status--up {
  --el-tag-bg-color: #12351f;
  --el-tag-text-color: #6fd68a;
}

.link-status--degraded {
  --el-tag-bg-color: #3a2c10;
  --el-tag-text-color: #ffb84d;
}

.link-status--down {
  --el-tag-bg-color: #3a1620;
  --el-tag-text-color: #ff7b7b;
}

.link-status.el-tag--info {
  --el-tag-bg-color: #28313a;
  --el-tag-text-color: #b3bcc6;
}
</style>
