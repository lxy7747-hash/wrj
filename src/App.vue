<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import BrandIcon from './components/BrandIcon.vue'
import { useAuthStore } from './stores/auth'
import { useBatchStore } from './stores/batch'
import { useDataExchangeStore } from './stores/data-exchange'
import { useReplayStore } from './stores/replay'
import { useScenarioStore } from './stores/scenario'
import { useSimulationStore } from './stores/simulation'
import { useTelemetryStore } from './stores/telemetry'

const auth = useAuthStore()
const batch = useBatchStore()
const dataExchange = useDataExchangeStore()
const replay = useReplayStore()
const scenario = useScenarioStore()
const simulation = useSimulationStore()
const telemetry = useTelemetryStore()
const router = useRouter()

watch(
  () => auth.principal,
  (principal) => {
    if (principal === null) {
      telemetry.disconnectAndReset()
      simulation.resetToSafeEmpty()
      scenario.resetToSafeEmpty()
      batch.resetToSafeEmpty()
      replay.resetToSafeEmpty()
      dataExchange.resetToSafeEmpty()
    }
  },
  { immediate: true, flush: 'sync' },
)

/**
 * 以中文显示当前已认证主体的固定应用角色。
 *
 * @returns 当前主体对应的本地化管理员或操作员标签。
 * @remarks 此计算值只读，不会修改身份验证状态。
 */
const roleLabel = computed(() => auth.principal?.role === 'ADMIN' ? '管理员' : '操作员')

/**
 * 返回当前角色进入系统管理时的默认路由。
 *
 * @returns 管理员进入用户与角色页，操作员进入数据交换与接口页。
 */
const systemManagementPath = computed(() => (
  auth.principal?.role === 'ADMIN' ? '/admin' : '/admin/data-exchange'
))

/**
 * 结束当前内存会话并返回独立登录路由。
 *
 * @returns 登录导航替换浏览器历史记录后兑现且不返回值的 Promise。
 * @remarks 无参数。通过身份验证 Store 清除主体、角色、权限和反馈，再使用 `replace`
 * 完成导航，避免受保护页面保留为浏览器后退条目。
 */
async function logout(): Promise<void> {
  auth.resetToSafeEmpty()
  await router.replace('/login')
}
</script>

