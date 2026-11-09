// 5 秒一帧，允许一个推送周期的抖动；仅控制展示，不改变引擎时间或归档。
export const FRAME_PLAYBACK_TIMEOUT_MS = 10_000
export const FRAME_PLAYBACK_RENDER_MS = 50
const CORRECTION_RATE = 0.2

export class FramePlaybackClock {
  time = 0
  running = false
  timedOut = false
  attached = false
  private frameTime = 0
  private receivedAt = 0
  private tickAt = 0
  private engineEpoch = -1

  startLocal(now: number): void {
    if (this.attached || !Number.isFinite(now)) return
    this.frameTime = this.time
    this.receivedAt = this.tickAt = now
    this.running = true
  }

  attach(now: number): void {
    if (this.attached || !Number.isFinite(now)) return
    this.advance(now)
    this.frameTime = this.time
    this.receivedAt = this.tickAt = now
    this.attached = true
  }

  calibrate(time: number, epoch: number, receivedAt: number, now: number): void {
    if (![time, epoch, receivedAt, now].every(Number.isFinite) || time < 0) return
    this.advance(now)
    if (now - receivedAt >= FRAME_PLAYBACK_TIMEOUT_MS) {
      this.running = false
      this.timedOut = true
      return
    }
    if (!this.running || epoch !== this.engineEpoch || time < this.frameTime) this.time = time
    this.frameTime = time
    this.engineEpoch = epoch
    this.receivedAt = receivedAt
    this.tickAt = now
    this.attached = true
    this.running = true
    this.timedOut = false
  }

  advance(now: number): number {
    if (!this.running || !Number.isFinite(now)) return this.time
    const deadline = this.attached ? this.receivedAt + FRAME_PLAYBACK_TIMEOUT_MS : Infinity
    const at = Math.max(this.tickAt, Math.min(now, deadline))
    const elapsed = (at - this.tickAt) / 1000
    const target = this.frameTime + (at - this.receivedAt) / 1000
    // 普通帧的时差通过有限速率校准，不因网络抖动把展示时间拉回去。
    const correction = Math.max(-elapsed * CORRECTION_RATE, Math.min(elapsed * CORRECTION_RATE, target - this.time - elapsed))
    this.time += elapsed + correction
    this.tickAt = at
    if (now >= deadline) { this.running = false; this.timedOut = true }
    return this.time
  }

  freeze(): void { this.running = false }

  reset(time = 0): void {
    this.time = time
    this.running = false
    this.timedOut = false
    this.attached = false
    this.frameTime = 0
    this.receivedAt = 0
    this.tickAt = 0
    this.engineEpoch = -1
  }
}
