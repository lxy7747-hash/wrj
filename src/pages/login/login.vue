<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useRouter } from 'vue-router'
import BrandIcon from '../../components/BrandIcon.vue'
import { useAuthStore, type LoginCredentials } from '../../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const form = reactive<LoginCredentials>({
  username: '',
  password: '',
})

const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(auth.authState))

const failureDescription = computed(() => {
  switch (auth.lastCode) {
    case 'INVALID_CREDENTIALS':
      return '用户名或密码错误，请重新输入。'
    case 'ACCOUNT_LOCKED':
      return '账号已锁定，请联系管理员。'
    case 'NETWORK_ERROR':
      return '登录服务暂时不可用，请稍后重试。'
    default:
      return '登录失败，请稍后重试。'
  }
})

/**
 * 使用登录表单中的当前凭据发起身份验证。
 * @returns 身份验证及成功后的导航完成时兑现且不返回值的 Promise。
 * @remarks 无参数。调用 Pinia 身份验证流程并更新等待状态和错误反馈；成功时将浏览器历史
 * 替换为 `/situation`，失败时停留在 `/login`。按钮等待状态会阻止重复点击提交。
 */
async function submitLogin(): Promise<void> {
  const result = await auth.login({ ...form })
  if (result.authenticated) {
    await router.replace('/situation')
  }
}
</script>

<template>
  <section class="page login-page" aria-labelledby="login-title">
    <div class="login-page__backdrop" aria-hidden="true"></div>

    <header class="product-intro">
      <div class="product-brand">
        <span class="product-brand__mark" aria-hidden="true"><BrandIcon /></span>
        <div>
          <p class="product-brand__eyebrow">无人集群通联任务控制台</p>
          <h1>多手段集群通联仿真软件</h1>
        </div>
      </div>

      <div class="product-intro__copy">
        <p class="product-intro__label">MISSION COMMUNICATION CONSOLE</p>
        <p class="product-intro__title">面向任务规划与通联仿真的统一工作入口</p>
        <p class="product-intro__description">
          在受控工作区内开展场景配置、链路协同与仿真态势作业。
        </p>
      </div>

      <div class="topology" aria-hidden="true">
        <span class="topology__orbit topology__orbit--outer"></span>
        <span class="topology__orbit topology__orbit--inner"></span>
        <span class="topology__axis topology__axis--horizontal"></span>
        <span class="topology__axis topology__axis--diagonal"></span>
        <span class="topology__node topology__node--center"></span>
        <span class="topology__node topology__node--north"></span>
        <span class="topology__node topology__node--east"></span>
        <span class="topology__node topology__node--south"></span>
        <span class="topology__node topology__node--west"></span>
      </div>
    </header>

    <main class="login-card">
      <div class="login-card__heading">
        <p class="login-card__eyebrow">ACCOUNT ACCESS</p>
        <h2 id="login-title">系统登录</h2>
        <p>请输入用户名和密码以继续使用系统。</p>
      </div>

      <el-form class="login-form" label-position="top" :model="form" @submit.prevent="submitLogin">
        <el-form-item label="用户名">
          <el-input
            v-model="form.username"
            data-testid="login-username"
            autocomplete="username"
            aria-label="用户名"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            data-testid="login-password"
            type="password"
            show-password
            autocomplete="current-password"
            aria-label="密码"
          />
        </el-form-item>
        <el-button
          native-type="submit"
          type="primary"
          :loading="pending"
          data-testid="login-submit"
        >
          登录
        </el-button>

        <el-alert
          v-if="auth.authState === 'ERROR'"
          class="auth-feedback"
          type="error"
          :closable="false"
          show-icon
          data-testid="auth-feedback"
          title="登录失败"
          :description="failureDescription"
        />
      </el-form>
    </main>
  </section>
</template>

