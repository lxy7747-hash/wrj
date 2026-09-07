import { VectorTile, type VectorTileFeature } from '@mapbox/vector-tile'
import L from 'leaflet'
import { PbfReader } from 'pbf'
import { MAP_CONFIG } from '../../config/map.config'
import type { MapTheme } from '../../config/map.config'

const TILE_SIZE = 256
const GUTTER = 64
const CANVAS_SIZE = TILE_SIZE + GUTTER * 2
const FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif'
const LABEL_LAYERS = [
  'boundary_labels',
  'place_labels',
  'street_labels',
  'street_labels_points',
  'streets_polygons_labels',
  'water_lines_labels',
  'water_polygons_labels',
] as const

const PLACE_MIN_ZOOM: Readonly<Record<string, number>> = {
  capital: 4,
  state_capital: 4,
  city: 4,
  town: 7,
  suburb: 13,
  village: 13,
  neighbourhood: 13,
}

const ROAD_MIN_ZOOM: Readonly<Record<string, number>> = {
  motorway: 10,
  trunk: 10,
  primary: 10,
  rail: 10,
  secondary: 12,
  tertiary: 13,
  residential: 14,
  service: 14,
  unclassified: 14,
}

const WATER_POLYGON_KINDS = new Set([
  'bay',
  'basin',
  'canal',
  'dock',
  'lake',
  'ocean',
  'pond',
  'reservoir',
  'river',
  'sea',
  'water',
])
const WATER_LINE_KINDS = new Set(['river', 'canal'])

/**
 * 离线矢量标签层对地图控制器开放的窄接口。
 */
export interface OfflineVectorLabelLayer extends L.GridLayer {
  /**
   * 原地切换后续标签瓦片使用的颜色主题。
   * @param theme 要切换到的深色或浅色主题。
   * @param redraw 是否立即重绘当前瓦片，默认重绘。
   * @returns 无返回值。
   * @sideeffect 主题变化时更新闭包状态，并按需触发一次 GridLayer 重绘；相同主题不会重绘。
   */
  setTheme(theme: MapTheme, redraw?: boolean): void
}

type LabelLayerName = (typeof LABEL_LAYERS)[number]
type LabelCategory = 'boundary' | 'place' | 'road' | 'water'

interface LabelColors {
  fill: string
  stroke: string
}

/** 所有标签类别统一从主题调色板读取填充色和描边色，避免绘制分支产生颜色漂移。 */
const LABEL_PALETTES: Readonly<Record<MapTheme, Readonly<Record<LabelCategory, LabelColors>>>> = {
  dark: {
    boundary: { fill: '#d7e8f3', stroke: '#06111d' },
    place: { fill: '#edf4f7', stroke: '#06111d' },
    road: { fill: '#a9bdca', stroke: '#06111d' },
    water: { fill: '#69bce8', stroke: '#06111d' },
  },
  light: {
    boundary: { fill: '#243746', stroke: '#f7fbfd' },
    place: { fill: '#18242d', stroke: '#f7fbfd' },
    road: { fill: '#425663', stroke: '#f7fbfd' },
    water: { fill: '#17658a', stroke: '#f7fbfd' },
  },
}

interface LabelSource {
  feature: VectorTileFeature
  layerName: LabelLayerName
  extent: number
  category: LabelCategory
  kind: string
  text: string
  adminLevel: number
  population: number
  priority: number
}

interface PixelPoint {
  x: number
  y: number
}

interface LabelCandidate extends LabelSource {
  anchor: PixelPoint
  angle: number
  pathLength: number
}

interface LabelBox {
  left: number
  top: number
  right: number
  bottom: number
}

interface TileLoadEvent extends L.LeafletEvent {
  tile?: HTMLElement
}

/**
 * 创建只读取本机 MVT 的透明文字瓦片层。
 * @param theme 初始标签主题，配置默认使用浅色主题。
 * @returns 可直接添加到 Leaflet 地图并原地切换主题的 Canvas GridLayer。
 * @sideeffect 每个可见标签瓦片会独立请求本机 4174 端口；卸载瓦片或移除图层会取消对应请求。
 */
