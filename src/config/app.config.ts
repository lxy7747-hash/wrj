export const APP_CONFIG = {
  /** 仅控制主导航入口显隐；保留报表路由、功能及原有权限。 */
  showReports: true,
  /** 系统管理可选入口；只控制显隐，不改变路由和角色权限。 */
  systemManagement: {
    showMasterData: false, // 主数据管理
    showDatabaseBackup: false, // 数据库备份 / 恢复
    showSimulationData: false, // 仿真数据管理
    showRuntimeStatus: true, // 系统运行状态
    showDataExchange: false, // 数据交换与接口
  },
}
