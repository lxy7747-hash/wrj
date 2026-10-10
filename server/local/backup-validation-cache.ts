import { lstatSync } from 'node:fs'

export type ListedValidation = 'VALID' | 'INVALID' | 'UNKNOWN'

// SQLite 主错误码：BUSY、LOCKED、NOMEM、IOERR、FULL、CANTOPEN、PROTOCOL 属于读取环境问题，不代表备份内容无效。
const TRANSIENT_SQLITE = new Set([5, 6, 7, 10, 13, 14, 15])
const TRANSIENT_ERRNO = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'EIO', 'EACCES', 'EPERM', 'ENOMEM', 'ETIMEDOUT'])

/** 锁冲突或临时 I/O 失败只影响本次结果；无法归为临时错误的才视为内容无效。 */
export function isTransientReadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { errcode, code } = error as { errcode?: unknown; code?: unknown }
  if (typeof errcode === 'number') return TRANSIENT_SQLITE.has(errcode & 0xff)
  return typeof code === 'string' && TRANSIENT_ERRNO.has(code)
}

/** 文件身份、大小及修改时间；任一变化都视为需要重新完整校验。 */
export function fileFingerprint(path: string): string {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('备份文件不是普通文件。')
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

/** 备份文件写入后不再修改，列表结果按文件指纹和登记摘要复用，不按时间到期；恢复不使用此缓存。 */
export class BackupValidationCache {
  private readonly entries = new Map<string, { fingerprint: string; checksum: string; valid: boolean }>()

  /** 返回 UNKNOWN 表示本次未能完成校验（临时读取失败或检查中文件变化），结果不缓存，调用方也不得持久化。 */
  check(path: string, checksum: string, validate: () => void): ListedValidation {
    const fingerprint = fileFingerprint(path)
    const cached = this.entries.get(path)
    if (cached?.fingerprint === fingerprint && cached.checksum === checksum) return cached.valid ? 'VALID' : 'INVALID'
    let valid = false
    try { validate(); valid = true } catch (error) { if (isTransientReadError(error)) return 'UNKNOWN' }
    if (fileFingerprint(path) !== fingerprint) return 'UNKNOWN'
    this.entries.set(path, { fingerprint, checksum, valid })
    return valid ? 'VALID' : 'INVALID'
  }

  isValid(path: string, checksum: string, validate: () => void): boolean {
    return this.check(path, checksum, validate) === 'VALID'
  }

  /** 只保留当前目录登记的文件，避免长期运行时累积已移除的条目。 */
  retain(paths: Set<string>): void {
    for (const path of this.entries.keys()) if (!paths.has(path)) this.entries.delete(path)
  }
}
