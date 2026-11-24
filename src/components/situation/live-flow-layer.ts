import L from 'leaflet'
import { MAP_CONFIG } from '../../config/map.config'

const PULSE_MS = MAP_CONFIG.linkFlowCycleSeconds * 1000
const TRAIL_RATIO = MAP_CONFIG.linkFlowTrailRatio

export interface LiveFlowPath {
  id: string
  pulseId: string
  points: L.LatLngTuple[]
}

interface ProjectedPath {
  points: L.Point[]
  lengths: number[]
  length: number
}

interface Pulse {
  pulseId: string
  points: L.LatLngTuple[]
  elapsed: number
  updatedAt: number
  projected?: ProjectedPath
}

function projectPath(map: L.Map, points: L.LatLngTuple[]): ProjectedPath {
  const pixels = points.map(point => map.latLngToLayerPoint(point))
  const lengths = [0]
  let length = 0
  for (let index = 1; index < pixels.length; index += 1) {
    length += pixels[index]!.distanceTo(pixels[index - 1]!)
    lengths.push(length)
  }
  return { points: pixels, lengths, length }
}

function tracePulse(context: CanvasRenderingContext2D, path: ProjectedPath, elapsed: number): void {
  const head = (1 + TRAIL_RATIO) * elapsed / PULSE_MS
  const start = Math.max(0, head - TRAIL_RATIO) * path.length
  const end = Math.min(head, 1) * path.length
  if (start >= end) return

  const { points, lengths } = path
  let index = 1
  while (lengths[index]! <= start) index += 1
  const first = points[index - 1]!
  const next = points[index]!
  const startRatio = (start - lengths[index - 1]!) / (lengths[index]! - lengths[index - 1]!)
  context.moveTo(first.x + (next.x - first.x) * startRatio, first.y + (next.y - first.y) * startRatio)

  while (lengths[index]! < end) {
    const point = points[index]!
    context.lineTo(point.x, point.y)
    index += 1
  }
  const previous = points[index - 1]!
  const last = points[index]!
  const endRatio = (end - lengths[index - 1]!) / (lengths[index]! - lengths[index - 1]!)
  context.lineTo(previous.x + (last.x - previous.x) * endRatio, previous.y + (last.y - previous.y) * endRatio)
}

/** Draws live pulses on a single canvas, independently of the interactive link layers. */
export function createLiveFlowLayer(map: L.Map, pane: HTMLElement) {
  const pulses = new Map<string, Pulse>()
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  let ready = false
  let visible = true
  let playing = false
  let frame: number | undefined
  let canvas: HTMLCanvasElement | undefined
  let context: CanvasRenderingContext2D | null | undefined
  let position: L.Point | undefined
  let viewOrigin: L.Point | undefined
  let viewZoom: number | undefined

  function elapsedAt(pulse: Pulse, now: number): number {
    return pulse.elapsed + (playing ? now - pulse.updatedAt : 0)
  }

  function detach(): void {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    canvas?.remove()
  }

  function schedulePaint(now = performance.now()): void {
    if (!ready || !visible || reducedMotion?.matches || frame !== undefined || context === null) return
    if (!canvas?.parentNode && ![...pulses.values()].some(pulse => elapsedAt(pulse, now) < PULSE_MS)) return
    frame = requestAnimationFrame(paint)
  }

  function paint(): void {
    frame = undefined
    const now = performance.now()
    const active = [...pulses.values()].filter(pulse => elapsedAt(pulse, now) < PULSE_MS)
    if (active.length === 0) {
      canvas?.remove()
      return
    }

    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.className = 'situation-map-live-flow leaflet-zoom-hide'
      canvas.style.position = 'absolute'
      canvas.style.pointerEvents = 'none'
      canvas.setAttribute('aria-hidden', 'true')
      context = canvas.getContext('2d')
    }
    if (!context) return
    if (!canvas.parentNode) pane.append(canvas)

    const ratio = window.devicePixelRatio || 1
    const size = map.getSize()
    const width = Math.round(size.x * ratio)
    const height = Math.round(size.y * ratio)
    if (canvas.width !== width || canvas.height !== height || !canvas.style.width) {
      canvas.width = width
      canvas.height = height
      canvas.style.width = `${size.x}px`
      canvas.style.height = `${size.y}px`
    }
    const topLeft = map.containerPointToLayerPoint([0, 0])
    if (!position?.equals(topLeft)) {
      L.DomUtil.setPosition(canvas, topLeft)
      position = topLeft
    }

    const origin = map.getPixelOrigin()
    const zoom = map.getZoom()
    if (!viewOrigin?.equals(origin) || viewZoom !== zoom) {
      for (const pulse of pulses.values()) pulse.projected = undefined
      viewOrigin = origin
      viewZoom = zoom
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, size.x, size.y)
    context.setTransform(ratio, 0, 0, ratio, -topLeft.x * ratio, -topLeft.y * ratio)
    context.strokeStyle = 'rgba(232, 252, 255, 0.95)'
    context.lineWidth = 2.5
    context.beginPath()
    for (const pulse of active) {
      pulse.projected ??= projectPath(map, pulse.points)
      tracePulse(context, pulse.projected, elapsedAt(pulse, now))
    }
    context.stroke()
    if (playing) schedulePaint(now)
  }

  const onViewChange = () => schedulePaint()
  const onMotionChange = () => reducedMotion?.matches ? detach() : schedulePaint()
  const onReady = () => {
    ready = true
    schedulePaint()
  }
  map.whenReady(onReady)
  map.on('move zoom viewreset resize', onViewChange)
  reducedMotion?.addEventListener?.('change', onMotionChange)

  function clear(): void {
    pulses.clear()
    detach()
  }

  return {
    update(paths: readonly LiveFlowPath[], nextPlaying: boolean): void {
      const now = performance.now()
      const ids = new Set<string>()
      for (const { id, pulseId, points } of paths) {
        ids.add(id)
        let pulse = pulses.get(id)
        if (!pulse) {
          pulse = { pulseId, points, elapsed: 0, updatedAt: now }
          pulses.set(id, pulse)
          continue
        }
        const elapsed = elapsedAt(pulse, now)
        if (pulse.pulseId !== pulseId && elapsed >= PULSE_MS) {
          pulse.elapsed = 0
          pulse.updatedAt = now
        } else if (playing !== nextPlaying) {
          pulse.elapsed = elapsed
          pulse.updatedAt = now
        }
        pulse.pulseId = pulseId
        if (pulse.points !== points) {
          pulse.points = points
          pulse.projected = undefined
        }
      }
      for (const id of pulses.keys()) if (!ids.has(id)) pulses.delete(id)
      playing = nextPlaying
      schedulePaint(now)
    },
    setVisible(nextVisible: boolean): void {
      if (visible === nextVisible) return
      visible = nextVisible
      if (visible) schedulePaint()
      else detach()
    },
    clear,
    destroy(): void {
      clear()
      ready = false
      map.off('load', onReady)
      map.off('move zoom viewreset resize', onViewChange)
      reducedMotion?.removeEventListener?.('change', onMotionChange)
    },
  }
}
