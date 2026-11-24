import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScriptContract } from '../../src/contracts/domain-models'
import type { ScriptEngineLoadCheckResult } from '../../src/features/scenarios/script-file'
import ScriptGenerationReceipt from '../../src/components/scenarios/ScriptGenerationReceipt.vue'
import ScriptPreviewDialog from '../../src/components/scenarios/ScriptPreviewDialog.vue'
import ScriptPreview from '../../src/components/scenarios/ScriptPreview.vue'
import { useAuthStore } from '../../src/stores/auth'
import { createTemplateScenario } from '../fixtures/template-scenario'

enableAutoUnmount(afterEach)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const meta = { requestId: 'REQ-ENGINE-CHECK', generatedAt: '2026-11-22T00:00:00Z', page: 1, pageSize: 1, total: 1 }

function makeFile(relativePath: string, content: string): File {
  const file = new File([content], relativePath.split('/').at(-1)!, { type: 'text/plain' })
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
  Object.defineProperty(file, 'text', { value: async () => content, configurable: true })
  return file
}

function makeFolderFiles(folder = 'script-20261122113000'): File[] {
  const manifest = JSON.stringify({
    scenarioId: 'SCN-001',
    revision: 2,
    entry: 'comm_SimSetup.txt',
    scriptFiles: ['comm_SimSetup.txt', 'comm_platform_INS.txt'],
  })
  const input = JSON.stringify({ config: { platforms: [{ id: 'CMD-01' }], links: [], jammers: [], sensors: [] }, uiExtensions: { jammers: [], sensors: [] } })
  return [
    makeFile(`${folder}/metadata/mapping.json`, manifest),
    makeFile(`${folder}/metadata/input.json`, input),
    makeFile(`${folder}/comm_SimSetup.txt`, 'include_once comm_platform_INS.txt\nend_time 10 sec\n'),
    makeFile(`${folder}/comm_platform_INS.txt`, 'platform rear_comm_vehicle REAR_COMM_PLATFORM\nend_platform\n'),
  ]
}

function makeResult(folder = 'script-20261122113000', overrides: Partial<ScriptEngineLoadCheckResult> = {}): ScriptEngineLoadCheckResult {
  return {
    folder,
    entry: 'comm_SimSetup.txt',
    scenarioId: 'SCN-001',
    revision: 2,
    checksum: 'SHA256-UI-001',
    passed: true,
    syntaxPassed: true,
    linkCalcChecked: true,
    linkCalcSupported: true,
    elapsedMs: 580,
    engineVersion: 'WSF 2.9.0 02-25-2022',
    expected: { platforms: 9, comms: 10, sensors: 1, weapons: 1, configuredPlatforms: 9, configuredLinks: 5, configuredJammers: 2, configuredSensors: 0 },
    loaded: { platforms: 9, comms: 10, sensors: 1, weapons: 1 },
    platforms: [
      { name: 'rear_comm_vehicle', type: 'REAR_COMM_PLATFORM', commCount: 1, sensorCount: 0, weaponCount: 0 },
      { name: 'mission_uav_02', type: 'MISSION_UAV_PLATFORM', commCount: 2, sensorCount: 0, weaponCount: 0 },
    ],
    errors: [],
    warnings: [],
    checkedAt: '2026-11-22T00:00:00Z',
    cached: false,
    ...overrides,
  }
}

function makeScript(): ScriptContract {
  return {
    scriptId: 'SCRIPT-P2-001',
    taskId: 'TASK-001',
    scenarioId: 'SCN-001',
    configVersion: 'SCN-001-v1',
    target: 'AFSIM 2.9.0',
    checksum: 'CHK-UI-001',
    preview: '// ===== scenario.txt =====\ninclude_once comm_SimSetup.txt',
    generatedTime: '2026-11-22T00:00:00Z',
  }
}

function setupAuth() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({
    principal: { userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'] },
    role: 'OPERATOR',
    permissions: ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE'],
  })
  return pinia
}

describe('引擎加载检查仅在「脚本包结构预检」弹框中提供', () => {
  it('选择文件夹做结构预检时不自动调用引擎；手动点击后送审所选包并展示结果，换包后重置', async () => {
    const pinia = setupAuth()
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { folder: string }
      return { ok: true, json: async () => ({ ok: true, data: makeResult(body.folder), meta }) } as Response
    })
    vi.stubGlobal('fetch', fetchSpy)

    const wrapper = mount(ScriptGenerationReceipt, {
      props: { modelValue: false, receipt: null, currentScene: { scenarioId: 'SCN-001', revision: 2, dirty: false } },
      global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } },
    })

    const input = wrapper.get<HTMLInputElement>('[data-testid="script-preflight-folder-input"]')
    Object.defineProperty(input.element, 'files', { value: makeFolderFiles('script-A'), configurable: true })
    await input.trigger('change')
    await flushPromises()

    // 结构预检完成但未触发引擎检查
    expect(wrapper.get('[data-testid="script-folder-preflight-result"]').text()).toContain('结构预检通过')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="run-engine-load-check"]').exists()).toBe(true)

    // 手动触发引擎加载检查
    await wrapper.get('[data-testid="run-engine-load-check"]').trigger('click')
    await flushPromises()

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/api/v1/scripts/package/engine-load-check')
    const sent = JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body)) as { folder: string; entry: string; files: Record<string, string> }
    expect(sent.folder).toBe('script-A')
    expect(sent.entry).toBe('comm_SimSetup.txt')
    expect(Object.keys(sent.files).sort()).toEqual(['comm_SimSetup.txt', 'comm_platform_INS.txt'])
    expect(wrapper.get('[data-testid="engine-load-check-result"]').text()).toContain('引擎加载检查通过')
    expect(wrapper.get('[data-testid="engine-load-check-platforms"]').text()).toContain('mission_uav_02')

    // 重选另一个脚本包后，上次引擎检查结果自动清空
    Object.defineProperty(input.element, 'files', { value: makeFolderFiles('script-B'), configurable: true })
    await input.trigger('change')
    await flushPromises()
    expect(wrapper.find('[data-testid="engine-load-check-result"]').exists()).toBe(false)
  })

  it('脚本生成成功弹框、脚本预览弹框与校验页脚本预览均不出现引擎加载检查入口', async () => {
    const pinia = setupAuth()

    const receiptWrapper = mount(ScriptGenerationReceipt, {
      props: {
        modelValue: true,
        receipt: { path: 'H:/output/scripts/script-1/comm_SimSetup.txt', version: 'SCN-001-v1', log: ['已生成'] },
        currentScene: { scenarioId: 'SCN-001', revision: 1, dirty: false },
      },
      global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } },
    })
    await flushPromises()
    expect(receiptWrapper.find('[data-testid="run-engine-load-check"]').exists()).toBe(false)

    const previewDialog = mount(ScriptPreviewDialog, {
      props: { modelValue: true, script: makeScript(), draft: createTemplateScenario() },
      global: { plugins: [pinia, ElementPlus], stubs: { teleport: true } },
    })
    await flushPromises()
    expect(previewDialog.find('[data-testid="run-engine-load-check"]').exists()).toBe(false)
    expect(previewDialog.text()).not.toContain('引擎加载检查')

    const previewPanel = mount(ScriptPreview, {
      props: {
        state: 'SUCCESS',
        resultMessage: '',
        script: makeScript(),
        preflight: { valid: true, errors: [], warnings: [] },
        locked: false,
        dirty: false,
        preflightPassed: true,
      },
      global: { plugins: [pinia, ElementPlus] },
    })
    expect(previewPanel.find('[data-testid="run-engine-load-check"]').exists()).toBe(false)
  })
})
