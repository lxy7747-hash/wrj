// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseAfsimEventLog } from '../../src/features/data-exchange/afsim-event-log'
import { buildFilePlatformDeletions, isFilePlatformDeletion } from '../../src/features/situation/platform-lifecycle'
import { isInitialNodeSnapshot } from '../../src/features/situation/initial-nodes'
import { isLocalReplaySnapshot, selectReplayNodes, type LocalReplaySnapshot } from '../../src/features/replays/local-replay'
import { LOCAL_REPLAY } from '../fixtures/local-replay'

const DECLARATION = [
  '! PLATFORM_ADDED,time<time>,event<string>,platform<string>,side<string>,type<string>',
  '! PLATFORM_DELETED,time<time>,event<string>,platform<string>,side<string>,type<string>',
  '! MOVER_TURNED_ON,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>,lat<lat>,lon<lon>,alt<double>,heading<double>,pitch<double>,roll<double>,ned_speed<double>',
]

const CSV = [
  ...DECLARATION,
  '0,PLATFORM_ADDED,A,blue,DRONE',
  '0,PLATFORM_ADDED,B,blue,DRONE',
  '0,MOVER_TURNED_ON,A,blue,Mover,mover,WSF_AIR_MOVER,25,120,3000,0,0,0,100',
  '0,MOVER_TURNED_ON,B,blue,Mover,mover,WSF_AIR_MOVER,26,121,3000,0,0,0,100',
].join('\n')

const build = (text = CSV, ids = ['A', 'B']) => ({
  parsed: parseAfsimEventLog(text),
  deletions: buildFilePlatformDeletions(parseAfsimEventLog(text).events, new Set(ids)),
})

const replay = (base: LocalReplaySnapshot, deletions: LocalReplaySnapshot['initial']['platformDeletions']): LocalReplaySnapshot => ({
  ...structuredClone(base),
  initial: { ...structuredClone(base.initial), platformDeletions: deletions },
})

describe('文件平台生命周期', () => {
  it('只提取已登记平台的删除记录，未登记平台不新建节点', () => {
    const { deletions } = build(`${CSV}\n5400,PLATFORM_DELETED,A,blue,DRONE\n5400,PLATFORM_DELETED,UNKNOWN,blue,DRONE`)
    expect(deletions).toEqual([{ sourceEventId: 'LOG-L8', platformId: 'A', time: 5400 }])
  })

  it('同一平台重复删除保留最早时刻，不因后发记录让节点复活', () => {
    const { deletions } = build(`${CSV}\n5400,PLATFORM_DELETED,A,blue,DRONE\n100,PLATFORM_DELETED,A,blue,DRONE`)
    expect(deletions).toEqual([{ sourceEventId: 'LOG-L9', platformId: 'A', time: 100 }])
  })

  it('没有删除事件时返回空集合，字段校验拒绝未登记平台与非法时刻', () => {
    expect(build().deletions).toEqual([])
    const ids = new Set(['A'])
    expect(isFilePlatformDeletion({ sourceEventId: 'LOG-L1', platformId: 'A', time: 0 }, ids)).toBe(true)
    for (const changes of [
      { platformId: 'B' }, { sourceEventId: '' }, { time: -1 }, { time: Infinity }, { time: '1' },
    ]) {
      expect(isFilePlatformDeletion({ sourceEventId: 'LOG-L1', platformId: 'A', time: 0, ...changes }, ids)).toBe(false)
    }
    expect(isFilePlatformDeletion(null, ids)).toBe(false)
  })

  it('回放游标到达删除时刻后移除节点，到达前保留；总时长必须包含删除时刻', () => {
    const snapshot = replay(LOCAL_REPLAY, [
      { sourceEventId: 'LOG-L90', platformId: 'A', time: 2.5 },
      { sourceEventId: 'LOG-L91', platformId: 'B', time: 9 },
    ])
    // 位置记录末刻只有 3 秒，删除时刻 9 秒必须计入总时长，否则回放游标永远到不了删除时刻。
    expect(snapshot.durationS).toBe(3)
    expect(isLocalReplaySnapshot(snapshot)).toBe(false)
    const valid: LocalReplaySnapshot = { ...snapshot, durationS: 9 }
    expect(isLocalReplaySnapshot(valid)).toBe(true)

    expect(selectReplayNodes(valid, 0).map(node => node.platformId)).toEqual(['A', 'B'])
    expect(selectReplayNodes(valid, 2.4).map(node => node.platformId)).toEqual(['A', 'B'])
    // A 在 2.5 秒删除，B 在 9 秒删除。
    expect(selectReplayNodes(valid, 2.5).map(node => node.platformId)).toEqual(['B'])
    expect(selectReplayNodes(valid, 3).map(node => node.platformId)).toEqual(['B'])
    expect(selectReplayNodes(valid, 9)).toEqual([])
  })

  it('没有删除记录时节点集合与旧版本一致，不改变既有行为', () => {
    expect(selectReplayNodes(LOCAL_REPLAY, 0).map(node => node.platformId)).toEqual(['A', 'B'])
    expect(selectReplayNodes(LOCAL_REPLAY, 3).map(node => node.platformId)).toEqual(['A', 'B'])
    const withoutField: LocalReplaySnapshot = structuredClone(LOCAL_REPLAY)
    delete withoutField.initial.platformDeletions
    expect(selectReplayNodes(withoutField, 3).map(node => node.platformId)).toEqual(['A', 'B'])
  })

  it('快照校验拒绝重复平台、未登记平台和非法删除记录', () => {
    const base = { ...LOCAL_REPLAY.initial }
    expect(isInitialNodeSnapshot(base)).toBe(true)
    const deletion = { sourceEventId: 'LOG-L90', platformId: 'A', time: 1 }
    expect(isInitialNodeSnapshot({ ...base, platformDeletions: [deletion] })).toBe(true)
    expect(isInitialNodeSnapshot({ ...base, platformDeletions: [deletion, deletion] })).toBe(false)
    expect(isInitialNodeSnapshot({ ...base, platformDeletions: [{ ...deletion, platformId: 'Z' }] })).toBe(false)
    expect(isInitialNodeSnapshot({ ...base, platformDeletions: [{ ...deletion, time: -1 }] })).toBe(false)
    expect(isInitialNodeSnapshot({ ...base, platformDeletions: [null] })).toBe(false)
    expect(isInitialNodeSnapshot({ ...base, platformDeletions: {} })).toBe(false)
  })
})
