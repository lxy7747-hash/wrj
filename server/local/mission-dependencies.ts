import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export const LINK_CALC_PROCESSOR = 'WSF_LINK_CALC_PROCESSOR'
export const LINK_CALC_DEPENDENCY_NOTE = `本场景需要当前 Mission 注册 ${LINK_CALC_PROCESSOR}。请安装与引擎版本、架构匹配的对接方插件，并按对接方要求配置加载路径；文件存在不代表处理器已加载或兼容。`

/** 仅检查部署方明确指定的文件；不猜插件名、搜索目录或把未配置当成缺失。 */
export async function inspectMissionDependencies(requiredProcessors: readonly string[], pluginPath?: string) {
  if (!requiredProcessors.includes(LINK_CALC_PROCESSOR)) {
    return { status: 'not-required' as const, requiredProcessors, message: '本场景未生成 link_calc，不需要该处理器。' }
  }
  if (!pluginPath) {
    return { status: 'unknown' as const, requiredProcessors,
      message: `${LINK_CALC_DEPENDENCY_NOTE} 未配置 MISSION_LINK_CALC_PLUGIN_PATH，无法在启动前确认插件文件或处理器状态，交由引擎验证。` }
  }
  try {
    if (!isAbsolute(pluginPath)) throw new Error('必须为绝对路径')
    if (!(await stat(pluginPath)).isFile()) throw new Error('不是普通文件')
    await access(pluginPath, constants.R_OK)
    return { status: 'file-readable' as const, requiredProcessors, pluginPath,
      message: `${LINK_CALC_DEPENDENCY_NOTE} 配置的插件文件可读，处理器加载状态仍待引擎验证。` }
  } catch (error) {
    return { status: 'configured-file-unavailable' as const, requiredProcessors, pluginPath,
      message: `MISSION_LINK_CALC_PLUGIN_PATH 指定的插件文件不可用：${pluginPath}（${error instanceof Error ? error.message : '读取失败'}）。请修正部署配置后重试。此检查不判断其他位置或静态编译的处理器。` }
  }
}
