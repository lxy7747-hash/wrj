import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus, { ElMessage, ElMessageBox } from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ScenarioConfig, ScenarioDraft, SimulationRun } from '../../src/contracts/domain-models'
import ScenariosPage from '../../src/pages/scenarios/scenarios.vue'
import { useAuthStore } from '../../src/stores/auth'
import { useScenarioStore } from '../../src/stores/scenario'
import { useSimulationStore } from '../../src/stores/simulation'

enableAutoUnmount(afterEach)
afterEach(() => {
  ElMessage.closeAll()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

function success(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }))
}
function failure(message = '测试服务拒绝'): Response {
  return new Response(JSON.stringify({ ok: false, error: { code: 'START_FAILED', message, retryable: false, correlationId: 'TEST' } }), { status: 503 })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const auth = useAuthStore()
  const permissions = ['BUSINESS_READ', 'SCENARIO_DRAFT_WRITE', 'SIMULATION_CONTROL'] as const
  auth.$patch({ principal: { userId: 'USR-TEST', username: 'operator', role: 'OPERATOR', permissions: [...permissions] }, role: 'OPERATOR', permissions: [...permissions], runtimeMode: 'LOCAL' })
  const saved: ScenarioDraft = { config: structuredClone(fixture.scenario) as ScenarioConfig, uiExtensions: {
    jammers: fixture.scenario.jammers.map(jammer => ({ jammerId: jammer.id, direction: 360, duration: 60, enabled: true })),
    sensors: fixture.scenario.sensors.map(sensor => ({ sensorId: sensor.id, type: 'ESM', direction: 'OMNI', probability: 0.95, enabled: true })),
  }, revision: 4, locked: false, officialLibraryChanged: false }
  saved.config.scenario.id = 'SCN-AUTO'
  Object.assign(saved.config.jammers[0]!, { defaultPower: 1, bandwidth: 200 })
  const run: SimulationRun = {
    runId: 'RUN-007', taskId: 'TASK-001', scenarioId: 'SCN-OTHER', uiStatus: 'RUNNING', configLocked: true,
    canonical: { status: 'RUNNING', currentTime: 0, totalDuration: saved.config.scenario.duration, processId: null, progress: 0 },
  }
  const script = () => ({ scriptId: 'SCRIPT-AUTO', taskId: 'TASK-001', scenarioId: 'SCN-AUTO', configVersion: `SCN-AUTO-v${saved.revision}`, target: 'AFSIM 2.9.0', checksum: 'TEST', preview: '# test', generatedTime: '2026-09-30T00:00:00Z' })
  const file = () => ({ scriptId: 'SCRIPT-AUTO', configVersion: `SCN-AUTO-v${saved.revision}`, path: 'H:\\test-output\\SCN-AUTO.txt' })
  const calls: string[] = []
  const override = vi.fn<(path: string, init?: RequestInit) => Response | Promise<Response> | undefined>()
  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    const overridden = override(path, init)
    if (overridden !== undefined) return overridden
    if (path.endsWith('/validate')) return success({ valid: true, errors: [], warnings: [] })
    if (path === '/api/v1/scripts/preview') return success(script())
    if (path.endsWith('/local-file')) return success(file())
    if (path === '/api/v1/scenarios/SCN-AUTO') {
      if (init?.method === 'PUT') { saved.config = JSON.parse(String(init.body)).config; saved.revision++ }
      return success(saved)
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchSpy)
  const store = useScenarioStore()
  expect(await store.loadScenario('SCN-AUTO')).toBe(true)
  const wrapper = mount(ScenariosPage, { props: { managed: true }, global: { plugins: [pinia, ElementPlus] } })
  const successSpy = vi.spyOn(ElMessage, 'success')
  calls.length = 0
  const save = async () => { await wrapper.get('[data-testid="save-scenario"]').trigger('click'); await flushPromises() }
  const preview = async () => { await wrapper.get('[data-testid="generate-script"]').trigger('click'); await flushPromises() }
  const generateFile = async () => { await wrapper.get('[data-testid="generate-script-file"]').trigger('click'); await flushPromises() }
  return { auth, store, simulation: useSimulationStore(), wrapper, run, script, file, calls, override, save, preview, generateFile, successSpy }
}

