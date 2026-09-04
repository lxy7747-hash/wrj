import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { ContractDescriptor, Principal, SimulationRun } from '../../src/contracts/domain-models'
import { createCsvExample, inspectCsvText } from '../../src/features/data-exchange/csv-contract'
import { useAuthStore } from '../../src/stores/auth'
import { useDataExchangeStore } from '../../src/stores/data-exchange'

const operator: Principal = {
  userId: 'USR-OPERATOR', username: 'operator', role: 'OPERATOR', permissions: ['BUSINESS_READ', 'SIMULATION_CONTROL'],
}

/** 创建合同端点使用的统一成功响应。 */
function successResponse(data: unknown): Response {
  return { ok: true, json: vi.fn().mockResolvedValue({ ok: true, data }) } as unknown as Response
}

/** 按请求路径返回冻结夹具中的 P5 合同。 */
function contractResponse(input: RequestInfo | URL): Response {
  const path = new URL(String(input)).pathname
  if (path.endsWith('/scenario-config')) return successResponse(fixtureSource.contracts.scenarioConfig)
  if (path.endsWith('/frontend-types')) return successResponse(fixtureSource.contracts.frontendTypes)
  if (path.endsWith('/csv')) return successResponse(fixtureSource.contracts.csv)
  return successResponse(fixtureSource.metadata.interfaces)
}

