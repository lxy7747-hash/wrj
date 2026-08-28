import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'

const mapHost = '127.0.0.1'
const mapPort = 4174
const frontendRootUrl = new URL('../', import.meta.url)
const versaTilesPath = fileURLToPath(
  new URL('../_tools/versatiles/versatiles.exe', frontendRootUrl),
)
const probeTimeoutMs = 800
const startupTimeoutMs = 15_000
const startupPollIntervalMs = 250
const shutdownTimeoutMs = 2_000

type ProbeResult = 'available' | 'compatible' | 'occupied'

type TileJson = {
  name?: unknown
  minzoom?: unknown
  maxzoom?: unknown
  bounds?: unknown
  tile_format?: unknown
  tile_type?: unknown
}

type TileSource = {
  readonly id: string
  readonly pmtilesPath: string
  readonly expected: {
    readonly name: string
    readonly minzoom: number
    readonly maxzoom: number
    readonly bounds: readonly number[]
    readonly tileFormat?: string
    readonly tileType?: string
  }
}

const tileSources: readonly TileSource[] = [
  {
    id: 'china-taiwan-260823',
    pmtilesPath: fileURLToPath(
      new URL('./map/china-taiwan-260823.pmtiles', frontendRootUrl),
    ),
    expected: {
      name: 'Shortbread',
      minzoom: 0,
      maxzoom: 14,
      bounds: [71.61502, 7.197594, 135.677601, 54.011569],
    },
  },
  {
    id: 'taiwan-strait-satellite',
    pmtilesPath: fileURLToPath(
      new URL('./map/taiwan-strait-satellite.pmtiles', frontendRootUrl),
    ),
    expected: {
      name: 'VersaTiles - Satellite + Orthophotos',
      minzoom: 0,
      maxzoom: 12,
      bounds: [-0.043945, -66.530768, 157.543945, 66.530768],
      tileFormat: 'image/webp',
      tileType: 'raster',
    },
  },
]

type ManagedServer = ViteDevServer | PreviewServer

/**
 * 判断 TileJSON 是否与指定地图源的身份字段一致。
 * @param value 待校验的 TileJSON 数据。
 * @param source 提供预期身份字段的地图源描述。
 * @returns 所有身份字段精确匹配时返回 true。
 * @sideEffects 无副作用。
 */
function isExpectedTileJson(value: unknown, source: TileSource): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const tileJson = value as TileJson
  const { expected } = source
  return (
    tileJson.name === expected.name &&
    tileJson.minzoom === expected.minzoom &&
    tileJson.maxzoom === expected.maxzoom &&
    Array.isArray(tileJson.bounds) &&
    tileJson.bounds.length === expected.bounds.length &&
    tileJson.bounds.every((bound, index) => bound === expected.bounds[index]) &&
    (expected.tileFormat === undefined ||
      tileJson.tile_format === expected.tileFormat) &&
    (expected.tileType === undefined || tileJson.tile_type === expected.tileType)
  )
}

/**
 * 检查本机地图端口当前是否接受 TCP 连接。
 * @param timeoutMs 单次连接的最长等待时间。
 * @returns 端口可连接时返回 true，否则返回 false。
 * @sideEffects 短暂建立并立即销毁一个本机 TCP 连接。
 */
