import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import type L from 'leaflet'
import { MAP_CONFIG } from '../../config/map.config'

const MAX_TILES = 64
const MAX_BYTES = 16 * 1024 * 1024
const aborted = () => new DOMException('瓦片读取已取消', 'AbortError')

/** 地图实例内共享已解析瓦片；限 64 块及 16 MiB 原始数据，不跨地图资源版本复用。 */
export function createVectorTileSource() {
  type Entry = { controller: AbortController; pending: Promise<VectorTile>; users: number; settled: boolean; bytes: number }
  const entries = new Map<string, Entry>()
  let totalBytes = 0
  const remove = (key: string, entry: Entry) => {
    if (entries.get(key) !== entry) return
    entries.delete(key)
    totalBytes -= entry.bytes
  }
  const trim = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= MAX_TILES && totalBytes <= MAX_BYTES) break
      if (entry.settled) remove(key, entry)
    }
  }
  return {
    load(coords: L.Coords, signal?: AbortSignal): Promise<VectorTile> {
      if (signal?.aborted) return Promise.reject(aborted())
      const key = MAP_CONFIG.resources.vector.tileUrl.replace('{z}', String(coords.z)).replace('{x}', String(coords.x)).replace('{y}', String(coords.y))
      let entry = entries.get(key)
      if (!entry) {
        const controller = new AbortController()
        const created: Entry = { controller, users: 0, settled: false, bytes: 0, pending: undefined! }
        entries.set(key, created)
        created.pending = (async () => {
          try {
            const response = await fetch(key, { signal: controller.signal })
            if (!response.ok) throw new Error('矢量瓦片读取失败')
            const bytes = await response.arrayBuffer()
            if (controller.signal.aborted) throw aborted()
            const tile = new VectorTile(new PbfReader(bytes))
            created.settled = true
            if (entries.get(key) === created) {
              created.bytes = bytes.byteLength
              totalBytes += created.bytes
              trim()
            }
            return tile
          } catch (error) { remove(key, created); throw error }
        })()
        entry = created
      } else {
        entries.delete(key)
        entries.set(key, entry)
      }
      const current = entry
      current.users++
      return new Promise((resolve, reject) => {
        let finished = false
        const finish = () => {
          finished = true
          signal?.removeEventListener('abort', cancel)
          if (--current.users === 0 && !current.settled) {
            remove(key, current)
            current.controller.abort()
          }
        }
        const cancel = () => { if (!finished) { finish(); reject(aborted()) } }
        signal?.addEventListener('abort', cancel, { once: true })
        current.pending.then(tile => {
          if (!finished) { finish(); resolve(tile) }
        }, error => {
          if (!finished) { finish(); reject(error) }
        })
      })
    },
    clear(): void {
      for (const entry of entries.values()) entry.controller.abort()
      entries.clear()
      totalBytes = 0
    },
  }
}

export type VectorTileSource = ReturnType<typeof createVectorTileSource>

/** 适配项目锁定的 VectorGrid 1.3.0；不改依赖源码，也不修改供标签层共享的原始要素。 */
export function bindVectorTileSource(layer: L.Layer, source: VectorTileSource): void {
  const pending = new Map<string, AbortController>()
  const keyFor = (coords: L.Coords) => `${coords.z}/${coords.x}/${coords.y}`
  Object.assign(layer, {
    async _getVectorTilePromise(coords: L.Coords) {
      const key = keyFor(coords)
      pending.get(key)?.abort()
      const controller = new AbortController()
      pending.set(key, controller)
      try {
        const tile = await source.load(coords, controller.signal)
        return { layers: Object.fromEntries(Object.entries(tile.layers).map(([name, data]) => [name, {
          extent: data.extent,
          features: Array.from({ length: data.length }, (_, index) => {
            const feature = data.feature(index)
            return { type: feature.type, properties: feature.properties, id: feature.id, geometry: feature.loadGeometry() }
          }),
        }])) }
      } catch { return { layers: {} } }
      finally { if (pending.get(key) === controller) pending.delete(key) }
    },
  })
  layer.on('tileunload', event => {
    const coords = (event as L.TileEvent).coords
    if (coords) pending.get(keyFor(coords))?.abort()
  })
  layer.on('remove', () => { pending.forEach(controller => controller.abort()); pending.clear() })
}