<template>
  <router-view v-if="$route.meta.layout === 'standalone'" />

  <el-container v-else class="app-shell">
    <header class="app-shell__header">
      <div class="brand">
        <p class="brand__mark" aria-hidden="true">
          <BrandIcon />
        </p>
        <div class="brand__copy">
          <h1 id="app-title">多手段集群通联仿真软件</h1>
          <p class="brand__subtitle">任务规划与通联仿真控制台</p>
        </div>
      </div>

      <div class="app-shell__navigation">
        <nav aria-label="主导航">
          <router-link to="/situation">态势主界面</router-link>
          <router-link to="/scenarios">场景配置</router-link>
          <router-link to="/batches">批量仿真</router-link>
          <router-link to="/reports">报表中心</router-link>
          <router-link to="/replays">历史回放</router-link>
          <router-link :to="systemManagementPath">系统管理</router-link>
          <router-link
            to="/blueprint"
            :class="{ 'router-link-active': ['/traceability', '/interactions'].includes($route.path) }"
          >
            能力与追踪
          </router-link>
        </nav>
      </div>

      <section class="identity" aria-label="当前身份" data-testid="identity-panel">
        <div class="identity__details">
          <p class="identity__username" data-testid="identity-username">
            用户：{{ auth.principal?.username }}
          </p>
          <p class="identity__role" data-testid="identity-role">
            角色：{{ roleLabel }}
          </p>
        </div>
        <el-button data-testid="logout" @click="logout">退出登录</el-button>
      </section>
    </header>

    <el-main class="app-shell__main">
      <section
        v-if="$route.path.startsWith('/admin')"
        class="page system-management-page"
        aria-labelledby="system-management-title"
      >
        <header class="system-management__header">
          <div>
            <div class="system-management__title-line">
              <h2 id="system-management-title">系统管理</h2>
              <el-tag type="warning" effect="plain">管理员功能 / 数据交换可用</el-tag>
            </div>
            <p>管理员管理页面与系统/操作员数据交换子功能</p>
          </div>
        </header>

        <div class="system-management__body">
          <aside class="system-management__sidebar" aria-label="系统管理导航">
            <el-menu router :default-active="$route.fullPath">
              <el-menu-item-group title="模型与参数">
                <el-menu-item index="model-parameters" disabled>底层模型参数</el-menu-item>
                <el-menu-item
                  index="/admin?section=equipment-library"
                  :disabled="auth.principal?.role !== 'ADMIN'"
                >
                  装备参数库
                </el-menu-item>
                <el-menu-item index="/admin?section=scenario-templates" :disabled="auth.principal?.role !== 'ADMIN'">场景模板维护</el-menu-item>
              </el-menu-item-group>
              <el-menu-item-group title="账号与维护">
                <el-menu-item
                  index="/admin?section=audit-logs"
                  :disabled="auth.principal?.role !== 'ADMIN'"
                >
                  操作审计日志
                </el-menu-item>
                <el-menu-item index="/admin" :disabled="auth.principal?.role !== 'ADMIN'">账号管理</el-menu-item>
                <el-menu-item index="database-backup" disabled>数据库备份 / 恢复</el-menu-item>
              </el-menu-item-group>
              <el-menu-item-group title="数据与运行">
                <el-menu-item index="simulation-data" disabled>仿真数据管理</el-menu-item>
                <el-menu-item index="runtime-status" disabled>系统运行状态</el-menu-item>
              </el-menu-item-group>
              <el-menu-item-group title="数据交换">
                <el-menu-item index="/admin/data-exchange">
                  <span>数据交换与接口</span>
                  <small>系统/操作员</small>
                </el-menu-item>
              </el-menu-item-group>
            </el-menu>
          </aside>

          <div class="system-management__content">
            <router-view />
          </div>
        </div>
      </section>

      <section
        v-else-if="['/blueprint', '/traceability', '/interactions'].includes($route.path)"
        class="capability-page"
      >
        <div class="system-management__body">
          <aside class="system-management__sidebar" aria-label="能力与接口导航">
            <el-menu router :default-active="$route.path">
              <el-menu-item-group title="能力与追踪">
                <el-menu-item index="/blueprint">能力/接口蓝图</el-menu-item>
                <el-menu-item index="/traceability">需求追踪</el-menu-item>
                <el-menu-item index="/interactions">感知、干扰与选路</el-menu-item>
              </el-menu-item-group>
            </el-menu>
          </aside>

          <div class="system-management__content">
            <router-view />
          </div>
        </div>
      </section>

      <router-view v-else />
    </el-main>
  </el-container>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  color: var(--console-text-primary, var(--console-text, #e7f0f8));
  background: var(--console-bg, #050b12);
  font-family:
    Inter, "Microsoft YaHei", "PingFang SC", system-ui, -apple-system, sans-serif;
}

.app-shell {
  --shell-border: var(--console-border, #20364a);
  --shell-panel: var(--console-panel, var(--console-surface, #0d1926));
  --shell-panel-strong: var(--console-panel-strong, var(--console-surface-raised, #101f2f));
  --shell-text: var(--console-text-primary, var(--console-text, #e7f0f8));
  --shell-text-muted: var(--console-text-secondary, var(--console-text-muted, #8ea4b9));
  --shell-accent: var(--console-accent, var(--console-cyan, #42c8f5));
  --shell-accent-soft: var(--console-accent-soft, rgba(66, 200, 245, 0.12));
  flex-direction: column;
  height: 100vh;
  min-height: 100vh;
  color: var(--shell-text);
  background:
    linear-gradient(rgba(66, 200, 245, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(66, 200, 245, 0.025) 1px, transparent 1px),
    var(--console-bg, #050b12);
  background-size: 2rem 2rem;
}

.app-shell__header {
  z-index: 1;
  display: flex;
  min-height: 3.5rem;
  align-items: center;
  gap: clamp(0.75rem, 2vw, 1.5rem);
  padding: 0.5rem clamp(0.75rem, 2vw, 1.5rem);
  border-bottom: 1px solid var(--shell-border);
  background: var(--shell-panel-strong);
  box-shadow: 0 0.25rem 1rem rgba(0, 0, 0, 0.18);
}

.brand {
  display: flex;
  min-width: 17rem;
  align-items: center;
  gap: 0.65rem;
}

.brand__mark {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  flex: 0 0 auto;
  margin: 0;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--shell-accent) 65%, transparent);
  border-radius: 0.45rem;
  color: var(--shell-accent);
  background: var(--shell-accent-soft);
  box-shadow: inset 0 0 1rem rgba(66, 200, 245, 0.08);
}

h1 {
  margin: 0;
  color: var(--shell-text);
  font-size: clamp(0.95rem, 1.5vw, 1.12rem);
  line-height: 1.2;
  letter-spacing: 0.02em;
}

.brand__subtitle {
  margin: 0.1rem 0 0;
  color: var(--shell-text-muted);
  font-size: var(--console-font-size-min);
  letter-spacing: 0.12em;
}

.identity {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-left: auto;
  padding-left: clamp(0.75rem, 1.5vw, 1.25rem);
  border-left: 1px solid var(--shell-border);
}

.identity p {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.45;
  white-space: nowrap;
}

.identity__username {
  color: var(--shell-text);
  font-weight: 650;
}

.identity__role {
  color: var(--shell-text-muted);
}

.identity :deep(.el-button) {
  height: 2rem;
  border-color: var(--shell-border);
  color: var(--shell-text-muted);
  background: transparent;
  font-size: 0.75rem;
}

.identity :deep(.el-button:hover),
.identity :deep(.el-button:focus-visible) {
  border-color: var(--shell-accent);
  color: var(--shell-accent);
  background: var(--shell-accent-soft);
}

.app-shell__navigation {
  z-index: 1;
  min-width: 0;
  flex: 1 1 auto;
  overflow-x: auto;
  background: color-mix(in srgb, var(--shell-panel) 96%, transparent);
}

nav {
  display: flex;
  width: max-content;
  min-width: 100%;
  min-height: 2.75rem;
  align-items: stretch;
  padding: 0 clamp(0.75rem, 2vw, 1.5rem);
}

nav a {
  display: flex;
  align-items: center;
  padding: 0 0.7rem;
  border-bottom: 2px solid transparent;
  color: var(--shell-text-muted);
  font-size: 0.8rem;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
}

nav a:hover,
nav a:focus-visible,
nav a.router-link-active,
nav a.router-link-exact-active {
  border-bottom-color: var(--shell-accent);
  color: var(--shell-text);
  background: var(--shell-accent-soft);
  outline: none;
}

.app-shell__main {
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  padding: 0;
  margin: 0;
  background: transparent;
}

.system-management-page {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}

.system-management__header {
  flex: 0 0 auto;
  padding: var(--space-3, 0.75rem) var(--space-5, 1.5rem);
  border-bottom: 1px solid var(--console-border);
  background: var(--console-surface-raised);
}

.system-management__title-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2, 0.5rem);
}

.system-management__title-line h2 {
  margin: 0;
  color: var(--console-text);
  font-size: 1.1rem;
}

.system-management__header p {
  margin: var(--space-1, 0.25rem) 0 0;
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.system-management__body {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
}

.system-management__sidebar {
  width: 11.875rem;
  flex: 0 0 11.875rem;
  overflow-y: auto;
  border-right: 1px solid var(--console-border);
  background: var(--console-bg-elevated);
}

.system-management__sidebar :deep(.el-menu) {
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--console-text-muted);
  --el-menu-hover-bg-color: var(--shell-accent-soft);
  --el-menu-active-color: var(--console-cyan);
  border-right: 0;
}

.system-management__sidebar :deep(.el-menu-item-group__title) {
  padding: var(--space-3, 0.75rem) var(--space-4, 1rem) var(--space-1, 0.25rem) !important;
  color: var(--console-text-dim);
  font-size: var(--console-font-size-min);
  line-height: 1.4;
}

.system-management__sidebar :deep(.el-menu-item) {
  height: 2.5rem;
  padding-left: var(--space-4, 1rem) !important;
  border-left: 2px solid transparent;
  line-height: 2.5rem;
}

.system-management__sidebar :deep(.el-menu-item.is-active) {
  border-left-color: var(--console-cyan);
  background: var(--shell-accent-soft);
  font-weight: 600;
}

.system-management__sidebar :deep(.el-menu-item.is-disabled) {
  color: var(--console-text-muted);
  cursor: default;
  opacity: 1;
}

.system-management__sidebar :deep(.el-menu-item small) {
  margin-left: auto;
  color: var(--console-amber);
  font-size: var(--console-font-size-min);
}

.system-management__content {
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
}

.capability-page {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

@media (max-width: 720px) {
  .system-management__sidebar {
    width: 10rem;
    flex-basis: 10rem;
  }
}

:global(.page) {
  width: 100%;
  min-height: 100%;
  margin: 0;
  padding: clamp(0.75rem, 2vw, 1.5rem);
  background: color-mix(in srgb, var(--console-panel, var(--console-surface, #0d1926)) 82%, transparent);
}

:global(.page h2) {
  margin: 0.35rem 0 0.75rem;
  font-size: clamp(1.5rem, 3vw, 2rem);
}

:global(.eyebrow) {
  margin: 0;
  color: var(--console-success, var(--console-teal, #5ce0a0));
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

@media (max-width: 760px) {
  .app-shell {
    height: auto;
  }

  .app-shell__header {
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 0.8rem 1.25rem;
    padding: 0.85rem 1rem;
  }

  .brand {
    min-width: 0;
    flex: 1 1 17rem;
  }

  .app-shell__navigation {
    order: 3;
    flex-basis: 100%;
    width: 100%;
  }

  .identity {
    align-self: center;
    margin-left: 0;
    padding-left: 0;
    border-left: 0;
  }


}

@media (max-width: 480px) {
  .brand__subtitle {
    display: none;
  }

  .identity {
    width: 100%;
    justify-content: space-between;
  }

  nav a {
    padding-right: 0.55rem;
    padding-left: 0.55rem;
    font-size: 0.78rem;
  }
}
</style>
