// 离线包 deployment.env 的解析与校验。只支持 IPv4；不做域名、IPv6、HTTPS 或自动网卡发现。
import { readFile, stat } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const DEPLOYMENT_FILE = 'deployment.env'
const REQUIRED_KEYS = ['LISTEN_HOST', 'DEPLOY_HOST', 'UI_PORT', 'API_PORT', 'MAP_PORT']
const OPTIONAL_KEYS = ['OUTPUT_ROOT', 'SCRIPT_OUTPUT_ROOT', 'DATA_DIR', 'MISSION_EXE_PATH', 'MISSION_OUTPUT_DIR']
const KEYS = [...REQUIRED_KEYS, ...OPTIONAL_KEYS]
const PORT_LABELS = { UI_PORT: '页面', API_PORT: '接口', MAP_PORT: '地图' }

/** 缺少 deployment.env 时的原有行为：三个服务只监听 127.0.0.1，路径使用包内默认目录。 */
export const LOCAL_DEFAULT = Object.freeze({
  configured: false, lan: false, listenHost: '127.0.0.1', deployHost: '127.0.0.1', uiPort: 5173, apiPort: 4173, mapPort: 4174,
  outputRoot: undefined, scriptOutputRoot: undefined, dataDir: undefined, missionExe: undefined, missionOutputDir: undefined,
})

/** 本机全部 IPv4 地址，仅用于校验 DEPLOY_HOST 与报错提示。 */
export function localIPv4Addresses() {
  return Object.values(networkInterfaces()).flat().filter(item => item && item.family === 'IPv4').map(item => item.address)
}

/** 严格解析 KEY=VALUE；允许空行、# 注释、UTF-8 BOM 与 CRLF。必填项为空视为缺失，可选项为空表示使用默认值。 */
export function parseDeploymentEnv(text) {
  const values = {}
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const match = /^([A-Z_]+)\s*=\s*(.*)$/.exec(line)
    if (!match) throw new Error(`第 ${index + 1} 行格式错误，应为 键=值。`)
    const [, key, value] = match
    if (!KEYS.includes(key)) throw new Error(`第 ${index + 1} 行包含不支持的配置项 ${key}。`)
    if (Object.hasOwn(values, key)) throw new Error(`配置项 ${key} 重复。`)
    values[key] = value.trim()
  })
  const missing = REQUIRED_KEYS.filter(key => !values[key])
  if (missing.length > 0) throw new Error(`缺少配置项：${missing.join('、')}。`)
  for (const key of OPTIONAL_KEYS) if (values[key] === '') delete values[key]
  return values
}

/**
 * 本机 mission 运行包内的输出子目录：必须是运行包内的相对路径，禁止绝对路径、盘符和 .. 逃逸。
 * @returns 归一化后的相对路径（分隔符统一为 /）；空值返回 undefined，表示沿用场景 output.directory。
 */
export function validateRelativeSubdirectory(value, key) {
  const text = value.trim()
  if (text === '') return undefined
  if (text.length > 200 || /[\r\n\0]/.test(text)) throw new Error(`${key} 不合法：长度需为 1–200 且不能包含控制字符。`)
  if (isAbsolute(text) || /^[A-Za-z]:/.test(text) || /^[\\/]/.test(text)) throw new Error(`${key}=${value} 必须是运行包内的相对路径，不能是绝对路径或盘符路径。`)
  const segments = text.split(/[\\/]/)
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) throw new Error(`${key}=${value} 不能包含空段、. 或 ..。`)
  return segments.join('/')
}
function isUnicastIPv4(address) {
  if (!isIPv4(address)) return false
  const first = Number(address.split('.')[0])
  return address !== '0.0.0.0' && address !== '255.255.255.255' && !(first >= 224 && first <= 239)
}

