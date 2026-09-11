// @vitest-environment node
import { expect, it, vi } from 'vitest'
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { TemplateProjection } = await import('../../server/templates/' + 'projection.js')

function scenarioStorage() {
  const original = new ScenarioProjection().get('SCN-001').data
  return { original, storage: {
    load: vi.fn(() => structuredClone(original)), list: vi.fn(() => [structuredClone(original)]),
    save: vi.fn(() => true), delete: vi.fn(() => true),
  } }
}

it('场景存储读取失败时，列表和所有依赖读取的操作拒绝继续写入', () => {
  const { original, storage } = scenarioStorage()
  const projection = new ScenarioProjection(storage)
  storage.load.mockImplementation(() => { throw new Error('read failed') })
  expect(() => projection.list()).toThrow()
  const results = [projection.get('SCN-001'), projection.create({ config: original.config }),
    projection.save('SCN-001', {}), projection.copyTemplate(original.config, 'copy'),
    projection.importSnapshots({ items: [original.config] }), projection.delete('SCN-001', { expectedRevision: original.revision })]
  for (const result of results) expect(result).toMatchObject({ ok: false, status: 503 })
  expect(storage.save).not.toHaveBeenCalled()
  expect(storage.delete).not.toHaveBeenCalled()
})

it.each(['conflict', 'error'] as const)('场景删除 %s 保留数据与锁，并允许修复存储后重试', mode => {
  const { original, storage } = scenarioStorage()
  const projection = new ScenarioProjection(storage)
  const revision = { expectedRevision: original.revision }
  if (mode === 'conflict') storage.delete.mockReturnValueOnce(false)
  else storage.delete.mockImplementationOnce(() => { throw new Error('delete failed') })
  expect(projection.delete('SCN-001', revision)).toMatchObject({ ok: false, status: mode === 'conflict' ? 409 : 503 })
  expect(projection.get('SCN-001').data).toEqual(original)
  expect(projection.delete('SCN-001', {})).toMatchObject({ ok: false, status: 422 })
  expect(projection.delete('SCN-001', { expectedRevision: -1 })).toMatchObject({ ok: false, status: 422 })
  projection.setLocked('SCN-001', true)
  expect(projection.delete('SCN-001', revision)).toMatchObject({ ok: false, code: 'CONFIG_LOCKED' })
  projection.setLocked('SCN-001', false)
  expect(projection.delete('SCN-001', revision)).toMatchObject({ ok: true, data: { deleted: true } })
})

it('外部删除后读取为 404，不恢复旧撤销历史；外部重建后按新修订读取', () => {
  const { original, storage } = scenarioStorage()
  const projection = new ScenarioProjection(storage)
  expect(projection.get('SCN-001').data).toEqual(original)
  storage.load.mockReturnValueOnce(undefined)
  expect(projection.get('SCN-001')).toMatchObject({ ok: false, status: 404 })
  storage.load.mockReturnValue({ ...original, revision: original.revision + 1 })
  expect(projection.get('SCN-001').data.revision).toBe(original.revision + 1)
  expect(projection.undo('SCN-001', { expectedRevision: original.revision + 1 })).toMatchObject({ ok: false, fieldPath: 'history' })
})

function templateStorage() {
  const original = new TemplateProjection().list()[0]
  original.referenceCount = 0
  return { original, storage: { load: vi.fn(() => [structuredClone(original)]), save: vi.fn(() => true), delete: vi.fn(() => true) } }
}

it('模板读取失败阻断创建、更新和删除，不产生存储写入', () => {
  const { original, storage } = templateStorage()
  const projection = new TemplateProjection(storage)
  storage.load.mockImplementation(() => { throw new Error('load failed') })
  for (const result of [projection.create({ name: 'new', config: original.config }), projection.update(original.templateId, {}), projection.delete(original.templateId)]) {
    expect(result).toMatchObject({ ok: false, status: 503 })
  }
  expect(storage.save).not.toHaveBeenCalled()
  expect(storage.delete).not.toHaveBeenCalled()
})

it.each(['conflict', 'error'] as const)('模板更新和删除 %s 保留原版本；存储恢复后允许重试', mode => {
  const { original, storage } = templateStorage()
  const projection = new TemplateProjection(storage)
  if (mode === 'conflict') { storage.save.mockReturnValueOnce(false); storage.delete.mockReturnValueOnce(false) }
  else {
    storage.save.mockImplementationOnce(() => { throw new Error('save failed') })
    storage.delete.mockImplementationOnce(() => { throw new Error('delete failed') })
  }
  const update = { name: 'updated', config: original.config }
  expect(projection.update(original.templateId, update)).toMatchObject({ ok: false, status: mode === 'conflict' ? 409 : 503 })
  expect(projection.delete(original.templateId)).toMatchObject({ ok: false, status: mode === 'conflict' ? 409 : 503 })
  expect(projection.get(original.templateId).data).toEqual(original)
  expect(projection.update(original.templateId, update)).toMatchObject({ ok: true, data: { name: 'updated', version: String(Number(original.version) + 1) } })
  expect(projection.delete(original.templateId)).toMatchObject({ ok: true })
})
