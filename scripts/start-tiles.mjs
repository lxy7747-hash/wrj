import { spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function startTiles(env = process.env) {
  const file = async (key, expectedName) => {
    const value = env[key]?.trim()
    if (!value || !isAbsolute(value)) throw new Error(`${key} 必须配置为绝对路径。`)
    if (expectedName && basename(value) !== expectedName) throw new Error(`${key} 的文件名必须为 ${expectedName}。`)
    await access(value)
    if (!(await stat(value)).isFile()) throw new Error(`${key} 不是普通文件。`)
    return value
  }
  const executable = await file('WRJ_MAP_EXECUTABLE_PATH')
  const vector = await file('WRJ_MAP_VECTOR_PATH', 'china-taiwan-260823.pmtiles')
  const satellite = await file('WRJ_MAP_SATELLITE_PATH', 'taiwan-strait-satellite.pmtiles')
  const port = Number(env.WRJ_MAP_PORT ?? '4174')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WRJ_MAP_PORT 必须为有效端口号。')
  // 地图子进程不需要账号初始化密码或其他后端配置。
  const childEnv = { ...env }
  delete childEnv.AUTH_BOOTSTRAP_PASSWORD
  return spawn(executable, ['serve', '-i', '127.0.0.1', '-p', String(port), vector, satellite], {
    env: childEnv, windowsHide: true, shell: false, stdio: 'inherit',
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const child = await startTiles()
    child.once('error', error => { console.error(`地图服务启动失败：${error.message}`); process.exitCode = 1 })
    child.once('exit', code => { process.exitCode = code ?? 1 })
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill())
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