describe('保存场景并生成 TXT', () => {
  it('写入修改后的非默认场景和 TXT，无仿真请求，仅一次成功反馈', async () => {
    const t = await setup()
    await t.wrapper.get('[data-testid="scenario-name"]').setValue('已修改的场景')
    await t.save()
    expect(t.calls).toEqual([
      'PUT /api/v1/scenarios/SCN-AUTO', 'POST /api/v1/scenarios/SCN-AUTO/validate',
      'POST /api/v1/scripts/preview', 'POST /api/v1/scripts/SCRIPT-AUTO/local-file',
    ])
    expect(t.simulation.run).toBeNull()
    expect(t.simulation.selectedScene).toBeNull()
    expect(t.store.draft?.locked).toBe(false)
    expect(t.store.dirty).toBe(false)
    expect(t.successSpy).toHaveBeenCalledExactlyOnceWith('场景已保存，TXT 已生成。')
    expect(t.wrapper.emitted('saved')).toHaveLength(1)
  })

  it.each(['PUT', 'preview', 'local-file'])('%s 失败不选用或运行场景', async stage => {
    const t = await setup()
    await t.wrapper.get('[data-testid="scenario-name"]').setValue('需要保存')
    t.override.mockImplementation((path, init) => (stage === 'PUT' ? init?.method === 'PUT' : path.endsWith(`/${stage}`)) ? failure() : undefined)
    await t.save()
    expect(t.calls.some(c => c.includes('/simulations'))).toBe(false)
    expect(t.successSpy).not.toHaveBeenCalled()
    expect(t.wrapper.emitted('saved')).toBeUndefined()
  })

  it('已有其他场景运行时，仍能保存本场景且不影响运行状态', async () => {
    const t = await setup()
    t.simulation.applyRun(t.run)
    await t.wrapper.get('[data-testid="scenario-name"]').setValue('运行期间保存的另一场景')
    await t.save()
    expect(t.calls).toContain('PUT /api/v1/scenarios/SCN-AUTO')
    expect(t.calls.some(c => c.includes('/simulations'))).toBe(false)
    expect(t.simulation.run).toEqual(t.run)
    expect(t.store.dirty).toBe(false)
    expect(t.successSpy).toHaveBeenCalledExactlyOnceWith('场景已保存，TXT 已生成。')
  })

  it.each(['离页', '登出', '修改草稿', '全局重置'])('TXT 写入在途时%s，迟到结果不提示保存成功', async action => {
    const t = await setup()
    const pending = deferred<Response>()
    t.override.mockImplementation(path => path.endsWith('/local-file') ? pending.promise : undefined)
    await t.save()
    expect(t.calls).toContain('POST /api/v1/scripts/SCRIPT-AUTO/local-file')
    if (action === '离页') t.wrapper.unmount()
    else if (action === '登出') { t.auth.resetToSafeEmpty(); t.store.resetToSafeEmpty(); t.simulation.resetToSafeEmpty() }
    else if (action === '修改草稿') await t.wrapper.get('[data-testid="scenario-name"]').setValue('新的草稿')
    else t.store.resetToSafeEmpty()
    pending.resolve(success(t.file()))
    await flushPromises()
    expect(t.calls.some(c => c.includes('/simulations'))).toBe(false)
    expect(t.successSpy).not.toHaveBeenCalled()
  })

  it('TXT 在途时重复点击保存只写入并提示成功一次', async () => {
    const t = await setup()
    const pending = deferred<Response>()
    t.override.mockImplementation(path => path.endsWith('/local-file') ? pending.promise : undefined)
    await t.save()
    await t.save()
    expect(t.calls.filter(c => c.endsWith('/local-file'))).toHaveLength(1)
    pending.resolve(success(t.file()))
    await flushPromises()
    expect(t.calls.some(c => c.includes('/simulations'))).toBe(false)
    expect(t.successSpy).toHaveBeenCalledExactlyOnceWith('场景已保存，TXT 已生成。')
  })
})

