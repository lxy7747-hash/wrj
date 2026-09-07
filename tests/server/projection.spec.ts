import { beforeAll, describe, expect, it } from 'vitest'
import type {
  DeterministicFixtureSet,
  ResetResult,
  ScenarioDraft,
  TaskId,
  WsTopic,
} from '../../src/contracts/domain-models.js'

interface MockProjectionInstance {
  snapshot(): DeterministicFixtureSet
  reset(): ResetResult
  nextSequence(taskId: TaskId, topic: WsTopic): number
}

interface ScenarioProjectionInstance {
  copyTemplate(config: DeterministicFixtureSet['scenario'], name: string): unknown
  get(scenarioId: string): unknown
  importSnapshots(value: unknown): unknown
  validate(scenarioId: string, value: unknown): unknown
  save(scenarioId: string, value: unknown): unknown
}

interface TemplateProjectionInstance {
  create(value: unknown): unknown
  update(templateId: string, value: unknown): unknown
  delete(templateId: string): unknown
}

interface ConfirmationProjectionInstance {
  create(action: 'SCENARIO_WARNING_CONTINUE', objectId: string, role: 'OPERATOR'): { confirmationId: string; actor: string; expiresAt: string }
  confirm(confirmationId: string, role: 'ADMIN' | 'OPERATOR'): unknown
  consume(
    confirmationId: string,
    action: 'OFFICIAL_TEMPLATE_DELETE' | 'SCENARIO_WARNING_CONTINUE',
    objectId: string,
    role: 'ADMIN' | 'OPERATOR',
  ): unknown
}

let loadFixtureProjection: () => DeterministicFixtureSet
let MockProjection: new () => MockProjectionInstance
let ScenarioProjection: new () => ScenarioProjectionInstance
let TemplateProjection: new () => TemplateProjectionInstance
let ConfirmationProjection: new (clock?: { now(): string; expiresAt(createdAt: string): string }) => ConfirmationProjectionInstance

