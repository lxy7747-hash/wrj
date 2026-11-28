// @vitest-environment node
import { afterEach, expect, it } from 'vitest'

const { spawnSync } = await import('node:' + 'child_process')
const { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { fileURLToPath } = await import('node:' + 'url')
const process = await import('node:' + 'process')

const script = fileURLToPath(new URL('../../scripts/clean-retired-ws-journal.mjs', import.meta.url))
const ACTIVE = '11111111-1111-4111-8111-111111111111'
const RETIRED = '22222222-2222-4222-8222-222222222222'
const UNFAMILIAR = '33333333-3333-4333-8333-333333333333'
const LINKED = '44444444-4444-4444-8444-444444444444'
const NESTED_LINK = '55555555-5555-4555-8555-555555555555'

const sandboxes: string[] = []
afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await rm(sandbox, { recursive: true, force: true })
})

async function fixture() {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'wrj-journal-maintenance-')))
  sandboxes.push(sandbox)
  const root = join(sandbox, 'ws-journal')
  const task = join(root, 'a'.repeat(64))
  const external = join(sandbox, 'external')
  await mkdir(task, { recursive: true })
  await mkdir(external)
  await writeFile(join(root, 'active.json'), JSON.stringify({ generation: ACTIVE }))
  return { root, task, external }
}

async function event(generation: string, content: string, filename = 'events.ndjson') {
  const topic = join(generation, 'link.metric')
  await mkdir(topic, { recursive: true })
  const path = join(topic, filename)
  await writeFile(path, content)
  return path
}

function run(root: string, ...flags: string[]) {
  return spawnSync(process.execPath, [script, root, ...flags], { encoding: 'utf8', windowsHide: true })
}

it('previews candidates and deletes only eligible generations on explicit apply', async () => {
  const { root, task, external } = await fixture()
  const active = await event(join(task, ACTIVE), 'active')
  const retired = await event(join(task, RETIRED), 'old')
  const unfamiliar = await event(join(task, UNFAMILIAR), 'keep', 'unfamiliar.txt')
  const externalEvent = await event(external, 'outside')
  await symlink(external, join(task, LINKED), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(external, join(root, 'b'.repeat(64)), process.platform === 'win32' ? 'junction' : 'dir')
  await mkdir(join(task, NESTED_LINK))
  await symlink(external, join(task, NESTED_LINK, 'mission.log'), process.platform === 'win32' ? 'junction' : 'dir')

  const preview = run(root)
  expect(preview.stderr).toBe('')
  expect(preview.status).toBe(0)
  expect(JSON.parse(preview.stdout)).toMatchObject({
    mode: 'dry-run',
    activeGeneration: ACTIVE,
    candidateBytes: 3,
    candidates: [{ path: join(task, RETIRED), logicalBytes: 3, fileCount: 1 }],
    skipped: expect.arrayContaining([join(task, UNFAMILIAR), join(task, LINKED), join(task, NESTED_LINK), join(root, 'b'.repeat(64))]),
    removed: [],
  })
  expect(await readFile(retired, 'utf8')).toBe('old')

  const apply = run(root, '--apply')
  expect(apply.stderr).toBe('')
  expect(apply.status).toBe(0)
  expect(JSON.parse(apply.stdout)).toMatchObject({ mode: 'apply', removed: [join(task, RETIRED)] })
  await expect(readFile(retired, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(active, 'utf8')).toBe('active')
  expect(await readFile(unfamiliar, 'utf8')).toBe('keep')
  expect(await readFile(externalEvent, 'utf8')).toBe('outside')
})

it('refuses apply when the active marker is invalid', async () => {
  const { root, task } = await fixture()
  const retired = await event(join(task, RETIRED), 'old')
  await writeFile(join(root, 'active.json'), JSON.stringify({ generation: '../elsewhere' }))
  const apply = run(root, '--apply')
  expect(apply.status).toBe(1)
  expect(apply.stderr).toContain('active.json')
  expect(await readFile(retired, 'utf8')).toBe('old')
})