describe('独立生成脚本文件入口', () => {
  const receipt = '[data-testid="script-generation-receipt"]'
  const writeRequest = 'POST /api/v1/scripts/SCRIPT-AUTO/local-file'

  it('已保存场景写盘确认后显示路径、修订和日志并留在编辑页', async () => {
    const t = await setup()
    const revision = t.store.draft?.revision
    const pending = deferred<Response>()
    const logDetail = '示例生成记录'
    const mapping = JSON.stringify({ executionStatus: {
      emitted: [], retainedSnapshot: [{ fieldPath: 'scenario.duration', detail: logDetail }], dependencyUnconfirmed: [],
    } }, null, 2)
    const preview = ['# synthetic', '// ===== mapping.json =====', ...mapping.split('\n').map(line => '// ' + line)].join('\n')
    t.override.mockImplementation(path => {
      if (path === '/api/v1/scripts/preview') return success({ ...t.script(), preview })
      if (path.endsWith('/local-file')) return pending.promise
    })
    await t.generateFile()
    expect(t.calls[0]).toBe('POST /api/v1/scenarios/SCN-AUTO/validate')
    expect(t.calls.filter(call => !call.endsWith('/validate'))).toEqual(['POST /api/v1/scripts/preview', writeRequest])
    expect(t.wrapper.find(receipt).exists()).toBe(false)
    const file = t.file()
    pending.resolve(success(file))
    await flushPromises()
    const previewDialog = t.wrapper.get('[data-testid="script-preview-dialog"]')
    expect(previewDialog.get('[data-testid="standalone-script-preview"]').element.textContent).toBe('# synthetic')
    await previewDialog.get('[data-testid="script-file-mapping.json"]').trigger('click')
    await flushPromises()
    expect(previewDialog.get('[data-testid="standalone-script-preview"]').element.textContent).toContain('"fieldPath": "scenario.duration"')
    const result = previewDialog.get(receipt)
    expect(result.text()).toContain('脚本生成成功')
    expect(result.text()).toContain('脚本路径')
    expect(result.text()).toContain(file.path)
    expect(result.text()).toContain('场景版本号')
    expect(result.text()).toContain(file.configVersion)
    expect(result.text()).toContain('生成日志')
    expect(result.get('[data-testid="script-generation-receipt-log"]').text()).toContain(logDetail)
    expect(result.get('[data-testid="script-generation-receipt-log"]').text()).not.toContain('预览未执行引擎校验')
    expect(result.get('[data-testid="script-generation-receipt-log"]').text()).not.toContain('WSF_LINK_CALC_PROCESSOR')
    await result.get('[data-testid="toggle-generation-log"]').trigger('click')
    await flushPromises()
    expect(result.find('[data-testid="script-generation-receipt-log"]').exists()).toBe(false)
    await result.get('[data-testid="toggle-generation-log"]').trigger('click')
    await flushPromises()
    expect(result.get('[data-testid="script-generation-receipt-log"]').text()).toContain(logDetail)
    expect(t.store.draft?.revision).toBe(revision)
    expect(t.wrapper.emitted('saved')).toBeUndefined()
    expect(t.simulation.run).toBeNull()
  })

  it('无需生成即可从工具栏预检旧修订的脚本包', async () => {
    const t = await setup()
    const preflight = t.wrapper.get('[data-testid="preflight-script-folder"]')
    const generate = t.wrapper.get('[data-testid="generate-script-file"]')
    expect(generate.element.closest('.scenario-header__actions')?.contains(preflight.element)).toBe(true)
    expect(preflight.attributes('disabled')).toBeUndefined()
    const closeOutput = async () => {
      const close = t.wrapper.get(receipt).findAll('button').find(button => button.text() === '关闭')
      expect(close).toBeDefined()
      await close!.trigger('click')
      await flushPromises()
      const dialog = t.wrapper.find(receipt)
      expect(dialog.exists() && dialog.isVisible()).toBe(false)
    }
    const picker = t.wrapper.get('[data-testid="script-preflight-folder-input"]')
    const input = picker.element as HTMLInputElement
    expect(input.type).toBe('file')
    expect(input.hasAttribute('webkitdirectory')).toBe(true)
    expect(input.closest('[role="dialog"]')).toBeNull()
    const openPicker = vi.spyOn(input, 'click').mockImplementation(() => {})

    const pickedFile = (path: string, content: string) => {
      const file = new File([content], path.split('/').at(-1)!)
      Object.defineProperties(file, {
        webkitRelativePath: { value: 'sample-output/' + path },
        text: { value: async () => content },
      })
      return file
    }
    const entry = 'SCN-AUTO-v2.txt'
    const dependency = 'dependency.txt'
    const files = [
      pickedFile(entry, 'include_once dependency.txt\n'),
      pickedFile('metadata/mapping.json', JSON.stringify({
        scenarioId: 'SCN-AUTO', revision: 2, entry, scriptFiles: [entry, dependency],
      })),
      pickedFile('metadata/input.json', '{}'),
    ]
    const chooseFolder = async (selection: File[]) => {
      await preflight.trigger('click')
      Object.defineProperty(input, 'files', { configurable: true, value: selection })
      await picker.trigger('change')
      await flushPromises()
      const output = t.wrapper.get(receipt)
      expect(output.text()).toContain('脚本包结构预检')
      return output.get('[data-testid="script-folder-preflight-result"]')
    }
    const fileRows = () => t.wrapper.get('[data-testid="script-preflight-script-files"]').findAll('tbody tr')
      .map(row => row.findAll('th, td').map(cell => cell.text()))
    const verified = await chooseFolder([...files, pickedFile(dependency, [
      'platform placeholder WSF_PLATFORM', '  route', '  end_route', 'end_platform',
    ].join('\r\n'))])
    expect(verified.text()).toContain('结构预检通过')
    expect(verified.text()).toMatch(/所选场景\s*SCN-AUTO/u)
    expect(verified.text()).toMatch(/所选修订\s*2/u)
    expect(verified.text()).toContain('入口文件')
    expect(verified.text()).toContain(entry)
    expect(verified.text()).toContain('当前场景为修订 4。')
    expect(verified.text()).toContain('TXT 文件明细（2 个）')
    expect(verified.text()).not.toContain('检查在本机浏览器完成，未调用引擎。')
    expect(verified.get('[data-testid="script-preflight-overview"]').findAll('div')
      .map(row => [row.get('dt').text(), row.get('dd').text()])).toEqual([
      ['入口状态', '有脚本内容'], ['清单文件', '4 / 4'], ['包含引用', '1 条'], ['配对定义块', '2 个'],
    ])
    expect(fileRows()).toEqual([[entry, '1', '—', '已检查'], [dependency, '0', '2', '已检查']])
    await closeOutput()
    await t.wrapper.get('[data-testid="scenario-name"]').setValue('带有未保存修改的当前草稿')
    expect(t.store.dirty).toBe(true)
    expect(preflight.attributes('disabled')).toBeUndefined()
    const missing = await chooseFolder(files)
    expect(missing.text()).toContain('结构预检有错误')
    expect(missing.text()).toContain(dependency)
    expect(fileRows()).toEqual([[entry, '1', '—', '有错误'], [dependency, '—', '—', '文件缺失']])
    await closeOutput()
    const malformed = await chooseFolder([...files, pickedFile(dependency, '# placeholder\r\nplatform placeholder WSF_PLATFORM')])
    expect(malformed.text()).toContain('结构预检有错误')
    expect(malformed.text()).toMatch(/dependency\.txt:2：[^。]*未闭合/u)
    expect(fileRows()).toEqual([[entry, '1', '—', '已检查'], [dependency, '0', '—', '有错误']])
    expect(openPicker).toHaveBeenCalledTimes(3)
    expect(t.calls).toEqual([])
  })

  it('有阻断项时显示字段校验，不发起生成或写盘请求', async () => {
    const t = await setup()
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
    await t.wrapper.get('[data-testid="scenario-name"]').setValue(' ')
    await t.generateFile()
    expect(t.wrapper.get('[data-testid="validation-panel"]').text()).toContain('场景名称')
    expect(t.calls).toEqual([])
    expect(confirm).not.toHaveBeenCalled()
    expect(t.wrapper.find(receipt).exists()).toBe(false)
  })

  it('写盘失败时显示错误且没有成功回执', async () => {
    const t = await setup()
    const errorSpy = vi.spyOn(ElMessage, 'error')
    t.override.mockImplementation(path => path.endsWith('/local-file') ? failure('测试写盘失败') : undefined)
    await t.generateFile()
    expect(t.calls).toContain(writeRequest)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('测试写盘失败'))
    expect(t.wrapper.find(receipt).exists()).toBe(false)
    expect(t.successSpy).not.toHaveBeenCalled()
    expect(t.wrapper.emitted('saved')).toBeUndefined()
  })

  it.each([true, false])('确认保存并生成=%s 时才保存草稿和写盘', async confirmed => {
    const t = await setup()
    await t.wrapper.get('[data-testid="scenario-name"]').setValue('待确认生成的场景')
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
    if (confirmed) confirm.mockResolvedValue('confirm' as never)
    else confirm.mockRejectedValue('cancel')
    await t.generateFile()
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]?.at(-1)).toMatchObject({ confirmButtonText: '保存并生成' })
    expect(t.store.dirty).toBe(!confirmed)
    expect(t.wrapper.find(receipt).exists()).toBe(confirmed)
    expect(t.wrapper.emitted('saved')).toBeUndefined()
    if (confirmed) {
      expect(t.calls).toEqual([
        'PUT /api/v1/scenarios/SCN-AUTO', 'POST /api/v1/scenarios/SCN-AUTO/validate',
        'POST /api/v1/scripts/preview', writeRequest,
      ])
      expect(t.wrapper.get(receipt).text()).toContain(t.file().configVersion)
    } else {
      expect(t.calls).toEqual([])
    }
  })
})

