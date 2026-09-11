let onExpired: (() => void) | undefined
let sessionEpoch = 0
export function invalidateSessionRequests(): void { sessionEpoch += 1 }
export function onSessionExpired(handler: () => void): void { onExpired = handler }

/** 仅业务 API 使用此入口；地图瓦片不携带认证凭据。 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const epoch = sessionEpoch
  const response = await fetch(input, { ...init, credentials: 'include' })
  if (epoch === sessionEpoch && response.status === 401 && !input.endsWith('/auth/login') && !input.endsWith('/auth/session')) onExpired?.()
  return response
}
