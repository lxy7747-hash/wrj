import type { Platform, ScenarioConfig, ScenarioDraft, ScenarioId } from '../../contracts/domain-models'
import { configuredScenarioOutput } from '../../config/app.config.js'

/** 默认按名称展示；同名或失效引用保留编号，避免隐藏后无法区分对象。 */
export function scenarioPlatformLabel(platforms: readonly Pick<Platform, 'id' | 'name'>[], id: string, showIds = false): string {
  const platform = platforms.find(item => item.id === id)
  if (!platform?.name) return id
  return showIds || platforms.some(item => item.id !== id && item.name === platform.name)
    ? `${platform.name}（${id}）` : platform.name
}

/** 《前端2后端配置参数》场景环境类默认值；总时长在接口中继续使用秒。 */
export const SCENARIO_BASIC_DEFAULTS = {
  duration: 20 * 60,
  simClockSpeed: 2,
  transmissionDistance: 300,
  rainCloudAttenuation: 'lightRain',
} as const

/** 仅创建待填写的浏览器草稿，不导入 Mock 实体；通过完整写入校验后才能入库。 */
export function createEmptyScenarioDraft(id: ScenarioId): ScenarioDraft {
  return {
    config: withScenarioBasicDefaults({
      schemaVersion: '1.0',
      scenario: {
        id, name: '', description: '', startTime: '',
        duration: SCENARIO_BASIC_DEFAULTS.duration,
        timeStep: 1,
        environment: {
          seaState: 0, temperatureC: 0, humidityPercent: 0,
          rainRateMmPerHour: 0, rainLossDbPerKm: 0, multipathEnabled: false,
        },
      },
      platforms: [], links: [], jammers: [], sensors: [], informationDemand: [],
      output: configuredScenarioOutput(1),
    }),
    uiExtensions: { jammers: [], sensors: [] },
    revision: 0,
    officialLibraryChanged: false,
    locked: false,
  }
}

/**
 * 补齐环境字段并采用系统输出设置，不覆盖场景时长或物理环境参数。
 * @param config 已通过场景校验的配置，原对象保持不变。
 * @returns 可供当前表单保存的配置副本。
 */
export function withScenarioBasicDefaults(config: ScenarioConfig): ScenarioConfig {
  return {
    ...config,
    output: configuredScenarioOutput(config.scenario.timeStep),
    scenario: {
      ...config.scenario,
      environment: {
        simClockSpeed: SCENARIO_BASIC_DEFAULTS.simClockSpeed,
        transmissionDistance: SCENARIO_BASIC_DEFAULTS.transmissionDistance,
        rainCloudAttenuation: SCENARIO_BASIC_DEFAULTS.rainCloudAttenuation,
        ...config.scenario.environment,
      },
    },
  }
}