function isMapPortOpen(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: mapHost, port: mapPort })
    let settled = false

    const finish = (isOpen: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve(isOpen)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 探测全部固定 TileJSON 地址并区分空闲、兼容服务和未知占用。
 * @param timeoutMs 每个 HTTP 探测的最长等待时间。
 * @returns 地图端口与全部 TileJSON 的综合状态。
 * @sideEffects 并发发起本机 HTTP 请求，连接失败时补充一次 TCP 连接探测。
 */
async function probeMapService(timeoutMs: number): Promise<ProbeResult> {
  try {
    const matches = await Promise.all(
      tileSources.map(async (source) => {
        const response = await fetch(
          `http://${mapHost}:${mapPort}/tiles/${source.id}/tiles.json`,
          { signal: AbortSignal.timeout(timeoutMs) },
        )
        if (!response.ok) {
          return false
        }

        let tileJson: unknown
        try {
          tileJson = await response.json()
        } catch {
          return false
        }
        return isExpectedTileJson(tileJson, source)
      }),
    )
    return matches.every(Boolean) ? 'compatible' : 'occupied'
  } catch {
    return (await isMapPortOpen(timeoutMs)) ? 'occupied' : 'available'
  }
}

/**
 * 等待指定子进程退出，但不超过给定时限。
 * @param child 本插件启动的子进程。
 * @param timeoutMs 最长等待时间。
 * @returns 进程已退出时返回 true，超时时返回 false。
 * @sideEffects 临时注册并移除子进程退出监听器。
 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs)
    const onExit = (): void => finish(true)
    const finish = (didExit: boolean): void => {
      clearTimeout(timeout)
      child.off('exit', onExit)
      resolve(didExit)
    }

    child.once('exit', onExit)
  })
}

/**
 * 创建管理本机 VersaTiles 生命周期的 Vite 插件。
 * @returns 仅在开发或预览服务器期间启用的 Vite 插件。
 * @sideEffects 可能启动并回收 VersaTiles 子进程，也会探测本机 4174 端口。
 */
export function createVersaTilesPlugin(): Plugin {
  let ownedProcess: ChildProcess | undefined
  let startupPromise: Promise<void> | undefined

  /**
   * 关闭且仅关闭当前插件实例拥有的 VersaTiles 进程。
   * @returns 进程退出或有界等待结束后完成的 Promise。
   * @sideEffects 向本插件拥有的子进程发送终止信号。
   */
  async function stopOwnedProcess(): Promise<void> {
    const child = ownedProcess
    ownedProcess = undefined
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return
    }

    try {
      child.kill()
    } catch {
      return
    }

    if (await waitForExit(child, shutdownTimeoutMs)) {
      return
    }

    try {
      child.kill('SIGKILL')
    } catch {
      return
    }
    await waitForExit(child, shutdownTimeoutMs)
  }

  /**
   * 校验工具与全部地图文件均可访问。
   * @returns 工具和全部地图文件均可访问时完成的 Promise。
   * @sideEffects 读取文件系统元数据，不修改文件。
   */
  async function validateInputs(): Promise<void> {
    try {
      await access(versaTilesPath)
    } catch (error) {
      throw new Error(`VersaTiles 工具不可用：${versaTilesPath}`, { cause: error })
    }

    for (const source of tileSources) {
      try {
        await access(source.pmtilesPath)
      } catch (error) {
        throw new Error(`PMTiles 地图文件不可用：${source.pmtilesPath}`, {
          cause: error,
        })
      }
    }
  }

  /**
   * 启动单个 VersaTiles 进程并等待全部 TileJSON 通过校验。
   * @returns 地图服务就绪时完成的 Promise。
   * @sideEffects 启动一个承载全部地图源的自有子进程；失败时回收该进程。
   */
  async function startOwnedProcess(): Promise<void> {
    await validateInputs()

    const child = spawn(
      versaTilesPath,
      [
        'serve',
        '-i',
        mapHost,
        '-p',
        String(mapPort),
        ...tileSources.map((source) => source.pmtilesPath),
      ],
      {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    ownedProcess = child

    let processFailure: string | undefined
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000)
    })
    child.once('error', (error) => {
      processFailure = `VersaTiles 工具启动失败：${error.message}`
    })
    child.once('exit', (code, signal) => {
      processFailure ??= `VersaTiles 工具提前退出（退出码 ${String(code)}，信号 ${String(signal)}）`
    })

    const deadline = Date.now() + startupTimeoutMs
    try {
      while (Date.now() < deadline) {
        const state = await probeMapService(probeTimeoutMs)
        if (state === 'compatible') {
          return
        }
        if (state === 'occupied') {
          throw new Error(
            `地图端口 ${mapPort} 已被不匹配的服务占用，未启动第二个服务，也未终止未知进程。`,
          )
        }
        if (processFailure) {
          const details = stderr.trim()
          throw new Error(details ? `${processFailure}：${details}` : processFailure)
        }
        await delay(startupPollIntervalMs)
      }

      throw new Error(
        `VersaTiles 工具已启动，但全部地图文件未能在端口 ${mapPort} 上按时就绪。`,
      )
    } catch (error) {
      await stopOwnedProcess()
      throw error
    }
  }

  /**
   * 复用合法外部地图服务，或在端口空闲时启动自有服务。
   * @returns 地图服务可用时完成的共享 Promise。
   * @sideEffects 探测 4174 端口，必要时启动 VersaTiles 子进程。
   */
  function ensureMapService(): Promise<void> {
    if (!startupPromise) {
      startupPromise = (async () => {
        const state = await probeMapService(probeTimeoutMs)
        if (state === 'compatible') {
          return
        }
        if (state === 'occupied') {
          throw new Error(
            `地图端口 ${mapPort} 已被不匹配的服务占用，未启动第二个服务，也未终止未知进程。`,
          )
        }
        await startOwnedProcess()
      })().finally(() => {
        startupPromise = undefined
      })
    }
    return startupPromise
  }

  /**
   * 将地图进程回收绑定到 Vite 服务器的关闭与监听失败流程。
   * @param server 当前开发或预览服务器。
   * @returns 无返回值。
   * @sideEffects 包装服务器 close 方法，并在关闭或监听失败后回收自有子进程。
   */
  function bindServerClose(server: ManagedServer): void {
    const closeServer = server.close.bind(server)
    let closePromise: Promise<void> | undefined
    server.httpServer?.once('error', () => {
      void stopOwnedProcess()
    })
    server.close = () => {
      closePromise ??= closeServer().finally(stopOwnedProcess)
      return closePromise
    }
  }

  /**
   * 启动或复用地图服务，并将其生命周期绑定到 Vite 服务器。
   * @param server 当前开发或预览服务器。
   * @returns 地图服务就绪时完成的 Promise。
   * @sideEffects 可能启动地图进程，并包装服务器关闭方法。
   */
  async function configureServer(server: ManagedServer): Promise<void> {
    bindServerClose(server)
    await ensureMapService()
  }

  return {
    name: 'wrj-versatiles',
    apply: 'serve',
    configureServer,
    configurePreviewServer: configureServer,
  }
}