describe('P5 数据交换 Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAuthStore().$patch({ principal: operator, role: operator.role, permissions: [...operator.permissions] })
  })

  it('原子加载三类 CSV、场景、五类前端结构和七类接口合同', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => Promise.resolve(contractResponse(input))))
    const store = useDataExchangeStore()

    await expect(store.loadContracts()).resolves.toBe(true)
    expect(store.$state).toMatchObject({ loadState: 'SUCCESS', resultCode: 'SUCCESS' })
    expect(store.csvContracts).toHaveLength(3)
    expect(store.frontendContracts).toHaveLength(5)
    expect(store.interfaces).toHaveLength(7)
    expect(store.scenarioContract?.name).toBe('ScenarioConfig')

    store.resetToSafeEmpty()
    expect(store.$state).toMatchObject({ loadState: 'EMPTY', csvContracts: [], scenarioContract: null })
  })

  it('合同响应损坏时进入错误态且不发布半套数据', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successResponse([])))
    const store = useDataExchangeStore()

    await expect(store.loadContracts()).resolves.toBe(false)
    expect(store.$state).toMatchObject({ loadState: 'ERROR', resultCode: 'CONTRACT_LOAD_FAILED' })
    expect(store.csvContracts).toEqual([])
  })

  it.each([
    ['重复 CSV', '/csv', (() => {
      const value = structuredClone(fixtureSource.contracts.csv)
      value[1] = structuredClone(value[0]!)
      return value
    })()],
    ['错误合同名称', '/frontend-types', (() => {
      const value = structuredClone(fixtureSource.contracts.frontendTypes)
      value[0]!.name = 'UnknownType'
      return value
    })()],
    ['错误合同版本', '/scenario-config', { ...structuredClone(fixtureSource.contracts.scenarioConfig), version: '2.0' }],
    ['错误字段集合', '/scenario-config', { ...structuredClone(fixtureSource.contracts.scenarioConfig), fields: ['schemaVersion'] }],
    ['未知接口 ID', '/meta/interfaces', (() => {
      const value = structuredClone(fixtureSource.metadata.interfaces)
      value[0]!.id = 'DSDWRJQTLJS-JK-UNKNOWN'
      return value
    })()],
    ['错误接口目的地', '/meta/interfaces', (() => {
      const value = structuredClone(fixtureSource.metadata.interfaces)
      value[0]!.destination = 'de-if-wrong'
      return value
    })()],
    ['错误接口分类数量', '/meta/interfaces', (() => {
      const value = structuredClone(fixtureSource.metadata.interfaces)
      value[0]!.kind = '内部'
      return value
    })()],
  ])('拒绝%s', async (_name, endpoint, invalidData) => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      return Promise.resolve(path.endsWith(endpoint) ? successResponse(invalidData) : contractResponse(input))
    }))
    const store = useDataExchangeStore()

    await expect(store.loadContracts()).resolves.toBe(false)
    expect(store.$state).toMatchObject({ loadState: 'ERROR', resultCode: 'CONTRACT_LOAD_FAILED' })
    expect(store.csvContracts).toEqual([])
    expect(store.interfaces).toEqual([])
  })

  it('校验 canonical CSV 的表头、引号、编码、数值和枚举', () => {
    const contracts = structuredClone(fixtureSource.contracts.csv) as ContractDescriptor[]
    const linkContract = contracts[0]!
    const eventContract = contracts[1]!
    const valid = createCsvExample(linkContract)

    expect(inspectCsvText(linkContract, valid)).toMatchObject({ valid: true, rowCount: 1, headerMatched: true })
    expect(inspectCsvText(linkContract, valid.replace('Frequency', '频率')).issues[0]).toMatchObject({ code: 'HEADER_INVALID', row: 1 })
    expect(inspectCsvText(linkContract, `${valid},多余列`).issues[0]).toMatchObject({ code: 'TYPE_INVALID', row: 2 })
    expect(inspectCsvText(linkContract, valid.replace('\n42,', '\n�,')).issues[0]).toMatchObject({ code: 'ENCODING_INVALID' })

    const invalidFrequency = valid.split('\n')
    const cells = invalidFrequency[1]!.split(',')
    cells[4] = '-1'
    invalidFrequency[1] = cells.join(',')
    expect(inspectCsvText(linkContract, invalidFrequency.join('\n')).valid).toBe(false)

    for (const field of ['Time', 'BER']) {
      const blankNumeric = valid.split('\n')
      const blankCells = blankNumeric[1]!.split(',')
      blankCells[linkContract.fields.indexOf(field)] = '   '
      blankNumeric[1] = blankCells.join(',')
      expect(inspectCsvText(linkContract, blankNumeric.join('\n')).issues[0]).toMatchObject({
        code: 'TYPE_INVALID',
        fieldPath: `rows[0].${field}`,
      })
    }

    const eventText = `${eventContract.fields.join(',')}\n42,DETECTION,UAV-01,,SUCCESS,,,,"a,b"`
    expect(inspectCsvText(eventContract, eventText)).toMatchObject({ valid: true, rowCount: 1 })
    expect(inspectCsvText(eventContract, `${eventContract.fields.join(',')}\n42,DETECTION,UAV-01,   ,SUCCESS, , , ,`))
      .toMatchObject({ valid: true, rowCount: 1 })
    expect(inspectCsvText(eventContract, `${eventContract.fields.join(',')}\n42,DETECTION,UAV-01,,,,,,"未闭合`).valid).toBe(false)
  })

  it('通过 Store 执行 CSV 与场景 JSON 的成功和错误路径', async () => {
    const store = useDataExchangeStore()
    store.csvContracts = structuredClone(fixtureSource.contracts.csv) as ContractDescriptor[]

    expect(store.createCsvExample('不存在.csv')).toBe('')
    await expect(store.validateCsv('link_quality.csv', '')).resolves.toBe(false)
    await expect(store.validateCsv('不存在.csv', 'a')).resolves.toBe(false)
    const example = store.createCsvExample('link_quality.csv')
    await expect(store.validateCsv('link_quality.csv', example)).resolves.toBe(true)
    expect(store.csvResult).toMatchObject({ atomicWrite: 'NOT_EXECUTED_BY_DESIGN' })
    await expect(store.validateCsv('link_quality.csv', example.replace('LinkStatus', '状态'))).resolves.toBe(false)

    await expect(store.parseScenarioJson('')).resolves.toBe(false)
    await expect(store.parseScenarioJson('{')).resolves.toBe(false)
    expect(store.jsonValidation.errors[0]).toMatchObject({ code: 'JSON_SYNTAX_ERROR', fieldPath: '$' })
    const invalidScenario = structuredClone(fixtureSource.scenario) as Record<string, unknown>
    invalidScenario.unknown = true
    await expect(store.parseScenarioJson(JSON.stringify(invalidScenario))).resolves.toBe(false)
    expect(store.jsonValidation.errors[0]).toMatchObject({ code: 'SCENARIO_SHAPE_INVALID', fieldPath: 'config' })
    await expect(store.parseScenarioJson(JSON.stringify(fixtureSource.scenario))).resolves.toBe(true)
    expect(store.jsonResult?.scenario.id).toBe('SCN-001')
  })

  it('投影进程状态但不启动操作系统进程', async () => {
    const store = useDataExchangeStore()
    await expect(store.inspectProcess(null)).resolves.toBe(false)

    for (const [uiStatus, status, processId, resourcesReleased] of [
      ['RUNNING', 'RUNNING', 8801, false],
      ['PAUSED', 'RUNNING', 8801, false],
      ['COMPLETED', 'EXITED', null, true],
      ['ERROR', 'ERROR', null, true],
      ['STOPPED', 'TERMINATED', null, true],
      ['IDLE', 'NOT_STARTED', null, true],
    ] as const) {
      const run = structuredClone(fixtureSource.run) as SimulationRun
      run.uiStatus = uiStatus
      run.canonical.processId = processId
      await expect(store.inspectProcess(run)).resolves.toBe(true)
      expect(store.processResult).toMatchObject({ status, processId, resourcesReleased, stdout: 'NOT_CAPTURED_BY_DESIGN' })
    }
  })

  it('让内存校验的 VALIDATING 和 EXECUTING 阶段可观察', async () => {
    const store = useDataExchangeStore()
    store.csvContracts = structuredClone(fixtureSource.contracts.csv) as ContractDescriptor[]

    const csvPending = store.validateCsv('link_quality.csv', store.createCsvExample('link_quality.csv'))
    expect(store.csvState).toBe('VALIDATING')
    await Promise.resolve()
    expect(store.csvState).toBe('EXECUTING')
    await expect(csvPending).resolves.toBe(true)

    const jsonPending = store.parseScenarioJson(JSON.stringify(fixtureSource.scenario))
    expect(store.jsonState).toBe('VALIDATING')
    await Promise.resolve()
    expect(store.jsonState).toBe('EXECUTING')
    await expect(jsonPending).resolves.toBe(true)

    const processPending = store.inspectProcess(structuredClone(fixtureSource.run) as SimulationRun)
    expect(store.processState).toBe('VALIDATING')
    await Promise.resolve()
    expect(store.processState).toBe('EXECUTING')
    await expect(processPending).resolves.toBe(true)
  })
})
