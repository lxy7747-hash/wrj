import { describe, expect, it } from 'vitest'
import { FramePlaybackClock, FRAME_PLAYBACK_TIMEOUT_MS } from '../../src/features/situation/frame-playback-clock'
import { selectReplayNodes } from '../../src/features/replays/local-replay'
import { LOCAL_REPLAY } from '../fixtures/local-replay'

describe('连续展示时钟', () => {
  it('接入前本地连续推进且可暂停恢复，接入后才启用无帧超时，重播清除接入状态', () => {
    const clock = new FramePlaybackClock()
    clock.startLocal(1000)
    expect(clock.advance(31_000)).toBe(30)
    expect(clock.attached).toBe(false)
    clock.freeze()
    expect(clock.advance(40_000)).toBe(30)
    clock.startLocal(40_000)
    expect(clock.advance(41_000)).toBe(31)
    clock.attach(41_000)
    expect(clock.advance(46_000)).toBe(36)
    clock.attach(46_000) // 重复连接通知不延长无帧期限。
    expect(clock.advance(60_000)).toBe(41)
    expect(clock.timedOut).toBe(true)
    clock.startLocal(60_000)
    expect(clock.running).toBe(false)
    clock.calibrate(5, 0, 60_000, 60_000)
    expect(clock.advance(61_000)).toBe(6)
    clock.reset()
    clock.startLocal(70_000)
    expect(clock.advance(71_000)).toBe(1)
    expect(clock.attached).toBe(false)
  })

  it('每五秒校准一次，帧间持续前进；普通延迟校准不倒退', () => {
    const clock = new FramePlaybackClock()
    expect(clock.advance(1000)).toBe(0)
    clock.calibrate(5, 0, 1000, 1000)
    expect(clock.advance(1500)).toBe(5.5)
    expect(clock.advance(3500)).toBe(7.5)
    expect(clock.advance(6000)).toBe(10)
    clock.calibrate(10, 0, 6000, 6000)
    expect(clock.advance(8500)).toBe(12.5)
    clock.calibrate(15, 0, 11500, 11500)
    const before = clock.time
    expect(clock.advance(12000)).toBeGreaterThan(before)
    expect(clock.time - before).toBeLessThan(0.5)
  })

  it('断线或暂停立即冻结，超时含后台页长停顿也不无限推进，新帧才恢复', () => {
    const clock = new FramePlaybackClock()
    clock.calibrate(0, 0, 0, 0)
    expect(clock.advance(2500)).toBe(2.5)
    clock.freeze()
    expect(clock.advance(30_000)).toBe(2.5)
    clock.calibrate(5, 0, 30_000, 30_000)
    expect(clock.advance(30_500)).toBe(5.5)
    expect(clock.advance(100_000)).toBe(15)
    expect(clock.timedOut).toBe(true)
    expect(clock.running).toBe(false)
    clock.calibrate(10, 0, 0, FRAME_PLAYBACK_TIMEOUT_MS + 1)
    expect(clock.time).toBe(15)
    clock.calibrate(20, 0, 101_000, 101_000)
    expect(clock.running).toBe(true)
    expect(clock.time).toBe(20)
  })

  it('引擎归零和新运行清除旧锚点；非法时刻不能推进', () => {
    const clock = new FramePlaybackClock()
    clock.calibrate(100, 0, 0, 0)
    clock.advance(1000)
    clock.calibrate(0, 1, 1000, 1000)
    expect(clock.time).toBe(0)
    expect(clock.advance(1500)).toBe(0.5)
    clock.reset()
    expect(clock.advance(2000)).toBe(0)
    clock.calibrate(NaN, 0, 2000, 2000)
    expect(clock.running).toBe(false)
    clock.calibrate(5, 0, 2000, 2000)
    expect(clock.time).toBe(5)
  })
})

describe('本地轨迹展示插值', () => {
  it('仅显式开启时插值相邻轨迹和初始位置，不改文件、不外推末尾', () => {
    const snapshot = structuredClone(LOCAL_REPLAY)
    expect(selectReplayNodes(snapshot, 0.5, true)[0]).toMatchObject({ longitude: -77.5, latitude: 30.5, altitude: 5 })
    expect(selectReplayNodes(snapshot, 2, true)[0]).toMatchObject({ longitude: -78.5, latitude: 31.5, altitude: 15 })
    expect(selectReplayNodes(snapshot, 2)[0]?.longitude).toBe(-78)
    expect(selectReplayNodes(snapshot, 100, true)[0]?.longitude).toBe(-79)
    expect(snapshot).toEqual(LOCAL_REPLAY)
  })

  it('跨日期变更线走短路径，新增/删除节点仍严格按时间生效', () => {
    const snapshot = structuredClone(LOCAL_REPLAY)
    snapshot.initial.nodes[0]!.longitude = 179
    snapshot.tracks[1]!.positions[0]!.longitude = -179
    snapshot.initial.nodes[1]!.time = 2
    snapshot.initial.platformDeletions = [{ platformId: 'A', time: 2.5, sourceEventId: 'DELETE-A' }]
    expect(Math.abs(selectReplayNodes(snapshot, 0.5, true)[0]!.longitude)).toBe(180)
    expect(selectReplayNodes(snapshot, 1, true).map(node => node.platformId)).toEqual(['A'])
    expect(selectReplayNodes(snapshot, 2.5, true).map(node => node.platformId)).toEqual(['B'])
  })
})
