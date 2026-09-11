import { apiFetch } from '../features/shared/api-fetch'
import { defineStore } from 'pinia'
import {
  EVENTS_CSV_HEADER,
  LINK_QUALITY_CSV_HEADER,
  LINK_SWITCH_CSV_HEADER,
  type CapabilityState,
  type ContractDescriptor,
  type InterfaceMetadata,
  type ScenarioConfig,
  type SimulationRun,
  type ValidationResult,
} from '../contracts/domain-models'
import { createCsvExample as buildCsvExample, inspectCsvText, type CsvValidationResult } from '../features/data-exchange/csv-contract'
import { inspectScenarioConfig } from '../features/scenarios/scenario-validation'
import { resolveMockOrigin, useAuthStore } from './auth'

export interface ProcessContractResult {
  status: 'NOT_STARTED' | 'RUNNING' | 'EXITED' | 'TERMINATED' | 'ERROR'
  processId: number | null
  stdout: 'NOT_CAPTURED_BY_DESIGN'
  exitCode: number | null
  timeoutMs: 5_000
  singleInstance: true
  resourcesReleased: boolean
}

interface ContractExpectation {
  name: string
  version: string
  fields: readonly string[]
}

const SCENARIO_CONTRACT: ContractExpectation = {
  name: 'ScenarioConfig',
  version: '1.0',
  fields: ['schemaVersion', 'scenario', 'platforms', 'links', 'jammers', 'sensors', 'output', 'informationDemand'],
}

const FRONTEND_CONTRACTS: readonly ContractExpectation[] = [
  {
    name: 'LinkQualityData',
    version: '1.0',
    fields: ['time', 'sourcePlatform', 'destPlatform', 'linkType', 'frequency', 'bandwidth', 'distance', 'txPower', 'txAntennaGain', 'rxAntennaGain', 'pathLoss', 'jammingPower', 'receivedPower', 'snr', 'modulation', 'ber', 'linkStatus', 'berThreshold', 'dataRate'],
  },
  {
    name: 'LinkStatusSummary',
    version: '1.0',
    fields: ['linkKey', 'sourcePlatform', 'destPlatform', 'linkType', 'currentSnr', 'currentBer', 'status', 'updatedAt'],
  },
  {
    name: 'JammerStatusData',
    version: '1.0',
    fields: ['time', 'jammerId', 'platformId', 'targetPlatform', 'power', 'frequency', 'bandwidth', 'active'],
  },
  {
    name: 'PlatformStatus',
    version: '1.0',
    fields: ['platformId', 'name', 'type', 'longitude', 'latitude', 'altitude', 'speed', 'linkIds', 'jammers', 'updatedAt'],
  },
  {
    name: 'SimulationState',
    version: '1.0',
    fields: ['status', 'currentTime', 'totalDuration', 'processId', 'progress', 'errorMessage'],
  },
]

const CSV_CONTRACTS: readonly ContractExpectation[] = [
  { name: 'link_quality.csv', version: '1.0', fields: LINK_QUALITY_CSV_HEADER.split(',') },
  { name: 'events.csv', version: '1.0', fields: EVENTS_CSV_HEADER.split(',') },
  { name: 'link_switch.csv', version: '1.0', fields: LINK_SWITCH_CSV_HEADER.split(',') },
]

const INTERFACES: readonly InterfaceMetadata[] = [
  { id: 'DSDWRJQTLJS-JK-YHCZ', kind: '外部', name: '用户操作接口', destination: 'de-if-jk-yhcz' },
  { id: 'DSDWRJQTLJS-JK-WJXT', kind: '外部', name: '文件系统接口', destination: 'de-if-jk-wjxt' },
  { id: 'DSDWRJQTLJS-JK-CZXT', kind: '外部', name: '操作系统接口', destination: 'de-if-jk-czxt' },
  { id: 'DSDWRJQTLJS-JK-QDZS-SJJHYJK', kind: '内部', name: '前端展示 ↔ 数据交换', destination: 'de-if-jk-qdzs-sjjhyjk' },
  { id: 'DSDWRJQTLJS-JK-SJJHYJK-FZYXYLLJS', kind: '内部', name: '数据交换 ↔ 仿真计算', destination: 'de-if-jk-sjjhyjk-fzyxylljs' },
  { id: 'DSDWRJQTLJS-JK-CJPZYJBSC-WJXT', kind: '内部', name: '场景配置 ↔ 文件系统', destination: 'de-if-jk-cjpzyjbsc-wjxt' },
  { id: 'DSDWRJQTLJS-JK-CSCI-SJJH', kind: '内部', name: '七 CSCI 数据交换', destination: 'de-if-jk-csci-sjjh' },
]

