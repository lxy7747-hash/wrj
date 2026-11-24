// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ScenarioDraft } from '../../src/contracts/domain-models'
import type {
  EngineLoadedPlatform,
  ScriptEngineLoadCheckResult,
  ScriptPackageEngineLoadCheckRequest,
} from '../../src/features/scenarios/script-engine-load-contract'
import { createTemplateScenario } from '../fixtures/template-scenario'

const { existsSync } = await import('node:' + 'fs')
const { once } = await import('node:' + 'events')
const { fileURLToPath } = await import('node:' + 'url')
const { createMockServer } = await import('../../server/' + 'app.js')
const { createScriptPackageEngineLoadChecker } = await import('../../server/local/' + 'script-engine-load-check.js')
const { buildMissionPackage, SCENARIO_PREVIEW_FILE } = await import('../../server/scripts/' + 'mission-generator.js')
const { stripScriptComments } = await import('../../server/scripts/' + 'afsim-template-patch.js')
const { default: request } = await import('super' + 'test')

const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'OPERATOR' }
const localMissionExe = fileURLToPath(new URL('../../Release/Release/mission.exe', import.meta.url))

function templateDraftFor(scenarioId: `SCN-${string}`): ScenarioDraft {
  const draft = createTemplateScenario()
  draft.config.scenario.id = scenarioId
  draft.config.jammers.forEach(jammer => { jammer.frequency = 4500 })
  return draft
}

/** 构造与 writeScriptText 落盘一致的交付脚本包请求载荷（保留 comm_SimSetup.txt 中的模板输出路径）。 */
function buildDeliveryPackageRequest(draft: ScenarioDraft, folder = 'script-20261122113000'): ScriptPackageEngineLoadCheckRequest {
  const generated = buildMissionPackage(draft)
  const scriptFiles: string[] = generated.manifest.scriptFiles.filter((name: string) => name !== SCENARIO_PREVIEW_FILE)
  const files: Record<string, string> = {}
  for (const name of scriptFiles) {
    files[name] = stripScriptComments(generated.files[name] ?? '')
  }
  return {
    folder,
    entry: generated.manifest.entry,
    scenarioId: draft.config.scenario.id,
    revision: draft.revision,
    files,
    mappingJson: JSON.stringify({ ...generated.manifest, scriptFiles }, null, 2),
    inputJson: generated.files['input.json'],
  }
}