/** 只校验语法与语义；路径存在性等需要访问文件系统的检查在 readDeploymentConfig 中完成。 */
export function validateDeployment(values, localAddresses = localIPv4Addresses()) {
  const { LISTEN_HOST: listenHost, DEPLOY_HOST: deployHost } = values
  if (!isIPv4(listenHost) || (listenHost !== '0.0.0.0' && !isUnicastIPv4(listenHost))) throw new Error(`LISTEN_HOST=${listenHost} 不是有效的 IPv4 监听地址。`)
  if (deployHost === '0.0.0.0') throw new Error('DEPLOY_HOST 不能填写 0.0.0.0；0.0.0.0 只用于 LISTEN_HOST，请填写部署机的真实 IPv4。')
  if (!isUnicastIPv4(deployHost)) throw new Error(`DEPLOY_HOST=${deployHost} 不是有效的 IPv4 地址。`)
  if (listenHost !== '0.0.0.0' && listenHost !== deployHost) throw new Error('LISTEN_HOST 必须为 0.0.0.0 或与 DEPLOY_HOST 相同。')
  const ports = {}
  for (const key of ['UI_PORT', 'API_PORT', 'MAP_PORT']) {
    const text = values[key]
    const port = /^[0-9]{1,5}$/.test(text) ? Number(text) : Number.NaN
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${key}=${text} 必须是 1–65535 的整数。`)
    ports[key] = port
  }
  if (new Set(Object.values(ports)).size !== 3) throw new Error('UI_PORT、API_PORT、MAP_PORT 必须互不相同。')
  const lan = !deployHost.startsWith('127.')
  if (!lan && listenHost === '0.0.0.0') throw new Error('LISTEN_HOST=0.0.0.0 表示局域网模式，DEPLOY_HOST 必须填写部署机真实 IPv4；仅本机使用时两项都填写 127.0.0.1。')
  if (lan && !localAddresses.includes(deployHost)) {
    const candidates = localAddresses.filter(address => !address.startsWith('127.') && !address.startsWith('169.254.'))
    throw new Error(`DEPLOY_HOST=${deployHost} 不是本机当前的 IPv4 地址。本机可用地址：${candidates.join('、') || '无'}。请改为部署机实际地址后重启。`)
  }
  const pathValue = (key) => {
    const value = values[key]
    if (value === undefined) return undefined
    if (!isAbsolute(value)) throw new Error(`${key}=${value} 必须为绝对路径。`)
    return resolve(value)
  }
  const missionOutputDir = (() => {
    const text = (values.MISSION_OUTPUT_DIR ?? '').trim()
    if (text === '') return undefined
    return validateRelativeSubdirectory(text, 'MISSION_OUTPUT_DIR')
  })()
  const outputRoot = pathValue('OUTPUT_ROOT')
  const scriptOutputRoot = pathValue('SCRIPT_OUTPUT_ROOT')
  const dataDir = pathValue('DATA_DIR')
  const missionExe = pathValue('MISSION_EXE_PATH')
  return { configured: true, lan, listenHost, deployHost, uiPort: ports.UI_PORT, apiPort: ports.API_PORT, mapPort: ports.MAP_PORT, outputRoot, scriptOutputRoot, dataDir, missionExe, missionOutputDir }
}

/**
 * 读取启动器目录下的 deployment.env；文件不存在时返回仅本机默认配置。
 * @throws 文件存在但不可读、配置非法、或配置的路径不可用时抛出，调用方必须退出，不得回退。
 */
export async function readDeploymentConfig(root, localAddresses = localIPv4Addresses()) {
  let text
  try {
    text = await readFile(join(root, DEPLOYMENT_FILE), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return LOCAL_DEFAULT
    throw new Error(`${DEPLOYMENT_FILE} 无法读取：${error.message}`)
  }
  let config
  try {
    config = validateDeployment(parseDeploymentEnv(text), localAddresses)
  } catch (error) {
    throw new Error(`${DEPLOYMENT_FILE} 配置错误：${error.message}`)
  }
  try {
    if (config.dataDir !== undefined) {
      const database = join(config.dataDir, 'scenarios.db')
      const info = await stat(database).catch(() => undefined)
      if (!info?.isFile()) throw new Error(`DATA_DIR=${config.dataDir} 下缺少 scenarios.db；请把原 data 目录整体复制到该位置。`)
    }
    if (config.outputRoot !== undefined) {
      const info = await stat(config.outputRoot).catch(() => undefined)
      if (info !== undefined && !info.isDirectory()) throw new Error(`OUTPUT_ROOT=${config.outputRoot} 不是目录。`)
    }
    if (config.scriptOutputRoot !== undefined) {
      const info = await stat(config.scriptOutputRoot).catch(() => undefined)
      if (info !== undefined && !info.isDirectory()) throw new Error(`SCRIPT_OUTPUT_ROOT=${config.scriptOutputRoot} 不是目录。`)
    }
    if (config.missionExe !== undefined) {
      const info = await stat(config.missionExe).catch(() => undefined)
      if (!info?.isFile()) throw new Error(`MISSION_EXE_PATH=${config.missionExe} 不存在或不是文件。`)
    } else {
      const info = await stat(join(root, 'afsim', 'Release', 'mission.exe')).catch(() => undefined)
      if (!info?.isFile()) throw new Error('包内缺少 afsim/Release/mission.exe，且未配置 MISSION_EXE_PATH；点击开始无法运行本机 mission。')
    }
  } catch (error) {
    throw new Error(`${DEPLOYMENT_FILE} 配置错误：${error.message}`)
  }
  return config
}

/** 前端唯一需要的运行时字段；不包含主机、路径、账号或其他环境变量。 */
export function runtimeConfigBody(config) {
  return JSON.stringify({ apiPort: config.apiPort, mapPort: config.mapPort })
}

/** 传给接口服务的来源范围与 LinkCalc 连接地址；不配置第三方插件的监听地址。 */
export function apiAccessEnv(config) {
  return {
    MOCK_PORT: String(config.apiPort), WRJ_DEPLOY_HOST: config.deployHost, WRJ_LISTEN_HOST: config.listenHost, WRJ_UI_PORT: String(config.uiPort),
    // 启动环境优先于 .env.local，避免旧部署包中的开发地址覆盖部署机 IP。
    realUrl: `ws://${config.deployHost}:8080/ws/v1`,
  }
}

export function portEntries(config) {
  return [['UI_PORT', config.uiPort], ['API_PORT', config.apiPort], ['MAP_PORT', config.mapPort]].map(([key, port]) => ({ key, label: PORT_LABELS[key], port }))
}
