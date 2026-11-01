import type { ScenarioDraft, ScenarioSnapshot } from '../../contracts/domain-models'
export type { ScenarioSnapshot } from '../../contracts/domain-models'

/** 文件快照独立于场景配置版本，避免把界面扩展混入规范配置。 */
export const SCENARIO_SNAPSHOT_FORMAT = 'wrj.scenario.snapshot'
export const SCENARIO_SNAPSHOT_VERSION = 1

export interface ParsedScenarioSnapshot {
  config: unknown
  uiExtensions?: unknown
  versioned: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 构造可跨版本导入的场景文件；不包含运行锁、修订号等服务器状态。 */
export function createScenarioSnapshot(draft: Pick<ScenarioDraft, 'config' | 'uiExtensions'>): ScenarioSnapshot {
  return {
    format: SCENARIO_SNAPSHOT_FORMAT,
    version: SCENARIO_SNAPSHOT_VERSION,
    config: structuredClone(draft.config),
    uiExtensions: structuredClone(draft.uiExtensions),
  }
}

/**
 * 读取本地场景文件外壳。旧版纯 ScenarioConfig 仍被识别，但不接受带未知字段的快照外壳。
 * 具体配置和扩展字段继续由调用方使用其完整校验器验证。
 */
export function parseScenarioSnapshot(value: unknown): ParsedScenarioSnapshot | undefined {
  if (!isRecord(value)) return undefined
  if (Object.hasOwn(value, 'schemaVersion')) return { config: value, versioned: false }
  const keys = Object.keys(value)
  if (keys.length !== 4 || !keys.every(key => ['format', 'version', 'config', 'uiExtensions'].includes(key))
    || value.format !== SCENARIO_SNAPSHOT_FORMAT || value.version !== SCENARIO_SNAPSHOT_VERSION) return undefined
  return { config: value.config, uiExtensions: value.uiExtensions, versioned: true }
}

/** 供导入覆盖提示读取文件场景编号；不将未验证内容视为有效配置。 */
export function scenarioSnapshotId(value: unknown): string | undefined {
  const snapshot = parseScenarioSnapshot(value)
  if (!snapshot || !isRecord(snapshot.config) || !isRecord(snapshot.config.scenario)) return undefined
  return typeof snapshot.config.scenario.id === 'string' ? snapshot.config.scenario.id : undefined
}
