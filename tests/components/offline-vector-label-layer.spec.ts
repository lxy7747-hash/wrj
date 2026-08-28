import L from 'leaflet'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakePoint {
  x: number
  y: number
}

interface FakeFeature {
  properties: Record<string, string | number | boolean>
  type: 1 | 2 | 3
  loadGeometry: ReturnType<typeof vi.fn<() => FakePoint[][]>>
}

interface FakeLayer {
  extent: number
  length: number
  feature: (index: number) => FakeFeature
}

interface FakeTile {
  layers: Record<string, FakeLayer>
}

const parserState = vi.hoisted(() => ({
  tile: { layers: {} } as FakeTile,
  throwOnParse: false,
  vectorTileCalls: 0,
  pbfCalls: 0,
}))

vi.mock('@mapbox/vector-tile', () => ({
  VectorTile: class {
    constructor() {
      parserState.vectorTileCalls += 1
      if (parserState.throwOnParse) throw new Error('损坏的 MVT')
      return parserState.tile
    }
  },
}))

vi.mock('pbf', () => ({
  PbfReader: class {
    constructor() {
      parserState.pbfCalls += 1
    }
  },
}))

import { createOfflineVectorLabelLayer } from '../../src/components/situation/offline-vector-label-layer'
import { MAP_CONFIG } from '../../src/config/map.config'

type PublicGridLayer = ReturnType<typeof createOfflineVectorLabelLayer> & {
  createTile: (coords: L.Coords, done: L.DoneCallback) => HTMLElement
}

interface CanvasContextMock {
  clearRect: ReturnType<typeof vi.fn>
  fillText: ReturnType<typeof vi.fn>
  lineJoin: CanvasLineJoin
  lineWidth: number
  measureText: ReturnType<typeof vi.fn<(text: string) => TextMetrics>>
  restore: ReturnType<typeof vi.fn>
  rotate: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  setTransform: ReturnType<typeof vi.fn>
  strokeText: ReturnType<typeof vi.fn>
  translate: ReturnType<typeof vi.fn>
  fillStyle: string
  font: string
  strokeStyle: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
}

