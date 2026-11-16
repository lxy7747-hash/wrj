/**
 * 生产页面的运行时服务端口：由离线包启动器按 deployment.env 生成 /runtime-config.json，
 * 主机名始终取自当前页面地址，因此更换部署机 IP 只需修改配置并重启，不重新构建。
 */
export interface RuntimeEndpoints {
  apiPort: number
  mapPort: number
}

/** 配置请求含响应体读取的总时限。 */
export const RUNTIME_CONFIG_TIMEOUT_MS = 5000
const MAX_CONFIG_BYTES = 1024

let current: RuntimeEndpoints | undefined

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

/** 严格校验：只接受 apiPort、mapPort 两个互不相同的端口字段。 */
export function parseRuntimeEndpoints(value: unknown): RuntimeEndpoints {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('运行配置格式不正确。')
  const keys = Object.keys(value).sort()
  const { apiPort, mapPort } = value as Record<string, unknown>
  if (keys.length !== 2 || keys[0] !== 'apiPort' || keys[1] !== 'mapPort' || !isPort(apiPort) || !isPort(mapPort) || apiPort === mapPort) {
    throw new Error('运行配置只能包含两个互不相同的有效端口 apiPort、mapPort。')
  }
  return { apiPort, mapPort }
}

/**
 * 读取页面同源的 /runtime-config.json；禁用缓存，请求与响应体读取共用一个有界时限。
 * @throws 超时、非 200、非 JSON 或字段不合法时抛出，调用方不得回退到旧地址。
 */
export async function loadRuntimeEndpoints(fetchImpl: typeof fetch = fetch, timeoutMs = RUNTIME_CONFIG_TIMEOUT_MS): Promise<RuntimeEndpoints> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl('/runtime-config.json', { cache: 'no-store', credentials: 'omit', signal: controller.signal })
    if (!response.ok) throw new Error(`运行配置请求失败（HTTP ${response.status}）。`)
    const text = await response.text()
    if (text.length > MAX_CONFIG_BYTES) throw new Error('运行配置内容过大。')
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new Error('运行配置不是有效的 JSON。') }
    current = parseRuntimeEndpoints(value)
    return current
  } catch (error) {
    if (controller.signal.aborted) throw new Error('运行配置读取超时。')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** 已加载的运行时端口；开发与测试入口不加载，继续使用原有本机地址。 */
export function runtimeEndpoints(): RuntimeEndpoints | undefined {
  return current
}

/** 仅供测试设置或清除运行时端口。 */
export function setRuntimeEndpoints(value: RuntimeEndpoints | undefined): void {
  current = value === undefined ? undefined : parseRuntimeEndpoints(value)
}

/** 由当前页面协议与主机名组合服务地址；HTTPS 页面对应 HTTPS 服务。 */
export function serviceOrigin(port: number, location: Pick<Location, 'protocol' | 'hostname'> = window.location): string {
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:'
  return new URL(`${protocol}//${location.hostname}:${port}`).origin
}

/** 生产入口（非单入口内网包）必须先加载运行配置，未加载时拒绝回退到旧端口。 */
export function requiresRuntimeEndpoints(): boolean {
  return import.meta.env.PROD && import.meta.env.MODE !== 'lan'
}