export function createOfflineVectorLabelLayer(
  theme: MapTheme = MAP_CONFIG.defaults.theme,
): OfflineVectorLabelLayer {
  const controllers = new Map<HTMLCanvasElement, AbortController>()
  let currentTheme = theme
  const layer = new L.GridLayer({
    bounds: L.latLngBounds([...MAP_CONFIG.resources.vector.bounds[0]], [...MAP_CONFIG.resources.vector.bounds[1]]),
    tileSize: TILE_SIZE,
    minZoom: MAP_CONFIG.zoom.min,
    maxZoom: MAP_CONFIG.zoom.max,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 1,
    pane: 'offline-label-pane',
    className: 'offline-vector-label-layer',
  }) as OfflineVectorLabelLayer

  const createTile = (coords: L.Coords, done: L.DoneCallback): HTMLElement => {
    const canvas = createLabelCanvas()
    let completed = false
    const finish = (): void => {
      if (completed) return
      completed = true
      configureCanvasElement(canvas)
      done(undefined, canvas)
    }

    if (coords.z <= 2) {
      queueMicrotask(finish)
      return canvas
    }

    const context = canvas.getContext('2d')
    if (!context) {
      queueMicrotask(finish)
      return canvas
    }

    const controller = new AbortController()
    controllers.set(canvas, controller)
    const loadTile = async (): Promise<void> => {
      try {
        const response = await fetch(tileUrl(coords), { signal: controller.signal })
        if (!response.ok) return

        const bytes = await response.arrayBuffer()
        if (controller.signal.aborted) return
        const tile = new VectorTile(new PbfReader(bytes))
        drawTileLabels(context, canvas, tile, coords.z, currentTheme)
      } catch {
        try {
          clearCanvas(context, canvas)
        } catch {
          // Canvas 失败时仍由 finally 完成透明瓦片，避免请求链产生未处理拒绝。
        }
      } finally {
        if (controllers.get(canvas) === controller) controllers.delete(canvas)
        finish()
      }
    }

    void loadTile()
    return canvas
  }

  /**
   * 仅在主题实际变化时更新闭包状态并按需请求 Leaflet 重绘现有瓦片。
   * @param nextTheme 要切换到的标签主题。
   * @param redraw 是否立即重绘当前瓦片。
   * @returns 无返回值。
   * @sideeffect 主题变化且允许重绘时调用一次 layer.redraw()，重复主题没有副作用。
   */
  const setTheme = (nextTheme: MapTheme, redraw = true): void => {
    if (currentTheme === nextTheme) return
    currentTheme = nextTheme
    if (redraw) layer.redraw()
  }
  Object.assign(layer, { createTile, setTheme })

  layer.on('tileunload', (event: TileLoadEvent) => {
    if (event.tile instanceof HTMLCanvasElement) {
      controllers.get(event.tile)?.abort()
    }
  })
  layer.on('remove', () => {
    controllers.forEach((controller) => controller.abort())
    controllers.clear()
  })

  return layer
}

/**
 * 创建带有 64 像素四周留白的透明画布。
 * @returns 已设置离线字体、无交互样式和 HiDPI 尺寸的 Canvas。
 * @sideeffect 创建 DOM 元素并读取当前设备像素比。
 */
function createLabelCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  configureCanvasElement(canvas)
  canvas.classList.add('offline-vector-label-tile')
  canvas.setAttribute('aria-hidden', 'true')
  return canvas
}

/**
 * 恢复画布的逻辑尺寸和外溢定位，防止 Leaflet 初始化瓦片时覆盖样式。
 * @param canvas 标签层使用的画布。
 * @returns 无返回值。
 * @sideeffect 修改画布像素尺寸和行内样式；尺寸变化会清空既有绘制内容。
 */
