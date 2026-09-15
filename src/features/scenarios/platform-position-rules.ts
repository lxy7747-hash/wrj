import type { PlatformType } from '../../contracts/domain-models'

/** 编辑器按边界限位；文件导入仅校验，不裁剪来源坐标。固定值采用精确比较。 */
export const PLATFORM_POSITION_RULES: Partial<Record<PlatformType, {
  minLongitude: number
  maxLongitude: number
  minLatitude: number
  maxLatitude: number
  altitude?: number
}>> = {
  AIRBORNE_MISSION_CLUSTER: { minLongitude: 117, maxLongitude: 122, minLatitude: 21, maxLatitude: 26 },
  REAR_COMMAND_NODE: { minLongitude: 118.5, maxLongitude: 120, minLatitude: 24, maxLatitude: 25 },
  FORWARD_RELAY_NODE: { minLongitude: 120.8, maxLongitude: 120.8, minLatitude: 25.3, maxLatitude: 25.7, altitude: 8000 },
  GROUND_JAMMER_DETECTION_STATION: { minLongitude: 121.2, maxLongitude: 121.8, minLatitude: 24.8, maxLatitude: 25.4 },
}
