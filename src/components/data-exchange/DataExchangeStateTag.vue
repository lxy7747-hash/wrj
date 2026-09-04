<script setup lang="ts">
import { computed } from 'vue'
import type { CapabilityState } from '../../contracts/domain-models'

const props = defineProps<{ state: CapabilityState }>()
const label = computed(() => ({
  LOADING: '加载中', VALIDATING: '校验中', EXECUTING: '处理中',
  SUCCESS: '已完成', EMPTY: '待操作', ERROR: '失败',
})[props.state])
const type = computed(() => ({
  LOADING: 'info', VALIDATING: 'warning', EXECUTING: 'warning',
  SUCCESS: 'success', EMPTY: 'info', ERROR: 'danger',
} as const)[props.state])
</script>

<template>
  <el-tag :type="type" effect="dark">{{ label }}</el-tag>
</template>
