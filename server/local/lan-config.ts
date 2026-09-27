import { access, mkdir, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { validatePublicOrigin } from '../http/loopback.js'

export async function readLanConfig(env: NodeJS.ProcessEnv) {
  const required = (key: string): string => {
    const value = env[key]?.trim()
    if (!value) throw new Error(`内网部署必须配置 ${key}。`)
    return value
  }
  const path = (key: string): string => {
    const value = required(key)
    if (!isAbsolute(value)) throw new Error(`${key} 必须为绝对路径。`)
    return value
  }
  const portNumber = (key: string, fallback: string): number => {
    const value = Number(env[key] ?? fallback)
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${key} 必须为有效端口号。`)
    return value
  }
  const publicOrigin = validatePublicOrigin(required('WRJ_PUBLIC_ORIGIN'))
  if (env.WRJ_WEB_ONLY && env.WRJ_WEB_ONLY !== '1') throw new Error('WRJ_WEB_ONLY 只能设置为 1。')
  const webOnly = env.WRJ_WEB_ONLY === '1'
  const port = portNumber('WRJ_PORT', '8080')
  const tilePort = portNumber('WRJ_MAP_PORT', '4174')
  if (port === tilePort) throw new Error('Web 入口和地图服务不能使用相同端口。')
  const webRoot = path('WRJ_WEB_ROOT')
  const outputRoot = path('WRJ_OUTPUT_ROOT')
  const executable = webOnly ? undefined : path('MISSION_EXECUTABLE_PATH')
  const database = path('SCENARIO_DB_PATH')
  for (const target of [outputRoot, database, executable].filter((value): value is string => value !== undefined)) {
    const within = relative(webRoot, target)
    if (!isAbsolute(within) && within !== '..' && !within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error('数据库、仿真程序和输出目录不能放在前端公开目录中。')
    }
  }
  if (!(await stat(webRoot)).isDirectory() || (executable && !(await stat(executable)).isFile())) throw new Error('前端目录或仿真程序不可用。')
  const html = await readFile(join(webRoot, 'index.html'), 'utf8')
  if (!html.includes('name="wrj-deployment" content="lan"')) throw new Error('前端不是内网发布包，请先执行 npm run build:lan。')
  if (executable) await access(executable, constants.R_OK)
  await access(dirname(database), constants.W_OK)
  await mkdir(outputRoot, { recursive: true })
  await access(outputRoot, constants.W_OK)
  return { publicOrigin, port, tilePort, webRoot, outputRoot, executable, webOnly, host: env.WRJ_HOST?.trim() || '0.0.0.0' }
}
