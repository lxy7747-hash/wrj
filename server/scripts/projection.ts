import type {
  ApiErrorCode,
  ScenarioDraft,
  ScriptContract,
  ValidationIssue,
  ValidationResult,
} from '../../src/contracts/domain-models.js'

export type ScriptProjectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ApiErrorCode; status: 422; fieldPath?: string; message: string }

const GENERATED_TIME = '2026-08-06T08:03:02Z'

/** 将文本转换为稳定的非加密 Mock 校验和。 */
function mockChecksum(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `SHA256-MOCK-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

/** 从当前完整草稿生成不访问文件或进程的 AFSIM 文本预览。 */
function buildPreview(draft: ScenarioDraft): string {
  const config = draft.config
  const lines = [
    '# AFSIM 2.9.0 场景脚本预览；仅内存生成',
    `config_version ${config.schemaVersion}`,
    `scenario ${JSON.stringify(config.scenario.id)} {`,
    `  name ${JSON.stringify(config.scenario.name)}`,
    `  start_time ${JSON.stringify(config.scenario.startTime)}`,
    `  duration ${config.scenario.duration}s`,
    `  time_step ${config.scenario.timeStep}s`,
    `  environment sea_state=${config.scenario.environment.seaState} temperature=${config.scenario.environment.temperatureC} humidity=${config.scenario.environment.humidityPercent} rain_rate=${config.scenario.environment.rainRateMmPerHour} rain_loss=${config.scenario.environment.rainLossDbPerKm} multipath=${config.scenario.environment.multipathEnabled}`,
  ]
  config.platforms.forEach((platform) => {
    lines.push(`  platform ${JSON.stringify(platform.id)} type=${platform.type} domain=${platform.category} position=${platform.initialPosition.longitude},${platform.initialPosition.latitude},${platform.initialPosition.altitude}`)
    platform.waypoints.forEach((waypoint) => {
      lines.push(`    waypoint ${waypoint.longitude},${waypoint.latitude},${waypoint.altitude} speed=${waypoint.speed} arrival=${waypoint.arrivalTime}`)
    })
  })
  config.links.forEach((link) => {
    lines.push(`  comm ${JSON.stringify(link.id)} type=${link.type} source=${JSON.stringify(link.sourcePlatformId)} target=${JSON.stringify(link.targetPlatformId)} frequency=${link.frequency}MHz bandwidth=${link.bandwidth}MHz power=${link.txPower}W rate=${link.dataRate}Mbps`)
  })
  config.jammers.forEach((jammer) => {
    lines.push(`  jammer ${JSON.stringify(jammer.id)} platform=${JSON.stringify(jammer.platformId)} type=${jammer.type} frequency=${jammer.frequency}MHz bandwidth=${jammer.bandwidth}MHz power=${jammer.defaultPower}W range=${jammer.detectionRange}m`)
  })
  config.sensors.forEach((sensor) => {
    lines.push(`  sensor ${JSON.stringify(sensor.id)} platform=${JSON.stringify(sensor.platformId)} frequency=${sensor.frequencyRange.min}..${sensor.frequencyRange.max}MHz range=${sensor.detectionRange}m`)
  })
  config.informationDemand.forEach((demand) => {
    lines.push(`  information_demand ${JSON.stringify(demand.id)} source=${JSON.stringify(demand.sourcePlatformId)} destinations=${demand.destinationPlatformIds.map((id) => JSON.stringify(id)).join(',')} type=${JSON.stringify(demand.informationType)} volume=${demand.volumeMb}MB frequency=${demand.frequencyHz}Hz priority=${demand.priority} latency=${demand.maxLatencyMs}ms rate=${demand.minDataRateMbps}Mbps`)
  })
  lines.push(`  output path=${JSON.stringify(config.output.directory)} interval=${config.output.writeInterval}s link_quality=${config.output.linkQualityEnabled} events=${config.output.eventsEnabled} link_switch=${config.output.linkSwitchEnabled}`)
  lines.push('}')
  return lines.join('\n')
}

/** 对脚本预览执行结构、版本、输出路径和括号预检。 */
export function inspectScriptPreview(preview: string): ValidationResult {
  const lines = preview.split('\n')
  const errors: ValidationIssue[] = []
  const addError = (code: string, message: string, line: number, column = 1): void => {
    errors.push({ severity: 'ERROR', code, message: `第 ${line} 行，第 ${column} 列：${message}`, fieldPath: `preview[${line}:${column}]` })
  }
  if (lines[0] !== '# AFSIM 2.9.0 场景脚本预览；仅内存生成') addError('SCRIPT_HEADER_INVALID', '脚本头结构不正确。', 1)
  if (lines[1] !== 'config_version 1.0') addError('SCRIPT_VERSION_INVALID', '脚本配置版本必须为 1.0。', 2)
  if (!lines.some((line) => /^scenario "SCN-[^"]+" \{$/.test(line))) addError('SCRIPT_SCENARIO_INVALID', '缺少有效场景结构。', 3)
  const outputLine = lines.findIndex((line) => /^  output path=".+" interval=/.test(line))
  if (outputLine < 0) addError('SCRIPT_OUTPUT_PATH_INVALID', '缺少有效输出路径合同。', Math.max(1, lines.length - 1))
  const openBraces = [...preview].filter((character) => character === '{').length
  const closeBraces = [...preview].filter((character) => character === '}').length
  if (openBraces !== closeBraces) addError('SCRIPT_STRUCTURE_INVALID', '脚本结构括号不匹配。', lines.length, (lines.at(-1)?.length ?? 0) + 1)
  return { valid: errors.length === 0, errors, warnings: [] }
}

export class ScriptProjection {
  private scripts = new Map<string, ScriptContract>()
  private nextSequence = 1

  /** 生成并保存当前草稿的确定性内存脚本预览。 */
  preview(draft: ScenarioDraft): ScriptContract {
    const preview = buildPreview(draft)
    const script: ScriptContract = {
      scriptId: `SCRIPT-P2-${String(this.nextSequence).padStart(3, '0')}`,
      taskId: 'TASK-001',
      scenarioId: draft.config.scenario.id,
      configVersion: `${draft.config.scenario.id}-v${draft.revision}`,
      target: 'AFSIM 2.9.0',
      checksum: mockChecksum(preview),
      preview,
      generatedTime: GENERATED_TIME,
    }
    this.nextSequence += 1
    this.scripts.set(script.scriptId, script)
    return structuredClone(script)
  }

  /** 校验脚本编号、校验和及内存预览结构。 */
  preflight(scriptId: string, checksum: string): ScriptProjectionResult<ValidationResult> {
    const script = this.scripts.get(scriptId)
    if (script === undefined) return { ok: false, code: 'NOT_FOUND', status: 422, fieldPath: 'scriptId', message: '未找到指定脚本预览。' }
    if (checksum !== script.checksum) return { ok: false, code: 'VALIDATION_FAILED', status: 422, fieldPath: 'checksum', message: '脚本校验和不匹配。' }
    return { ok: true, data: inspectScriptPreview(script.preview) }
  }

  /** 清除脚本预览并恢复确定性编号。 */
  reset(): void {
    this.scripts.clear()
    this.nextSequence = 1
  }
}
