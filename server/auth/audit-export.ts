import type { AuditExportResult, AuditRecord, AuditRequest } from '../../src/contracts/domain-models.js'
import { formatAction, formatModule, formatObject, roleLabels, resultLabels } from '../../src/features/admin/audit-labels.js'
import { formatDateTime } from '../../src/features/shared/date-time.js'

/** 纯文本序列化；引号转义换行和制表符，避免日志字段伪造额外记录。 */
export function buildAuditExport(records: AuditRecord[], filters: AuditRequest, actor: string, verifiedAt: string, confirmationId: string): AuditExportResult {
  const watermark = `内部使用 · ${actor} · AUDIT-LOG`
  const filterLabels = { from: '开始时间', to: '结束时间', actor: '用户', role: '角色', module: '模块', action: '操作', result: '结果' }
  const selected = Object.entries(filterLabels).filter(([key]) => filters[key as keyof AuditRequest] !== undefined)
    .map(([key, label]) => `${label}=${JSON.stringify(filters[key as keyof AuditRequest])}`).join('；')
  const lines = records.map((record) => [record.auditId, formatDateTime(record.occurredAt), record.actor,
    roleLabels[record.role], formatModule(record), formatAction(record), formatObject(record), resultLabels[record.result]]
    .map((value) => JSON.stringify(value)).join('\t'))
  return {
    objectId: 'AUDIT-LOG', generated: true, classification: 'INTERNAL', watermark, verifiedAt,
    fileName: `operation_audit_${formatDateTime(verifiedAt).replace(/\D/g, '')}_${confirmationId.replace(/[^A-Za-z0-9_-]/g, '_')}.txt`,
    recordCount: records.length,
    content: ['操作审计日志', '开发验证明文文件，未加密，请妥善保管。', `水印：${JSON.stringify(watermark)}`,
      `导出时间：${formatDateTime(verifiedAt)}（UTC+8）`, `筛选条件：${selected || '全部'}`, `记录数量：${records.length}`,
      '审计编号\t操作时间\t用户\t角色\t模块\t操作\t操作对象\t结果', ...lines].join('\r\n') + '\r\n',
  }
}
