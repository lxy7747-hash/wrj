import type {
  ApiErrorCode,
  ApiFailure,
  ApiSuccess,
  Iso8601Utc,
  PageMeta,
} from '../../src/contracts/domain-models.js'

const DEFAULT_GENERATED_AT: Iso8601Utc = '2026-08-06T08:00:00Z'

const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  INVALID_REQUEST: 'The request does not match the expected contract.',
  VALIDATION_FAILED: 'The request failed validation.',
  NOT_FOUND: 'The requested local mock resource was not found.',
  CONFLICT: 'The request conflicts with the current projection.',
  INVALID_CREDENTIALS: 'The supplied credentials are invalid.',
  ACCOUNT_LOCKED: 'The account is locked.',
  PERMISSION_DENIED: 'The demo role is not permitted to perform this request.',
  LAST_ADMIN_GUARD: 'The last administrator cannot be changed.',
  CONFIRMATION_REQUIRED: 'A confirmation is required.',
  CONFIRMATION_EXPIRED: 'The confirmation has expired.',
  CONFIG_LOCKED: 'The configuration is locked.',
  INVALID_TRANSITION: 'The requested state transition is invalid.',
  NODE_LIMIT_EXCEEDED: 'The business node limit was exceeded.',
  DUPLICATE_EVENT: 'The event was already accepted.',
  HEADER_INVALID: 'The header is invalid.',
  TYPE_INVALID: 'The value type is invalid.',
  ENCODING_INVALID: 'The encoding is invalid.',
  ATOMIC_REPLACE_FAILED: 'The atomic replacement failed.',
  START_FAILED: 'The operation could not be started.',
  TIMEOUT: 'The operation timed out.',
  EXIT_NONZERO: 'The operation exited unsuccessfully.',
  CORRUPT_FIXTURE: 'The deterministic fixture is corrupt.',
  OUT_OF_RANGE: '参数超出设备能力范围。',
  DEVICE_DISABLED: '干扰设备不可用。',
  LOOPBACK_ONLY: 'The mock server accepts only its canonical loopback boundary.',
  TOPIC_FORBIDDEN: 'The requested WebSocket topic is not canonical.',
  SEQUENCE_GAP: 'The requested sequence cannot be resumed.',
  INTERNAL_FIXTURE_ERROR: 'The deterministic fixture could not be projected.',
}

export interface FailureOptions {
  message?: string
  fieldPath?: string
  details?: unknown
  retryable?: boolean
  correlationId?: string
  requestId?: string
  generatedAt?: Iso8601Utc
}

export function success<T>(data: T, meta: PageMeta): ApiSuccess<T> {
  return { ok: true, data, meta }
}

export function failure(
  code: ApiErrorCode,
  status: number,
  options: FailureOptions = {},
): ApiFailure {
  const requestId = options.requestId ?? `REQ-P0-${status}`
  const generatedAt = options.generatedAt ?? DEFAULT_GENERATED_AT
  const correlationId = options.correlationId ?? `CORR-P0-${status}-${code}`

  return {
    ok: false,
    error: {
      code,
      message: options.message ?? DEFAULT_MESSAGES[code],
      ...(options.fieldPath === undefined ? {} : { fieldPath: options.fieldPath }),
      ...(options.details === undefined ? {} : { details: options.details }),
      retryable: options.retryable ?? false,
      correlationId,
    },
    meta: { requestId, generatedAt },
  }
}
