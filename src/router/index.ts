import type { Pinia } from 'pinia'
import {
  createRouter,
  createWebHistory,
  type NavigationGuardReturn,
  type RouterHistory,
  type RouteLocationNormalized,
  type RouteRecordRaw,
} from 'vue-router'
import LoginPage from '../pages/login/login.vue'
import { useAuthStore } from '../stores/auth'
import { useUiStore } from '../stores/ui'
import { canVisitMenu } from '../features/admin/access-control'

declare module 'vue-router' {
  interface RouteMeta {
    title: string
    guard: 'public' | 'principal' | 'admin'
    layout?: 'standalone' | 'workspace'
  }
}

type RouteGuard = (
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
) => NavigationGuardReturn

/**
 * 解析路由决策使用的身份验证 Store。
 * @param pinia 路由单元测试和应用启动时可选用的 Pinia 实例。
 * @returns 与传入实例或当前活动实例关联的身份验证 Store。
 * @remarks 只读取 Store，不执行导航，也不修改身份验证状态。
 */
function authFor(pinia?: Pinia) {
  return useAuthStore(pinia)
}

/**
 * 允许已登录主体进入受保护路由，并将匿名用户重定向到登录页。
 * @returns 已登录时返回 `true`，否则返回指向 `/login` 的重定向。
 * @remarks 可能改变本次导航目标，但不修改身份验证状态。
 */
export const requirePrincipal: RouteGuard = () => {
  return authFor().principal === null ? { path: '/login' } : true
}

/**
 * 允许管理员进入管理路由，并安全重定向其他身份。
 * @returns 管理员返回 `true`，匿名用户重定向到 `/login`，非管理员重定向到 `/blueprint`。
 * @remarks 已登录但被拒绝时，会先在身份验证 Store 中记录 `USER_ROLE_MAINTAIN` 授权决策，
 * 然后改变本次导航目标。
 */
export const requireAdmin: RouteGuard = () => {
  const auth = authFor()
  if (auth.principal === null) return { path: '/login' }
  if (auth.role === 'ADMIN') return true

  auth.authorize('USER_ROLE_MAINTAIN')
  return { path: '/blueprint' }
}

export const routeRecords: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: LoginPage,
    meta: { title: '登录', guard: 'public', layout: 'standalone' },
  },
  {
    path: '/situation',
    name: 'situation',
    component: () => import('../pages/situation/situation.vue'),
    beforeEnter: requirePrincipal,
    meta: { title: '态势展示', guard: 'principal', layout: 'workspace' },
  },
  {
    path: '/scenarios',
    name: 'scenarios',
    component: () => import('../pages/scenarios/ScenarioWorkspace.vue'),
    beforeEnter: requirePrincipal,
    meta: { title: '场景管理', guard: 'principal', layout: 'workspace' },
  },
  {
    path: '/batches',
    name: 'batches',
    component: () => import('../pages/batches/batches.vue'),
    beforeEnter: requirePrincipal,
    meta: { title: '批量仿真', guard: 'principal', layout: 'workspace' },
  },
  {
    path: '/reports',
    name: 'reports',
    component: () => import('../pages/reports/reports.vue'),
    beforeEnter: requirePrincipal,
    meta: { title: '评估报表', guard: 'principal', layout: 'workspace' },
  },
  {
    path: '/replays',
    name: 'replays',
    component: () => import('../pages/replays/replays.vue'),
    beforeEnter: requirePrincipal,
    meta: { title: '历史回放', guard: 'principal', layout: 'workspace' },
  },
  {
    path: '/admin',
    name: 'admin',
    component: () => import('../pages/admin/admin.vue'),
    beforeEnter: requireAdmin,
    meta: { title: '用户与角色', guard: 'admin', layout: 'workspace' },
  },
  {
    path: '/blueprint',
    name: 'blueprint',
    component: () => import('../pages/blueprint/blueprint.vue'),
    beforeEnter: requirePrincipal,
    meta: { title: '能力蓝图', guard: 'principal', layout: 'workspace' },
  },
  {
    path: '/admin/data-exchange',
    name: 'admin-data-exchange',
    component: () => import('../pages/admin-data-exchange/admin-data-exchange.vue'),
    beforeEnter: requirePrincipal,
    // 冻结的路由合同规定，此概念性管理子页也向操作员开放。
    meta: { title: '数据交换与接口', guard: 'principal', layout: 'workspace' },
  },
  {
    path: '/traceability',
    name: 'traceability',
    component: () => import('../pages/traceability/traceability.vue'),
    beforeEnter: requirePrincipal,
    meta: { title: '需求追踪', guard: 'principal', layout: 'workspace' },
  },
  {
    path: '/interactions',
    name: 'interactions',
    component: () => import('../pages/interactions/interactions.vue'),
    beforeEnter: requirePrincipal,
    meta: { title: '感知、干扰与选路', guard: 'principal', layout: 'workspace' },
  },
]

/**
 * 使用冻结的命名路由和身份验证策略创建应用路由器。
 * @param history 路由历史实现，默认使用浏览器历史。
 * @param pinia 用于确定性守卫求值的可选显式 Pinia 实例。
 * @returns 配置完成的 Vue Router 实例。
 * @remarks 创建路由器本身不会导航；后续导航可能重定向匿名或未授权用户，也可能在身份验证
 * Store 中记录授权拒绝。
 */
export function createAppRouter(history: RouterHistory = createWebHistory(), pinia?: Pinia) {
  const router = createRouter({
    history,
    routes: [
      ...routeRecords,
      // 未匹配路径（包括“/”）直接重定向到登录页且不新增命名路由，以保留冻结的 11 条路由合同并避免警告。
      { path: '/:pathMatch(.*)*', redirect: '/login' },
    ],
  })

  router.beforeEach((to) => {
    // 重置期间不切换业务页面，避免新页面加载与全局投影重建交叉；退出登录仍可达。
    if (useUiStore(pinia).resetState === 'EXECUTING' && to.path !== '/login') return false
    const principal = authFor(pinia).principal
    if (to.path !== '/login' && principal?.menuPaths) {
      const menuPath = to.path === '/admin' && typeof to.query.section === 'string' ? `/admin?section=${to.query.section}` : to.path
      if (!canVisitMenu(principal, menuPath)) {
        authFor(pinia).lastCode = 'PERMISSION_DENIED'
        authFor(pinia).lastMessage = '当前角色没有此菜单的访问权限。'
        return principal.menuPaths[0] ?? '/login'
      }
    }
    // 显式注入 Pinia，使路由单元测试不依赖应用插件的安装顺序。
    if (pinia !== undefined) {
      const auth = authFor(pinia)
      if (to.meta.guard === 'principal' && auth.principal === null) return { path: '/login' }
      if (to.meta.guard === 'admin') {
        if (auth.principal === null) return { path: '/login' }
        if (auth.role !== 'ADMIN') {
          auth.authorize('USER_ROLE_MAINTAIN')
          return { path: '/blueprint' }
        }
      }
    }

    return true
  })

  return router
}

const router = createAppRouter()

export default router
