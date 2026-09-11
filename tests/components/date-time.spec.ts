import { describe, expect, it } from 'vitest'
import { formatDateTime } from '../../src/features/shared/date-time'

describe('interface date/time formatting', () => {
  it.each([
    ['2026-09-11T06:01:57.327Z', '2026-09-11 14:01:57'],
    ['2026-12-31T20:00:00Z', '2027-01-01 04:00:00'],
    ['2024-02-29T18:00:00Z', '2024-03-01 02:00:00'],
    ['2026-09-11T14:01:57+08:00', '2026-09-11 14:01:57'],
    ['2026-09-11T01:01:57-05:00', '2026-09-11 14:01:57'],
    ['', '—'], ['invalid', '—'], [null, '—'], [undefined, '—'],
  ])('formats %s without relying on the browser timezone', (value, expected) => {
    expect(formatDateTime(value)).toBe(expected)
  })

  it('formats Date inputs without changing them and handles invalid dates', () => {
    const date = new Date('2026-09-11T06:01:57.327Z')
    expect(formatDateTime(date)).toBe('2026-09-11 14:01:57')
    expect(date.toISOString()).toBe('2026-09-11T06:01:57.327Z')
    expect(formatDateTime(new Date(Number.NaN))).toBe('—')
  })
})
