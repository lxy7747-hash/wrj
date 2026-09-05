import { describe, expect, it, vi } from 'vitest'
import { readApiFailure, readJson, unwrapSuccessData } from '../../src/stores/api-envelope'

describe('API envelope helpers', () => {
  it('reads only minimal valid failure envelopes', () => {
    const failure = { ok: false, error: { code: 'INVALID', message: 'failed' } }

    expect(readApiFailure(failure)).toBe(failure)
    for (const invalid of [null, {}, { ok: true, error: failure.error }, { ok: false }, {
      ok: false, error: { code: 1, message: 'failed' },
    }, { ok: false, error: { code: 'INVALID', message: null } }]) {
      expect(readApiFailure(invalid)).toBeUndefined()
    }
  })

  it('returns undefined when JSON parsing fails', async () => {
    const response = { json: vi.fn().mockRejectedValue(new SyntaxError('malformed JSON')) } as unknown as Response

    await expect(readJson(response)).resolves.toBeUndefined()
  })

  it('unwraps success data without changing its shape', () => {
    const values = [{ id: 'one' }, ['one', 'two'], null]

    for (const value of values) expect(unwrapSuccessData({ ok: true, data: value })).toBe(value)
    expect(unwrapSuccessData({ ok: true })).toBeUndefined()
    expect(unwrapSuccessData({ ok: false, data: values[0] })).toBeUndefined()
    expect(unwrapSuccessData({ data: values[0] })).toBeUndefined()
  })
})