/** 判断未知值是否为闭合合同描述。 */
function isContractDescriptor(value: unknown): value is ContractDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const descriptor = value as Partial<ContractDescriptor>
  return Object.keys(value).length === 4
    && ['name', 'version', 'sourceRef', 'fields'].every((key) => Object.hasOwn(value, key))
    && typeof descriptor.name === 'string' && descriptor.name.length > 0
    && typeof descriptor.version === 'string' && descriptor.version.length > 0
    && typeof descriptor.sourceRef === 'string' && descriptor.sourceRef.length > 0
    && Array.isArray(descriptor.fields) && descriptor.fields.length > 0
    && descriptor.fields.every((field) => typeof field === 'string' && field.length > 0)
    && new Set(descriptor.fields).size === descriptor.fields.length
}

/** 判断合同描述是否与冻结名称、版本和字段顺序完全一致。 */
function matchesContract(descriptor: ContractDescriptor, expected: ContractExpectation): boolean {
  return descriptor.name === expected.name
    && descriptor.version === expected.version
    && descriptor.fields.length === expected.fields.length
    && descriptor.fields.every((field, index) => field === expected.fields[index])
}

/** 判断未知值是否为闭合接口元数据。 */
function isInterfaceMetadata(value: unknown): value is InterfaceMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Partial<InterfaceMetadata>
  return Object.keys(value).length === 4
    && ['id', 'kind', 'name', 'destination'].every((key) => Object.hasOwn(value, key))
    && typeof item.id === 'string' && item.id.startsWith('DSDWRJQTLJS-JK-')
    && (item.kind === '外部' || item.kind === '内部')
    && typeof item.name === 'string' && item.name.length > 0
    && typeof item.destination === 'string' && item.destination.startsWith('de-if-')
}

/** 从成功信封读取并校验单个合同描述。 */
async function readContract(response: Response, expected: ContractExpectation): Promise<ContractDescriptor> {
  const payload = await response.json() as { ok?: unknown; data?: unknown }
  if (!response.ok || payload.ok !== true || !isContractDescriptor(payload.data)
    || !matchesContract(payload.data, expected)) throw new Error('合同数据格式不正确。')
  return payload.data
}

/** 从成功信封读取并校验合同描述集合。 */
async function readContracts(response: Response, expected: readonly ContractExpectation[]): Promise<ContractDescriptor[]> {
  const payload = await response.json() as { ok?: unknown; data?: unknown }
  if (!response.ok || payload.ok !== true || !Array.isArray(payload.data)
    || payload.data.length !== expected.length || !payload.data.every(isContractDescriptor)) {
    throw new Error('合同数据格式不正确。')
  }
  const expectedByName = new Map(expected.map((item) => [item.name, item]))
  if (new Set(payload.data.map((item) => item.name)).size !== expected.length
    || !payload.data.every((item) => {
      const frozen = expectedByName.get(item.name)
      return frozen !== undefined && matchesContract(item, frozen)
    })) throw new Error('合同数据格式不正确。')
  return payload.data
}

/** 从成功信封读取七类接口元数据。 */
async function readInterfaces(response: Response): Promise<InterfaceMetadata[]> {
  const payload = await response.json() as { ok?: unknown; data?: unknown }
  if (!response.ok || payload.ok !== true || !Array.isArray(payload.data)
    || payload.data.length !== 7 || !payload.data.every(isInterfaceMetadata)) {
    throw new Error('接口元数据格式不正确。')
  }
  const expectedById = new Map(INTERFACES.map((item) => [item.id, item]))
  const externalCount = payload.data.filter((item) => item.kind === '外部').length
  if (new Set(payload.data.map((item) => item.id)).size !== INTERFACES.length
    || externalCount !== 3
    || payload.data.length - externalCount !== 4
    || !payload.data.every((item) => {
      const frozen = expectedById.get(item.id)
      return frozen !== undefined && item.kind === frozen.kind
        && item.name === frozen.name && item.destination === frozen.destination
    })) throw new Error('接口元数据格式不正确。')
  return payload.data
}

