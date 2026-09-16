import { DatabaseSync } from 'node:sqlite'
import { isAbsolute } from 'node:path'
import { randomBytes, scrypt, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import type { AuditRecord, User } from '../../src/contracts/domain-models.js'
import type { AuthStorage } from '../auth/projection.js'

const SESSION_MS = 8 * 60 * 60 * 1000
export const SESSION_COOKIE = 'wrj_session'
export const validPassword = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length >= 6 && value.length <= 128
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
const MAX_CONCURRENT_SCRYPT = 2
const derive = (password: string, salt: Buffer) => scryptSync(password, salt, 32, SCRYPT_OPTIONS)
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

/** 账号持久化；会话只保留在当前进程，重启必须重新登录。 */
export class AuthSqliteStorage implements AuthStorage {
  private readonly db: DatabaseSync
  private readonly sessions = new Map<string, { userId: string; expires: number }>()
  private loginWindow = 0
  private loginCount = 0
  private activeVerifications = 0
  // ponytail: 账号撤权会保守地淘汰所有在途登录；高并发管理场景再细化到单账号。
  private authRevision = 0
  private closed = false

  constructor(path: string, bootstrapPassword?: string, private readonly now = Date.now) {
    if (!isAbsolute(path)) throw new Error('账号数据库路径必须为绝对路径。')
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA busy_timeout = 1000;
        CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY NOT NULL,
          username TEXT NOT NULL UNIQUE CHECK(length(trim(username)) BETWEEN 1 AND 64),
          role TEXT NOT NULL CHECK(role IN ('ADMIN','OPERATOR')),
          status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED','LOCKED')),
          password_salt TEXT NOT NULL CHECK(length(password_salt) = 32),
          password_hash TEXT NOT NULL CHECK(length(password_hash) = 64),
          last_login_at TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT NOT NULL CHECK(length(trim(actor)) > 0),
          role TEXT NOT NULL CHECK(role IN ('ADMIN','OPERATOR')),
          module TEXT NOT NULL CHECK(length(trim(module)) > 0),
          action TEXT NOT NULL CHECK(length(trim(action)) > 0),
          object_id TEXT,
          result TEXT NOT NULL CHECK(result IN ('SUCCESS','DENIED','ERROR')),
          occurred_at TEXT NOT NULL
        ) STRICT;`)
      if (this.list().length === 0) {
        if (!validPassword(bootstrapPassword) || bootstrapPassword.length < 12) throw new Error('首次启动请设置 12–128 位 AUTH_BOOTSTRAP_PASSWORD，不能全为空白；不会使用演示密码。')
        this.insertUser({ userId: 'USR-ADMIN', username: 'admin', role: 'ADMIN', status: 'ACTIVE' }, bootstrapPassword)
      }
    } catch (error) { this.db.close(); throw error }
  }

  list(): User[] {
    return this.db.prepare('SELECT user_id, username, role, status, last_login_at FROM users ORDER BY user_id').all().map(row => ({
      userId: String(row.user_id), username: String(row.username), role: row.role as User['role'], status: row.status as User['status'],
      ...(row.last_login_at === null ? {} : { lastLoginAt: String(row.last_login_at) }),
    }))
  }

  time(): string { return new Date(this.now()).toISOString() }
  appendAudit(record: Omit<AuditRecord, 'auditId'>): void {
    try {
      this.db.prepare('INSERT INTO audit_logs(actor,role,module,action,object_id,result,occurred_at) VALUES(?,?,?,?,?,?,?)')
        .run(record.actor, record.role, record.module, record.action, record.objectId ?? null, record.result, record.occurredAt)
    } catch { throw new Error('审计数据库写入失败，操作结果未确认，请先重新查询。') }
  }

  readAudit(): AuditRecord[] {
    // 保留既有响应字段 immutableFixture 以兼容冻结合同；它不代表数据库具备防篡改能力。
    try { return this.db.prepare('SELECT * FROM audit_logs ORDER BY id').all().map(row => ({
      auditId: `AUD-LOCAL-${row.id}`, actor: String(row.actor), role: row.role as AuditRecord['role'],
      module: String(row.module), action: String(row.action), result: row.result as AuditRecord['result'],
      ...(row.object_id === null ? {} : { objectId: String(row.object_id) }),
      occurredAt: String(row.occurred_at), immutableFixture: true,
    })) } catch { throw new Error('审计数据库读取失败，未回退到演示数据。') }
  }
  expiresAt(created: string): string { return new Date(Date.parse(created) + 5 * 60 * 1000).toISOString() }
  watchSessions(check: () => void): () => void {
    const timer = setInterval(check, 30_000)
    timer.unref()
    return () => clearInterval(timer)
  }

  allowLogin(): boolean {
    if (this.now() - this.loginWindow >= 60_000) { this.loginWindow = this.now(); this.loginCount = 0 }
    // 单机服务按进程限制尝试次数，随机用户名不能绕过限制或扩大计数表。
    return ++this.loginCount <= 30 && this.activeVerifications < MAX_CONCURRENT_SCRYPT
  }

  async verify(username: string, password: string): Promise<boolean> {
    // 不排无界队列，最多两次 scrypt 并行，为文件读取等线程池任务留余量。
    if (this.closed || this.activeVerifications >= MAX_CONCURRENT_SCRYPT) return false
    const revision = this.authRevision
    const query = 'SELECT user_id, username, role, status, password_salt, password_hash FROM users WHERE username = ?'
    const row = this.db.prepare(query).get(username)
    const salt = Buffer.from(row ? String(row.password_salt) : '00'.repeat(16), 'hex')
    const expected = Buffer.from(row ? String(row.password_hash) : '00'.repeat(32), 'hex')
    this.activeVerifications++
    try {
      const actual = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key))
      })
      if (this.closed || revision !== this.authRevision) return false
      const current = this.db.prepare(query).get(username)
      return timingSafeEqual(actual, expected) && row !== undefined && current?.status === 'ACTIVE'
        && JSON.stringify(current) === JSON.stringify(row)
    } finally { this.activeVerifications-- }
  }

  save(user: User, password?: string): void {
    if (password !== undefined) {
      if (!validPassword(password) || password.length > 32) throw new Error('密码须为 6–32 位。密码不能全为空白。')
      this.insertUser(user, password)
    } else {
      this.db.prepare('UPDATE users SET username=?, role=?, status=?, last_login_at=? WHERE user_id=?')
        .run(user.username, user.role, user.status, user.lastLoginAt ?? null, user.userId)
    }
  }

  // 初始化管理员与界面新建账号的长度规则独立，校验后共用同一哈希写入路径。
  private insertUser(user: User, password: string): void {
    const salt = randomBytes(16)
    this.db.prepare(`INSERT INTO users (user_id, username, role, status, password_salt, password_hash, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(user.userId, user.username, user.role, user.status, salt.toString('hex'), derive(password, salt).toString('hex'), user.lastLoginAt ?? null)
  }

  delete(id: string): void { this.db.prepare('DELETE FROM users WHERE user_id=?').run(id); this.revokeUser(id) }
  revokeUser(id: string): void {
    this.authRevision++
    for (const [key, session] of this.sessions) if (session.userId === id) this.sessions.delete(key)
  }

  issueSession(id: string): string {
    for (const [key, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(key)
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value!)
    const token = randomBytes(32).toString('hex')
    this.sessions.set(digest(token), { userId: id, expires: this.now() + SESSION_MS })
    return token
  }

  private token(cookie?: string): string | undefined {
    const value = cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1)
    return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined
  }

  currentUser(cookie?: string): User | undefined {
    const token = this.token(cookie)
    if (!token) return undefined
    const key = digest(token)
    const session = this.sessions.get(key)
    if (!session) return undefined
    const user = this.list().find(item => item.userId === session.userId)
    if (session.expires <= this.now() || user?.status !== 'ACTIVE') { this.sessions.delete(key); return undefined }
    return user
  }

  revokeSession(cookie?: string): void {
    const token = this.token(cookie)
    if (token) this.sessions.delete(digest(token))
  }
  revokeAllSessions(): void { this.authRevision++; this.sessions.clear() }
  close(): void { this.closed = true; this.revokeAllSessions(); this.db.close() }
}
