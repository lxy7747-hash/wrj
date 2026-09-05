<script setup lang="ts">
import { computed, nextTick, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import LinkCalculatorContractCard from '../../components/blueprint/LinkCalculatorContractCard.vue'
import { useAuthStore } from '../../stores/auth'
import { CAPABILITY_LABELS, useTraceabilityStore } from '../../stores/traceability'

const route = useRoute()
const authStore = useAuthStore()
const store = useTraceabilityStore()
const title = computed(() => String(route.meta.title ?? '能力蓝图'))

/** 按既有模块和少量跨模块能力定位工作页，不增加新路由。 */
function capabilityPage(destination: string, module: string): string {
  const specific: Record<string, string> = {
    'cap-bbksh': '/reports', 'cap-yqqd': '/situation', 'cap-lljs': '#link-calculator-title',
    'cap-llzt': '/situation', 'cap-lljc': '/situation',
    'cap-jcsj': '/admin?section=master-data', 'cap-yhjs': '/admin',
    'cap-bfhf': '/admin?section=database-backup', 'cap-czrz': '/admin?section=audit-logs',
  }
  const modules: Record<string, string> = {
    '前端展示': '/situation', '场景配置与脚本生成': '/scenarios', '数据交换与接口': '/admin/data-exchange',
  }
  return specific[destination] ?? modules[module] ?? '/interactions'
}

/** 目录异步加载或锚点变化后定位说明卡；仅查找已渲染的 DOM 编号。 */
async function locateAnchor(): Promise<void> {
  await nextTick()
  document.getElementById(route.hash.slice(1))?.scrollIntoView({ block: 'start' })
}
watch(() => route.hash, locateAnchor)
onMounted(async () => { if (store.metadata === null) await store.loadMetadata(); await locateAnchor() })
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
        <p class="eyebrow">能力、接口与设计决策</p>
        <h2 id="page-blueprint">{{ title }}</h2>
        <p>查看需求覆盖、功能入口、接口边界及已采纳的设计决策。</p>
      </div>
      <el-tag effect="plain">/blueprint</el-tag>
    </header>

    <el-alert v-if="store.state === 'ERROR'" :title="store.message" type="error" :closable="false" />
    <el-button :loading="store.state === 'LOADING'" @click="store.loadMetadata()">刷新目录</el-button>
    <p>说明中的“交互界面”不代表真实引擎已接入；“可见合同”仅展示协议与模拟结果。</p>
    <div class="capability-grid" aria-label="29 项能力目录">
      <el-card v-for="item in store.metadata?.capabilities" :id="item.destination" :key="item.id" shadow="never" data-testid="capability-card">
        <h3>{{ item.name }}</h3><p>{{ item.module }} · {{ item.coverage === 'INTERACTIVE_UI' ? '交互界面' : '可见合同' }}</p>
        <code>{{ item.id }}</code>
        <p>声明状态：{{ item.states.map(state => CAPABILITY_LABELS[state]).join('、') }}</p>
        <router-link :to="capabilityPage(item.destination, item.module)">进入功能</router-link>
      </el-card>
    </div>
    <h3>七类接口</h3>
    <div class="capability-grid">
      <el-card v-for="item in store.metadata?.interfaces" :id="item.destination" :key="item.id" shadow="never" data-testid="interface-anchor">
        <h4>{{ item.name }}</h4><p>{{ item.kind }}接口</p><code>{{ item.id }}</code>
        <p><router-link :to="`/admin/data-exchange#${item.destination}`">查看接口合同</router-link></p>
      </el-card>
    </div>
    <h3>已采纳的设计决策</h3>
    <el-table :data="store.metadata?.decisions ?? []" data-testid="decision-table" row-key="id">
      <el-table-column prop="id" label="编号" width="105" />
      <el-table-column prop="conflict" label="分歧" min-width="200" />
      <el-table-column prop="adopted" label="采用方案" min-width="240" />
      <el-table-column prop="effect" label="影响" min-width="240" />
    </el-table>
    <LinkCalculatorContractCard />
  </section>
</template>

<style scoped>
.blueprint-page {
  overflow: auto;
}
.capability-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); margin: var(--space-4) 0; }
.capability-grid code { overflow-wrap: anywhere; }
.capability-grid p { color: var(--console-text-muted); }
.capability-grid a { color: var(--console-cyan); text-underline-offset: 3px; }
@media (max-width: 1400px) { .capability-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .capability-grid { grid-template-columns: 1fr; } }

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
