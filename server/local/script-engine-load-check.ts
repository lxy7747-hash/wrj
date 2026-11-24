import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  EngineLoadedPlatform,
  ScriptEngineLoadCheckResult,
  ScriptPackageEngineLoadCheckRequest,
} from '../../src/features/scenarios/script-engine-load-contract.js'
import { stripScriptComments } from '../scripts/afsim-template-patch.js'

const LOAD_CHECK_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BUFFER_BYTES = 4 * 1024 * 1024
const MAX_CACHE_ENTRIES = 16
const LINK_CALC_MISSING_MARKER = 'Could not find processor WSF_LINK_CALC_PROCESSOR'
const LOAD_PROBE_FILE = '_load_check.txt'

const LOAD_PROBE_SCRIPT = [
  'end_time 0.1 sec',
  'event_pipe',
  '   file output/load_check.aer',
  'end_event_pipe',
  'csv_event_output',
  '   file output/load_check.csv',
  'end_csv_event_output',
  'execute at_time 0.05 sec absolute',
  '   int pCount = WsfSimulation.PlatformCount();',
  '   int totalComms = 0;',
  '   int totalSensors = 0;',
  '   int totalWeapons = 0;',
  '   for (int i = 0; i < pCount; i = i + 1) {',
  '      WsfPlatform p = WsfSimulation.PlatformEntry(i);',
  '      if (p.IsValid()) {',
  '         int cc = p.CommCount();',
  '         int sc = p.SensorCount();',
  '         int wc = p.WeaponCount();',
  '         totalComms = totalComms + cc;',
  '         totalSensors = totalSensors + sc;',
  '         totalWeapons = totalWeapons + wc;',
  '         writeln("LOAD_CHECK_PLATFORM|" + p.Name() + "|" + p.Type() + "|" + (string)cc + "|" + (string)sc + "|" + (string)wc);',
  '      }',
  '   }',
  '   writeln("LOAD_CHECK_SUMMARY|" + (string)pCount + "|" + (string)totalComms + "|" + (string)totalSensors + "|" + (string)totalWeapons);',
  'end_execute',
  '',
].join('\n')

export interface EngineCommandResult {
  exitCode: number | null
  timedOut: boolean
  output: string
}