function configureCanvasElement(canvas: HTMLCanvasElement): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const pixelSize = Math.round(CANVAS_SIZE * ratio)
  if (canvas.width !== pixelSize) canvas.width = pixelSize
  if (canvas.height !== pixelSize) canvas.height = pixelSize
  canvas.style.width = `${CANVAS_SIZE}px`
  canvas.style.height = `${CANVAS_SIZE}px`
  canvas.style.marginLeft = `${-GUTTER}px`
  canvas.style.marginTop = `${-GUTTER}px`
  canvas.style.pointerEvents = 'none'
  canvas.style.overflow = 'visible'
}

/**
 * 将瓦片坐标写入固定的本机 URL 模板。
 * @param coords Leaflet 提供的瓦片横纵坐标和缩放级别。
 * @returns 由浏览器端地图配置生成的本机 MVT 地址。
 * @sideeffect 无副作用。
 */
function tileUrl(coords: L.Coords): string {
  return MAP_CONFIG.resources.vector.tileUrl
    .replace('{z}', String(coords.z))
    .replace('{x}', String(coords.x))
    .replace('{y}', String(coords.y))
}

/**
 * 解析、去重并按优先级绘制单个 MVT 的标签。
 * @param context 当前瓦片的二维绘图上下文。
 * @param canvas 承载标签的画布。
 * @param tile 已解析的矢量瓦片。
 * @param zoom 当前整数缩放级别。
 * @param theme 当前标签颜色主题。
 * @returns 无返回值。
 * @sideeffect 清空并绘制画布；只在属性通过白名单后加载几何。
 */
function drawTileLabels(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  tile: VectorTile,
  zoom: number,
  theme: MapTheme,
): void {
  clearCanvas(context, canvas)
  const sources = collectLabelSources(tile, zoom).sort(compareLabelSources)
  const candidates = sources
    .map(materializeCandidate)
    .filter((candidate): candidate is LabelCandidate => candidate !== null)
  const uniqueCandidates = deduplicateCandidates(candidates).sort(compareLabelSources)
  const occupied: LabelBox[] = []
  const limit = tileLabelLimit(zoom)
  let drawn = 0

  for (const candidate of uniqueCandidates) {
    if (drawn >= limit) break
    const style = labelStyle(candidate, zoom, theme)
    context.font = style.font
    const textWidth = context.measureText(candidate.text).width
    if (candidate.pathLength > 0 && candidate.pathLength < textWidth + 8) continue

    const box = labelBox(candidate.anchor, textWidth, style.fontSize, candidate.angle)
    if (!insideGutter(box) || occupied.some((other) => boxesOverlap(box, other, 3))) continue

    context.save()
    context.translate(candidate.anchor.x + GUTTER, candidate.anchor.y + GUTTER)
    context.rotate(candidate.angle)
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.lineJoin = 'round'
    context.strokeStyle = style.stroke
    context.lineWidth = 3
    context.fillStyle = style.fill
    context.strokeText(candidate.text, 0, 0)
    context.fillText(candidate.text, 0, 0)
    context.restore()
    occupied.push(box)
    drawn += 1
  }
}

/**
 * 清空画布并按当前设备像素比设置 CSS 像素坐标系。
 * @param context 要重置的二维绘图上下文。
 * @param canvas 对应画布。
 * @returns 无返回值。
 * @sideeffect 清空所有像素并修改上下文变换矩阵。
 */
function clearCanvas(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
}

/**
 * 从白名单图层收集无需读取几何即可判断有效性的标签来源。
 * @param tile 已解析的矢量瓦片。
 * @param zoom 当前缩放级别。
 * @returns 已通过图层、kind、文字和缩放规则的来源列表。
 * @sideeffect 读取要素属性，但不会调用 loadGeometry。
 */
function collectLabelSources(tile: VectorTile, zoom: number): LabelSource[] {
  const sources: LabelSource[] = []

  LABEL_LAYERS.forEach((layerName) => {
    const layer = tile.layers[layerName]
    if (!layer) return

    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index)
      const properties = feature.properties
      const text = labelText(properties)
      if (!text) continue
      const source = classifySource(feature, layerName, layer.extent, text, zoom)
      if (source) sources.push(source)
    }
  })

  return sources
}

