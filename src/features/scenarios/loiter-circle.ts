import type { TemplateRoutePoint } from '../../contracts/domain-models'

export interface LoiterCircleParams {
  longitude: number
  latitude: number
  radiusKm: number
  altitude: number
  speed: number
  pointCount?: number
}

export const DEFAULT_LOITER_RADIUS_KM = 5
export const DEFAULT_LOITER_POINT_COUNT = 8
export const MIN_LOITER_RADIUS_KM = 0.5
export const MAX_LOITER_RADIUS_KM = 500

const EARTH_RADIUS_KM = 6371.0088
const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI

function roundCoord(value: number): number {
  return Number(value.toFixed(6))
}

function greatCircleDistanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const φ1 = lat1 * DEG_TO_RAD
  const φ2 = lat2 * DEG_TO_RAD
  const Δφ = (lat2 - lat1) * DEG_TO_RAD
  const Δλ = (lon2 - lon1) * DEG_TO_RAD
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
}

/** 按球面大圆航向公式，从圆心沿指定方位角偏移指定半径（km）得到圆周坐标。 */
function offsetPoint(longitude: number, latitude: number, radiusKm: number, bearingRad: number): { longitude: number; latitude: number } {
  const δ = radiusKm / EARTH_RADIUS_KM
  const φ1 = latitude * DEG_TO_RAD
  const λ1 = longitude * DEG_TO_RAD
  const sinφ1 = Math.sin(φ1)
  const cosφ1 = Math.cos(φ1)
  const sinδ = Math.sin(δ)
  const cosδ = Math.cos(δ)

  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(bearingRad)
  const φ2 = Math.asin(Math.max(-1, Math.min(1, sinφ2)))
  const λ2 = λ1 + Math.atan2(Math.sin(bearingRad) * sinδ * cosφ1, cosδ - sinφ1 * Math.sin(φ2))
  let lonDeg = λ2 * RAD_TO_DEG
  if (lonDeg > 180) lonDeg -= 360
  if (lonDeg < -180) lonDeg += 360
  return {
    longitude: roundCoord(lonDeg),
    latitude: roundCoord(φ2 * RAD_TO_DEG),
  }
}

/** 根据盘旋圆心、半径（km）、高度与速度生成顺时针均匀分布的盘旋圆周航点数组（供模板与 AFSIM 引擎直接执行）。 */
export function generateLoiterCircleWaypoints(params: LoiterCircleParams): TemplateRoutePoint[] {
  const count = Math.max(4, Math.min(36, Math.round(params.pointCount ?? DEFAULT_LOITER_POINT_COUNT)))
  const radiusKm = Number.isFinite(params.radiusKm) && params.radiusKm > 0 ? params.radiusKm : DEFAULT_LOITER_RADIUS_KM
  const altitude = Number.isFinite(params.altitude) ? params.altitude : 0
  const speed = Number.isFinite(params.speed) ? params.speed : 120
  const points: TemplateRoutePoint[] = []
  for (let i = 0; i < count; i += 1) {
    // 从正东（90°）起始顺时针均匀布点，生成闭合多边形近似圆。
    const bearingRad = (Math.PI / 2) + (2 * Math.PI * i) / count
    const { longitude, latitude } = offsetPoint(params.longitude, params.latitude, radiusKm, bearingRad)
    points.push({ longitude, latitude, altitude, speed })
  }
  return points
}

/** 从已有的盘旋航点数组反推近似圆心、半径、高度和速度，用于编辑旧场景时回显。 */
export function inferLoiterCircle(
  points: readonly TemplateRoutePoint[] | undefined,
  fallback: { longitude: number; latitude: number; altitude: number; speed: number },
): LoiterCircleParams {
  if (!points || points.length === 0) {
    return {
      longitude: roundCoord(fallback.longitude),
      latitude: roundCoord(fallback.latitude),
      radiusKm: DEFAULT_LOITER_RADIUS_KM,
      altitude: fallback.altitude,
      speed: fallback.speed,
      pointCount: DEFAULT_LOITER_POINT_COUNT,
    }
  }
  const avgLon = points.reduce((sum, p) => sum + p.longitude, 0) / points.length
  const avgLat = points.reduce((sum, p) => sum + p.latitude, 0) / points.length
  const distances = points.map(p => greatCircleDistanceKm(avgLon, avgLat, p.longitude, p.latitude))
  const avgRadius = distances.reduce((sum, d) => sum + d, 0) / distances.length
  const radiusKm = Number.isFinite(avgRadius) && avgRadius >= MIN_LOITER_RADIUS_KM
    ? Number(avgRadius.toFixed(2))
    : DEFAULT_LOITER_RADIUS_KM
  return {
    longitude: roundCoord(avgLon),
    latitude: roundCoord(avgLat),
    radiusKm,
    altitude: points[0]!.altitude,
    speed: points[0]!.speed,
    pointCount: Math.max(points.length, DEFAULT_LOITER_POINT_COUNT),
  }
}
