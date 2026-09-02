<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import BrandIcon from './components/BrandIcon.vue'
import { useAuthStore } from './stores/auth'
import { useScenarioStore } from './stores/scenario'
import { useSimulationStore } from './stores/simulation'
import { useTelemetryStore } from './stores/telemetry'

const auth = useAuthStore()
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
          <section class="nav-group" aria-label="仿真作业">
            <div class="nav-group__links">
              <router-link to="/situation">态势主界面</router-link>
              <router-link to="/scenarios">场景配置</router-link>
              <router-link to="/batches">仿真批次</router-link>
              <router-link to="/reports">报表中心</router-link>
              <router-link to="/replays">回放复盘</router-link>
            </div>
          </section>

          <section class="nav-group" aria-label="能力治理">
            <div class="nav-group__links">
              <router-link to="/blueprint">能力蓝图</router-link>
              <router-link to="/traceability">可追溯性</router-link>
              <router-link to="/interactions">交互管理</router-link>
            </div>
          </section>

          <section class="nav-group" aria-label="系统管理">
            <div class="nav-group__links">
              <router-link to="/admin/data-exchange">数据交换与接口</router-link>
              <router-link v-if="auth.principal?.role === 'ADMIN'" to="/admin">用户与角色</router-link>
            </div>
          </section>
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
      <router-view />
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

.nav-group {
  display: flex;
  min-width: max-content;
  align-items: stretch;
}

.nav-group+.nav-group {
  margin-left: 0.75rem;
  padding-left: 0.75rem;
  border-left: 1px solid color-mix(in srgb, var(--shell-border) 70%, transparent);
}

.nav-group__links {
  display: flex;
  align-items: stretch;
  gap: 0.15rem;
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