/**
 * 依次选择中文名、英文名和道路编号作为安全标签文字。
 * @param properties MVT 要素属性。
 * @returns 经过首尾空白清理且不超过 80 字符的文字，否则返回空值。
 * @sideeffect 无副作用。
 */
function labelText(properties: Record<string, string | number | boolean>): string | null {
  for (const field of ['name', 'name_en', 'ref'] as const) {
    const value = properties[field]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0 && trimmed.length <= 80) return trimmed
  }
  return null
}

/**
 * 根据固定图层与 kind 白名单确定标签类别和优先级。
 * @param feature 尚未加载几何的 MVT 要素。
 * @param layerName 要素所在标签图层。
 * @param extent 图层自身坐标范围。
 * @param text 已清理的显示文字。
 * @param zoom 当前缩放级别。
 * @returns 通过规则的标签来源，不通过时返回空值。
 * @sideeffect 无副作用，不访问要素几何。
 */
function classifySource(
  feature: VectorTileFeature,
  layerName: LabelLayerName,
  extent: number,
  text: string,
  zoom: number,
): LabelSource | null {
  const kindValue = feature.properties.kind
  const kind = typeof kindValue === 'string' ? kindValue : ''
  const common = { feature, layerName, extent, kind, text }

  if (layerName === 'boundary_labels') {
    const adminLevel = finiteNumber(feature.properties.admin_level)
    if (zoom < 3 || adminLevel === null || adminLevel < 0 || adminLevel > 20) return null
    return {
      ...common,
      category: 'boundary',
      adminLevel,
      population: 0,
      priority: adminLevel,
    }
  }

  if (layerName === 'place_labels') {
    const minimumZoom = PLACE_MIN_ZOOM[kind]
    if (minimumZoom === undefined || zoom < minimumZoom) return null
    const placeRank = Object.keys(PLACE_MIN_ZOOM).indexOf(kind)
    return {
      ...common,
      category: 'place',
      adminLevel: 99,
      population: finiteNumber(feature.properties.population) ?? 0,
      priority: 100 + placeRank,
    }
  }

  if (layerName === 'water_polygons_labels') {
    if (zoom < 10 || !WATER_POLYGON_KINDS.has(kind)) return null
    return { ...common, category: 'water', adminLevel: 99, population: 0, priority: 200 }
  }

  if (layerName === 'water_lines_labels') {
    if (zoom < 12 || !WATER_LINE_KINDS.has(kind)) return null
    return { ...common, category: 'water', adminLevel: 99, population: 0, priority: 220 }
  }

  const minimumZoom = ROAD_MIN_ZOOM[kind]
  if (minimumZoom === undefined || zoom < minimumZoom) return null
  if (layerName === 'street_labels_points' && zoom < 12) return null
  if (layerName === 'streets_polygons_labels' && zoom < 14) return null
  const roadRank = Object.keys(ROAD_MIN_ZOOM).indexOf(kind)
  return {
    ...common,
    category: 'road',
    adminLevel: 99,
    population: 0,
    priority: 300 + roadRank,
  }
}

/**
 * 将数值型属性安全转换为有限数值。
 * @param value 任意 MVT 属性值。
 * @returns 有限数值，无法转换时返回空值。
 * @sideeffect 无副作用。
 */
