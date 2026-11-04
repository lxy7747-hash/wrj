import type { PlatformType } from '../../contracts/domain-models'

/** 通信卫星按 GEO 定点处理，与模板脚本 `position 0n 120e altitude 35786 km` 一致；界面不提供编辑。 */
export const SATELLITE_GEO_POSITION = { longitude: 120, latitude: 0, altitude: 35_786_000 } as const

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

/** 编辑器按边界限位；文件导入仅校验，不裁剪来源坐标。 */
export const PLATFORM_POSITION_RULES: Partial<Record<PlatformType, {
  minLongitude: number
  maxLongitude: number
  minLatitude: number
  maxLatitude: number
}>> = {
  AIRBORNE_MISSION_CLUSTER: { minLongitude: 117, maxLongitude: 122, minLatitude: 21, maxLatitude: 26 },
  REAR_COMMAND_NODE: { minLongitude: 118.5, maxLongitude: 120, minLatitude: 24, maxLatitude: 25 },
  FORWARD_RELAY_NODE: { minLongitude: 117, maxLongitude: 122, minLatitude: 21, maxLatitude: 26 },
  GROUND_JAMMER_DETECTION_STATION: { minLongitude: 121.2, maxLongitude: 121.8, minLatitude: 24.8, maxLatitude: 25.4 },
}
