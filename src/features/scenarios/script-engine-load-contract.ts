/** 本机 AFSIM 仿真引擎加载检查请求与结果结构（针对脚本包结构预检所选文件夹，独立于静态预检）。 */
export interface ScriptPackageEngineLoadCheckRequest {
  folder: string
  entry: string
  scenarioId?: string
  revision?: number
  /** 包根目录下的执行 TXT 文件（安全单段 .txt 文件名 → 文本内容）。 */
  files: Record<string, string>
  /** 可选的 mapping.json 原文（用于核对场景平台映射与配置统计）。 */
  mappingJson?: string
  /** 可选的 input.json 原文（用于展示场景配置数量）。 */
  inputJson?: string
}

export interface EngineLoadedPlatform {
  name: string
  type: string
  commCount: number
  sensorCount: number
  weaponCount: number
}

export interface ScriptEngineLoadCheckResult {
  folder: string
  entry: string
  scenarioId: string | null
  revision: number | null
  checksum: string
  passed: boolean
  syntaxPassed: boolean
  linkCalcChecked: boolean
  linkCalcSupported: boolean
  elapsedMs: number
  engineVersion: string | null
  expected: {
    platforms: number
    comms: number
    sensors: number
    weapons: number
    configuredPlatforms: number | null
    configuredLinks: number | null
    configuredJammers: number | null
    configuredSensors: number | null
  }
  loaded: {
    platforms: number
    comms: number
    sensors: number
    weapons: number
  }
  platforms: EngineLoadedPlatform[]
  errors: string[]
  warnings: string[]
  checkedAt: string
  cached: boolean
}

const SAFE_SCRIPT_FILENAME = /^[A-Za-z0-9._-]+\.txt$/u
const MAX_PACKAGE_FILES = 128
const MAX_PACKAGE_BYTES = 7 * 1024 * 1024

export function isSafeScriptFilename(name: string): boolean {
  return name.length > 0 && name.length <= 128 && name !== '.' && name !== '..' && SAFE_SCRIPT_FILENAME.test(name)
}

export function isScriptPackageEngineLoadCheckRequest(value: unknown): value is ScriptPackageEngineLoadCheckRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const allowedKeys = new Set(['folder', 'entry', 'scenarioId', 'revision', 'files', 'mappingJson', 'inputJson'])
  if (!Object.keys(record).every(key => allowedKeys.has(key))) return false
  if (typeof record.folder !== 'string' || !record.folder.trim() || record.folder.length > 256) return false
  if (typeof record.entry !== 'string' || !isSafeScriptFilename(record.entry)) return false
  if (record.scenarioId !== undefined && (typeof record.scenarioId !== 'string' || !record.scenarioId.trim())) return false
  if (record.revision !== undefined && (typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0)) return false
  if (record.mappingJson !== undefined && typeof record.mappingJson !== 'string') return false
  if (record.inputJson !== undefined && typeof record.inputJson !== 'string') return false
  if (typeof record.files !== 'object' || record.files === null || Array.isArray(record.files)) return false
  const entries = Object.entries(record.files as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_PACKAGE_FILES) return false
  let totalLength = (record.mappingJson?.length ?? 0) + (record.inputJson?.length ?? 0)
  for (const [name, content] of entries) {
    if (!isSafeScriptFilename(name) || typeof content !== 'string') return false
    totalLength += content.length
    if (totalLength > MAX_PACKAGE_BYTES) return false
  }
  return Object.hasOwn(record.files, record.entry)
}

function isEngineCountGroup(value: unknown): value is { platforms: number; comms: number; sensors: number; weapons: number } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return ['platforms', 'comms', 'sensors', 'weapons'].every(key => typeof record[key] === 'number' && Number.isFinite(record[key]))
}

function isEngineLoadedPlatform(value: unknown): value is EngineLoadedPlatform {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' && typeof record.type === 'string'
    && typeof record.commCount === 'number' && typeof record.sensorCount === 'number' && typeof record.weaponCount === 'number'
}

export function isScriptEngineLoadCheckResult(value: unknown): value is ScriptEngineLoadCheckResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.folder === 'string'
    && typeof record.entry === 'string'
    && (record.scenarioId === null || typeof record.scenarioId === 'string')
    && (record.revision === null || typeof record.revision === 'number')
    && typeof record.checksum === 'string'
    && typeof record.passed === 'boolean'
    && typeof record.syntaxPassed === 'boolean'
    && typeof record.linkCalcChecked === 'boolean'
    && typeof record.linkCalcSupported === 'boolean'
    && typeof record.elapsedMs === 'number'
    && (record.engineVersion === null || typeof record.engineVersion === 'string')
    && isEngineCountGroup(record.expected)
    && isEngineCountGroup(record.loaded)
    && Array.isArray(record.platforms) && record.platforms.every(isEngineLoadedPlatform)
    && Array.isArray(record.errors) && record.errors.every(item => typeof item === 'string')
    && Array.isArray(record.warnings) && record.warnings.every(item => typeof item === 'string')
    && typeof record.checkedAt === 'string'
    && typeof record.cached === 'boolean'
}