function finiteNumber(value: string | number | boolean | undefined): number | null {
  if (typeof value === 'boolean' || value === undefined) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 按行政级别、地点等级与人口、道路等级稳定比较来源。
 * @param left 左侧标签来源。
 * @param right 右侧标签来源。
 * @returns 小于零表示左侧应优先绘制。
 * @sideeffect 无副作用。
 */
function compareLabelSources(left: LabelSource, right: LabelSource): number {
  if (left.priority !== right.priority) return left.priority - right.priority
  if (left.category === 'place' && right.category === 'place' && left.population !== right.population) {
    return right.population - left.population
  }
  return left.text.localeCompare(right.text, 'zh-CN')
}

/**
 * 在过滤完成后加载几何并计算像素锚点和正向角度。
 * @param source 已通过属性白名单的标签来源。
 * @returns 锚点位于本瓦片核心区的候选，否则返回空值。
 * @sideeffect 调用一次 MVT 要素的 loadGeometry。
 */
function materializeCandidate(source: LabelSource): LabelCandidate | null {
  const paths = source.feature.loadGeometry()
  if (source.feature.type === 1) {
    for (const path of paths) {
      for (const point of path) {
        if (!insideCore(point.x, point.y, source.extent)) continue
        return {
          ...source,
          anchor: toPixel(point.x, point.y, source.extent),
          angle: 0,
          pathLength: 0,
        }
      }
    }
    return null
  }

  if (source.feature.type !== 2) return null
  let longest: { anchor: PixelPoint; angle: number; length: number } | null = null
  for (const path of paths) {
    const line = lineAnchor(path, source.extent)
    if (line && (!longest || line.length > longest.length)) longest = line
  }
  if (!longest || !insideCore(longest.anchor.x, longest.anchor.y, TILE_SIZE)) return null
  return {
    ...source,
    anchor: longest.anchor,
    angle: longest.angle,
    pathLength: longest.length,
  }
}

/**
 * 计算折线累计长度中点及其所在分段的正向切线角。
 * @param path MVT extent 坐标中的单条折线。
 * @param extent 当前图层的独立 extent。
 * @returns CSS 像素坐标中的中点、[-90°, 90°] 角度和总长度；退化折线返回空值。
 * @sideeffect 无副作用。
 */
function lineAnchor(
  path: Array<{ x: number; y: number }>,
  extent: number,
): { anchor: PixelPoint; angle: number; length: number } | null {
  if (path.length < 2 || extent <= 0) return null
  const points = path.map((point) => toPixel(point.x, point.y, extent))
  const lengths: number[] = []
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const length = Math.hypot(current.x - previous.x, current.y - previous.y)
    lengths.push(length)
    total += length
  }
  if (total === 0) return null

  const midpoint = total / 2
  let traversed = 0
  for (let index = 0; index < lengths.length; index += 1) {
    const segmentLength = lengths[index]
    if (segmentLength === 0) continue
    if (traversed + segmentLength < midpoint) {
      traversed += segmentLength
      continue
    }
    const start = points[index]
    const end = points[index + 1]
    const ratio = (midpoint - traversed) / segmentLength
    const angle = normalizeAngle(Math.atan2(end.y - start.y, end.x - start.x))
    return {
      anchor: {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
      },
      angle,
      length: total,
    }
  }
  return null
}

/**
 * 将折线角度翻转到文字可正向阅读的半圆范围。
 * @param angle 画布弧度角。
 * @returns 处于 [-π/2, π/2] 的等价角度。
 * @sideeffect 无副作用。
 */
function normalizeAngle(angle: number): number {
  if (angle > Math.PI / 2) return angle - Math.PI
  if (angle < -Math.PI / 2) return angle + Math.PI
  return angle
}

/**
 * 把图层 extent 坐标映射到 256 CSS 像素瓦片核心区。
 * @param x extent 横坐标。
 * @param y extent 纵坐标。
 * @param extent 当前图层坐标范围。
 * @returns CSS 像素坐标。
 * @sideeffect 无副作用。
 */
function toPixel(x: number, y: number, extent: number): PixelPoint {
  return { x: x / extent * TILE_SIZE, y: y / extent * TILE_SIZE }
}

/**
 * 判断锚点是否严格属于当前瓦片核心 extent。
 * @param x 横坐标。
 * @param y 纵坐标。
 * @param extent 对应坐标上界。
 * @returns 坐标位于 [0, extent) 时返回 true。
 * @sideeffect 无副作用。
 */
function insideCore(x: number, y: number, extent: number): boolean {
  return x >= 0 && x < extent && y >= 0 && y < extent
}

