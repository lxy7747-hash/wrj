import type {
  ApiErrorCode,
  ConfirmationAction,
  ConfirmationContext,
  Role,
} from '../../src/contracts/domain-models.js'

export type ConfirmationProjectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 403 | 409; message: string }

interface StoredConfirmation {
  context: ConfirmationContext
  action: ConfirmationAction
  objectId: string
  owner?: string
}

const DEFAULT_NOW = '2026-08-06T08:00:00Z'
const DEFAULT_EXPIRES_AT = '2026-08-06T08:05:00Z'

export interface ConfirmationClock {
  now(): string
  expiresAt(createdAt: string): string
}

const DEFAULT_CLOCK: ConfirmationClock = {
  now: () => DEFAULT_NOW,
  expiresAt: () => DEFAULT_EXPIRES_AT,
}

export class ConfirmationProjection {
  private contexts = new Map<string, StoredConfirmation>()
  private nextSequence = 1

  constructor(private readonly clock: ConfirmationClock = DEFAULT_CLOCK, private readonly owner?: () => { id: string; name: string }) {}

  /** 判断确认上下文是否已到期，并在到期时立即移除。 */
  private hasExpired(confirmationId: string, stored: StoredConfirmation): boolean {
    if (this.clock.now() < stored.context.expiresAt) return false
    this.contexts.delete(confirmationId)
    return true
  }

  /**
   * 创建一次性二次确认上下文。
   * @param action 需要确认的受控动作。
   * @param objectId 动作对应的业务对象编号。
   * @param role 发起确认的当前角色。
   * @returns 等待确认的确定性上下文。
   * @remarks 只写入内存，不访问系统时间或持久化介质。
   */
  create(action: ConfirmationAction, objectId: string, role: Role): ConfirmationContext {
    const confirmationId = `CONF-P2-${String(this.nextSequence).padStart(3, '0')}`
    this.nextSequence += 1
    const createdAt = this.clock.now()
    const context: ConfirmationContext = {
      confirmationId,
      state: 'AWAITING_CONFIRMATION',
      actor: this.owner?.().name ?? (role === 'ADMIN' ? 'admin' : 'operator'),
      role,
      createdAt,
      expiresAt: this.clock.expiresAt(createdAt),
    }
    this.contexts.set(confirmationId, { context, action, objectId, ...(this.owner ? { owner: this.owner().id } : {}) })
    return structuredClone(context)
  }

  /**
   * 将等待中的上下文标记为已确认。
   * @param confirmationId 待确认上下文编号。
   * @param role 当前请求角色。
   * @returns 已确认上下文，或失效错误。
   * @remarks 角色不一致、未知编号和重复确认均按失效处理。
   */
  confirm(confirmationId: string, role: Role): ConfirmationProjectionResult<ConfirmationContext> {
    const stored = this.contexts.get(confirmationId)
    if (stored === undefined || this.hasExpired(confirmationId, stored) || stored.context.state !== 'AWAITING_CONFIRMATION') {
      return { ok: false, code: 'CONFIRMATION_EXPIRED', status: 409, message: '二次确认已失效。' }
    }
    if (stored.context.role !== role || (this.owner && stored.owner !== this.owner().id)) {
      return { ok: false, code: 'PERMISSION_DENIED', status: 403, message: '当前角色不能处理该确认。' }
    }
    stored.context.state = 'CONFIRMED'
    return { ok: true, data: structuredClone(stored.context) }
  }

  /**
   * 核验并消费一次性确认上下文。
   * @param confirmationId 已确认上下文编号。
   * @param action 受控动作。
   * @param objectId 受控对象编号。
   * @param role 当前请求角色。
   * @returns 上下文匹配时返回成功，否则返回失效错误。
   * @remarks 成功后立即删除上下文，防止重复使用。
   */
  consume(
    confirmationId: string,
    action: ConfirmationAction,
    objectId: string,
    role: Role,
  ): ConfirmationProjectionResult<true> {
    const stored = this.contexts.get(confirmationId)
    if (stored === undefined || this.hasExpired(confirmationId, stored) || stored.context.state !== 'CONFIRMED'
      || stored.action !== action
      || stored.objectId !== objectId) {
      return { ok: false, code: 'CONFIRMATION_EXPIRED', status: 409, message: '二次确认已失效。' }
    }
    if (stored.context.role !== role || (this.owner && stored.owner !== this.owner().id)) {
      return { ok: false, code: 'PERMISSION_DENIED', status: 403, message: '当前角色不能处理该确认。' }
    }
    this.contexts.delete(confirmationId)
    return { ok: true, data: true }
  }

  /** 清除全部确认上下文并恢复确定性编号。 */
  reset(): void {
    this.contexts.clear()
    this.nextSequence = 1
  }
}
