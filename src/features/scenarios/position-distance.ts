import type { Position } from '../../contracts/domain-models'

/** 大圆距离（米）；复用本机运动验证脚本的球面计算，不计高度。 */
export function metersBetween(left: Pick<Position, 'longitude' | 'latitude'>, right: Pick<Position, 'longitude' | 'latitude'>): number {
  const radians = Math.PI / 180
  const latitude = (right.latitude - left.latitude) * radians
  const longitude = (right.longitude - left.longitude) * radians
  const a = Math.sin(latitude / 2) ** 2 + Math.cos(left.latitude * radians) * Math.cos(right.latitude * radians) * Math.sin(longitude / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
