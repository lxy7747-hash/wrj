/**
 * 运行期干扰计划/本地接受参数的持久化存储抽象。
 * 键为 (taskId, runId, jammerId)，记录只表示“本地已接受/已保存”，不代表引擎执行确认。
 */
export interface JammerPlanRecord {
  version: number
  detectionRangeM: number
  style?: 'BARRAGE' | 'SPOT'
  elevation?: number
  plannedStartFrame?: number
  plannedStopFrame?: number
}

export interface JammerPlanStorage {
  load(taskId: string, runId: string, jammerId: string): JammerPlanRecord | undefined
  save(taskId: string, runId: string, jammerId: string, record: JammerPlanRecord): void
  /** 清理某运行的全部本地计划，避免新运行/重播继承上一运行。 */
  deleteRun(runId: string): void
  close(): void
}

/** 纯 Mock/测试用内存实现；不触碰磁盘，随服务对象生命周期存在。 */
export class InMemoryJammerPlanStorage implements JammerPlanStorage {
  private readonly records = new Map<string, JammerPlanRecord>()

  private key(taskId: string, runId: string, jammerId: string): string {
    return `${taskId}|${runId}|${jammerId}`
  }

  load(taskId: string, runId: string, jammerId: string): JammerPlanRecord | undefined {
    const value = this.records.get(this.key(taskId, runId, jammerId))
    return value === undefined ? undefined : structuredClone(value)
  }

  save(taskId: string, runId: string, jammerId: string, record: JammerPlanRecord): void {
    this.records.set(this.key(taskId, runId, jammerId), structuredClone(record))
  }

  deleteRun(runId: string): void {
    for (const key of [...this.records.keys()]) {
      if (key.split('|')[1] === runId) this.records.delete(key)
    }
  }

  close(): void {
    this.records.clear()
  }
}

/** 依据已接受记录构造读取结果（合同 JammerRuntimeParameters 不含 runId）。 */
export function toRuntimeParameters(taskId: string, jammerId: string, record: JammerPlanRecord): {
  taskId: string; jammerId: string; version: number; detectionRangeM: number;
  style?: 'BARRAGE' | 'SPOT'; elevation?: number; plannedStartFrame?: number; plannedStopFrame?: number;
} {
  const result: {
    taskId: string; jammerId: string; version: number; detectionRangeM: number;
    style?: 'BARRAGE' | 'SPOT'; elevation?: number; plannedStartFrame?: number; plannedStopFrame?: number;
  } = { taskId, jammerId, version: record.version, detectionRangeM: record.detectionRangeM }
  if (record.style !== undefined) result.style = record.style
  if (record.elevation !== undefined) result.elevation = record.elevation
  if (record.plannedStartFrame !== undefined) result.plannedStartFrame = record.plannedStartFrame
  if (record.plannedStopFrame !== undefined) result.plannedStopFrame = record.plannedStopFrame
  return result
}
