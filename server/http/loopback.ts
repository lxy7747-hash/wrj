/**
 * 纯 IPv4 校验：生产运行时闭包禁止导入 node:net 等宿主模块。
 * 与 Node 的 net.isIPv4 保持同样的严格十进制点分四段规则，允许前导零由调用方自行拒绝。
 */
function isIPv4(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every(part => /^(?:0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255)
}

interface LoopbackRequestLike {
  method?: string
  headers: {
    host?: string
    origin?: string
  }
  socket: {
    remoteAddress?: string
  }
}

/** 发布入口只允许一个完整 origin；拒绝路径、凭据和模糊的主机匹配。 */
export function validatePublicOrigin(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || url.origin !== value.replace(/\/$/, '')) {
    throw new Error('WRJ_PUBLIC_ORIGIN 必须是完整的 HTTP(S) 地址，不能包含路径、凭据或查询参数。')
  }
  return url.origin
}

/** 同源 GET/HEAD 可以不带 Origin；写操作和 WebSocket 握手必须验证来源。 */
export function assertLanRequest(req: LoopbackRequestLike, publicOrigin: string, websocket = false):
  { allowed: true; origin?: string } | { allowed: false; code: 'LOOPBACK_ONLY'; message: string } {
  const deny = (message: string) => ({ allowed: false as const, code: 'LOOPBACK_ONLY' as const, message })
  if (req.headers.host !== new URL(publicOrigin).host) return deny('请求 Host 与部署入口不匹配。')
  const origin = req.headers.origin
  if (origin !== undefined && origin !== publicOrigin) return deny('请求来源不在允许范围内。')
  if (origin === undefined && (websocket || !['GET', 'HEAD'].includes(req.method ?? ''))) {
    return deny('此请求必须提供部署入口的 Origin。')
  }
  return { allowed: true, ...(origin ? { origin } : {}) }
}

export type LoopbackDecision =
  | { allowed: true; peerAddress: string; origin: string }
  | { allowed: false; code: 'LOOPBACK_ONLY'; message: string }

export const VITE_ORIGIN = 'http://127.0.0.1:5173'
const VITE_ORIGINS = new Set([VITE_ORIGIN, 'http://localhost:5173'])

/**
 * 页面、接口、地图分端口部署时的来源放行范围；仅由启动器读取 deployment.env 后经环境变量传入。
 * deployHost 为回环地址时只供本机访问，非回环地址才开放局域网对端。
 */
export interface DeploymentAccess {
  /** 浏览器访问的部署机 IPv4，不能是 0.0.0.0。 */
  deployHost: string
  /** 三个服务的监听地址；为 0.0.0.0 或与 deployHost 相同。 */
  listenHost: string
  uiPort: number
  apiPort: number
}

function isLoopbackIPv4(address: string | undefined): boolean {
  return address !== undefined && isIPv4(address) && address.startsWith('127.')
}

/**
 * 读取启动器传入的部署来源配置；三个变量均未设置时返回 undefined，保持原有仅本机行为。
 * @throws 部分设置或取值非法时拒绝启动，不静默回退。
 */
export function readDeploymentAccess(env: NodeJS.ProcessEnv, apiPort: number): DeploymentAccess | undefined {
  const keys = ['WRJ_DEPLOY_HOST', 'WRJ_LISTEN_HOST', 'WRJ_UI_PORT'] as const
  const values = keys.map(key => env[key]?.trim() ?? '')
  if (values.every(value => value === '')) return undefined
  const missing = keys.filter((_, index) => values[index] === '')
  if (missing.length > 0) throw new Error(`部署配置不完整：缺少 ${missing.join('、')}。`)
  const [deployHost, listenHost, uiPortText] = values as [string, string, string]
  if (!isIPv4(deployHost) || deployHost === '0.0.0.0') throw new Error('WRJ_DEPLOY_HOST 必须是部署机的 IPv4 地址，不能为 0.0.0.0。')
  if (!isIPv4(listenHost) || (listenHost !== '0.0.0.0' && listenHost !== deployHost)) {
    throw new Error('WRJ_LISTEN_HOST 必须为 0.0.0.0 或与 WRJ_DEPLOY_HOST 相同的 IPv4 地址。')
  }
  const uiPort = /^[0-9]{1,5}$/.test(uiPortText) ? Number(uiPortText) : Number.NaN
  if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65_535) throw new Error('WRJ_UI_PORT 必须为 1–65535 的整数。')
  if (uiPort === apiPort) throw new Error('页面端口与接口端口不能相同。')
  return { deployHost, listenHost, uiPort, apiPort }
}

function normalizePeerAddress(address: string | undefined): string | undefined {
  if (address === '::ffff:127.0.0.1') {
    return '127.0.0.1'
  }

  return address
}

function isCanonicalLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) {
    return false
  }

  const match = /^127\.0\.0\.1(?::([0-9]{1,5}))?$/.exec(host)
  if (match === null || match[1] === undefined) {
    return match !== null
  }

  const port = Number(match[1])
  return port >= 1 && port <= 65_535
}

export function assertLoopbackRequest(req: LoopbackRequestLike, access?: DeploymentAccess): LoopbackDecision {
  // Node can expose an IPv4 peer through an IPv6-mapped address; no name lookup is needed.
  const peerAddress = normalizePeerAddress(req.socket.remoteAddress)
  // 配置的部署入口：Origin 与 Host 必须同时精确匹配页面端口和接口端口，不读取任何代理头。
  if (access && req.headers.origin === `http://${access.deployHost}:${access.uiPort}`
    && req.headers.host === `${access.deployHost}:${access.apiPort}`) {
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/, '')
    // 回环部署地址仅用于本机；局域网对端范围由 Windows 防火墙 LocalSubnet 规则限定。
    if (isLoopbackIPv4(access.deployHost) && !isLoopbackIPv4(peer)) {
      return { allowed: false, code: 'LOOPBACK_ONLY', message: 'The request peer is not a loopback address.' }
    }
    return { allowed: true, peerAddress: peer ?? '', origin: req.headers.origin }
  }
  if (peerAddress !== '127.0.0.1') {
    return {
      allowed: false,
      code: 'LOOPBACK_ONLY',
      message: 'The request peer is not 127.0.0.1.',
    }
  }

  if (!isCanonicalLoopbackHost(req.headers.host)) {
    return {
      allowed: false,
      code: 'LOOPBACK_ONLY',
      message: 'The Host header is not the canonical loopback host.',
    }
  }

  const origin = req.headers.origin
  const localOrigins = access ? new Set([`http://127.0.0.1:${access.uiPort}`, `http://localhost:${access.uiPort}`]) : VITE_ORIGINS
  if (origin === undefined || !localOrigins.has(origin)) {
    return {
      allowed: false,
      code: 'LOOPBACK_ONLY',
      message: 'The Origin header is not the allowed local Vite origin.',
    }
  }

  return { allowed: true, peerAddress, origin }
}
