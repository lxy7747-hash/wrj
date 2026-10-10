// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'

const { BackupValidationCache } = await import('../../server/local/' + 'backup-validation-cache.js')
const { mkdtempSync, rmSync, writeFileSync } = await import('node:' + 'fs')
const { join } = await import('node:' + 'path')
const { tmpdir } = await import('node:' + 'os')
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'wrj-backup-cache-'))
  directories.push(directory)
  const file = join(directory, 'backup.db')
  writeFileSync(file, 'original')
  return { directory, file }
}

it('列表结果不按时间到期，仅登记摘要变化时重新完整检查；移除的登记条目被清理', () => {
  vi.useFakeTimers()
  try {
    const { file } = setup()
    const cache = new BackupValidationCache()
    const validate = vi.fn()
    expect(cache.isValid(file, 'A', validate)).toBe(true)
    vi.advanceTimersByTime(24 * 3600_000)
    expect(cache.isValid(file, 'A', validate)).toBe(true)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(cache.isValid(file, 'B', validate)).toBe(true)
    expect(validate).toHaveBeenCalledTimes(2)
    cache.retain(new Set())
    expect(cache.isValid(file, 'B', validate)).toBe(true)
    expect(validate).toHaveBeenCalledTimes(3)
  } finally { vi.useRealTimers() }
})

it('SQLite 占锁和临时 I/O 失败不缓存，内容错误仍缓存为无效', () => {
  const { file } = setup()
  const cache = new BackupValidationCache()
  const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
  expect(cache.check(file, 'A', () => { throw busy })).toBe('UNKNOWN')
  expect(cache.check(file, 'A', () => { throw Object.assign(new Error('io'), { code: 'EBUSY' }) })).toBe('UNKNOWN')
  expect(cache.check(file, 'A', () => { throw Object.assign(new Error('locked'), { errcode: 262 }) })).toBe('UNKNOWN')
  expect(cache.check(file, 'A', () => {})).toBe('VALID')
  const notDatabase = Object.assign(new Error('file is not a database'), { code: 'ERR_SQLITE_ERROR', errcode: 26 })
  const validate = vi.fn(() => { throw notDatabase })
  expect(cache.check(file, 'B', validate)).toBe('INVALID')
  expect(cache.check(file, 'B', validate)).toBe('INVALID')
  expect(validate).toHaveBeenCalledTimes(1)
})

it('非法结果同样缓存，文件修改立即重检；检查过程中变化不发布有效结果', () => {
  const { file, directory } = setup()
  const cache = new BackupValidationCache()
  const validate = vi.fn(() => { throw new Error('invalid') })
  expect(cache.isValid(file, 'A', validate)).toBe(false)
  expect(cache.isValid(file, 'A', validate)).toBe(false)
  expect(validate).toHaveBeenCalledTimes(1)
  writeFileSync(file, 'changed and longer')
  expect(cache.isValid(file, 'A', validate)).toBe(false)
  expect(validate).toHaveBeenCalledTimes(2)
  expect(cache.isValid(file, 'B', () => writeFileSync(file, 'changed during check'))).toBe(false)
  expect(cache.isValid(file, 'B', () => {})).toBe(true)
  expect(() => cache.isValid(directory, 'B', () => {})).toThrow('普通文件')
  expect(() => cache.isValid(join(directory, 'missing.db'), 'B', () => {})).toThrow()
})
