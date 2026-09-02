<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import LinkCalculatorContractCard from '../../components/blueprint/LinkCalculatorContractCard.vue'
import { useAuthStore } from '../../stores/auth'

const route = useRoute()
const authStore = useAuthStore()
const title = computed(() => String(route.meta.title ?? '能力蓝图'))
</script>

<template>
  <section class="page blueprint-page" aria-labelledby="page-blueprint">
    <el-alert
      v-if="authStore.lastDenial"
      class="blueprint-page__denial"
      type="error"
      :closable="false"
      show-icon
      data-testid="route-denial"
      title="PERMISSION_DENIED"
      :description="`当前 ${authStore.role} 角色不能进入用户与角色管理；已返回能力蓝图。缺少权限：${authStore.lastDenial.permission}`"
    />

    <header class="blueprint-page__header">
      <div>
        <p class="eyebrow">仿真运行与态势 · 链路计算</p>
        <h2 id="page-blueprint">{{ title }}</h2>
        <p>展示标准链路计算输入、输出、同帧约束和异常处理证据。</p>
      </div>
      <el-tag effect="plain">/blueprint</el-tag>
    </header>

    <LinkCalculatorContractCard />
  </section>
</template>

<style scoped>
.blueprint-page {
  overflow: auto;
}

.blueprint-page__denial {
  margin-bottom: var(--space-4);
}

.blueprint-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}

.blueprint-page__header p:last-child {
  margin: 0;
  color: var(--console-text-muted);
  line-height: 1.7;
}

@media (max-width: 620px) {
  .blueprint-page__header {
    flex-direction: column;
  }
}
</style>
