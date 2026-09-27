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
  | { allowed: true; peerAddress: '127.0.0.1'; origin: string }
  | { allowed: false; code: 'LOOPBACK_ONLY'; message: string }

export const VITE_ORIGIN = 'http://127.0.0.1:5173'
const VITE_ORIGINS = new Set([VITE_ORIGIN, 'http://localhost:5173'])

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

export function assertLoopbackRequest(req: LoopbackRequestLike): LoopbackDecision {
  // Node can expose an IPv4 peer through an IPv6-mapped address; no name lookup is needed.
  const peerAddress = normalizePeerAddress(req.socket.remoteAddress)
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
  if (origin === undefined || !VITE_ORIGINS.has(origin)) {
    return {
      allowed: false,
      code: 'LOOPBACK_ONLY',
      message: 'The Origin header is not the allowed local Vite origin.',
    }
  }

  return { allowed: true, peerAddress, origin }
}
