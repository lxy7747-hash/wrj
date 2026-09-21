import type { BackupPlan, BackupPlanStatus } from '../../contracts/domain-models'
import { isAdminObject, isAdminText } from './admin-contract'
import { isRfc3339DateTime } from '../scenarios/scenario-validation'

export function isBackupPlan(value: unknown): value is BackupPlan {
  return isAdminObject(value, ['version', 'enabled', 'name', 'intervalMinutes'])
    && Number.isSafeInteger(value.version) && Number(value.version) >= 1
    && typeof value.enabled === 'boolean' && isAdminText(value.name) && value.name.length <= 80
    && Number.isInteger(value.intervalMinutes) && Number(value.intervalMinutes) >= 60 && Number(value.intervalMinutes) <= 10080
}

export function isBackupPlanStatus(value: unknown): value is BackupPlanStatus {
  return isAdminObject(value, ['plan', 'nextRunAt', 'executions']) && isBackupPlan(value.plan)
    && (value.plan.enabled ? isRfc3339DateTime(value.nextRunAt) : value.nextRunAt === null)
    && Array.isArray(value.executions) && value.executions.length <= 20
    && value.executions.every(row => isAdminObject(row, ['startedAt', 'completedAt', 'result', 'backupId', 'message'])
      && isRfc3339DateTime(row.startedAt) && isRfc3339DateTime(row.completedAt)
      && Date.parse(row.completedAt) >= Date.parse(row.startedAt)
      && isAdminText(row.message) && (row.result === 'SUCCESS' ? isAdminText(row.backupId) : row.result === 'FAILURE' && row.backupId === null))
}