describe('fixture projection', () => {
  beforeAll(async () => {
    const fixtureModulePath = '../../server/fixtures/' + 'source.js'
    const projectionModulePath = '../../server/state/' + 'projection.js'
    const fixtureModule = await import(fixtureModulePath) as {
      loadFixtureProjection: typeof loadFixtureProjection
    }
    const projectionModule = await import(projectionModulePath) as {
      MockProjection: typeof MockProjection
    }
    const scenarioModule = await import('../../server/scenarios/' + 'projection.js') as {
      ScenarioProjection: typeof ScenarioProjection
    }
    const templateModule = await import('../../server/templates/' + 'projection.js') as {
      TemplateProjection: typeof TemplateProjection
    }
    const confirmationModule = await import('../../server/confirmations/' + 'projection.js') as {
      ConfirmationProjection: typeof ConfirmationProjection
    }

    ;({ loadFixtureProjection } = fixtureModule)
    ;({ MockProjection } = projectionModule)
    ;({ ScenarioProjection } = scenarioModule)
    ;({ TemplateProjection } = templateModule)
    ;({ ConfirmationProjection } = confirmationModule)
  })

  it('isolates fixture loads and snapshots from caller mutation', () => {
    const loaded = loadFixtureProjection()
    const projection = new MockProjection()
    const snapshot = projection.snapshot()

    loaded.scenario.scenario.name = 'mutated fixture load'
    loaded.frame.platforms[0].name = 'mutated nested fixture load'
    snapshot.scenario.scenario.name = 'mutated snapshot'
    snapshot.frame.platforms[0].name = 'mutated nested snapshot'

    const cleanLoad = loadFixtureProjection()
    const cleanSnapshot = projection.snapshot()

    expect(cleanLoad.scenario.scenario.name).toBe('跨海通联演示')
    expect(cleanLoad.frame.platforms[0].name).toBe('后方指挥节点')
    expect(cleanSnapshot).toEqual(cleanLoad)
  })

  it('restores a deeply equal baseline without retaining snapshot mutations', () => {
    const baseline = loadFixtureProjection()
    const projection = new MockProjection()
    const mutatedSnapshot = projection.snapshot()

    mutatedSnapshot.run.uiStatus = 'RUNNING'
    mutatedSnapshot.replay.currentTimeS = 900
    mutatedSnapshot.audit[0].action = 'CALLER_MUTATION'

    projection.reset()

    expect(projection.snapshot()).toEqual(baseline)
    expect(loadFixtureProjection()).toEqual(baseline)
  })

  it('increments independently by task and topic and restarts at one after reset', () => {
    const projection = new MockProjection()

    expect(projection.nextSequence('TASK-001', 'simulation.frame')).toBe(1)
    expect(projection.nextSequence('TASK-001', 'simulation.frame')).toBe(2)
    expect(projection.nextSequence('TASK-001', 'runtime.state')).toBe(1)
    expect(projection.nextSequence('TASK-002', 'simulation.frame')).toBe(1)

    projection.reset()

    expect(projection.nextSequence('TASK-001', 'simulation.frame')).toBe(1)
    expect(projection.nextSequence('TASK-001', 'runtime.state')).toBe(1)
    expect(projection.nextSequence('TASK-002', 'simulation.frame')).toBe(1)
  })

  it('returns fixed fixture reset constants in isolated results', () => {
    const projection = new MockProjection()

    const firstResult = projection.reset()
    const expected = {
      requestId: 'REQ-RESET-001',
      generatedAt: '2026-08-06T08:00:00Z',
      nextSequence: 1,
    }

    expect(firstResult).toEqual(expected)

    ;(firstResult as { requestId: string }).requestId = 'CALLER-MUTATION'

    expect(projection.reset()).toEqual(expected)
  })

  it.each([undefined, 'UNKNOWN', '', 'TIANTONG', 'SHENTONG'])('场景和模板写入验证卫星子类型 %s 且拒绝时不修改草稿', (satelliteType) => {
    const scenario = new ScenarioProjection()
    const original = scenario.get('SCN-001') as { ok: true; data: ScenarioDraft }
    const config = structuredClone(original.data.config)
    const index = config.platforms.findIndex(({ type }) => type === 'COMMUNICATION_SATELLITE')
    delete config.platforms[index]!.satelliteType
    if (satelliteType !== undefined) config.platforms[index]!.satelliteType = satelliteType as never
    const valid = satelliteType === 'TIANTONG' || satelliteType === 'SHENTONG'
    const templates = new TemplateProjection()
    for (const [result, fieldPath] of [
      [scenario.save('SCN-001', { config, uiExtensions: original.data.uiExtensions }), `platforms[${index}].satelliteType`],
      [scenario.importSnapshots({ items: [config] }), `items[0].platforms[${index}].satelliteType`],
      [scenario.copyTemplate(config, '卫星模板应用'), `platforms[${index}].satelliteType`],
      [templates.create({ name: '卫星模板新增', config }), `platforms[${index}].satelliteType`],
    ] as const) {
      expect(result).toMatchObject(valid ? { ok: true } : { ok: false, status: 422, fieldPath })
    }
    if (!valid) expect(scenario.get('SCN-001')).toEqual(original)
  })

  it('模板复制在共享场景投影层拒绝空名称、非法配置和运行锁', () => {
    const config = loadFixtureProjection().scenario
    const scenario = new ScenarioProjection()

    expect(scenario.copyTemplate(config, '  ')).toMatchObject({ ok: false, fieldPath: 'name' })
    const invalid = structuredClone(config)
    invalid.links[0]!.txPower = -1
    expect(scenario.copyTemplate(invalid, '非法模板')).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      fieldPath: 'links[0].txPower',
    })
    ;(scenario as unknown as { draft: ScenarioDraft }).draft.locked = true
    expect(scenario.copyTemplate(config, '锁定模板')).toMatchObject({ ok: false, code: 'CONFIG_LOCKED' })
  })

  it('场景投影在校验和保存前拒绝未知编号及运行锁', () => {
    const scenario = new ScenarioProjection()

    expect(scenario.validate('SCN-NOT-FOUND', {})).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(scenario.save('SCN-NOT-FOUND', {})).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    ;(scenario as unknown as { draft: ScenarioDraft }).draft.locked = true
    expect(scenario.validate('SCN-001', {})).toMatchObject({ ok: false, code: 'CONFIG_LOCKED' })
    expect(scenario.save('SCN-001', {})).toMatchObject({ ok: false, code: 'CONFIG_LOCKED' })
    expect(scenario.importSnapshots({ items: [loadFixtureProjection().scenario] })).toMatchObject({ ok: false, code: 'CONFIG_LOCKED' })
  })

  it('只读字段按深度语义比较，不受对象键顺序影响', () => {
    const scenario = new ScenarioProjection()
    const current = scenario.get('SCN-001') as { ok: true; data: ScenarioDraft }
    const update = structuredClone(current.data)
    update.config.sensors[0] = Object.fromEntries(
      Object.entries(update.config.sensors[0]!).reverse(),
    ) as typeof update.config.sensors[number]

    expect(scenario.save('SCN-001', { config: update.config, uiExtensions: update.uiExtensions }))
      .toMatchObject({ ok: true })
  })

  it('规范化层拒绝缺失和损坏的关联集合且保持草稿不变', () => {
    const scenario = new ScenarioProjection()
    const current = scenario.get('SCN-001') as { ok: true; data: ScenarioDraft }
    const malformedConfigs: unknown[] = [
      null,
      {},
      { platforms: null },
      { platforms: [null], links: [null], jammers: [null] },
      { platforms: [{ id: 1 }], links: [{ id: 1 }], jammers: [{ id: 1 }] },
    ]

    malformedConfigs.forEach((config) => {
      expect(scenario.save('SCN-001', { config, uiExtensions: current.data.uiExtensions }))
        .toMatchObject({ ok: false, code: 'VALIDATION_FAILED' })
    })
    expect(scenario.get('SCN-001')).toEqual(current)
  })

  it('保存请求外壳必须只包含配置和界面扩展', () => {
    const scenario = new ScenarioProjection()
    const current = scenario.get('SCN-001') as { ok: true; data: ScenarioDraft }
    const invalidRequests: unknown[] = [
      null,
      [],
      { config: current.data.config },
      { uiExtensions: current.data.uiExtensions },
      { config: current.data.config, uiExtensions: current.data.uiExtensions, extra: true },
    ]

    invalidRequests.forEach((request) => {
      expect(scenario.save('SCN-001', request)).toMatchObject({ ok: false, fieldPath: 'request' })
    })
  })

  it('保存边界拒绝编号并完整持久化场景数据和界面扩展', () => {
    const scenario = new ScenarioProjection()
    const current = scenario.get('SCN-001') as { ok: true; data: ScenarioDraft }

    const mismatched = structuredClone(current.data)
    mismatched.config.scenario.id = 'SCN-OTHER'
    expect(scenario.save('SCN-001', { config: mismatched.config, uiExtensions: mismatched.uiExtensions }))
      .toMatchObject({ ok: false, fieldPath: 'scenario.id' })

    const changed = structuredClone(current.data)
    changed.config.sensors[0]!.detectionRange += 1
    changed.config.output.directory = './changed'
    changed.config.informationDemand[0]!.maxLatencyMs += 1
    changed.uiExtensions.sensors[0]!.probability = 0.8
    expect(scenario.save('SCN-001', { config: changed.config, uiExtensions: changed.uiExtensions }))
      .toMatchObject({ ok: true })
    expect(scenario.get('SCN-001')).toMatchObject({
      ok: true,
      data: {
        config: { sensors: [{ detectionRange: changed.config.sensors[0]!.detectionRange }], output: { directory: './changed' }, informationDemand: [{ maxLatencyMs: changed.config.informationDemand[0]!.maxLatencyMs }] },
        uiExtensions: { sensors: [{ probability: 0.8 }] },
      },
    })

    const invalidDemand = structuredClone(changed)
    invalidDemand.config.informationDemand = []
    expect(scenario.save('SCN-001', { config: invalidDemand.config, uiExtensions: invalidDemand.uiExtensions }))
      .toMatchObject({ ok: false, fieldPath: 'informationDemand' })

    const changedExtensions = structuredClone(changed)
    changedExtensions.uiExtensions.sensors.push({
      sensorId: 'ESM-01',
      type: 'ESM',
      direction: 'OMNI',
      probability: 1,
      enabled: true,
    })
    expect(scenario.save('SCN-001', {
      config: changedExtensions.config,
      uiExtensions: changedExtensions.uiExtensions,
    })).toMatchObject({ ok: false, fieldPath: 'uiExtensions.sensors' })
  })

  it('模板投影关闭校验更新请求并拒绝删除未知模板', () => {
    const config = loadFixtureProjection().scenario
    const templates = new TemplateProjection()

    expect(templates.create(null)).toMatchObject({ ok: false, fieldPath: 'request' })
    expect(templates.create({ name: 1, config })).toMatchObject({ ok: false, fieldPath: 'name' })
    expect(templates.update('TPL-SCN-001', { name: '缺少配置' })).toMatchObject({ ok: false, fieldPath: 'request' })
    expect(templates.delete('TPL-NOT-FOUND')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('一次性确认绑定角色、动作和对象且操作员身份可投影', () => {
    const confirmations = new ConfirmationProjection()
    const operator = confirmations.create('SCENARIO_WARNING_CONTINUE', 'SCN-001', 'OPERATOR')

    expect(operator.actor).toBe('operator')
    expect(confirmations.confirm(operator.confirmationId, 'ADMIN')).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' })
    expect(confirmations.confirm(operator.confirmationId, 'OPERATOR')).toMatchObject({ ok: true, data: { state: 'CONFIRMED' } })
    expect(confirmations.consume(operator.confirmationId, 'OFFICIAL_TEMPLATE_DELETE', 'SCN-001', 'OPERATOR'))
      .toMatchObject({ ok: false, code: 'CONFIRMATION_EXPIRED' })
    expect(confirmations.consume(operator.confirmationId, 'SCENARIO_WARNING_CONTINUE', 'OTHER', 'OPERATOR'))
      .toMatchObject({ ok: false, code: 'CONFIRMATION_EXPIRED' })
    expect(confirmations.consume(operator.confirmationId, 'SCENARIO_WARNING_CONTINUE', 'SCN-001', 'ADMIN'))
      .toMatchObject({ ok: false, code: 'PERMISSION_DENIED' })
    expect(confirmations.consume(operator.confirmationId, 'SCENARIO_WARNING_CONTINUE', 'SCN-001', 'OPERATOR'))
      .toEqual({ ok: true, data: true })
  })

  it('确定性时钟到达截止时间后拒绝确认和消费', () => {
    let now = '2026-08-06T08:00:00Z'
    const confirmations = new ConfirmationProjection({ now: () => now, expiresAt: () => '2026-08-06T08:05:00Z' })
    const awaiting = confirmations.create('SCENARIO_WARNING_CONTINUE', 'SCN-001', 'OPERATOR')
    expect(awaiting.expiresAt).toBe('2026-08-06T08:05:00Z')

    now = awaiting.expiresAt
    expect(confirmations.confirm(awaiting.confirmationId, 'OPERATOR'))
      .toMatchObject({ ok: false, code: 'CONFIRMATION_EXPIRED' })

    now = '2026-08-06T08:00:00Z'
    const confirmed = confirmations.create('SCENARIO_WARNING_CONTINUE', 'SCN-001', 'OPERATOR')
    expect(confirmations.confirm(confirmed.confirmationId, 'OPERATOR')).toMatchObject({ ok: true })
    now = '2026-08-06T08:05:00Z'
    expect(confirmations.consume(confirmed.confirmationId, 'SCENARIO_WARNING_CONTINUE', 'SCN-001', 'OPERATOR'))
      .toMatchObject({ ok: false, code: 'CONFIRMATION_EXPIRED' })
  })
})
