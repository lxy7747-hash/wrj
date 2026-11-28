import { lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const TASK_HASH = /^[0-9a-f]{64}$/
const TOPICS = new Set(['simulation.frame', 'runtime.state', 'link.metric', 'jammer.event', 'switch.event', 'mission.log', 'position.update'])
const FILES = new Set(['events.ndjson', 'events.idx', 'meta.json'])

function isDirectPath(path) {
  return relative(path, realpathSync.native(path)) === ''
}

function readActiveGeneration(root) {
  if (!lstatSync(root).isDirectory() || !isDirectPath(root)) throw new Error('日志根目录不能经过符号链接或联接点。')
  const marker = join(root, 'active.json')
  const stat = lstatSync(marker)
  if (!stat.isFile() || stat.size > 32 * 1024 || !isDirectPath(marker)) throw new Error('active.json 不是有效的日志标记文件。')
  const { generation } = JSON.parse(readFileSync(marker, 'utf8')) ?? {}
  if (typeof generation !== 'string' || !UUID.test(generation)) throw new Error('active.json 缺少有效的活动代 ID。')
  return generation
}

function inspectGeneration(directory) {
  if (!lstatSync(directory).isDirectory() || !isDirectPath(directory)) return undefined

  const topics = []
  const files = []
  let logicalBytes = 0
  for (const topic of readdirSync(directory, { withFileTypes: true })) {
    const topicDirectory = join(directory, topic.name)
    if (!TOPICS.has(topic.name) || !topic.isDirectory() || !isDirectPath(topicDirectory)) return undefined
    topics.push(topicDirectory)
    for (const entry of readdirSync(topicDirectory, { withFileTypes: true })) {
      if (!FILES.has(entry.name) || !entry.isFile()) return undefined
      const path = join(topicDirectory, entry.name)
      const stat = lstatSync(path)
      if (!stat.isFile() || !isDirectPath(path)) return undefined
      files.push(path)
      logicalBytes += stat.size
    }
  }
  return { directory, topics, files, logicalBytes }
}

function removeGeneration(root, expectedActive, directory) {
  const assertInactive = (path) => {
    if (readActiveGeneration(root) !== expectedActive) throw new Error('活动日志代已变化，清理已停止。')
    if (!isDirectPath(path)) throw new Error('日志路径已变化，清理已停止：' + path)
  }
  assertInactive(directory)
  if (basename(directory).toLowerCase() === expectedActive.toLowerCase()) throw new Error('拒绝清理活动日志代。')
  const candidate = inspectGeneration(directory)
  if (!candidate) throw new Error('日志目录内容已变化，清理已停止：' + directory)

  // Enumerate only known files and remove empty directories. An unexpected file cannot be removed by recursion.
  for (const file of candidate.files) {
    assertInactive(file)
    if (!lstatSync(file).isFile()) throw new Error('日志文件类型已变化，清理已停止：' + file)
    unlinkSync(file)
  }
  for (const topic of candidate.topics) {
    assertInactive(topic)
    rmdirSync(topic)
  }
  assertInactive(directory)
  rmdirSync(directory)
}

function main() {
  const [directory, flag, ...extra] = process.argv.slice(2)
  if (!directory || !isAbsolute(directory) || (flag !== undefined && flag !== '--apply') || extra.length) {
    throw new Error('用法：node scripts/clean-retired-ws-journal.mjs <ws-journal 的绝对路径> [--apply]')
  }

  const root = resolve(directory)
  if (basename(root) !== 'ws-journal') throw new Error('必须指定 ws-journal 目录本身。')
  const activeGeneration = readActiveGeneration(root)
  const candidates = []
  const skipped = []
  for (const task of readdirSync(root, { withFileTypes: true })) {
    if (!TASK_HASH.test(task.name)) continue
    const taskDirectory = join(root, task.name)
    if (!task.isDirectory() || !isDirectPath(taskDirectory)) {
      skipped.push(taskDirectory)
      continue
    }
    for (const generation of readdirSync(taskDirectory, { withFileTypes: true })) {
      if (!UUID.test(generation.name) || generation.name.toLowerCase() === activeGeneration.toLowerCase()) continue
      const path = join(taskDirectory, generation.name)
      const candidate = generation.isDirectory() ? inspectGeneration(path) : undefined
      if (candidate) {
        candidates.push({ path, logicalBytes: candidate.logicalBytes, fileCount: candidate.files.length })
      } else {
        skipped.push(path)
      }
    }
  }

  const removed = []
  const apply = flag === '--apply'
  try {
    if (apply) {
      for (const { path } of candidates) {
        removeGeneration(root, activeGeneration, path)
        removed.push(path)
      }
    }
  } finally {
    console.log(JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      root,
      activeGeneration,
      candidateBytes: candidates.reduce((sum, candidate) => sum + candidate.logicalBytes, 0),
      candidates,
      skipped,
      removed,
    }, null, 2))
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
