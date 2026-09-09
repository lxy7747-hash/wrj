import { latLng } from 'leaflet'
import { describe, expect, it } from 'vitest'
import { createPlatformGrid } from '../../src/features/scenarios/platform-layout'

const origin = { longitude: 119.5, latitude: 25, altitude: 1500 }

describe('批量节点方形平铺', () => {
  it.each([1, 4, 9, 44, 47])('%s 个节点不多补、不重叠、不修改原点和高度', quantity => {
    const positions = createPlatformGrid(origin, quantity, 1)
    expect(positions).toHaveLength(quantity)
    expect(new Set(positions.map(p => `${p.longitude},${p.latitude}`)).size).toBe(quantity)
    expect(positions.every(p => p.altitude === 1500)).toBe(true)
    expect(origin).toEqual({ longitude: 119.5, latitude: 25, altitude: 1500 })
    if (quantity === 1) expect(positions).toEqual([origin])
    const latitude = positions.map(p => p.latitude)
    const longitude = positions.map(p => p.longitude)
    expect((Math.min(...latitude) + Math.max(...latitude)) / 2).toBeCloseTo(origin.latitude, 10)
    expect((Math.min(...longitude) + Math.max(...longitude)) / 2).toBeCloseTo(origin.longitude, 10)
  })

  it.each([1, 2.5])('四节点居中 2×2 排列，东西／南北间距为 %s km', spacing => {
    const points = createPlatformGrid(origin, 4, spacing).map(p => latLng(p.latitude, p.longitude))
    expect(points[0]!.distanceTo(points[1]!) / 1000).toBeCloseTo(spacing, 3)
    expect(points[0]!.distanceTo(points[2]!) / 1000).toBeCloseTo(spacing, 3)
  })

  it('五节点末行居中，不新增第六个节点', () => {
    const points = createPlatformGrid(origin, 5, 1)
    expect(points[1]!.longitude).toBe(origin.longitude)
    expect((points[3]!.longitude + points[4]!.longitude) / 2).toBeCloseTo(origin.longitude, 10)
    expect(points[3]!.latitude).toBe(points[4]!.latitude)
  })

  it.each([0, -1, NaN, Infinity])('拒绝非法间隔 %s', spacing => {
    expect(() => createPlatformGrid(origin, 4, spacing)).toThrow('节点间隔须大于 0 km')
  })
  it.each([0, -1, 1.5])('拒绝非法数量 %s', quantity => {
    expect(() => createPlatformGrid(origin, quantity, 1)).toThrow(RangeError)
  })
  it.each([{ ...origin, latitude: 90 }, { ...origin, longitude: NaN }, { ...origin, latitude: NaN }])('拒绝无法展开的原点 %j', point => {
    expect(() => createPlatformGrid(point, 4, 1)).toThrow('有效编队原点')
  })
  it.each([{ ...origin, latitude: 89.999 }, { ...origin, longitude: 179.999 }])('跨越坐标边界时拒绝整批 %j', point => {
    expect(() => createPlatformGrid(point, 4, 1)).toThrow('平铺范围超出经纬度边界')
  })
})
