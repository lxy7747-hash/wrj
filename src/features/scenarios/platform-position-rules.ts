import type { PlatformType } from '../../contracts/domain-models'

/** 通信卫星按 GEO 定点处理，与模板脚本 `position 0n 120e altitude 35786 km` 一致；界面不提供编辑。 */
export const SATELLITE_GEO_POSITION = { longitude: 120, latitude: 0, altitude: 35_786_000 } as const

/** 节点配置中新增航点、盘旋点、返航点的默认高度（m）与默认速度（m/s）。 */
export const PLATFORM_POINT_DEFAULT_ALTITUDE = 3000
export const PLATFORM_POINT_DEFAULT_SPEED = 200

/** 后方指挥节点的预填位置，可改为任意合法经纬度。 */
export const REAR_DEFAULT_ORIGIN = { longitude: 118.5, latitude: 24, altitude: 0 } as const

/** 来源：`comm_platform_INS.txt` 中 `mission_uav_01` route 的首点。 */
export const RELAY_DEFAULT_ORIGIN = { longitude: 119.55, latitude: 24.66, altitude: 3200 } as const

const KNOTS = 1852 / 3600
/** 来源：comm_platform_INS.txt 中 mission_uav_01 的 route；中继点之后进入 RELAY_START 盘旋。 */
export const RELAY_DEFAULT_ROUTE = {
  waypoints: [{ longitude: 120.8, latitude: 25.0, altitude: 8000, speed: 200 * KNOTS, arrivalTime: 0 }],
  loiterWaypoints: [
    { longitude: 120.82, latitude: 25.02, altitude: 8000, speed: 150 * KNOTS },
    { longitude: 120.8, latitude: 25.04, altitude: 8000, speed: 150 * KNOTS },
    { longitude: 120.78, latitude: 25.02, altitude: 8000, speed: 150 * KNOTS },
  ],
} as const

/** 无人机作业集群与前出中继的区域位置限制。 */
export const PLATFORM_POSITION_RULES: Partial<Record<PlatformType, {
  minLongitude: number
  maxLongitude: number
  minLatitude: number
  maxLatitude: number
}>> = {
  AIRBORNE_MISSION_CLUSTER: { minLongitude: 117, maxLongitude: 122, minLatitude: 21, maxLatitude: 26 },
  FORWARD_RELAY_NODE: { minLongitude: 117, maxLongitude: 122, minLatitude: 21, maxLatitude: 26 },
}
