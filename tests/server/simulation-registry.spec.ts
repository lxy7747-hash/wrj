// @vitest-environment node
import { describe, expect, it } from 'vitest'
const { SimulationRegistry } = await import('../../server/simulations/' + 'registry.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')

describe('任务登记与旧单任务兼容', () => {
  it('本地入口可注入跨重启唯一运行身份，错误或重复编号不改变场景锁', () => {
    const scenes = new ScenarioProjection()
    const first = new SimulationRegistry(scenes, 1, () => 'RUN-LOCAL-A')
    const run = first.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).data
    first.finishMission(run.runId, { code: 0 })
    expect(() => first.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })).toThrow('编号生成失败')
    const restarted = new SimulationRegistry(scenes, 1, () => 'RUN-LOCAL-B')
    const other = restarted.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).data
    expect(other.runId).not.toBe(run.runId)
    restarted.finishMission(other.runId, { code: 0 })
    expect(() => new SimulationRegistry(scenes, 1, () => '../bad').create({ taskId: 'TASK-001', scenarioId: 'SCN-001' })).toThrow()
    expect(scenes.get('SCN-001').data.locked).toBe(false)
  })
  it('非法容量/请求拒绝，不锁定场景，不生成运行；未知任务和运行不路由到别的任务', () => {
    const scenes = new ScenarioProjection()
    expect(() => new SimulationRegistry(scenes, 0)).toThrow()
    expect(() => new SimulationRegistry(scenes, 5)).toThrow()
    const registry = new SimulationRegistry(scenes)
    for (const body of [null, [], {}, { taskId: '../TASK-1', scenarioId: 'SCN-001' },
      { taskId: 'TASK-1', scenarioId: 'wrong' }, { taskId: 'TASK-001', scenarioId: 'SCN-001', extra: true }]) {
      expect(registry.create(body)).toMatchObject({ ok: false, status: 422 })
    }
    expect(registry.create({ taskId: 'TASK-OTHER', scenarioId: 'SCN-001' })).toMatchObject({ ok: false, fieldPath: 'taskId' })
    expect(scenes.get('SCN-001').data.locked).toBe(false)
    expect(registry.get('RUN-MISSING')).toMatchObject({ ok: false, status: 404 })
    expect(registry.current('TASK-MISSING')).toBeUndefined()
    expect(registry.controlJammer('TASK-MISSING', 'JAM', {})).toMatchObject({ ok: false, status: 404 })
    expect(registry.syncJammerParameters('TASK-MISSING', 'JAM', {})).toMatchObject({ ok: false, status: 404 })
    expect(() => registry.startMission('RUN-MISSING', 1, '')).toThrow()
  })

  it('完成后可复用任务，重置清理登记但不复用已发出的运行编号', () => {
    const scenes = new ScenarioProjection(), registry = new SimulationRegistry(scenes, 2)
    const first = registry.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).data
    registry.startMission(first.runId, 100, '2026-10-27T00:00:00Z')
    registry.finishMission(first.runId, { code: 0 })
    const second = registry.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).data
    expect(second.runId).not.toBe(first.runId)
    expect(registry.get(first.runId)).toMatchObject({ ok: false, status: 404 })
    registry.finishMission(second.runId, { code: 0 })
    const custom = registry.create({ taskId: 'TASK-B', scenarioId: 'SCN-001' }).data
    registry.finishMission(custom.runId, { code: 0 })
    expect(registry.list()).toHaveLength(2)
    registry.reset()
    expect(registry.list()).toHaveLength(1)
    expect(registry.current('TASK-B')).toBeUndefined()
    expect(registry.create({ taskId: 'TASK-001', scenarioId: 'SCN-001' }).data.runId).not.toBe(second.runId)
  })

  it('锁定场景不借给另一任务；任务登记有界，历史达到上限明确拒绝而不覆盖', () => {
    const scenes = new ScenarioProjection(), registry = new SimulationRegistry(scenes, 2)
    expect(registry.create({ taskId: 'TASK-B', scenarioId: 'SCN-MISSING' })).toMatchObject({ ok: false, status: 404 })
    scenes.setLocked('SCN-001', true)
    expect(registry.create({ taskId: 'TASK-B', scenarioId: 'SCN-001' })).toMatchObject({ ok: false, code: 'CONFIG_LOCKED' })
    scenes.setLocked('SCN-001', false)
    for (let index = 2; index <= 64; index++) {
      const created = registry.create({ taskId: `TASK-${index}`, scenarioId: 'SCN-001' })
      expect(created.ok).toBe(true)
      registry.finishMission(created.data.runId, { code: 0 })
    }
    expect(registry.list()).toHaveLength(64)
    expect(registry.create({ taskId: 'TASK-65', scenarioId: 'SCN-001' })).toMatchObject({ ok: false, status: 409 })
    expect(scenes.get('SCN-001').data.locked).toBe(false)
  })
})
