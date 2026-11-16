import { isAbsolute, resolve } from 'node:path'

/** 绝对路径目录：留空时回退到默认目录，相对路径直接拒绝，不回退到默认目录。 */
function resolveConfiguredRoot(configured: string | undefined, fallback: string, key: string): string {
  const value = configured?.trim()
  if (!value) return resolve(fallback)
  if (!isAbsolute(value)) throw new Error(`${key} 必须为绝对路径。`)
  return resolve(value)
}

/**
 * 运行输出根目录：启动器按 deployment.env 的 OUTPUT_ROOT 传入，留空时使用包内默认目录。
 * 任务脚本、运行包、结果、引擎帧、质量、证据、实时日志与报告都写在该目录下的固定子目录。
 * @throws 配置了相对路径时抛出；调用方必须拒绝启动，不得回退到默认目录。
 */
export function resolveOutputRoot(configured: string | undefined, fallback: string): string {
  return resolveConfiguredRoot(configured, fallback, 'WRJ_OUTPUT_ROOT')
}

/**
 * 场景配置生成脚本包（TXT 模板包）的输出目录：启动器按 deployment.env 的 SCRIPT_OUTPUT_ROOT 传入，
 * 留空时为 <运行输出根目录>/scripts。只保存“生成脚本”产生的可下载包，不改变运行包位置。
 * @throws 配置了相对路径时抛出；调用方必须拒绝启动，不得回退到默认目录。
 */
export function resolveScriptOutputRoot(configured: string | undefined, fallback: string): string {
  return resolveConfiguredRoot(configured, fallback, 'WRJ_SCRIPT_OUTPUT_ROOT')
}
