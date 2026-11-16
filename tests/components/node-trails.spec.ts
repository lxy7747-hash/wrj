import { describe, expect, it } from 'vitest'
import { createNodeTrailTracker, replayNodeTrails } from '../../src/features/situation/node-trails'
import { LOCAL_REPLAY } from '../fixtures/local-replay'

const node = LOCAL_REPLAY.initial.nodes[0]!

describe('节点运动轨迹', () => {
  it('只累积明确时刻的位置，静止、重复和同刻冲突不增加线段', () => {
    const track = createNodeTrailTracker()
    expect(track('run', [{ ...node, time: undefined }])).toEqual([])
    expect(track('run', [node])).toEqual([])
    expect(track('run', [{ ...node, time: 1 }])).toEqual([])
    const moved = { ...node, time: 2, longitude: node.longitude + 1 }
    expect(track('run', [moved])[0]!.points.map(point => point.time)).toEqual([0, 2])
    expect(track('run', [moved])[0]!.points).toHaveLength(2)
    expect(track('run', [{ ...moved, longitude: 130 }])[0]!.points.at(-1)!.longitude).toBe(moved.longitude)
  })

  it('支持完整遥测帧时刻，不使用静态配置制造轨迹', () => {
    const track = createNodeTrailTracker(), initial = { ...node, time: undefined }
    track('mock', [initial], 0)
    expect(track('mock', [{ ...initial, longitude: -78 }], 1)[0]!.points).toHaveLength(2)
  })

  it.each(['run', 'epoch', 'seek'])('%s变化不串接旧轨迹', reason => {
    const track = createNodeTrailTracker()
    track('before', [node])
    expect(track('before', [{ ...node, time: 1, longitude: -78 }])).toHaveLength(1)
    expect(track(reason, [{ ...node, time: 2, longitude: -79 }])).toEqual([])
  })

  it('时间倒退、节点移除或位置来源变化后重新起线', () => {
    const track = createNodeTrailTracker()
    track('run', [node])
    track('run', [{ ...node, time: 2, longitude: -78 }])
    expect(track('run', [{ ...node, time: 1, longitude: -79 }])).toEqual([])
    expect(track('run', [{ ...node, time: 3, longitude: -80, positionSource: 'ENGINE' }])).toEqual([])
    expect(track('run', [])).toEqual([])
    expect(track('run', [{ ...node, time: 4, longitude: -81 }])).toEqual([])
  })

  it('丢弃无效坐标或时刻，不污染已有点', () => {
    const track = createNodeTrailTracker()
    track('run', [node])
    for (const changes of [{ longitude: NaN }, { latitude: 91 }, { longitude: 181 }, { time: Infinity }, { time: -1 }]) {
      expect(track('run', [{ ...node, time: 1, ...changes }])).toEqual([])
    }
  })

  it('回放按原始记录截取完整已知轨迹，前后定位不包含未来，隐藏节点不留轨迹', () => {
    const before = JSON.stringify(LOCAL_REPLAY)
    const nodes = LOCAL_REPLAY.initial.nodes
    expect(replayNodeTrails(LOCAL_REPLAY, 3, nodes)[0]!.points.map(point => point.time)).toEqual([0, 1, 3])
    expect(replayNodeTrails(LOCAL_REPLAY, 1, nodes)[0]!.points.map(point => point.time)).toEqual([0, 1])
    expect(replayNodeTrails(LOCAL_REPLAY, 0, nodes)).toEqual([])
    expect(replayNodeTrails(LOCAL_REPLAY, 3, [])).toEqual([])
    expect(JSON.stringify(LOCAL_REPLAY)).toBe(before)
  })
})
