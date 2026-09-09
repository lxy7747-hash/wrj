import type { Platform } from '../../contracts/domain-models'

/** 按东西／南北方向排列局部方形网格；不足一行时居中，不额外补节点。 */
export function createPlatformGrid(origin: Platform['initialPosition'], quantity: number, spacingKm: number): Platform['initialPosition'][] {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || !Number.isFinite(spacingKm) || spacingKm <= 0) {
    throw new RangeError('新增数量须为正整数，节点间隔须大于 0 km。')
  }
  if (quantity === 1) return [{ ...origin }]
  if (!Number.isFinite(origin.longitude) || Math.abs(origin.longitude) > 180
    || !Number.isFinite(origin.latitude) || Math.abs(origin.latitude) >= 90) {
    throw new RangeError('请设置有效编队原点，极点不支持方形平铺。')
  }
  const columns = Math.ceil(Math.sqrt(quantity))
  const rows = Math.ceil(quantity / columns)
  // 局部平铺使用球面切平面近似；经向距离按原点纬度修正，不把 1 km 当成固定经度差。
  const latitudeStep = spacingKm / 6371 * 180 / Math.PI
  const longitudeStep = latitudeStep / Math.cos(origin.latitude * Math.PI / 180)
  return Array.from({ length: quantity }, (_, index) => {
    const row = Math.floor(index / columns)
    const rowSize = Math.min(columns, quantity - row * columns)
    const latitude = origin.latitude + ((rows - 1) / 2 - row) * latitudeStep
    const longitude = origin.longitude + (index % columns - (rowSize - 1) / 2) * longitudeStep
    if (Math.abs(latitude) >= 90 || Math.abs(longitude) > 180) {
      throw new RangeError('平铺范围超出经纬度边界，请调整编队原点或减小节点间隔。')
    }
    return { longitude, latitude, altitude: origin.altitude }
  })
}
