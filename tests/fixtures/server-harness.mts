// B1-1 测试夹具：真实 createMockServer + 真实 TemplateSqliteStorage，监听随机端口；
// 另起控制端口用于一次性注入模板 save 失败、读取真实模板/引用/审计状态。仅供测试子进程使用。
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createMockServer } from '../../server/app.ts'
import { EquipmentSqliteStorage } from '../../server/local/equipment-sqlite.ts'
import { TemplateSqliteStorage } from '../../server/local/template-sqlite.ts'
import { TemplateProjection } from '../../server/templates/projection.ts'
import { EQUIPMENT } from '../../tests/fixtures/equipment.ts'

const ORIGIN = 'http://127.0.0.1:5173'
const ADMIN_HEADERS = { Origin: ORIGIN, 'X-Demo-Role': 'ADMIN' }
const root = await mkdtemp(join(tmpdir(), 'wrj-import-harness-'))
const equipment = new EquipmentSqliteStorage(join(root, 'equipment.db'))
const templates = new TemplateSqliteStorage(join(root, 'templates.db'))
const server = createMockServer({ port: 0, equipmentStorage: equipment, templateStorage: templates })
if (!server.httpServer.listening) await once(server.httpServer, 'listening')
const address = server.httpServer.address()
if (!address || typeof address === 'string') throw new Error('missing port')
const origin = `http://127.0.0.1:${address.port}`

// 记录预览 templateId（测试侧 spy，不改变行为）。
let previewTemplateId = ''
const originalPreview = TemplateProjection.prototype.previewCreate
TemplateProjection.prototype.previewCreate = function (this: unknown, value: unknown) {
  const result = originalPreview.call(this as never, value)
  if (result.ok) previewTemplateId = result.data.templateId
  return result
} as never

// 一次性模板保存失败注入（由控制接口开启）。
let failNextSave = false
const originalSave = templates.save.bind(templates)
;(templates as unknown as { save: (template: unknown, version?: string) => boolean }).save = (template: unknown, version?: string) => {
  if (failNextSave) { failNextSave = false; throw new Error('AUDIT template save failure') }
  return originalSave(template as never, version)
}

const seeded = await fetch(`${origin}/api/v1/admin/equipment`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...ADMIN_HEADERS }, body: JSON.stringify(EQUIPMENT),
})
if (seeded.status !== 201) throw new Error(`seed failed ${seeded.status}`)

const control = createServer((req, res) => {
  void (async () => {
    if (req.method === 'POST' && req.url === '/fail-next-save') { failNextSave = true; res.writeHead(204); res.end(); return }
    if (req.method === 'POST' && req.url === '/seed-old-ref') {
      equipment.addPublishedReference({
        equipmentId: EQUIPMENT.equipmentId, equipmentVersion: 1, targetType: 'TEMPLATE', targetId: 'TPL-OLD', targetVersion: '1',
        sourceSummary: 'links[L-OLD].parameterSource fields=modulation', createdAt: '2020-01-01T00:00:00.000Z',
      } as never)
      res.writeHead(204); res.end(); return
    }
    if (req.method === 'GET' && req.url === '/state') {
      const listResponse = await fetch(`${origin}/api/v1/templates`, { headers: ADMIN_HEADERS })
      const list = (await listResponse.json() as { data: unknown }).data
      const body = JSON.stringify({
        templates: list,
        refs: equipment.publishedReferences(EQUIPMENT.equipmentId),
        audit: server.auditSnapshot(),
        previewTemplateId,
      })
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); return
    }
    res.writeHead(404); res.end()
  })().catch(error => { res.writeHead(500); res.end(String(error)) })
})
control.listen(0)
await once(control, 'listening')
const controlAddress = control.address()
if (!controlAddress || typeof controlAddress === 'string') throw new Error('missing control port')
process.stdout.write(JSON.stringify({ origin, controlOrigin: `http://127.0.0.1:${controlAddress.port}`, root }) + '\n')

const shutdown = () => {
  try { control.close() } catch { /* already closed */ }
  try { server.close() } catch { /* already closed */ }
  try { templates.close(); equipment.close() } catch { /* already closed */ }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