export const useDataExchangeStore = defineStore('dataExchange', {
  state: () => ({
    loadState: 'EMPTY' as CapabilityState,
    resultCode: 'EMPTY',
    resultMessage: '尚未加载数据交换合同。',
    csvContracts: [] as ContractDescriptor[],
    scenarioContract: null as ContractDescriptor | null,
    frontendContracts: [] as ContractDescriptor[],
    interfaces: [] as InterfaceMetadata[],
    csvState: 'EMPTY' as CapabilityState,
    csvResult: null as CsvValidationResult | null,
    csvMessage: '尚未校验 CSV 文本。',
    jsonState: 'EMPTY' as CapabilityState,
    jsonResult: null as ScenarioConfig | null,
    jsonValidation: { valid: true, errors: [], warnings: [] } as ValidationResult,
    jsonMessage: '尚未解析场景 JSON。',
    processState: 'EMPTY' as CapabilityState,
    processResult: null as ProcessContractResult | null,
    processMessage: '尚未检查进程管理合同。',
    requestEpoch: 0,
  }),

  actions: {
    /**
     * 从本机 Mock 并行加载 P5 所需的规范合同。
     * @returns 四类响应均通过闭合校验时返回 `true`。
     * @sideEffects 原子更新 CSV、场景、前端类型和七类接口元数据。
     */
    async loadContracts(): Promise<boolean> {
      const requestEpoch = this.requestEpoch
      this.loadState = 'LOADING'
      try {
        const headers = { 'X-Demo-Role': useAuthStore().role }
        const [scenarioResponse, frontendResponse, csvResponse, interfaceResponse] = await Promise.all([
          apiFetch(`${resolveMockOrigin()}/api/v1/contracts/scenario-config`, { headers }),
          apiFetch(`${resolveMockOrigin()}/api/v1/contracts/frontend-types`, { headers }),
          apiFetch(`${resolveMockOrigin()}/api/v1/contracts/csv`, { headers }),
          apiFetch(`${resolveMockOrigin()}/api/v1/meta/interfaces`, { headers }),
        ])
        if (requestEpoch !== this.requestEpoch) return false
        this.loadState = 'VALIDATING'
        const [scenarioContract, frontendContracts, csvContracts, interfaces] = await Promise.all([
          readContract(scenarioResponse, SCENARIO_CONTRACT),
          readContracts(frontendResponse, FRONTEND_CONTRACTS),
          readContracts(csvResponse, CSV_CONTRACTS),
          readInterfaces(interfaceResponse),
        ])
        if (requestEpoch !== this.requestEpoch) return false
        this.scenarioContract = structuredClone(scenarioContract)
        this.frontendContracts = structuredClone(frontendContracts)
        this.csvContracts = structuredClone(csvContracts)
        this.interfaces = structuredClone(interfaces)
        this.loadState = 'SUCCESS'
        this.resultCode = 'SUCCESS'
        this.resultMessage = '数据交换合同已加载。'
        return true
      } catch (error) {
        if (requestEpoch !== this.requestEpoch) return false
        this.loadState = 'ERROR'
        this.resultCode = 'CONTRACT_LOAD_FAILED'
        this.resultMessage = error instanceof Error ? error.message : '数据交换合同加载失败。'
        return false
      }
    },

    /**
     * 为所选 CSV 合同生成内存示例。
     * @param contractName 三个 canonical CSV 文件名之一。
     * @returns 表头和一条示例记录；合同不存在时返回空文本。
     */
    createCsvExample(contractName: string): string {
      const contract = this.csvContracts.find((item) => item.name === contractName)
      return contract === undefined ? '' : buildCsvExample(contract)
    },

    /**
     * 校验内存 CSV 文本，不读取或写入文件。
     * @param contractName 所选 canonical CSV 合同名称。
     * @param text 用户输入的内存文本。
     * @returns 表头、类型和编码均通过时返回 `true`。
     * @sideEffects 更新 CSV 六态、行号错误和原子写入设计状态。
     */
    async validateCsv(contractName: string, text: string): Promise<boolean> {
      this.csvResult = null
      if (text.trim() === '') {
        this.csvState = 'EMPTY'
        this.csvMessage = '请输入或加载 CSV 文本。'
        return false
      }
      const contract = this.csvContracts.find((item) => item.name === contractName)
      if (contract === undefined) {
        this.csvState = 'ERROR'
        this.csvMessage = '未找到所选 CSV 合同。'
        return false
      }
      this.csvState = 'VALIDATING'
      await Promise.resolve()
      this.csvState = 'EXECUTING'
      await Promise.resolve()
      const result = inspectCsvText(contract, text)
      this.csvResult = result
      this.csvState = result.valid ? 'SUCCESS' : 'ERROR'
      this.csvMessage = result.valid
        ? `CSV 合同校验通过，共 ${result.rowCount} 行数据；未执行文件写入。`
        : result.issues[0]?.message ?? 'CSV 合同校验失败。'
      return result.valid
    },

    /**
     * 解析并校验内存中的 ScenarioConfig JSON。
     * @param text 用户输入的 JSON 文本。
     * @returns 语法和完整场景合同均有效时返回 `true`。
     * @sideEffects 更新 JSON 六态、规范对象和可定位错误；不修改场景草稿。
     */
    async parseScenarioJson(text: string): Promise<boolean> {
      this.jsonResult = null
      this.jsonValidation = { valid: true, errors: [], warnings: [] }
      if (text.trim() === '') {
        this.jsonState = 'EMPTY'
        this.jsonMessage = '请输入或加载场景 JSON。'
        return false
      }
      this.jsonState = 'VALIDATING'
      await Promise.resolve()
      let value: unknown
      try {
        value = JSON.parse(text) as unknown
      } catch {
        this.jsonState = 'ERROR'
        this.jsonValidation = {
          valid: false,
          errors: [{ severity: 'ERROR', code: 'JSON_SYNTAX_ERROR', message: 'JSON 语法不正确。', fieldPath: '$' }],
          warnings: [],
        }
        this.jsonMessage = 'JSON 语法不正确。'
        return false
      }
      this.jsonState = 'EXECUTING'
      await Promise.resolve()
      const inspection = inspectScenarioConfig(value)
      this.jsonValidation = structuredClone(inspection.result)
      if (!inspection.result.valid) {
        this.jsonState = 'ERROR'
        this.jsonMessage = inspection.result.errors[0]?.message ?? '场景 JSON 合同校验失败。'
        return false
      }
      this.jsonResult = structuredClone(value as ScenarioConfig)
      this.jsonState = 'SUCCESS'
      this.jsonMessage = inspection.result.warnings.length > 0
        ? `场景 JSON 解析通过，存在 ${inspection.result.warnings.length} 个警告。`
        : '场景 JSON 解析通过，未修改当前场景。'
      return true
    },

    /**
     * 检查 AFSIM 进程管理的可见合同，不调用操作系统。
     * @param run 已通过 simulationStore 校验的当前运行；没有运行时传入 `null`。
     * @returns 有运行投影时返回 `true`。
     * @sideEffects 更新 PID、stdout、退出码、超时、单实例和资源释放设计状态。
     */
    async inspectProcess(run: SimulationRun | null): Promise<boolean> {
      this.processResult = null
      if (run === null) {
        this.processState = 'EMPTY'
        this.processMessage = '暂无可检查的仿真运行。'
        return false
      }
      this.processState = 'VALIDATING'
      await Promise.resolve()
      const status: ProcessContractResult['status'] = run.uiStatus === 'RUNNING' || run.uiStatus === 'PAUSED'
        ? 'RUNNING'
        : run.uiStatus === 'COMPLETED'
          ? 'EXITED'
          : run.uiStatus === 'ERROR'
            ? 'ERROR'
            : run.uiStatus === 'STOPPED'
              ? 'TERMINATED'
              : 'NOT_STARTED'
      this.processState = 'EXECUTING'
      await Promise.resolve()
      this.processResult = {
        status,
        processId: run.canonical.processId,
        stdout: 'NOT_CAPTURED_BY_DESIGN',
        exitCode: status === 'EXITED' ? 0 : null,
        timeoutMs: 5_000,
        singleInstance: true,
        resourcesReleased: run.canonical.processId === null && !['RUNNING', 'PAUSED'].includes(run.uiStatus),
      }
      this.processState = 'SUCCESS'
      this.processMessage = '进程管理合同检查通过；未启动真实 AFSIM 进程。'
      return true
    },

    /** 清空本页派生状态，不修改场景、仿真或遥测事实。 */
    resetToSafeEmpty(): void {
      this.requestEpoch += 1
      this.loadState = 'EMPTY'
      this.resultCode = 'EMPTY'
      this.resultMessage = '尚未加载数据交换合同。'
      this.csvContracts = []
      this.scenarioContract = null
      this.frontendContracts = []
      this.interfaces = []
      this.csvState = 'EMPTY'
      this.csvResult = null
      this.csvMessage = '尚未校验 CSV 文本。'
      this.jsonState = 'EMPTY'
      this.jsonResult = null
      this.jsonValidation = { valid: true, errors: [], warnings: [] }
      this.jsonMessage = '尚未解析场景 JSON。'
      this.processState = 'EMPTY'
      this.processResult = null
      this.processMessage = '尚未检查进程管理合同。'
    },
  },
})
