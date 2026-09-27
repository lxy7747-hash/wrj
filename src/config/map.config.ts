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
      tileUrl: `${import.meta.env.MODE === 'lan' ? '' : 'http://127.0.0.1:4174'}/tiles/china-taiwan-260823/{z}/{x}/{y}`,
      /** 保留版权来源元数据，供未来版权或关于页面使用。 */
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      /** 此矢量资源可原生提供的最高缩放级别；地图可继续缩放至全局上限。 */
      maxNativeZoom: 14,
    },
    satellite: {
      /** 卫星包 TileJSON 覆盖范围；坐标顺序为 [纬度, 经度]，与矢量范围独立。 */
      bounds: [[-66.530768, -0.043945], [66.530768, 157.543945]],
      tileUrl: `${import.meta.env.MODE === 'lan' ? '' : 'http://127.0.0.1:4174'}/tiles/taiwan-strait-satellite/{z}/{x}/{y}`,
      /** 保留版权来源元数据，供未来版权或关于页面使用。 */
      attribution: 'VersaTiles - Satellite + Orthophotos',
      /** 此卫星资源可原生提供的最高缩放级别；地图可继续缩放至全局上限。 */
      maxNativeZoom: 12,
    },
  },
  /** 界面与控制器的默认状态；任务视图随后会通过 fitBounds(taskBounds) 调整实际视图。 */
  defaults: {
    theme: 'dark',
    basemap: 'vector',
    /** 底图地名、道路及水域文字；不影响节点名称、图例和经纬网。 */
    basemapLabelsVisible: false,
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
  /** 同节点对多类别的控制点总分离比例；曲线最大偏离约为端点距离的 4%。 */
  linkCurveSeparationRatio: 0.16,
  /** 每条曲线的分段数；采样循环包含两端，因此实际生成分段数加一的点。 */
  curveSampleCount: 32,
  /** 经纬网线的间隔，单位为度。 */
  gridIntervalDegrees: 0.5,
  /** 激活干扰范围传给 Leaflet circle 的半径，单位为米。 */
  activeInterferenceRadiusMeters: 12000,
  /** 文件干扰节点范围圈的半径（显示约定，非 CSV 遥测、非引擎参数）：24 海里 × 1852 米/海里。 */
  fileInterferenceRadiusMeters: 24 * 1852,
  /** 单颗流星的尾迹占链路长度的比例，不随缩放增加流星数量。 */
  linkFlowTrailRatio: 0.12,
  /** 单颗流星的现实展示时长，不随播放倍速变化；不是发送周期或真实传输时延。 */
  linkFlowCycleSeconds: 1.4,
  /**
   * 卫星位置来源开关：
   * true：用数据位置；
   * false：单卫星使用临时中心，多卫星按稳定 ID 等角度环绕中心。
   */
  useSatelliteDataPosition: false as boolean,
  /** 卫星临时位置（经度 120.827670° · 纬度 26.018571°） */
  temporarySatellitePosition: {
    longitude: 120.827670,
    latitude: 26.018571,
  },
  /** 临时卫星分布半径，以纬度度数表示；经度按中心纬度修正。仅用于示意。 */
  temporarySatelliteSpreadRadiusDegrees: 0.05,
  /** 右侧全链路状态表的 SNR / BER 列；只控制展示，不删除质量数据。 */
  showLinkQualityColumns: false as boolean,
} as const

/**
 * 判断指定平台或节点是否为卫星。
 * 明确类型优先；仅在缺少类型时兼容已知日志 ID，不按名称或 ID 前缀猜测。
 */
export function isSatellitePlatform(platform?: {
  type?: string
  platformId?: string
  id?: string
  name?: string
} | null): boolean {
  if (!platform) return false
  if (platform.type) return ['COMMUNICATION_SATELLITE', 'TIAN_TONG_SAT', 'SHEN_TONG_SAT'].includes(platform.type)
  const id = platform.platformId ?? platform.id ?? ''
  return id === 'tiantong_sat' || id === 'shentong_sat'
}

/**
 * 根据 MAP_CONFIG 中的开关获取平台在地图展示时的有效经纬度坐标。
 * 开关为 false 时，单卫星居中，多卫星按稳定 ID 等角度环绕临时中心；
 * 开关为 true 时，卫星使用真实数据位置。非卫星平台始终使用自身数据位置。
 */
export function resolvePlatformCoordinates(
  platform: { longitude: number; latitude: number; type?: string; platformId?: string; id?: string; name?: string },
  platforms: readonly { type?: string; platformId?: string; id?: string; name?: string }[] = [platform],
): { longitude: number; latitude: number } {
  if (isSatellitePlatform(platform) && !MAP_CONFIG.useSatelliteDataPosition) {
    const center = MAP_CONFIG.temporarySatellitePosition
    const ids = [...new Set(platforms.filter(isSatellitePlatform).map(node => node.platformId ?? node.id ?? ''))].sort()
    const index = ids.indexOf(platform.platformId ?? platform.id ?? '')
    if (ids.length > 1 && index >= 0) {
      const angle = index * 2 * Math.PI / ids.length
      const radius = MAP_CONFIG.temporarySatelliteSpreadRadiusDegrees
      return {
        longitude: center.longitude + radius * Math.cos(angle) / Math.cos(center.latitude * Math.PI / 180),
        latitude: center.latitude + radius * Math.sin(angle),
      }
    }
    return {
      longitude: center.longitude,
      latitude: center.latitude,
    }
  }
  return {
    longitude: platform.longitude,
    latitude: platform.latitude,
  }
}
