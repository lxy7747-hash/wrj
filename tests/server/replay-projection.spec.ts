import { beforeAll, describe, expect, it } from 'vitest'
import type { Replay } from '../../src/contracts/domain-models'

type ReplayResult<T> = { ok: true; data: T } | { ok: false; code: string; status: number; fieldPath?: string }

interface ReplayProjectionInstance {
  list(): Replay[]
  get(replayId: string): ReplayResult<Replay>
  command(replayId: string, value: unknown): ReplayResult<Replay>
  reset(): void
}

let ReplayProjection: new () => ReplayProjectionInstance

beforeAll(async () => {
  const module = await import('../../server/replays/' + 'projection.js') as { ReplayProjection: typeof ReplayProjection }
  ;({ ReplayProjection } = module)
})

describe('回放服务端投影', () => {
  it('回放命令只改变游标、播放状态和倍速校验', () => {
    const projection = new ReplayProjection()
    expect(projection.list()).toMatchObject([{ replayId: 'REPLAY-001', runId: 'RUN-001' }])
    expect(projection.get('REPLAY-MISSING')).toMatchObject({ ok: false, status: 404 })
    expect(projection.command('REPLAY-MISSING', { command: 'PLAY' })).toMatchObject({ ok: false, status: 404 })
    for (const command of [null, [], 'PLAY', {}, { command: 'PLAY', value: 1 }, { command: 'SEEK' }, { command: 'SPEED', value: 'fast' }, { command: 'SPEED', value: Number.NaN }]) {
      expect(projection.command('REPLAY-001', command)).toMatchObject({ ok: false, status: 422 })
    }
    expect(projection.command('REPLAY-001', { command: 'PAUSE' })).toMatchObject({ ok: false, status: 409 })
    expect(projection.command('REPLAY-001', { command: 'PLAY' })).toMatchObject({ ok: true, data: { state: 'PLAYING' } })
    expect(projection.command('REPLAY-001', { command: 'SEEK', value: 2539 })).toMatchObject({ ok: true, data: { state: 'PLAYING', currentTimeS: 2539 } })
    expect(projection.command('REPLAY-001', { command: 'PAUSE' })).toMatchObject({ ok: true, data: { state: 'PAUSED', currentTimeS: 2539 } })
    expect(projection.command('REPLAY-001', { command: 'SEEK', value: -1 })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' })
    expect(projection.command('REPLAY-001', { command: 'SEEK', value: 7201 })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' })
    expect(projection.command('REPLAY-001', { command: 'SEEK', value: 7200 })).toMatchObject({ ok: true, data: { state: 'COMPLETED', currentTimeS: 7200 } })
    expect(projection.command('REPLAY-001', { command: 'STEP_FORWARD' })).toMatchObject({ ok: true, data: { state: 'COMPLETED', currentTimeS: 7200 } })
    expect(projection.command('REPLAY-001', { command: 'PLAY' })).toMatchObject({ ok: true, data: { state: 'PLAYING', currentTimeS: 0 } })
    expect(projection.command('REPLAY-001', { command: 'STEP_FORWARD' })).toMatchObject({ ok: true, data: { state: 'PAUSED', currentTimeS: 1 } })
    expect(projection.command('REPLAY-001', { command: 'STEP_BACK' })).toMatchObject({ ok: true, data: { state: 'PAUSED', currentTimeS: 0 } })
    expect(projection.command('REPLAY-001', { command: 'SEEK', value: 7200 })).toMatchObject({ ok: true, data: { state: 'COMPLETED' } })
    expect(projection.command('REPLAY-001', { command: 'STEP_BACK' })).toMatchObject({ ok: true, data: { state: 'PAUSED', currentTimeS: 7199 } })
    expect(projection.command('REPLAY-001', { command: 'SPEED', value: 0 })).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' })
  })

  it('reset 恢复冻结回放游标且返回防御性副本', () => {
    const projection = new ReplayProjection()
    const listed = projection.list()
    listed[0]!.state = 'PLAYING'
    expect(projection.get('REPLAY-001')).toMatchObject({ ok: true, data: { state: 'PAUSED' } })
    projection.command('REPLAY-001', { command: 'SEEK', value: 12 })
    projection.reset()
    expect(projection.get('REPLAY-001')).toMatchObject({ ok: true, data: { state: 'PAUSED', currentTimeS: 2537 } })
    expect(projection.command('REPLAY-001', { command: 'SEEK', value: 0 })).toMatchObject({ ok: true, data: { currentTimeS: 0 } })
    expect(projection.command('REPLAY-001', { command: 'STEP_BACK' })).toMatchObject({ ok: true, data: { currentTimeS: 0 } })
  })
})