describe('脚本包结构预检 → 本机 AFSIM 引擎加载检查', () => {
  it('语法解析通过 + 实载平台/设备核对通过，且按包内容校验和缓存结果', async () => {
    const draft = templateDraftFor('SCN-001')
    const pkg = buildDeliveryPackageRequest(draft)
    const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args.includes('-list-variables')) {
        return {
          exitCode: 0,
          timedOut: false,
          output: 'mission:\n    WSF Version: 2.9.0 02-25-2022\nLoading simulation input.\nLoading simulation input complete.\nInput Variables:\n',
        }
      }
      return {
        exitCode: 0,
        timedOut: false,
        output: [
          'Loading simulation input complete.',
          'LOAD_CHECK_PLATFORM|rear_comm_vehicle|REAR_COMM_PLATFORM|1|0|0',
          'LOAD_CHECK_PLATFORM|command_vehicle|COMMAND_VEHICLE_PLATFORM|3|0|0',
          'LOAD_CHECK_PLATFORM|tiantong_sat|TIAN_TONG_SAT|0|0|0',
          'LOAD_CHECK_PLATFORM|shentong_sat|SHEN_TONG_SAT|0|0|0',
          'LOAD_CHECK_PLATFORM|mission_uav_01|MISSION_UAV_PLATFORM|2|0|0',
          'LOAD_CHECK_PLATFORM|mission_uav_02|MISSION_UAV_PLATFORM|2|0|0',
          'LOAD_CHECK_PLATFORM|mission_uav_03|MISSION_UAV_PLATFORM|2|0|0',
          'LOAD_CHECK_PLATFORM|jammer_station_01|GROUND_JAMMER_STATION|0|1|0',
          'LOAD_CHECK_PLATFORM|jammer_airborne_01|AIRBORNE_JAMMER_PLATFORM|0|0|1',
          'LOAD_CHECK_SUMMARY|9|10|1|1',
          'Simulation complete',
        ].join('\n'),
      }
    })

    const checker = createScriptPackageEngineLoadChecker('C:/mock/mission.exe', runner)
    const first: ScriptEngineLoadCheckResult = await checker(pkg)
    expect(first.passed).toBe(true)
    expect(first.syntaxPassed).toBe(true)
    expect(first.linkCalcChecked).toBe(true)
    expect(first.linkCalcSupported).toBe(true)
    expect(first.cached).toBe(false)
    expect(first.engineVersion).toBe('WSF 2.9.0 02-25-2022')
    expect(first.loaded).toEqual({ platforms: 9, comms: 10, sensors: 1, weapons: 1 })
    expect(first.platforms).toHaveLength(9)
    expect(first.errors).toEqual([])
    expect(runner).toHaveBeenCalledTimes(2)

    const second: ScriptEngineLoadCheckResult = await checker(pkg)
    expect(second.cached).toBe(true)
    expect(second.passed).toBe(true)
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('语法错误时直接阻断并返回精确行号上下文，不进入第二步', async () => {
    const pkg = buildDeliveryPackageRequest(templateDraftFor('SCN-001'))
    const runner = vi.fn(async () => ({
      exitCode: 1,
      timedOut: false,
      output: [
        'Loading simulation input.',
        '***** FATAL: Could not process input files.',
        '    ***** ERROR: Unknown command: bad_cmd',
        "             'comm_platform_REAR.txt', line 88, near column 26",
      ].join('\n'),
    }))

    const checker = createScriptPackageEngineLoadChecker('C:/mock/mission.exe', runner)
    const result: ScriptEngineLoadCheckResult = await checker(pkg)
    expect(result.passed).toBe(false)
    expect(result.syntaxPassed).toBe(false)
    expect(result.errors.some((line: string) => line.includes('Unknown command: bad_cmd'))).toBe(true)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('缺少 WSF_LINK_CALC_PROCESSOR 插件时诚实提示并用占位完成基础语法与平台核对', async () => {
    const pkg = buildDeliveryPackageRequest(templateDraftFor('SCN-001'))
    const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args.includes('-list-variables')) {
        return {
          exitCode: 1,
          timedOut: false,
          output: '***** ERROR: Could not find processor WSF_LINK_CALC_PROCESSOR\n***** FATAL: Could not process input files.',
        }
      }
      return {
        exitCode: 0,
        timedOut: false,
        output: [
          'Loading simulation input complete.',
          'LOAD_CHECK_PLATFORM|rear_comm_vehicle|REAR_COMM_PLATFORM|1|0|0',
          'LOAD_CHECK_PLATFORM|command_vehicle|COMMAND_VEHICLE_PLATFORM|3|0|0',
          'LOAD_CHECK_PLATFORM|tiantong_sat|TIAN_TONG_SAT|0|0|0',
          'LOAD_CHECK_PLATFORM|shentong_sat|SHEN_TONG_SAT|0|0|0',
          'LOAD_CHECK_PLATFORM|mission_uav_01|MISSION_UAV_PLATFORM|2|0|0',
          'LOAD_CHECK_PLATFORM|mission_uav_02|MISSION_UAV_PLATFORM|2|0|0',
          'LOAD_CHECK_PLATFORM|mission_uav_03|MISSION_UAV_PLATFORM|2|0|0',
          'LOAD_CHECK_PLATFORM|jammer_station_01|GROUND_JAMMER_STATION|0|1|0',
          'LOAD_CHECK_PLATFORM|jammer_airborne_01|AIRBORNE_JAMMER_PLATFORM|0|0|1',
          'LOAD_CHECK_SUMMARY|9|10|1|1',
          'Simulation complete',
        ].join('\n'),
      }
    })

    const checker = createScriptPackageEngineLoadChecker('C:/mock/mission.exe', runner)
    const result: ScriptEngineLoadCheckResult = await checker(pkg)
    expect(result.passed).toBe(true)
    expect(result.syntaxPassed).toBe(true)
    expect(result.linkCalcSupported).toBe(false)
    expect(result.linkCalcChecked).toBe(false)
    expect(result.warnings.some((line: string) => line.includes('WSF_LINK_CALC_PROCESSOR'))).toBe(true)
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('HTTP 接口校验鉴权、非法路径注入与纯 Mock 503，且不触碰轻量 preflight', async () => {
    const draft = templateDraftFor('SCN-001')
    const pkg = buildDeliveryPackageRequest(draft)
    const checkSpy = vi.fn(async (input: ScriptPackageEngineLoadCheckRequest): Promise<ScriptEngineLoadCheckResult> => ({
      folder: input.folder,
      entry: input.entry,
      scenarioId: input.scenarioId ?? null,
      revision: input.revision ?? null,
      checksum: 'SHA256-TEST',
      passed: true,
      syntaxPassed: true,
      linkCalcChecked: true,
      linkCalcSupported: true,
      elapsedMs: 120,
      engineVersion: 'WSF 2.9.0',
      expected: { platforms: 9, comms: 10, sensors: 1, weapons: 1, configuredPlatforms: 9, configuredLinks: 5, configuredJammers: 2, configuredSensors: 0 },
      loaded: { platforms: 9, comms: 10, sensors: 1, weapons: 1 },
      platforms: [],
      errors: [],
      warnings: [],
      checkedAt: '2026-11-22T00:00:00Z',
      cached: false,
    }))

    const server = createMockServer({ checkScriptEngineLoad: checkSpy })
    const pureMock = createMockServer()
    try {
      if (!server.httpServer.listening) await once(server.httpServer, 'listening')
      if (!pureMock.httpServer.listening) await once(pureMock.httpServer, 'listening')
      const api = request(`http://127.0.0.1:${(server.httpServer.address() as { port: number }).port}`)
      const mockApi = request(`http://127.0.0.1:${(pureMock.httpServer.address() as { port: number }).port}`)

      const endpoint = '/api/v1/scripts/package/engine-load-check'
      await api.post(endpoint).set({ Origin: headers.Origin }).send(pkg).expect(403)
      await api.post(endpoint).set(headers).send({ ...pkg, files: { '../evil.txt': 'x' } }).expect(400)
      await api.post(endpoint).set(headers).send({ ...pkg, entry: 'missing.txt' }).expect(400)
      expect(checkSpy).not.toHaveBeenCalled()

      const checked = (await api.post(endpoint).set(headers).send(pkg).expect(200)).body.data
      expect(checked.passed).toBe(true)
      expect(checked.folder).toBe(pkg.folder)
      expect(checkSpy).toHaveBeenCalledTimes(1)

      await mockApi.post(endpoint).set(headers).send(pkg).expect(503)
    } finally {
      await server.close()
      await pureMock.close()
    }
  })

  it.skipIf(!existsSync(localMissionExe))('真实本机 mission.exe 加载交付脚本包（标准 9 平台 + 51 信息节点）均无语法错误且数量一致', async () => {
    const checker = createScriptPackageEngineLoadChecker(localMissionExe)

    // 1. 标准交付包（含交付版绝对输出路径，验证自动重定向不报错）
    const standardDraft = templateDraftFor('SCN-001')
    const standardResult: ScriptEngineLoadCheckResult = await checker(buildDeliveryPackageRequest(standardDraft, 'script-std'))
    expect(standardResult.passed).toBe(true)
    expect(standardResult.syntaxPassed).toBe(true)
    expect(standardResult.linkCalcSupported).toBe(true)
    expect(standardResult.errors).toEqual([])
    expect(standardResult.loaded.platforms).toBe(standardDraft.config.platforms.length)

    // 2. GNZB-08 51 信息节点交付包（55 平台）
    const scaleDraft = templateDraftFor('SCN-001')
    const baseUav = scaleDraft.config.platforms.find(item => item.type === 'AIRBORNE_MISSION_CLUSTER')!
    const existingUavs = scaleDraft.config.platforms.filter(item => item.type === 'AIRBORNE_MISSION_CLUSTER').length
    for (let index = existingUavs; index < 48; index += 1) {
      const clone = structuredClone(baseUav)
      clone.id = `AIR-${String(index + 1).padStart(2, '0')}`
      clone.name = `任务机-${index + 1}`
      clone.initialPosition.latitude += index * 0.002
      clone.linkIds = []
      scaleDraft.config.platforms.push(clone)
    }
    const scaleResult: ScriptEngineLoadCheckResult = await checker(buildDeliveryPackageRequest(scaleDraft, 'script-51'))
    expect(scaleResult.passed).toBe(true)
    expect(scaleResult.syntaxPassed).toBe(true)
    expect(scaleResult.linkCalcSupported).toBe(true)
    expect(scaleResult.errors).toEqual([])
    expect(scaleResult.loaded.platforms).toBe(55)
    expect(scaleResult.platforms.filter((item: EngineLoadedPlatform) => item.type === 'MISSION_UAV_PLATFORM')).toHaveLength(49)
  }, 30_000)
})
