import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { provideGlobalConfig } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'
import './styles/console-theme.css'
import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'
import { onSessionExpired } from './features/shared/api-fetch'
import { loadRuntimeEndpoints, requiresRuntimeEndpoints } from './config/runtime-endpoints'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
provideGlobalConfig({ locale: zhCn }, app, true)
const auth = useAuthStore(pinia)
onSessionExpired(() => {
  auth.resetToSafeEmpty()
  void router.replace('/login')
})
/** 运行配置不可用时只显示明确提示，不创建请求客户端或实时连接。 */
function showRuntimeConfigFailure(error: unknown): void {
  const root = document.getElementById('app')
  if (!root) return
  const panel = document.createElement('div')
  panel.setAttribute('role', 'alert')
  panel.style.cssText = 'max-width:560px;margin:15vh auto;padding:24px;font:14px/1.7 system-ui,sans-serif;color:#b42318;background:#fff;border:1px solid #fda29b;border-radius:8px'
  const title = document.createElement('strong')
  title.textContent = '运行配置加载失败，系统未连接任何服务。'
  const detail = document.createElement('p')
  detail.textContent = `${error instanceof Error ? error.message : String(error)} 请确认部署服务已通过 start.cmd 正常启动后刷新页面。`
  panel.append(title, detail)
  root.replaceChildren(panel)
}

async function bootstrap(): Promise<void> {
  if (requiresRuntimeEndpoints()) {
    try { await loadRuntimeEndpoints() } catch (error) { showRuntimeConfigFailure(error); return }
  }
  await auth.restoreSession().catch(() => undefined)
  app.use(router)
  app.mount('#app')
}

void bootstrap()