/**
 * 按业务去重键保留优先点标签和同名最长线标签。
 * @param candidates 已完成几何计算的候选。
 * @returns 去重后的候选列表。
 * @sideeffect 无副作用。
 */
function deduplicateCandidates(candidates: LabelCandidate[]): LabelCandidate[] {
  const unique = new Map<string, LabelCandidate>()
  candidates.forEach((candidate) => {
    const key = candidate.category === 'boundary' || candidate.category === 'place'
      ? `administrative:${candidate.text}`
      : `${candidate.category}:${candidate.text}`
    const current = unique.get(key)
    if (!current || (candidate.pathLength > 0 && candidate.pathLength > current.pathLength)) {
      unique.set(key, candidate)
    }
  })
  return [...unique.values()]
}

/**
 * 返回当前缩放级别的每瓦片最大实际绘制数。
 * @param zoom 当前缩放级别。
 * @returns 合同规定的标签密度上限。
 * @sideeffect 无副作用。
 */
function tileLabelLimit(zoom: number): number {
  if (zoom <= 5) return 12
  if (zoom <= 9) return 20
  if (zoom <= 11) return 24
  if (zoom <= 13) return 32
  return 40
}

/**
 * 计算候选在当前主题下使用的离线字体和颜色。
 * @param candidate 当前标签候选。
 * @param zoom 当前缩放级别。
 * @param theme 当前标签颜色主题。
 * @returns 字号、完整系统字体链以及统一调色板中的填充色和描边色。
 * @sideeffect 无副作用。
 */
function labelStyle(
  candidate: LabelCandidate,
  zoom: number,
  theme: MapTheme,
): { font: string; fontSize: number; fill: string; stroke: string } {
  const colors = LABEL_PALETTES[theme][candidate.category]
  if (candidate.category === 'boundary') {
    const fontSize = zoom <= 5 ? 13 : 12
    return { font: `600 ${fontSize}px ${FONT_FAMILY}`, fontSize, ...colors }
  }
  if (candidate.category === 'place') {
    const fontSize = candidate.kind === 'capital' || candidate.kind === 'state_capital' ? 14 : 12
    return { font: `600 ${fontSize}px ${FONT_FAMILY}`, fontSize, ...colors }
  }
  return { font: `500 12px ${FONT_FAMILY}`, fontSize: 12, ...colors }
}

/**
 * 计算旋转文字对应的轴对齐碰撞框。
 * @param anchor 文字锚点。
 * @param width 文字测量宽度。
 * @param height 字号近似高度。
 * @param angle 规范后的画布角度。
 * @returns 核心瓦片坐标中的轴对齐包围盒。
 * @sideeffect 无副作用。
 */
function labelBox(anchor: PixelPoint, width: number, height: number, angle: number): LabelBox {
  const projectedWidth = Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle))
  const projectedHeight = Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle))
  return {
    left: anchor.x - projectedWidth / 2,
    top: anchor.y - projectedHeight / 2,
    right: anchor.x + projectedWidth / 2,
    bottom: anchor.y + projectedHeight / 2,
  }
}

/**
 * 判断文字包围盒是否仍处于 64 像素 gutter 内。
 * @param box 核心瓦片坐标中的文字包围盒。
 * @returns 未越出 gutter 时返回 true。
 * @sideeffect 无副作用。
 */
function insideGutter(box: LabelBox): boolean {
  return box.left >= -GUTTER
    && box.top >= -GUTTER
    && box.right <= TILE_SIZE + GUTTER
    && box.bottom <= TILE_SIZE + GUTTER
}

/**
 * 判断两个轴对齐标签框在指定间距下是否冲突。
 * @param left 已接受的标签框。
 * @param right 待判断标签框。
 * @param padding 两标签最小 CSS 像素间距。
 * @returns 相交或不足间距时返回 true。
 * @sideeffect 无副作用。
 */
function boxesOverlap(left: LabelBox, right: LabelBox, padding: number): boolean {
  return left.left < right.right + padding
    && left.right + padding > right.left
    && left.top < right.bottom + padding
    && left.bottom + padding > right.top
}
