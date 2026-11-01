import type { OutputConfig } from '../contracts/domain-models'

export const APP_CONFIG = {
  /** 仅控制主导航入口显隐；保留报表路由、功能及原有权限。 */
  showReports: true,
  /** 系统管理可选入口；只控制显隐，不改变路由和角色权限。 */
  systemManagement: {
    // 测试大纲 GNZB-22～28 需要以下入口可见；只控制显隐，路由和权限不变。
    showMasterData: true, // 基础数据管理，含设备参数、体制、字典和枚举
    showDatabaseBackup: true, // 数据库备份 / 恢复
    showSimulationData: true, // 仿真数据管理
    showRuntimeStatus: true, // 系统运行状态
    showDataExchange: true, // 数据交换与接口
  },
  /** 仿真结果写入设置由系统统一维护，不由场景操作员逐项选择。 */
  scenarioOutput: {
    directory: 'output',
    writeInterval: 5,
    linkQualityEnabled: false,
    eventsEnabled: true,
    linkSwitchEnabled: false,
  } satisfies OutputConfig,
}

/** 场景时间步长增大时，隐藏的输出间隔也须满足写入合同。 */
export function configuredScenarioOutput(timeStep: number): OutputConfig {
  const output = APP_CONFIG.scenarioOutput
  return {
    ...output,
    writeInterval: Number.isFinite(timeStep) && timeStep > 0
      ? Math.max(output.writeInterval, timeStep)
      : output.writeInterval,
  }
}
