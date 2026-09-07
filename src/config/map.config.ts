/** 浏览器端地图支持的配色主题。 */
export type MapTheme = 'dark' | 'light'

/** 浏览器端地图支持的底图类型。 */
export type MapBasemap = 'vector' | 'satellite'

/**
 * 浏览器端地图资源、默认状态和展示参数的唯一配置来源。
 * 普通数组保持深度只读，交给 Leaflet 前由消费者创建副本。
 */
export const MAP_CONFIG = {
  /** 矢量/卫星底图共用 Leaflet 瓦片模板，{z}/{x}/{y} 分别由 Leaflet 替换为缩放级别和瓦片横、纵坐标。 */
  resources: {
    vector: {
      /** 资源 TileJSON 中的西南、东北边界，每点为 [纬度, 经度]；范围外不请求不存在的瓦片。 */
      bounds: [[7.197594, 71.61502], [54.011569, 135.677601]],
      tileUrl: 'http://127.0.0.1:4174/tiles/china-taiwan-260823/{z}/{x}/{y}',
      /** 保留版权来源元数据，供未来版权或关于页面使用。 */
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      /** 此矢量资源可原生提供的最高缩放级别；地图可继续缩放至全局上限。 */
      maxNativeZoom: 14,
    },
    satellite: {
      /** 卫星包 TileJSON 覆盖范围；坐标顺序为 [纬度, 经度]，与矢量范围独立。 */
      bounds: [[-66.530768, -0.043945], [66.530768, 157.543945]],
      tileUrl: 'http://127.0.0.1:4174/tiles/taiwan-strait-satellite/{z}/{x}/{y}',
      /** 保留版权来源元数据，供未来版权或关于页面使用。 */
      attribution: 'VersaTiles - Satellite + Orthophotos',
      /** 此卫星资源可原生提供的最高缩放级别；地图可继续缩放至全局上限。 */
      maxNativeZoom: 12,
    },
  },
  /** 界面与控制器的默认状态；任务视图随后会通过 fitBounds(taskBounds) 调整实际视图。 */
  defaults: {
    theme: 'light',
    basemap: 'vector',
    zoom: 10,
    /** 是否默认显示经纬网，关闭后仍可通过图层按钮手动开启。 */
    gridVisible: false,
  },
  /** Leaflet 允许的最小/最大缩放级别，以及滚轮等交互吸附到的缩放步长。 */
  zoom: {
    min: 1,
    max: 14,
    snap: 0.25,
  },
  /** 任务区域的西南、东北边界；Leaflet 坐标顺序为 [纬度, 经度]。 */
  taskBounds: [[21.8, 117.0], [26.4, 123.0]],
  /** 传给 fitBounds 的 [水平, 垂直] 像素留白，避免任务区域紧贴地图边缘。 */
  fitPadding: [24, 24],
  /** 按链路摘要顺序使用的二次贝塞尔控制点经纬度偏移，单位为度。 */
  linkCurveOffsets: [-0.18, -0.06, 0.06, 0.18],
  /** 每条曲线的分段数；采样循环包含两端，因此实际生成分段数加一的点。 */
  curveSampleCount: 32,
  /** 经纬网线的间隔，单位为度。 */
  gridIntervalDegrees: 0.5,
  /** 激活干扰范围传给 Leaflet circle 的半径，单位为米。 */
  activeInterferenceRadiusMeters: 12000,
} as const
