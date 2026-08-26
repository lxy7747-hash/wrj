interface LoopbackRequestLike {
  headers: {
    host?: string
    origin?: string
  }
  socket: {
    remoteAddress?: string
  }
}

export type LoopbackDecision =
  | { allowed: true; peerAddress: '127.0.0.1' }
  | { allowed: false; code: 'LOOPBACK_ONLY'; message: string }

export const VITE_ORIGIN = 'http://127.0.0.1:5173'

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

  if (req.headers.origin !== VITE_ORIGIN) {
    return {
      allowed: false,
      code: 'LOOPBACK_ONLY',
      message: 'The Origin header is not the allowed local Vite origin.',
    }
  }

  return { allowed: true, peerAddress }
}
