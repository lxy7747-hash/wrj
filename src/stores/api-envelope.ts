import type { ApiFailure } from '../contracts/domain-models'

/** Read the minimal API failure envelope accepted by Stores. */
export function readApiFailure(payload: unknown): ApiFailure | undefined {
  if (typeof payload !== 'object' || payload === null || (payload as { ok?: unknown }).ok !== false) return undefined
  const error = (payload as { error?: { code?: unknown; message?: unknown } }).error
  return typeof error?.code === 'string' && typeof error.message === 'string' ? payload as ApiFailure : undefined
}

/** Parse JSON without leaking malformed-body errors into Store error handling. */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/** Return data from an API success envelope without validating its business shape. */
export function unwrapSuccessData(payload: unknown): unknown {
  return typeof payload === 'object' && payload !== null && (payload as { ok?: unknown }).ok === true
    ? (payload as { data?: unknown }).data
    : undefined
}
