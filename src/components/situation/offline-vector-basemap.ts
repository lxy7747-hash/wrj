import L from 'leaflet'
import 'leaflet.vectorgrid'
import { MAP_CONFIG, type MapTheme } from '../../config/map.config'
import { bindVectorTileSource, createVectorTileSource } from './vector-tile-source'

interface VectorTilePathOptions extends L.PathOptions {
  radius?: number
}

type VectorTileStyle = VectorTilePathOptions
  | ((properties: Record<string, unknown>, zoom: number) => VectorTilePathOptions)

interface VectorGridOptions extends L.GridLayerOptions {
  rendererFactory: unknown
  vectorTileLayerStyles: Record<string, VectorTileStyle>
  maxNativeZoom: number
  maxZoom: number
  attribution: string
  interactive: boolean
}

interface LeafletVectorGridApi {
  protobuf: (url: string, options: VectorGridOptions) => OfflineVectorBasemap
}

/** 仅暴露换肤需要的 VectorGrid 可变样式选项与原地重绘能力。 */
interface OfflineVectorBasemap extends L.Layer {
  options: VectorGridOptions
  redraw: () => OfflineVectorBasemap
}

type LeafletWithVectorGrid = typeof L & {
  vectorGrid: LeafletVectorGridApi
  canvas: typeof L.canvas & { tile: unknown }
}

const HIDDEN_VECTOR_TILE_STYLE: VectorTilePathOptions = {
  stroke: false,
  color: 'transparent',
  weight: 0,
  opacity: 0,
  fill: false,
  fillColor: 'transparent',
  fillOpacity: 0,
  radius: 0,
}

/**
 * 为指定地图主题创建一份独立的 VectorGrid 样式表。
 * @param theme 深色或浅色地图主题。
 * @returns 可直接替换到既有 VectorGrid 实例的图层样式。
 * @sideeffect 无副作用；每次调用都返回新对象，避免主题间共享可变样式。
 */
export function createVectorTileStyles(theme: MapTheme): Record<string, VectorTileStyle> {
  const hiddenStyles = {
    addresses: HIDDEN_VECTOR_TILE_STYLE,
    aerialways: HIDDEN_VECTOR_TILE_STYLE,
    boundary_labels: HIDDEN_VECTOR_TILE_STYLE,
    bridges: HIDDEN_VECTOR_TILE_STYLE,
    dam_lines: HIDDEN_VECTOR_TILE_STYLE,
    dam_polygons: HIDDEN_VECTOR_TILE_STYLE,
    ferries: HIDDEN_VECTOR_TILE_STYLE,
    pier_lines: HIDDEN_VECTOR_TILE_STYLE,
    pier_polygons: HIDDEN_VECTOR_TILE_STYLE,
    place_labels: HIDDEN_VECTOR_TILE_STYLE,
    pois: HIDDEN_VECTOR_TILE_STYLE,
    public_transport: HIDDEN_VECTOR_TILE_STYLE,
    sites: HIDDEN_VECTOR_TILE_STYLE,
    street_labels: HIDDEN_VECTOR_TILE_STYLE,
    street_labels_points: HIDDEN_VECTOR_TILE_STYLE,
    streets_polygons_labels: HIDDEN_VECTOR_TILE_STYLE,
    water_lines_labels: HIDDEN_VECTOR_TILE_STYLE,
    water_polygons_labels: HIDDEN_VECTOR_TILE_STYLE,
  }

  if (theme === 'light') {
    return {
      ...hiddenStyles,
      ocean: { fill: true, fillColor: '#cfe8f3', fillOpacity: 1, stroke: false },
      land: {
        fill: true,
        fillColor: '#eee7d6',
        fillOpacity: 1,
        color: '#c7c0b2',
        weight: 0.5,
      },
      water_polygons: {
        fill: true,
        fillColor: '#c6e2ef',
        fillOpacity: 1,
        color: '#8fb9cc',
        weight: 0.7,
      },
      water_lines: { color: '#73a9c0', weight: 1, opacity: 0.9 },
      boundaries: {
        color: '#718899',
        weight: 1,
        opacity: 0.85,
        dashArray: '5 4',
      },
      streets: (properties, zoom) => {
        const kind = typeof properties.kind === 'string' ? properties.kind : ''
        const arterialColors: Readonly<Record<string, string>> = {
          motorway: '#d98b18',
          trunk: '#e5a536',
          primary: '#efbd63',
        }
        return {
          color: arterialColors[kind] ?? (zoom >= 12 ? '#8d969b' : '#a7adb0'),
          weight: zoom >= 12 ? 1.35 : 0.75,
          opacity: zoom >= 10 ? 0.9 : 0.7,
        }
      },
      street_polygons: {
        fill: true,
        fillColor: '#d6d7d5',
        fillOpacity: 0.65,
        stroke: false,
      },
      buildings: {
        fill: true,
        fillColor: '#c8cac8',
        fillOpacity: 0.75,
        color: '#afb3b2',
        weight: 0.5,
      },
    }
  }

  return {
    ...hiddenStyles,
    ocean: { fill: true, fillColor: '#06111d', fillOpacity: 1, stroke: false },
    land: {
      fill: true,
      fillColor: '#10283a',
      fillOpacity: 1,
      color: '#1a3b51',
      weight: 0.5,
    },
    water_polygons: {
      fill: true,
      fillColor: '#092034',
      fillOpacity: 1,
      color: '#16445f',
      weight: 0.7,
    },
    water_lines: { color: '#1e5571', weight: 1, opacity: 0.85 },
    boundaries: {
      color: '#54728a',
      weight: 1,
      opacity: 0.75,
      dashArray: '5 4',
    },
    streets: (_properties, zoom) => ({
      color: zoom >= 12 ? '#496579' : '#354f63',
      weight: zoom >= 12 ? 1.35 : 0.75,
      opacity: zoom >= 10 ? 0.8 : 0.55,
    }),
    street_polygons: {
      fill: true,
      fillColor: '#324b5d',
      fillOpacity: 0.55,
      stroke: false,
    },
    buildings: {
      fill: true,
      fillColor: '#3b5363',
      fillOpacity: 0.7,
      color: '#4d6879',
      weight: 0.5,
    },
  }
}

/** 使用共享瓦片数据源创建离线矢量底图。 */
export function createOfflineVectorBasemap(theme: MapTheme, source = createVectorTileSource()): OfflineVectorBasemap {
  const leaflet = L as LeafletWithVectorGrid
  const vectorGrid = leaflet.vectorGrid.protobuf(MAP_CONFIG.resources.vector.tileUrl, {
    bounds: L.latLngBounds([...MAP_CONFIG.resources.vector.bounds[0]], [...MAP_CONFIG.resources.vector.bounds[1]]),
    rendererFactory: leaflet.canvas.tile,
    vectorTileLayerStyles: createVectorTileStyles(theme),
    maxNativeZoom: MAP_CONFIG.resources.vector.maxNativeZoom,
    maxZoom: MAP_CONFIG.zoom.max,
    attribution: MAP_CONFIG.resources.vector.attribution,
    interactive: false,
    pane: 'tilePane',
  })
  bindVectorTileSource(vectorGrid, source)
  return vectorGrid
}
