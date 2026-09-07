import type { ScenarioConfig } from '../../contracts/domain-models'

/** 《前端2后端配置参数》场景环境类默认值；总时长在接口中继续使用秒。 */
export const SCENARIO_BASIC_DEFAULTS = {
  duration: 20 * 60,
  simClockSpeed: 2,
  transmissionDistance: 300,
  rainCloudAttenuation: 'lightRain',
} as const

/**
 * 为旧场景补齐新增环境字段，不覆盖已有值、时长或物理环境参数。
 * @param config 已通过场景校验的配置，原对象保持不变。
 * @returns 可供当前表单保存的配置副本。
 */
export function withScenarioBasicDefaults(config: ScenarioConfig): ScenarioConfig {
  return {
    ...config,
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
