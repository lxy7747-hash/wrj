export interface CurvePointLike {
  label?: string
  value: number
  time?: number
  breakBefore?: boolean
}

/** 导出 SVG（540px）与 PDF（400pt）折线图的单图最大顶点数；像素级无损保留极值与波形轮廓。 */
export const EXPORT_CURVE_MAX_POINTS = 480
/** 折线图保留全部独立圆点标记的阈值；超过后仅保留均匀/极值关键标记。 */
export const EXPORT_CURVE_FULL_MARKER_LIMIT = 80
/** 超过全量阈值后的最大圆点标记数量。 */
export const EXPORT_CURVE_MAX_MARKERS = 60
/** SVG 允许保留独立 `<polyline>` 的最大分段数；超过后合并为单条 `<path>`。 */
export const EXPORT_CURVE_MAX_POLYLINES = 80

/**
 * Min-Max 分桶降采样：
 * - 点数 ≤ maxPoints 时原样返回（不改变小图测试与精确点序）。
 * - 超过阈值时按桶保留每桶最小值与最大值（按原始顺序），并始终保留首点、末点、全局最小/最大值及断点状态。
 * - 即使存在大量 `breakBefore`（如逐帧断帧），总输出点数仍严格有界（≤ maxPoints + 4）。
 */
export function downsampleCurveRows<T extends CurvePointLike>(
  rows: readonly T[],
  maxPoints = EXPORT_CURVE_MAX_POINTS,
): T[] {
  const n = rows.length
  if (n <= maxPoints || maxPoints < 4) return rows as T[]

  let globalMinIdx = 0
  let globalMaxIdx = 0
  for (let i = 1; i < n; i += 1) {
    const v = rows[i]!.value
    if (v < rows[globalMinIdx]!.value) globalMinIdx = i
    if (v > rows[globalMaxIdx]!.value) globalMaxIdx = i
  }

  const chosen = new Set<number>([0, n - 1, globalMinIdx, globalMaxIdx])
  // 每个桶最多选 min/max 两个点，因此桶数取 (maxPoints - 4) / 2。
  const interiorCount = n - 2
  const bucketCount = Math.max(1, Math.floor((maxPoints - 4) / 2))
  const bucketSize = interiorCount / bucketCount

  for (let b = 0; b < bucketCount; b += 1) {
    const start = 1 + Math.floor(b * bucketSize)
    const end = Math.min(n - 1, 1 + Math.floor((b + 1) * bucketSize))
    if (start >= end) continue
    let minIdx = start
    let maxIdx = start
    let minVal = rows[start]!.value
    let maxVal = minVal
    for (let i = start + 1; i < end; i += 1) {
      const v = rows[i]!.value
      if (v < minVal) { minVal = v; minIdx = i }
      if (v > maxVal) { maxVal = v; maxIdx = i }
    }
    chosen.add(minIdx)
    chosen.add(maxIdx)
  }

  const ordered = [...chosen].sort((a, b) => a - b)
  const result: T[] = new Array(ordered.length)
  for (let k = 0; k < ordered.length; k += 1) {
    const idx = ordered[k]!
    const prevIdx = k === 0 ? -1 : ordered[k - 1]!
    let hasBreak = Boolean(rows[idx]!.breakBefore)
    if (!hasBreak && prevIdx >= 0) {
      for (let j = prevIdx + 1; j <= idx; j += 1) {
        if (rows[j]!.breakBefore) { hasBreak = true; break }
      }
    }
    const row = rows[idx]!
    result[k] = hasBreak === Boolean(row.breakBefore) ? row : { ...row, breakBefore: true }
  }
  return result
}

/**
 * 计算需要渲染圆点标记的索引集合（对大图控制在 <= EXPORT_CURVE_MAX_MARKERS 个，始终包含首尾与全局极值）。
 */
export function selectCurveMarkerIndices(rows: readonly CurvePointLike[]): Set<number> {
  const n = rows.length
  const indices = new Set<number>()
  if (n === 0) return indices
  if (n <= EXPORT_CURVE_FULL_MARKER_LIMIT) {
    for (let i = 0; i < n; i += 1) indices.add(i)
    return indices
  }
  let minIdx = 0
  let maxIdx = 0
  for (let i = 1; i < n; i += 1) {
    if (rows[i]!.value < rows[minIdx]!.value) minIdx = i
    if (rows[i]!.value > rows[maxIdx]!.value) maxIdx = i
  }
  indices.add(0)
  indices.add(n - 1)
  indices.add(minIdx)
  indices.add(maxIdx)
  const step = Math.max(1, Math.ceil(n / EXPORT_CURVE_MAX_MARKERS))
  for (let i = 0; i < n; i += step) indices.add(i)
  return indices
}

export interface StreamingCurvePoint {
  time: number
  value: number
  breakBefore?: boolean
}

/**
 * 单遍流式有界采样器：用于原生帧归档导出时同时聚合多条曲线，内存严格 O(maxPoints)。
 * 当点数达到 2 * maxPoints 时按 Min-Max 成对压缩回 maxPoints，并始终精确跟踪全局极值与首末点。
 */
export class StreamingCurveReservoir {
  readonly maxPoints: number
  rawCount = 0
  private buffer: StreamingCurvePoint[] = []
  private firstPoint: StreamingCurvePoint | null = null
  private lastPoint: StreamingCurvePoint | null = null
  private minPoint: StreamingCurvePoint | null = null
  private maxPoint: StreamingCurvePoint | null = null

  constructor(maxPoints = EXPORT_CURVE_MAX_POINTS) {
    this.maxPoints = Math.max(16, maxPoints)
  }

  push(time: number, value: number, breakBefore: boolean): void {
    const point: StreamingCurvePoint = breakBefore ? { time, value, breakBefore: true } : { time, value }
    this.rawCount += 1
    if (this.firstPoint === null) this.firstPoint = point
    this.lastPoint = point
    if (this.minPoint === null || value < this.minPoint.value) this.minPoint = point
    if (this.maxPoint === null || value > this.maxPoint.value) this.maxPoint = point
    this.buffer.push(point)
    if (this.buffer.length >= this.maxPoints * 2) {
      this.buffer = downsampleCurveRows(this.buffer, this.maxPoints)
    }
  }

  finalize(): { rawCount: number; sampling: 'FULL' | 'DOWNSAMPLED'; points: StreamingCurvePoint[] } {
    if (this.rawCount === 0) return { rawCount: 0, sampling: 'FULL', points: [] }
    if (this.rawCount <= this.maxPoints) {
      return { rawCount: this.rawCount, sampling: 'FULL', points: this.buffer }
    }
    const merged = downsampleCurveRows(this.buffer, this.maxPoints)
    // 确保极端情况下首末点与全局极值一定存在（按时间序插入去重）。
    const mustHave = [this.firstPoint, this.minPoint, this.maxPoint, this.lastPoint].filter(
      (p): p is StreamingCurvePoint => p !== null,
    )
    const byKey = new Set(merged.map(p => `${p.time}:${p.value}`))
    let added = false
    for (const p of mustHave) {
      const k = `${p.time}:${p.value}`
      if (!byKey.has(k)) {
        merged.push(p)
        byKey.add(k)
        added = true
      }
    }
    if (added) merged.sort((a, b) => a.time - b.time)
    return { rawCount: this.rawCount, sampling: 'DOWNSAMPLED', points: merged }
  }
}