describe('独立脚本预览入口', () => {
  const previewText = (wrapper: VueWrapper) => {
    const content = wrapper.find('[data-testid="script-preview-dialog"] [data-testid="standalone-script-preview"]')
    return content.exists() ? content.text() : undefined
  }

  it('已保存场景直接打开预览，维持场景修订和管理页', async () => {
    const t = await setup()
    const revision = t.store.draft?.revision
    const text = '// ===== sample.txt =====\r\n  first line <&>\r\n\r\n  last line'
    t.override.mockImplementation(path => path === '/api/v1/scripts/preview' ? success({ ...t.script(), preview: text }) : undefined)
    await t.preview()
    const dialog = t.wrapper.get('[data-testid="script-preview-dialog"]')
    expect(dialog.find('[data-testid="script-generation-receipt"]').exists()).toBe(false)
    const code = dialog.get('[data-testid="standalone-script-preview"]')
    expect(code.element.textContent).toBe(text)
    expect(code.get('.script-preview-section').text()).toBe('// ===== sample.txt =====')
    expect(t.wrapper.get('.script-preview-gutter').element.textContent).toBe('1\n2\n3\n4')
    expect(t.calls.filter(call => !call.endsWith('/validate'))).toEqual(['POST /api/v1/scripts/preview'])
    expect(t.store.draft?.revision).toBe(revision)
    expect(t.wrapper.emitted('saved')).toBeUndefined()
  })

  it('验收核对可切换六类，定位原文后保留分类和原始文本', async () => {
    const t = await setup()
    const duplicatedPath = 'platforms[0].name'
    const dependencyPath = 'uiExtensions.jammers[0]'
    const durationLine = '  end_time 2 s  '
    const deviceLine = '    jammer_param {}  '
    const communicationBlock = ['  add processor link_calc SAMPLE_BLOCK', '    port_params []', deviceLine, '  end_processor']
    const mappingLines = JSON.stringify({ entry: 'sample.txt', executionStatus: {
      emitted: [
        { fieldPath: duplicatedPath, detail: '样例平台记录' },
        { fieldPath: 'platforms[0].waypoints', detail: '样例运动记录' },
        { fieldPath: 'links[0]', detail: '样例通信记录' },
        { fieldPath: 'jammers[0]', detail: '样例干扰定义' },
        { fieldPath: 'scenario.duration', detail: '样例时序记录' },
      ],
      retainedSnapshot: [
        { fieldPath: duplicatedPath, detail: '同路径的快照记录' },
      ],
      dependencyUnconfirmed: [
        { fieldPath: 'uiExtensions.sensors[0]', detail: '样例传感器记录' },
        { fieldPath: dependencyPath, detail: '样例干扰记录' },
      ],
    } }, null, 2).split('\n')
    const sampleSection = ['// ===== sample.txt =====', '  # synthetic <&>  ', '', durationLine, ''].join('\n')
    const rearSection = ['// ===== comm_platform_REAR.txt =====', ...communicationBlock, ''].join('\n')
    const mappingSection = ['// ===== mapping.json =====', ...mappingLines.map(line => '// ' + line), ''].join('\n')
    const text = [sampleSection, rearSection, mappingSection].join('\n')
    t.override.mockImplementation(path => path === '/api/v1/scripts/preview'
      ? success({ ...t.script(), preview: text }) : undefined)
    await t.preview()

    const dialog = t.wrapper.get('[data-testid="script-preview-dialog"]')
    const tabs = (name: string) => dialog.findAll('[role="tab"]').find(tab => tab.text() === name)!
    const original = () => dialog.get('[data-testid="standalone-script-preview"]')
    expect(tabs('脚本原文').attributes('aria-selected')).toBe('true')
    expect(original().element.textContent).toBe(sampleSection)
    expect(dialog.find('[data-testid="script-file-sample.txt"]').exists()).toBe(true)
    expect(dialog.find('[data-testid="script-file-comm_platform_REAR.txt"]').exists()).toBe(true)
    expect(dialog.find('[data-testid="script-file-mapping.json"]').exists()).toBe(true)
    const showAcceptance = async () => {
      await tabs('验收核对').trigger('click')
      await flushPromises()
      expect(tabs('验收核对').attributes('aria-selected')).toBe('true')
    }
    await showAcceptance()
    const review = () => dialog.get('[data-testid="script-acceptance-review"]')
    const group = (key: string) => review().get('[data-testid="script-acceptance-group-' + key + '"]')
    const groupTab = (name: string) => review().findAll('[role="tab"]').find(tab => tab.text() === name)!
    const sourceSelector = '[data-testid="script-acceptance-source"]'
    const openGroup = async (name: string) => {
      await groupTab(name).trigger('click')
      await flushPromises()
      expect(groupTab(name).attributes('aria-selected')).toBe('true')
    }
    const groups = [
      ['platform', '平台定义', '样例平台记录', '已写入脚本'],
      ['motion', '运动定义', '样例运动记录', '已写入脚本'],
      ['communication', '通信定义', '样例通信记录', '已写入脚本'],
      ['sensor', '传感器定义', '样例传感器记录', '依赖待确认'],
      ['jammer', '干扰定义', '样例干扰记录', '依赖待确认'],
      ['timeline', '时序定义', '样例时序记录', '已写入脚本'],
    ] as const
    expect(review().findAll('[role="tab"]').map(tab => tab.text())).toEqual(groups.map(([, name]) => name))
    for (const [key, name, detail, state] of groups) {
      await openGroup(name)
      const row = group(key).findAll('li').find(item => item.text().includes(detail))
      expect(row?.text()).toContain(state)
      expect(row?.find(sourceSelector).exists()).toBe(true)
    }
    await openGroup('平台定义')
    const repeated = group('platform').findAll('li').find(item => item.text().includes('同路径的快照记录'))
    expect(repeated?.text()).toContain('仅保留快照')
    const fieldJson = (field: string) => '"fieldPath": ' + JSON.stringify(field)
    const location = (index: number) => 'mapping.json:' + (index + 1)
    const duplicateLocations = mappingLines.flatMap((line, index) => line.includes(fieldJson(duplicatedPath)) ? [location(index)] : [])
    expect(duplicateLocations).toHaveLength(2)
    expect(group('platform').findAll(sourceSelector).map(item => item.text()))
      .toEqual(expect.arrayContaining(duplicateLocations.map(value => '清单 ' + value)))

    const jumpToSource = async (key: string, label: string, expectedText: string, expectedSectionText: string) => {
      const source = group(key).findAll(sourceSelector).find(button => button.text() === label)
      expect(source).toBeDefined()
      await source!.trigger('click')
      await flushPromises()
      expect(tabs('脚本原文').attributes('aria-selected')).toBe('true')
      expect(dialog.get('[data-testid="script-preview-target-line"]').element.textContent).toBe(expectedText)
      expect(original().element.textContent).toBe(expectedSectionText)
      await showAcceptance()
    }

    await openGroup('通信定义')
    await jumpToSource('communication', 'comm_platform_REAR.txt:1–4', communicationBlock.join('\n'), rearSection)

    await openGroup('干扰定义')
    const jammerDefinition = group('jammer').findAll('li').find(item => item.text().includes('样例干扰定义'))
    expect(jammerDefinition?.text()).toContain('已写入脚本')
    expect(jammerDefinition?.get(sourceSelector).text()).toBe('comm_platform_REAR.txt:3')
    await jumpToSource('jammer', 'comm_platform_REAR.txt:3', deviceLine, rearSection)
    const dependencyIndex = mappingLines.findIndex(line => line.includes(fieldJson(dependencyPath)))
    await jumpToSource('jammer', '清单 ' + location(dependencyIndex), '// ' + mappingLines[dependencyIndex], mappingSection)

    await openGroup('时序定义')
    await jumpToSource('timeline', 'sample.txt:3', durationLine, sampleSection)
    expect(groupTab('时序定义').attributes('aria-selected')).toBe('true')
    expect(group('timeline').text()).toContain('样例时序记录')
  })

  it('有阻断项时显示配置校验，未发起预览或保存请求', async () => {
    const t = await setup()
    await t.wrapper.get('[data-testid="scenario-name"]').setValue(' ')
    await t.preview()
    expect(t.wrapper.get('[data-testid="validation-panel"]').text()).toContain('场景名称')
    expect(previewText(t.wrapper)).toBeUndefined()
    expect(t.calls).toEqual([])
    expect(t.store.dirty).toBe(true)
  })

  it('预览被服务端校验拒绝时呈现可定位的字段错误', async () => {
    const t = await setup()
    t.override.mockImplementation(path => path === '/api/v1/scripts/preview'
      ? new Response(JSON.stringify({ ok: false, error: {
        code: 'VALIDATION_FAILED', message: '服务端校验拒绝场景名称。', fieldPath: 'scenario.name',
        retryable: false, correlationId: 'TEST-VALIDATION',
      } }), { status: 422 })
      : undefined)
    await t.preview()
    const issue = t.wrapper.get('[data-testid="validation-panel"] [data-field-path="scenario.name"]')
    expect(issue.text()).toContain('场景名称')
    expect(issue.text()).toContain('服务端校验拒绝场景名称。')
    expect(previewText(t.wrapper)).toBeUndefined()
    expect(t.calls.filter(call => !call.endsWith('/validate'))).toEqual(['POST /api/v1/scripts/preview'])
  })

  it.each([true, false])('确认保存并预览=%s 时分别保存草稿或保留草稿', async confirmed => {
    const t = await setup()
    await t.wrapper.get('[data-testid="scenario-name"]').setValue('待确认预览的场景')
    const confirm = vi.spyOn(ElMessageBox, 'confirm')
    if (confirmed) confirm.mockResolvedValue('confirm' as never)
    else confirm.mockRejectedValue('cancel')
    await t.preview()
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0]?.at(-1)).toMatchObject({ confirmButtonText: '保存并预览' })
    expect(t.wrapper.emitted('saved')).toBeUndefined()
    if (confirmed) {
      expect(t.calls.filter(call => !call.endsWith('/validate'))).toEqual(['PUT /api/v1/scenarios/SCN-AUTO', 'POST /api/v1/scripts/preview'])
      expect(previewText(t.wrapper)).toBe('# test')
      expect(t.store.dirty).toBe(false)
    } else {
      expect(t.calls).toEqual([])
      expect(previewText(t.wrapper)).toBeUndefined()
      expect(t.store.dirty).toBe(true)
      expect(t.store.draft?.config.scenario.name).toBe('待确认预览的场景')
    }
  })

  it('预览读取期间修改草稿，迟到内容不会出现在弹窗中', async () => {
    const t = await setup()
    const pending = deferred<Response>()
    t.override.mockImplementation(path => path === '/api/v1/scripts/preview' ? pending.promise : undefined)
    await t.preview()
    expect(t.calls).toContain('POST /api/v1/scripts/preview')
    await t.wrapper.get('[data-testid="scenario-name"]').setValue('预览在途时的新草稿')
    pending.resolve(success(t.script()))
    await flushPromises()
    expect(previewText(t.wrapper)).toBeUndefined()
    expect(t.store.dirty).toBe(true)
    expect(t.wrapper.emitted('saved')).toBeUndefined()
  })
})