<style scoped>
.login-page.page {
  --login-bg: var(--console-bg, #050b14);
  --login-panel: var(--console-surface, #0b1d2d);
  --login-panel-strong: var(--console-surface-raised, #10283a);
  --login-border: var(--console-border, #1d4058);
  --login-border-strong: var(--console-border-strong, #2a6883);
  --login-text: var(--console-text, #e7f6ff);
  --login-text-muted: var(--console-text-muted, #8ba9bd);
  --login-text-dim: var(--console-text-dim, #5e7b90);
  --login-accent: var(--console-cyan, #42d8ff);
  position: relative;
  display: grid;
  width: 100%;
  max-width: none;
  min-height: 100vh;
  min-height: 100svh;
  margin: 0;
  padding: clamp(1.25rem, 4vw, 4.5rem);
  grid-template-columns: minmax(0, 1fr) minmax(22rem, 28rem);
  align-items: center;
  gap: clamp(3rem, 9vw, 9rem);
  overflow: hidden;
  border: 0;
  border-radius: 0;
  color: var(--login-text);
  background:
    radial-gradient(circle at 18% 42%, rgba(66, 216, 255, 0.08), transparent 28rem),
    linear-gradient(118deg, rgba(8, 26, 41, 0.98), rgba(5, 11, 20, 0.98) 62%),
    var(--login-bg);
  box-shadow: none;
  isolation: isolate;
}

.login-page__backdrop {
  position: absolute;
  z-index: -1;
  inset: 0;
  opacity: 0.48;
  background-image:
    linear-gradient(rgba(66, 216, 255, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(66, 216, 255, 0.04) 1px, transparent 1px);
  background-size: 2.75rem 2.75rem;
  -webkit-mask-image: linear-gradient(90deg, #000, rgba(0, 0, 0, 0.5) 64%, transparent);
  mask-image: linear-gradient(90deg, #000, rgba(0, 0, 0, 0.5) 64%, transparent);
}

.product-intro {
  width: min(100%, 42rem);
  min-width: 0;
}

.product-brand {
  display: flex;
  align-items: center;
  gap: 0.9rem;
}

.product-brand__mark {
  display: grid;
  width: 3.25rem;
  height: 3.25rem;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--login-accent) 68%, transparent);
  border-radius: var(--console-radius, 8px);
  color: var(--login-accent);
  background: rgba(66, 216, 255, 0.08);
  box-shadow: inset 0 0 1.25rem rgba(66, 216, 255, 0.06);
}

.product-brand__eyebrow,
.product-intro__label,
.login-card__eyebrow {
  margin: 0;
  color: var(--login-accent);
  font-size: var(--console-font-size-min);
  font-weight: 700;
  letter-spacing: 0.16em;
}

.product-brand h1 {
  margin: 0.25rem 0 0;
  color: var(--login-text);
  font-size: clamp(1.05rem, 2vw, 1.35rem);
  line-height: 1.35;
  letter-spacing: 0.035em;
}

.product-intro__copy {
  margin-top: clamp(4rem, 9vh, 7.5rem);
}

.product-intro__title {
  max-width: 11em;
  margin: 1rem 0 0;
  color: var(--login-text);
  font-size: clamp(2rem, 4vw, 3.75rem);
  font-weight: 650;
  line-height: 1.16;
  letter-spacing: -0.025em;
}

.product-intro__description {
  max-width: 34rem;
  margin: 1.25rem 0 0;
  color: var(--login-text-muted);
  font-size: 0.9rem;
  line-height: 1.8;
}

.topology {
  position: relative;
  width: min(100%, 34rem);
  height: 8.5rem;
  margin-top: clamp(2rem, 6vh, 4.5rem);
  overflow: hidden;
  border-top: 1px solid color-mix(in srgb, var(--login-border) 65%, transparent);
  opacity: 0.72;
}

.topology__orbit,
.topology__axis,
.topology__node {
  position: absolute;
  display: block;
}

.topology__orbit {
  top: 1.5rem;
  left: 50%;
  border: 1px solid color-mix(in srgb, var(--login-accent) 32%, transparent);
  border-radius: 50%;
  transform: translateX(-50%);
}

.topology__orbit--outer {
  width: 25rem;
  height: 10rem;
}

.topology__orbit--inner {
  top: 3rem;
  width: 14rem;
  height: 6rem;
}

.topology__axis {
  top: 4.6rem;
  left: 50%;
  width: 22rem;
  height: 1px;
  background: color-mix(in srgb, var(--login-accent) 30%, transparent);
  transform: translateX(-50%);
}

.topology__axis--diagonal {
  transform: translateX(-50%) rotate(-17deg);
  transform-origin: center;
}

.topology__node {
  width: 0.48rem;
  height: 0.48rem;
  border: 1px solid var(--login-accent);
  border-radius: 50%;
  background: var(--login-bg);
  box-shadow: 0 0 0 0.3rem rgba(66, 216, 255, 0.07);
}

.topology__node--center {
  top: 4.38rem;
  left: calc(50% - 0.24rem);
  background: var(--login-accent);
}

.topology__node--north {
  top: 2.15rem;
  left: 37%;
}

.topology__node--east {
  top: 3.42rem;
  right: 12%;
}

.topology__node--south {
  top: 6.4rem;
  left: 63%;
}

.topology__node--west {
  top: 5.25rem;
  left: 13%;
}

.login-card {
  position: relative;
  width: 100%;
  min-width: 0;
  padding: clamp(1.5rem, 3vw, 2.75rem);
  border: 1px solid var(--login-border);
  border-radius: calc(var(--console-radius, 8px) + 2px);
  background:
    linear-gradient(145deg, rgba(16, 40, 58, 0.72), rgba(7, 21, 34, 0.9)),
    var(--login-panel);
  box-shadow: var(--console-shadow, 0 16px 40px rgba(0, 0, 0, 0.28));
}

.login-card::before {
  position: absolute;
  top: -1px;
  left: 2.75rem;
  width: 4rem;
  height: 1px;
  background: var(--login-accent);
  content: "";
}

.login-card__heading h2 {
  margin: 0.7rem 0 0;
  color: var(--login-text);
  font-size: clamp(1.65rem, 3vw, 2rem);
  font-weight: 650;
  letter-spacing: 0.02em;
}

.login-card__heading > p:last-child {
  margin: 0.7rem 0 0;
  color: var(--login-text-muted);
  font-size: 0.84rem;
  line-height: 1.65;
}

.login-form {
  margin-top: 2rem;
}

.login-form :deep(.el-form-item) {
  margin-bottom: 1.35rem;
}

.login-form :deep(.el-form-item__label) {
  height: auto;
  padding-bottom: 0.55rem;
  color: var(--login-text-muted);
  font-size: 0.78rem;
  font-weight: 650;
  letter-spacing: 0.04em;
  line-height: 1.4;
}

.login-form :deep(.el-input__wrapper) {
  min-height: 2.85rem;
  padding: 0 0.9rem;
  border: 1px solid var(--login-border);
  border-radius: var(--console-radius, 8px);
  background: transparent;
  box-shadow: none;
}

.login-form :deep(.el-input__wrapper:hover) {
  border-color: var(--login-border-strong);
}

.login-form :deep(.el-input__wrapper.is-focus) {
  border-color: var(--login-accent);
  box-shadow: 0 0 0 2px rgba(66, 216, 255, 0.13);
}

.login-form :deep(.el-input__inner) {
  background: transparent;
  caret-color: var(--login-text);
  color: var(--login-text);
  font-size: 0.9rem;
}

.login-form :deep(.el-input__inner:-webkit-autofill),
.login-form :deep(.el-input__inner:-webkit-autofill:hover),
.login-form :deep(.el-input__inner:-webkit-autofill:focus),
.login-form :deep(.el-input__inner:-webkit-autofill:active) {
  -webkit-background-clip: text;
  -webkit-text-fill-color: var(--login-text);
  background-color: transparent;
  caret-color: var(--login-text);
}

.login-form :deep(.el-input__password) {
  color: var(--login-text-muted);
}

.login-form > :deep(.el-button) {
  width: 100%;
  min-height: 2.85rem;
  margin-top: 0.35rem;
  border-color: var(--login-accent);
  color: #04111b;
  background: var(--login-accent);
  font-weight: 750;
  letter-spacing: 0.12em;
}

.login-form > :deep(.el-button:hover),
.login-form > :deep(.el-button:focus-visible) {
  border-color: color-mix(in srgb, var(--login-accent) 82%, white);
  color: #04111b;
  background: color-mix(in srgb, var(--login-accent) 82%, white);
}

.login-form > :deep(.el-button:focus-visible) {
  outline: 2px solid var(--login-text);
  outline-offset: 3px;
}

.auth-feedback {
  margin-top: 1.25rem;
}

.auth-feedback:deep(.el-alert) {
  border: 1px solid color-mix(in srgb, var(--console-danger, #ff667a) 45%, transparent);
}

.auth-feedback:deep(.el-alert__title) {
  font-size: 0.8rem;
}

.auth-feedback:deep(.el-alert__description) {
  color: var(--login-text-muted);
  font-size: 0.75rem;
  line-height: 1.55;
}

@media (max-width: 860px) {
  .login-page.page {
    grid-template-columns: minmax(0, 1fr) minmax(20rem, 24rem);
    gap: clamp(2rem, 5vw, 4rem);
  }

  .product-intro__title {
    font-size: clamp(1.75rem, 4vw, 2.5rem);
  }

  .topology {
    height: 6rem;
  }
}

@media (max-width: 680px) {
  .login-page.page {
    min-height: 100svh;
    padding: 1.25rem;
    grid-template-columns: minmax(0, 1fr);
    align-content: center;
    gap: 2.25rem;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .login-page__backdrop {
    opacity: 0.34;
    background-size: 2rem 2rem;
    -webkit-mask-image: linear-gradient(#000, rgba(0, 0, 0, 0.35));
    mask-image: linear-gradient(#000, rgba(0, 0, 0, 0.35));
  }

  .product-brand__mark {
    width: 2.75rem;
    height: 2.75rem;
  }

  .product-intro__copy {
    margin-top: 2.25rem;
  }

  .product-intro__title {
    max-width: 14em;
    margin-top: 0.7rem;
    font-size: clamp(1.55rem, 7vw, 2.1rem);
  }

  .product-intro__description,
  .topology {
    display: none;
  }

  .login-card {
    padding: 1.5rem;
  }
}

@media (max-width: 380px) {
  .login-page.page {
    padding: 1rem;
  }

  .product-brand__eyebrow {
    letter-spacing: 0.1em;
  }

  .login-card {
    padding: 1.25rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .login-page *,
  .login-page *::before,
  .login-page *::after {
    scroll-behavior: auto !important;
    transition: none !important;
  }
}
</style>
