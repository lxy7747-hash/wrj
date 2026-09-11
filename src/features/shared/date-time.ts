/** 仅用于界面显示：固定 UTC+8，不处理夏令时，也不改写接口原值。 */
export function formatDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  const local = new Date(timestamp + 8 * 60 * 60 * 1000)
  return Number.isNaN(local.getTime()) ? '—' : local.toISOString().slice(0, 19).replace('T', ' ')
}