describe('离线矢量文字瓦片层', () => {
  let context: CanvasContextMock
  let getContextSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    parserState.tile = { layers: {} }
    parserState.throwOnParse = false
    parserState.vectorTileCalls = 0
    parserState.pbfCalls = 0
    context = createContextMock()
    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(1),
    })))
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
  })

  afterEach(() => {
    getContextSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('固定使用唯一 loopback 地址且 Z0–2 返回空瓦片不请求网络', async () => {
    expect(MAP_CONFIG.resources.vector.tileUrl).toBe(
      'http://127.0.0.1:4174/tiles/china-taiwan-260823/{z}/{x}/{y}',
    )
    const layer = createOfflineVectorLabelLayer() as PublicGridLayer
    const done = vi.fn()

    const canvas = layer.createTile(coords(2), done) as HTMLCanvasElement

    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(fetch).not.toHaveBeenCalled()
    expect(done).toHaveBeenCalledOnce()
    expect(done).toHaveBeenCalledWith(undefined, canvas)
    expect(layer.options.pane).toBe('offline-label-pane')
    const layerOptions = layer.options as L.GridLayerOptions
    expect(layerOptions.minZoom).toBe(MAP_CONFIG.zoom.min)
    expect(layerOptions.maxZoom).toBe(MAP_CONFIG.zoom.max)
    expect(canvas.classList.contains('offline-vector-label-tile')).toBe(true)
    expect(canvas.style.pointerEvents).toBe('none')
    expect(canvas.style.width).toBe('384px')
    expect(canvas.style.marginLeft).toBe('-64px')
  })

  it('无参创建默认使用现有浅色标签调色板', async () => {
    parserState.tile = tileWith({
      boundary_labels: [pointFeature({ name: '浅色标签', admin_level: 4 }, 2000, 2000)],
    })

    await renderTile(7)

    expect(context.fillStyle).toBe('#243746')
    expect(context.strokeStyle).toBe('#f7fbfd')
  })

  it('切换深色主题仅重绘一次，新瓦片使用现有浅蓝色水系配色', async () => {
    parserState.tile = tileWith({
      water_lines_labels: [lineFeature(
        { name: '深色水系', kind: 'river' },
        [[500, 2000], [3500, 2000]],
      )],
    })
    const layer = createOfflineVectorLabelLayer() as PublicGridLayer
    const redrawSpy = vi.spyOn(layer, 'redraw')

    layer.setTheme('dark')

    expect(redrawSpy).toHaveBeenCalledOnce()
    const done = vi.fn()
    layer.createTile(coords(12), done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(context.fillStyle).toBe('#69bce8')
    expect(context.strokeStyle).toBe('#06111d')

    redrawSpy.mockClear()
    layer.setTheme('dark')
    expect(redrawSpy).not.toHaveBeenCalled()
  })

  it('可只更新主题状态而不重绘，后续瓦片仍使用新调色板', async () => {
    parserState.tile = tileWith({
      boundary_labels: [pointFeature({ name: '延迟深色标签', admin_level: 4 }, 2000, 2000)],
    })
    const layer = createOfflineVectorLabelLayer() as PublicGridLayer
    const redrawSpy = vi.spyOn(layer, 'redraw')

    layer.setTheme('dark', false)

    expect(redrawSpy).not.toHaveBeenCalled()
    const done = vi.fn()
    layer.createTile(coords(7), done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(context.fillStyle).toBe('#d7e8f3')
    expect(context.strokeStyle).toBe('#06111d')
  })

  it('中文名优先于英文名和编号，并对无效字段逐级回退', async () => {
    parserState.tile = tileWith({
      boundary_labels: [
        pointFeature({ name: '  臺灣  ', name_en: 'Taiwan', admin_level: 4 }, 500, 500),
        pointFeature({ name: '   ', name_en: 'English', admin_level: 5 }, 2000, 500),
        pointFeature({ name: 42, name_en: ' ', ref: ' A1 ', admin_level: 6 }, 3500, 500),
        pointFeature({ name: '字'.repeat(81), name_en: 'Fallback', admin_level: 7 }, 500, 2000),
      ],
    })

    await renderTile(7)

    expect(drawnTexts()).toEqual(['臺灣', 'English', 'A1', 'Fallback'])
    expect(context.font).toContain('"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif')
  })

  it('在读取几何前按 zoom、layer 和 kind 白名单过滤', async () => {
    const city = pointFeature({ name: '城市', kind: 'city', population: 100 }, 500, 500)
    const town = pointFeature({ name: '城镇', kind: 'town', population: 200 }, 1500, 500)
    const unknown = pointFeature({ name: '未知', kind: 'megacity', population: 999 }, 2500, 500)
    const road = lineFeature({ name: '主路', kind: 'primary' }, [[100, 3000], [3900, 3000]])
    parserState.tile = tileWith({ place_labels: [city, town, unknown], street_labels: [road] })

    await renderTile(6)

    expect(drawnTexts()).toEqual(['城市'])
    expect(city.loadGeometry).toHaveBeenCalledOnce()
    expect(town.loadGeometry).not.toHaveBeenCalled()
    expect(unknown.loadGeometry).not.toHaveBeenCalled()
    expect(road.loadGeometry).not.toHaveBeenCalled()
  })

  it('先按行政级别排序并执行 Z3–5 的 12 条密度上限', async () => {
    context.measureText.mockImplementation((text: string) => ({ width: text.length * 2 }) as TextMetrics)
    const features = Array.from({ length: 13 }, (_, index) => pointFeature(
      { name: String.fromCharCode(65 + index), admin_level: 13 - index },
      200 + index % 7 * 600,
      200 + Math.floor(index / 7) * 1800,
    ))
    parserState.tile = tileWith({ boundary_labels: features })

    await renderTile(3)

    expect(drawnTexts()).toHaveLength(12)
    expect(drawnTexts()[0]).toBe('M')
    expect(drawnTexts()).not.toContain('A')
  })

  it('按人口排序地点，并处理碰撞、跨行政地点去重和同名最长道路', async () => {
    const shortRoad = lineFeature({ name: '同名路', kind: 'primary' }, [[100, 3000], [900, 3000]])
    const longRoad = lineFeature({ name: '同名路', kind: 'primary' }, [[100, 3300], [3900, 3300]])
    parserState.tile = tileWith({
      boundary_labels: [pointFeature({ name: '重名', admin_level: 4 }, 500, 500)],
      place_labels: [
        pointFeature({ name: '重名', kind: 'city', population: 5000 }, 1500, 500),
        pointFeature({ name: '人口少', kind: 'town', population: 10 }, 2500, 500),
        pointFeature({ name: '人口多', kind: 'town', population: 1000 }, 3500, 500),
        pointFeature({ name: '碰撞项', kind: 'town', population: 1 }, 3500, 500),
      ],
      street_labels: [shortRoad, longRoad],
    })

    await renderTile(14)

    expect(drawnTexts().filter((text) => text === '重名')).toHaveLength(1)
    expect(drawnTexts().indexOf('人口多')).toBeLessThan(drawnTexts().indexOf('人口少'))
    expect(drawnTexts()).not.toContain('碰撞项')
    expect(drawnTexts().filter((text) => text === '同名路')).toHaveLength(1)
    expect(context.translate).toHaveBeenCalledWith(expect.any(Number), 3300 / 4096 * 256 + 64)
  })

  it('使用最长折线累计中点并把倒置切线规范成正向角', async () => {
    parserState.tile = tileWith({
      street_labels: [lineFeature(
        { name: '斜向主路', kind: 'primary' },
        [[3500, 3000], [500, 1000]],
      )],
    })

    await renderTile(12)

    expect(drawnTexts()).toEqual(['斜向主路'])
    expect(context.translate).toHaveBeenCalledWith(2000 / 4096 * 256 + 64, 2000 / 4096 * 256 + 64)
    const angle = context.rotate.mock.calls[0]?.[0] as number
    expect(angle).toBeGreaterThan(0)
    expect(angle).toBeLessThanOrEqual(Math.PI / 2)
  })

  it('将 HiDPI backing store 限制为 2 倍并保留 256 像素核心区', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 })
    const layer = createOfflineVectorLabelLayer() as PublicGridLayer

    const canvas = layer.createTile(coords(1), vi.fn()) as HTMLCanvasElement

    expect(canvas.width).toBe(768)
    expect(canvas.height).toBe(768)
    expect(canvas.style.width).toBe('384px')
  })

  it.each(['非 2xx', '解析失败'] as const)('%s 时只完成透明空瓦片且 done 一次', async (failure) => {
    if (failure === '非 2xx') {
      vi.mocked(fetch).mockResolvedValue({ ok: false } as Response)
    } else {
      parserState.throwOnParse = true
    }

    const { done } = await renderTile(7)

    expect(done).toHaveBeenCalledOnce()
    expect(context.fillText).not.toHaveBeenCalled()
  })

  it('Canvas 不可用时不请求网络并完成空瓦片', async () => {
    getContextSpy.mockReturnValue(null)
    const layer = createOfflineVectorLabelLayer() as PublicGridLayer
    const done = vi.fn()

    layer.createTile(coords(7), done)

    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tileunload 和图层 remove 分别取消独立请求且每瓦片只完成一次', async () => {
    const pending: Array<{ signal: AbortSignal; reject: (error: Error) => void }> = []
    vi.mocked(fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal
      pending.push({ signal, reject })
      signal.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true })
    }))
    const layer = createOfflineVectorLabelLayer() as PublicGridLayer
    const firstDone = vi.fn()
    const secondDone = vi.fn()
    const first = layer.createTile(coords(7, 1), firstDone)
    layer.createTile(coords(7, 2), secondDone)

    layer.fire('tileunload', { tile: first })
    await vi.waitFor(() => expect(firstDone).toHaveBeenCalledOnce())
    expect(pending[0]?.signal.aborted).toBe(true)
    expect(pending[1]?.signal.aborted).toBe(false)

    layer.fire('remove')
    await vi.waitFor(() => expect(secondDone).toHaveBeenCalledOnce())
    expect(pending[1]?.signal.aborted).toBe(true)
    expect(firstDone).toHaveBeenCalledOnce()
    expect(secondDone).toHaveBeenCalledOnce()
  })

  /**
   * 创建包含指定标签图层的伪 MVT。
   * @param layers 图层名到要素列表的映射。
   * @returns 使用独立 4096 extent 的伪瓦片。
   * @sideeffect 无副作用。
   */
  function tileWith(layers: Record<string, FakeFeature[]>): FakeTile {
    return {
      layers: Object.fromEntries(Object.entries(layers).map(([name, features]) => [
        name,
        { extent: 4096, length: features.length, feature: (index: number) => features[index] },
      ])),
    }
  }

  /**
   * 创建点标签要素。
   * @param properties 要素属性。
   * @param x extent 横坐标。
   * @param y extent 纵坐标。
   * @returns 可追踪几何加载次数的点要素。
   * @sideeffect 创建 Vitest mock。
   */
  function pointFeature(
    properties: FakeFeature['properties'],
    x: number,
    y: number,
  ): FakeFeature {
    return { properties, type: 1, loadGeometry: vi.fn(() => [[{ x, y }]]) }
  }

  /**
   * 创建线标签要素。
   * @param properties 要素属性。
   * @param points 单条折线的 extent 坐标数组。
   * @returns 可追踪几何加载次数的线要素。
   * @sideeffect 创建 Vitest mock。
   */
  function lineFeature(
    properties: FakeFeature['properties'],
    points: Array<[number, number]>,
  ): FakeFeature {
    return {
      properties,
      type: 2,
      loadGeometry: vi.fn(() => [points.map(([x, y]) => ({ x, y }))]),
    }
  }

  /**
   * 创建可记录 Canvas 调用的最小二维上下文。
   * @returns 满足标签绘制路径的上下文 mock。
   * @sideeffect 创建 Vitest mock。
   */
  function createContextMock(): CanvasContextMock {
    return {
      clearRect: vi.fn(),
      fillText: vi.fn(),
      lineJoin: 'round',
      lineWidth: 1,
      measureText: vi.fn((text: string) => ({ width: text.length * 10 }) as TextMetrics),
      restore: vi.fn(),
      rotate: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn(),
      strokeText: vi.fn(),
      translate: vi.fn(),
      fillStyle: '',
      font: '',
      strokeStyle: '',
      textAlign: 'start',
      textBaseline: 'alphabetic',
    }
  }

  /**
   * 创建 Leaflet 瓦片坐标。
   * @param zoom 缩放级别。
   * @param x 横向瓦片编号。
   * @returns 测试用坐标对象。
   * @sideeffect 无副作用。
   */
  function coords(zoom: number, x = 0): L.Coords {
    return { x, y: 0, z: zoom } as L.Coords
  }

  /**
   * 创建并等待一个标签瓦片完成。
   * @param zoom 缩放级别。
   * @returns 返回层、画布与完成回调，便于继续断言。
   * @sideeffect 触发一次已 mock 的 fetch 和 MVT 解析。
   */
  async function renderTile(zoom: number): Promise<{
    layer: L.GridLayer
    canvas: HTMLCanvasElement
    done: ReturnType<typeof vi.fn>
  }> {
    const layer = createOfflineVectorLabelLayer() as PublicGridLayer
    const done = vi.fn()
    const canvas = layer.createTile(coords(zoom), done) as HTMLCanvasElement
    await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
    return { layer, canvas, done }
  }

  /**
   * 返回当前上下文按绘制顺序记录的文字。
   * @returns fillText 的首参数列表。
   * @sideeffect 无副作用。
   */
  function drawnTexts(): string[] {
    return context.fillText.mock.calls.map(([text]) => text as string)
  }
})
