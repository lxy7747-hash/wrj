/** 浏览器端地图支持的配色主题。 */
export type MapTheme = 'dark' | 'light'

/** 浏览器端地图支持的底图类型。 */
export type MapBasemap = 'vector' | 'satellite'

/**
 * 浏览器端地图资源、默认状态和展示参数的唯一配置来源。
 * 普通数组保持深度只读，交给 Leaflet 前由消费者创建副本。
 */
export const MAP_CONFIG = {
  resources: {
    vector: {
      tileUrl: 'http://127.0.0.1:4174/tiles/china-taiwan-260823/{z}/{x}/{y}',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxNativeZoom: 14,
    },
    satellite: {
      tileUrl: 'http://127.0.0.1:4174/tiles/taiwan-strait-satellite/{z}/{x}/{y}',
      attribution: 'VersaTiles - Satellite + Orthophotos',
      maxNativeZoom: 12,
    },
  },
  defaults: {
    theme: 'light',
    basemap: 'vector',
    zoom: 10,
  },
  zoom: {
    min: 4,
    max: 14,
    snap: 0.25,
  },
  taskBounds: [[21.8, 117.0], [26.4, 123.0]],
  fitPadding: [24, 24],
  displayProjection: {
    'CMD-01': [24.45, 118.15],
    'UAV-01': [24.70, 119.35],
    'GCC-01': [23.55, 118.65],
    'AIR-01': [23.95, 120.15],
    'SAT-01': [25.75, 121.25],
    'STN-01': [25.25, 119.55],
  },
  linkCurveOffsets: [-0.18, -0.06, 0.06, 0.18],
  curveSampleCount: 32,
  gridIntervalDegrees: 0.5,
  activeInterferenceRadiusMeters: 12000,
} as const
