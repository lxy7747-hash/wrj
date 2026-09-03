<script setup lang="ts">
import { computed } from 'vue'
import type { SituationLinkView } from '../../features/situation/situation-model'

const props = defineProps<{ link: SituationLinkView }>()

const statusLabel = computed(() => ({
  UP: '正常',
  DEGRADED: '劣化',
  DOWN: '中断',
})[props.link.status])

const tagType = computed(() => ({
  UP: 'success',
  DEGRADED: 'warning',
  DOWN: 'danger',
} as const)[props.link.status])
</script>

<template>
  <el-tag
    :type="tagType"
    effect="dark"
    disable-transitions
    :class="`link-status link-status--${link.status.toLowerCase()}`"
    :data-canonical-status="link.canonicalStatus"
    :data-threshold-version="link.thresholdVersion ?? ''"
    :title="`${link.linkId}：单击链路查看判定依据`"
  >{{ statusLabel }}</el-tag>
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
</style>
