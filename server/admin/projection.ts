import type { ApiErrorCode, BackupRecord, DeleteResult, MasterData, RestoreResult } from '../../src/contracts/domain-models.js'
import { isAdminObject, isAdminText, isMasterData } from '../../src/features/admin/admin-contract.js'
import { loadFixtureProjection } from '../fixtures/source.js'

export type AdminResult<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode; status: number; message: string; fieldPath?: string }

/** 系统维护内存数据的唯一所有者；不访问文件、数据库或操作系统进程。 */
export class AdminProjection {
  private masterData = loadFixtureProjection().masterData
  private backups = loadFixtureProjection().backups
  private nextBackup = 1

  /** 返回可独立修改的主数据快照。 */
  listMasterData(): MasterData[] { return structuredClone(this.masterData) }

  /**
   * 创建或更新主数据；更新必须携带当前版本，引用数量始终由服务端持有。
   * @param value 未受信任的主数据请求。
   * @param dataId 更新时的路径编号；创建时不传。
   */
  saveMasterData(value: unknown, dataId?: string): AdminResult<MasterData> {
    if (!isAdminObject(value, ['operation', 'data'], ['confirmationId']) || !isMasterData(value.data)
      || value.operation !== (dataId === undefined ? 'CREATE' : 'UPDATE')
      || (value.confirmationId !== undefined && !isAdminText(value.confirmationId))) {
      return { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '主数据字段、版本或引用数量不正确。', fieldPath: 'data' }
    }
    const data = value.data
    if (dataId !== undefined && dataId !== data.dataId) return { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '主数据编号与请求路径不一致。', fieldPath: 'data.dataId' }
    const existing = this.masterData.find((item) => item.dataId === data.dataId)
    if (dataId === undefined) {
      if (existing) return { ok: false, code: 'CONFLICT', status: 409, message: '主数据编号已存在。', fieldPath: 'data.dataId' }
      if (data.version !== 1 || data.referenceCount !== 0) return { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '新增数据版本必须为 1，引用数量必须为 0。', fieldPath: 'data.version' }
      this.masterData.push(structuredClone(data))
      return { ok: true, data: structuredClone(data) }
    }
    if (!existing) return { ok: false, code: 'NOT_FOUND', status: 404, message: '主数据不存在。', fieldPath: 'dataId' }
    if (data.version !== existing.version) return { ok: false, code: 'VERSION_CONFLICT', status: 409, message: '主数据版本已更新，请刷新后重新编辑。', fieldPath: 'data.version' }
    if (data.referenceCount !== existing.referenceCount) return { ok: false, code: 'VALIDATION_FAILED', status: 422, message: '引用数量由系统维护，不允许修改。', fieldPath: 'data.referenceCount' }
    const updated = { ...data, version: existing.version + 1 }
    this.masterData = this.masterData.map((item) => item.dataId === dataId ? structuredClone(updated) : item)
    return { ok: true, data: updated }
  }

  /** 删除未被引用的主数据；参数为已通过权限和确认检查的编号。 */
  deleteMasterData(dataId: string): AdminResult<DeleteResult> {
    const data = this.masterData.find((item) => item.dataId === dataId)
    if (!data) return { ok: false, code: 'NOT_FOUND', status: 404, message: '主数据不存在。' }
    if (data.referenceCount > 0) return { ok: false, code: 'CONFLICT', status: 409, message: `该数据已有 ${data.referenceCount} 处引用，不能删除。`, fieldPath: 'referenceCount' }
    this.masterData = this.masterData.filter((item) => item.dataId !== dataId)
    return { ok: true, data: { deleted: true, objectId: dataId } }
  }

  /** 返回备份目录的独立副本。 */
  listBackups(): BackupRecord[] { return structuredClone(this.backups) }

  /** 创建内存备份记录；可选编号不允许覆盖已有记录。 */
  backup(backupId?: string): AdminResult<BackupRecord> {
    const id = backupId ?? `BACKUP-P7-${String(this.nextBackup++).padStart(3, '0')}`
    if (this.backups.some((item) => item.backupId === id)) return { ok: false, code: 'CONFLICT', status: 409, message: '备份编号已存在，未覆盖原记录。', fieldPath: 'backupId' }
    const record: BackupRecord = { backupId: id, status: 'VALID_FIXTURE', checksum: `MOCK-${id}`, createdAt: loadFixtureProjection().clock.levelThreeVerifiedAt }
    this.backups.push(record)
    return { ok: true, data: structuredClone(record) }
  }

  /**
   * 按冻结备份记录返回预备份、校验、进度与回滚结果，不恢复真实数据库。
   * @param backupId 已确认的恢复来源编号。
   */
  restore(backupId: string): AdminResult<RestoreResult> {
    const record = this.backups.find((item) => item.backupId === backupId)
    if (!record) return { ok: false, code: 'NOT_FOUND', status: 404, message: '备份记录不存在。', fieldPath: 'backupId' }
    const integrityValid = record.status === 'VALID_FIXTURE'
    // ponytail: 以冻结记录复现恢复失败；真实接入后由恢复任务结果决定回滚。
    const rolledBack = integrityValid && record.backupId === 'BACKUP-ROLLBACK-001'
    return { ok: true, data: { prebackupId: 'PREBACKUP-002', integrityValid, progress: integrityValid ? 100 : 0,
      result: integrityValid && !rolledBack ? 'SUCCESS' : 'FAILURE', rolledBack, generated: false } }
  }

  /** 重置本阶段内存变更，恢复权威夹具。 */
  reset(): void {
    this.masterData = loadFixtureProjection().masterData
    this.backups = loadFixtureProjection().backups
    this.nextBackup = 1
  }
}