export type EngineCommandRunner = (executable: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<EngineCommandResult>

function defaultEngineRunner(executable: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<EngineCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { cwd, shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BUFFER_BYTES },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`
        if (!error) {
          resolve({ exitCode: 0, timedOut: false, output })
          return
        }
        const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: string | number }
        if (err.code === 'ENOENT' || err.code === 'EACCES') {
          reject(new Error(`无法启动本机仿真引擎（${executable}）：${err.message}`))
          return
        }
        const timedOut = Boolean(err.killed) || err.signal === 'SIGTERM' || err.signal === 'SIGKILL'
        const exitCode = typeof err.code === 'number' ? err.code : null
        resolve({ exitCode, timedOut, output })
      },
    )
  })
}

function stripBlockComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//gu, '')
}

/** 仅用于第二步探针副本：将 WSF_LINK_CALC_PROCESSOR 块替换为无阻塞空脚本处理器，避免初始化等待 WS 连接。 */
function stubLinkCalcBlock(content: string): string {
  const lines = content.split(/\r?\n/u)
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (!skipping && /^\s*(?:add\s+)?processor\s+\S+\s+WSF_LINK_CALC_PROCESSOR\b/u.test(line)) {
      skipping = true
      out.push('  add processor local_link_stub WSF_SCRIPT_PROCESSOR')
      out.push('  end_processor')
      continue
    }
    if (skipping) {
      if (/^\s*end_processor\b/u.test(line)) skipping = false
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/** 仅用于第二步探针副本：把交付入口里的绝对输出文件路径重定向到临时目录的 output/，避免依赖固定盘符。 */
function redirectProbeOutputs(content: string): string {
  const lines = content.split(/\r?\n/u)
  let section: 'event_pipe' | 'csv_event_output' | null = null
  const out = lines.map(line => {
    const trimmed = line.trim()
    if (/^event_pipe\b/u.test(trimmed)) { section = 'event_pipe'; return line }
    if (/^end_event_pipe\b/u.test(trimmed)) { section = null; return line }
    if (/^csv_event_output\b/u.test(trimmed)) { section = 'csv_event_output'; return line }
    if (/^end_csv_event_output\b/u.test(trimmed)) { section = null; return line }
    if (section === 'event_pipe' && /^\s*file\s+/u.test(line)) return '   file output/load_check.aer'
    if (section === 'csv_event_output' && /^\s*file\s+/u.test(line)) return '   file output/load_check.csv'
    return line
  })
  return out.join('\n')
}

/** 从脚本包的 TXT 中统计各平台实例及每个 platform_type 定义的通信、传感器与干扰武器数量。 */
export function countGeneratedScriptEntities(files: Readonly<Record<string, string>>, scriptFiles: readonly string[]): {
  platforms: number
  comms: number
  sensors: number
  weapons: number
} {
  const typeDevices = new Map<string, { comms: number; sensors: number; weapons: number }>()
  for (const name of scriptFiles) {
    if (!name.startsWith('comm_platform_') || name === 'comm_platform_INS.txt') continue
    const raw = files[name]
    if (!raw) continue
    const cleaned = stripBlockComments(stripScriptComments(raw))
    let currentType: string | null = null
    for (const line of cleaned.split(/\r?\n/u)) {
      const start = /^\s*platform_type\s+(\S+)\s+/u.exec(line)
      if (start) {
        currentType = start[1]!
        if (!typeDevices.has(currentType)) typeDevices.set(currentType, { comms: 0, sensors: 0, weapons: 0 })
        continue
      }
      if (/^\s*end_platform_type\b/u.test(line)) {
        currentType = null
        continue
      }
      if (!currentType) continue
      const counts = typeDevices.get(currentType)!
      if (/^\s*(?:add\s+)?comm\s+\S+/u.test(line)) counts.comms += 1
      else if (/^\s*(?:add\s+)?sensor\s+\S+/u.test(line)) counts.sensors += 1
      else if (/^\s*(?:add\s+)?weapon\s+\S+/u.test(line)) counts.weapons += 1
    }
  }
  const ins = stripBlockComments(stripScriptComments(files['comm_platform_INS.txt'] ?? ''))
  let platforms = 0
  let comms = 0
  let sensors = 0
  let weapons = 0
  for (const line of ins.split(/\r?\n/u)) {
    const match = /^\s*platform\s+(\S+)\s+(\S+)/u.exec(line)
    if (!match) continue
    platforms += 1
    const counts = typeDevices.get(match[2]!)
    if (counts) {
      comms += counts.comms
      sensors += counts.sensors
      weapons += counts.weapons
    }
  }
  return { platforms, comms, sensors, weapons }
}

/** 从 mission.exe 控制台输出提取引擎版本、语法/加载错误与 LinkCalc 缺失标志。 */
export function parseEngineDiagnostics(output: string): {
  engineVersion: string | null
  inputLoaded: boolean
  simulationCompleted: boolean
  missingLinkCalc: boolean
  errors: string[]
} {
  const lines = output.split(/\r?\n/u)
  const versionMatch = /WSF Version:\s*([^\r\n]+)/u.exec(output)
  const engineVersion = versionMatch ? `WSF ${versionMatch[1]!.trim()}` : null
  const inputLoaded = lines.some(line => line.trim() === 'Loading simulation input complete.')
  const simulationCompleted = lines.some(line => line.trim() === 'Simulation complete')
  const missingLinkCalc = output.includes(LINK_CALC_MISSING_MARKER)
  const errors: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim()
    if (!/^\*{5}\s+(?:ERROR|FATAL):/u.test(trimmed)) continue
    const details = [trimmed.replace(/^\*{5}\s+/u, '')]
    for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
      const follow = lines[next]!.trim()
      if (!follow || /^\*{5}\s+/u.test(follow) || follow.startsWith('Loading ') || follow.startsWith('Reading ')) break
      if (/^(?:File:|Line:|Column:|'[^']+',\s*line\b)/u.test(follow)) details.push(follow)
    }
    const merged = details.join(' · ')
    if (!errors.includes(merged)) errors.push(merged)
  }
  return { engineVersion, inputLoaded, simulationCompleted, missingLinkCalc, errors }
}

/** 解析 _load_check.txt 输出的实载平台与设备统计。 */
export function parseLoadProbeOutput(output: string): {
  platforms: EngineLoadedPlatform[]
  summary: { platforms: number; comms: number; sensors: number; weapons: number } | null
} {
  const platforms: EngineLoadedPlatform[] = []
  let summary: { platforms: number; comms: number; sensors: number; weapons: number } | null = null
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line.startsWith('LOAD_CHECK_PLATFORM|')) {
      const parts = line.split('|')
      if (parts.length === 6) {
        const commCount = Number(parts[3])
        const sensorCount = Number(parts[4])
        const weaponCount = Number(parts[5])
        if (Number.isFinite(commCount) && Number.isFinite(sensorCount) && Number.isFinite(weaponCount)) {
          platforms.push({ name: parts[1]!, type: parts[2]!, commCount, sensorCount, weaponCount })
        }
      }
    } else if (line.startsWith('LOAD_CHECK_SUMMARY|')) {
      const parts = line.split('|')
      if (parts.length === 5) {
        const p = Number(parts[1])
        const c = Number(parts[2])
        const s = Number(parts[3])
        const w = Number(parts[4])
        if ([p, c, s, w].every(Number.isFinite)) summary = { platforms: p, comms: c, sensors: s, weapons: w }
      }
    }
  }
  return { platforms, summary }
}

interface ParsedPackageMetadata {
  scenarioId: string | null
  revision: number | null
  mappedPlatformNames: string[]
  emittedSensorsCount: number
  configuredPlatforms: number | null
  configuredLinks: number | null
  configuredJammers: number | null
  configuredSensors: number | null
  hasGroundJammerEnabled: boolean
}

function parsePackageMetadata(pkg: ScriptPackageEngineLoadCheckRequest): ParsedPackageMetadata {
  let scenarioId: string | null = pkg.scenarioId ?? null
  let revision: number | null = pkg.revision ?? null
  let mappedPlatformNames: string[] = []
  let emittedSensorsCount = 0
  let configuredPlatforms: number | null = null
  let configuredLinks: number | null = null
  let configuredJammers: number | null = null
  let configuredSensors: number | null = null
  let hasGroundJammerEnabled = false

  if (pkg.mappingJson) {
    try {
      const parsed = JSON.parse(pkg.mappingJson.replace(/^\uFEFF/u, '')) as Record<string, unknown>
      if (typeof parsed.scenarioId === 'string' && parsed.scenarioId) scenarioId ??= parsed.scenarioId
      if (typeof parsed.revision === 'number' && Number.isSafeInteger(parsed.revision)) revision ??= parsed.revision
      if (Array.isArray(parsed.platforms)) {
        mappedPlatformNames = parsed.platforms
          .map(item => (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string' ? (item as { name: string }).name : ''))
          .filter(Boolean)
      }
      if (Array.isArray(parsed.sensors)) emittedSensorsCount = parsed.sensors.length
    } catch { /* 忽略无法解析的快照，不影响引擎加载检查 */ }
  }

  if (pkg.inputJson) {
    try {
      const parsed = JSON.parse(pkg.inputJson.replace(/^\uFEFF/u, '')) as Record<string, unknown>
      const config = (typeof parsed.config === 'object' && parsed.config !== null ? parsed.config : parsed) as Record<string, unknown>
      const ui = (typeof parsed.uiExtensions === 'object' && parsed.uiExtensions !== null ? parsed.uiExtensions : {}) as Record<string, unknown>
      const platforms = Array.isArray(config.platforms) ? config.platforms as Array<Record<string, unknown>> : null
      const links = Array.isArray(config.links) ? config.links as Array<Record<string, unknown>> : null
      const jammers = Array.isArray(config.jammers) ? config.jammers as Array<Record<string, unknown>> : null
      const sensors = Array.isArray(config.sensors) ? config.sensors as Array<Record<string, unknown>> : null
      const jammerExts = Array.isArray(ui.jammers) ? ui.jammers as Array<Record<string, unknown>> : []
      const sensorExts = Array.isArray(ui.sensors) ? ui.sensors as Array<Record<string, unknown>> : []
      if (platforms) configuredPlatforms = platforms.length
      if (links) configuredLinks = links.filter(link => link.enabled !== false).length
      if (jammers) {
        const enabledJammers = jammers.filter(j => jammerExts.find(e => e.jammerId === j.id)?.enabled !== false)
        configuredJammers = enabledJammers.length
        if (platforms) {
          hasGroundJammerEnabled = enabledJammers.some(j =>
            platforms.find(p => p.id === j.platformId)?.type === 'GROUND_JAMMER_DETECTION_STATION',
          )
        }
      }
      if (sensors) {
        configuredSensors = sensors.filter(s => sensorExts.find(e => e.sensorId === s.id)?.enabled !== false).length
      }
    } catch { /* 忽略无法解析的快照 */ }
  }

  return {
    scenarioId,
    revision,
    mappedPlatformNames,
    emittedSensorsCount,
    configuredPlatforms: configuredPlatforms ?? (mappedPlatformNames.length > 0 ? mappedPlatformNames.length : null),
    configuredLinks,
    configuredJammers,
    configuredSensors,
    hasGroundJammerEnabled,
  }
}

function computePackageChecksum(pkg: ScriptPackageEngineLoadCheckRequest): string {
  const hash = createHash('sha256')
  hash.update(`${pkg.entry}\0`)
  for (const name of Object.keys(pkg.files).sort()) {
    hash.update(`${name}\0${pkg.files[name]}\0`)
  }
  if (pkg.mappingJson !== undefined) hash.update(`mapping\0${pkg.mappingJson}\0`)
  if (pkg.inputJson !== undefined) hash.update(`input\0${pkg.inputJson}\0`)
  return `SHA256-${hash.digest('hex').slice(0, 16).toUpperCase()}`
}

/**
 * 创建带按内容校验和缓存的本机 AFSIM 引擎加载检查器（面向脚本包结构预检所选文件夹）：
 * 1. 先以 `-list-variables` 解析所选文件夹的原始 TXT（含真实 WSF_LINK_CALC_PROCESSOR），验证无语法/加载错误且不阻塞于 WS；
 * 2. 再在临时副本中以空处理器替代 link_calc、重定向输出到临时 output/ 并追加短时探针，核对引擎实际加载的平台与设备数量。
 */
export function createScriptPackageEngineLoadChecker(
  executable: string,
  runner: EngineCommandRunner = defaultEngineRunner,
  timeoutMs = LOAD_CHECK_TIMEOUT_MS,
): (pkg: ScriptPackageEngineLoadCheckRequest) => Promise<ScriptEngineLoadCheckResult> {
  const cache = new Map<string, ScriptEngineLoadCheckResult>()

  return async (pkg: ScriptPackageEngineLoadCheckRequest): Promise<ScriptEngineLoadCheckResult> => {
    const checksum = computePackageChecksum(pkg)
    const cached = cache.get(checksum)
    if (cached) {
      return {
        ...cached,
        folder: pkg.folder,
        cached: true,
        platforms: cached.platforms.map(item => ({ ...item })),
        errors: [...cached.errors],
        warnings: [...cached.warnings],
      }
    }

    const startedAt = Date.now()
    const fileNames = Object.keys(pkg.files)
    const scriptEntities = countGeneratedScriptEntities(pkg.files, fileNames)
    const metadata = parsePackageMetadata(pkg)
    const expected = {
      ...scriptEntities,
      configuredPlatforms: metadata.configuredPlatforms,
      configuredLinks: metadata.configuredLinks,
      configuredJammers: metadata.configuredJammers,
      configuredSensors: metadata.configuredSensors,
    }
    const errors: string[] = []
    const warnings: string[] = []
    let engineVersion: string | null = null
    let syntaxPassed = false
    let linkCalcChecked = false
    let linkCalcSupported = false
    let loaded = { platforms: 0, comms: 0, sensors: 0, weapons: 0 }
    let platforms: EngineLoadedPlatform[] = []
    let cacheable = true

    const rootDir = await mkdtemp(join(tmpdir(), 'wrj-engine-load-check-'))
    try {
      const syntaxDir = join(rootDir, 'syntax')
      await mkdir(join(syntaxDir, 'output'), { recursive: true })
      for (const [name, content] of Object.entries(pkg.files)) {
        await writeFile(join(syntaxDir, name), content, 'utf8')
      }

      const step1 = await runner(executable, ['-list-variables', pkg.entry], syntaxDir, timeoutMs)
      const diag1 = parseEngineDiagnostics(step1.output)
      engineVersion = diag1.engineVersion

      if (step1.timedOut) {
        cacheable = false
        errors.push(`引擎语法解析超时（>${Math.round(timeoutMs / 1000)} 秒）。`)
      } else if (diag1.missingLinkCalc) {
        linkCalcSupported = false
        linkCalcChecked = false
        warnings.push('当前本机仿真引擎未安装 WSF_LINK_CALC_PROCESSOR 插件，已使用本地占位继续完成基础语法与平台/设备加载检查。')
      } else if (step1.exitCode === 0 && diag1.inputLoaded && diag1.errors.length === 0) {
        syntaxPassed = true
        linkCalcChecked = true
        linkCalcSupported = true
      } else {
        syntaxPassed = false
        if (diag1.errors.length > 0) errors.push(...diag1.errors)
        else errors.push(`仿真引擎加载脚本失败（退出码 ${step1.exitCode ?? '未知'}）。`)
      }

      if (errors.length === 0) {
        const probeDir = join(rootDir, 'probe')
        await mkdir(join(probeDir, 'output'), { recursive: true })
        for (const [name, content] of Object.entries(pkg.files)) {
          let probeContent = stubLinkCalcBlock(content)
          if (name === pkg.entry) probeContent = redirectProbeOutputs(probeContent)
          await writeFile(join(probeDir, name), probeContent, 'utf8')
        }
        await writeFile(join(probeDir, LOAD_PROBE_FILE), LOAD_PROBE_SCRIPT, 'utf8')

        const step2 = await runner(executable, ['-es', pkg.entry, LOAD_PROBE_FILE], probeDir, timeoutMs)
        const diag2 = parseEngineDiagnostics(step2.output)
        engineVersion ??= diag2.engineVersion

        if (step2.timedOut) {
          cacheable = false
          errors.push(`引擎平台与设备加载核对超时（>${Math.round(timeoutMs / 1000)} 秒）。`)
        } else if (step2.exitCode !== 0 || !diag2.inputLoaded || diag2.errors.length > 0) {
          syntaxPassed = false
          if (diag2.errors.length > 0) errors.push(...diag2.errors)
          else errors.push(`引擎初始化加载失败（退出码 ${step2.exitCode ?? '未知'}）。`)
        } else {
          if (!linkCalcSupported) syntaxPassed = true
          const probed = parseLoadProbeOutput(step2.output)
          platforms = probed.platforms
          loaded = probed.summary ?? {
            platforms: probed.platforms.length,
            comms: probed.platforms.reduce((sum, item) => sum + item.commCount, 0),
            sensors: probed.platforms.reduce((sum, item) => sum + item.sensorCount, 0),
            weapons: probed.platforms.reduce((sum, item) => sum + item.weaponCount, 0),
          }

          if (!probed.summary) {
            errors.push('仿真引擎未返回平台与设备统计摘要，无法确认加载数量。')
          } else {
            const loadedNames = new Set(platforms.map(item => item.name))
            if (metadata.mappedPlatformNames.length > 0) {
              const missingPlatforms = metadata.mappedPlatformNames.filter(name => !loadedNames.has(name))
              if (missingPlatforms.length > 0) {
                errors.push(`以下场景平台未被仿真引擎加载：${missingPlatforms.join('、')}。`)
              }
              const extraTemplatePlatforms = platforms.map(item => item.name).filter(name => !metadata.mappedPlatformNames.includes(name))
              if (extraTemplatePlatforms.length > 0) {
                warnings.push(`1112 固定模板包含场景未配置的固定平台实例：${extraTemplatePlatforms.join('、')}。`)
              }
            }
            if (loaded.platforms !== expected.platforms) {
              errors.push(`引擎实载平台数（${loaded.platforms}）与脚本定义数（${expected.platforms}）不一致。`)
            }
            if (loaded.comms !== expected.comms) {
              errors.push(`引擎实载通信设备数（${loaded.comms}）与脚本定义数（${expected.comms}）不一致。`)
            }
            if (loaded.sensors !== expected.sensors) {
              errors.push(`引擎实载传感器数（${loaded.sensors}）与脚本定义数（${expected.sensors}）不一致。`)
            }
            if (loaded.weapons !== expected.weapons) {
              errors.push(`引擎实载干扰武器数（${loaded.weapons}）与脚本定义数（${expected.weapons}）不一致。`)
            }
            if ((metadata.configuredSensors ?? 0) > 0 && metadata.emittedSensorsCount === 0) {
              warnings.push(`场景中 ${metadata.configuredSensors} 台已启用 ESM 传感器未独立写入当前 1112 模板脚本，仅保留配置快照。`)
            }
            if (metadata.hasGroundJammerEnabled && metadata.configuredJammers !== null && expected.weapons < metadata.configuredJammers) {
              warnings.push('1112 模板中地面干扰站 prophet_jammer 武器块处于注释状态，因此引擎实载武器数低于配置干扰机数。')
            }
          }
        }
      }

      const result: ScriptEngineLoadCheckResult = {
        folder: pkg.folder,
        entry: pkg.entry,
        scenarioId: metadata.scenarioId,
        revision: metadata.revision,
        checksum,
        passed: syntaxPassed && errors.length === 0,
        syntaxPassed,
        linkCalcChecked,
        linkCalcSupported,
        elapsedMs: Date.now() - startedAt,
        engineVersion,
        expected,
        loaded,
        platforms,
        errors,
        warnings,
        checkedAt: new Date().toISOString(),
        cached: false,
      }
      if (cacheable) {
        if (cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(checksum, result)
      }
      return result
    } finally {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
