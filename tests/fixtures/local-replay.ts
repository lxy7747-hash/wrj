import type { LocalReplaySnapshot } from '../../src/features/replays/local-replay'

/** 初始化与轨迹共用的小型真实文件样本，不触碰用户原始 CSV。 */
export const INITIAL_LOG = [
  '0 PLATFORM_ADDED A Type: AIR Side: blue',
  '0 PLATFORM_ADDED B Type: GROUND Side: blue',
  '0 MOVER_TURNED_ON A Mover: mover Type: WSF_AIR_MOVER',
  ' LLA: 30:00:00n 77:00:00w 0 m Heading: 0 deg Pitch: 0 deg Roll: 0 deg',
  ' Speed: 10 m/s',
  '0 MOVER_TURNED_ON B Mover: mover Type: WSF_GROUND_MOVER',
  ' LLA: 25:00:00n 117:00:00e 0 m Heading: 0 deg Pitch: 0 deg Roll: 0 deg',
  ' Speed: 0 m/s',
].join('\n')

export const POSITION_CSV = 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n0,B,117,25,0,0,90\n1,A,-78,31,10,10,-1\n3,A,-79,32,20,20,175\n'

export const LOCAL_REPLAY: LocalReplaySnapshot = {
  initial: { fileName: 'initial.csv', sha256: 'a'.repeat(64), nodes: [
    { platformId: 'A', name: 'A', type: 'AIR', longitude: -77, latitude: 30, altitude: 0, speed: 10, time: 0, sourceEventId: 'LOG-L3' },
    { platformId: 'B', name: 'B', type: 'GROUND', longitude: 117, latitude: 25, altitude: 0, speed: 0, time: 0, sourceEventId: 'LOG-L6' },
  ] },
  fileName: 'positions.csv', sha256: 'b'.repeat(64), durationS: 3, recordCount: 3,
  tracks: [
    { platformId: 'B', positions: [{ time: 0, platformId: 'B', longitude: 117, latitude: 25, altitude: 0, speed: 0, heading: 90 }] },
    { platformId: 'A', positions: [
      { time: 1, platformId: 'A', longitude: -78, latitude: 31, altitude: 10, speed: 10, heading: -1 },
      { time: 3, platformId: 'A', longitude: -79, latitude: 32, altitude: 20, speed: 20, heading: 175 },
    ] },
  ],
  issueCount: 0, issues: [], waitingForLine: false,
}
