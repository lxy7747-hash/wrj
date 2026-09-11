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

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
provideGlobalConfig({ locale: zhCn }, app, true)
const auth = useAuthStore(pinia)
onSessionExpired(() => {
  auth.resetToSafeEmpty()
  void router.replace('/login')
})
void auth.restoreSession().finally(() => {
  app.use(router)
  app.mount('#app')
})
