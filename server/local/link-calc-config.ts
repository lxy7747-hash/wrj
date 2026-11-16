import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { readLinkEngineWsUrl } from './engine-snapshot-client.js'

/** 在启动本机 mission 前同步实际连接地址；远程引擎的绑定配置由远端管理。 */
export async function syncLocalLinkCalcConfig(executable: string, wsUrl?: string): Promise<boolean> {
  const address = readLinkEngineWsUrl(wsUrl)
  if (!address) return false
  const url = new URL(address)
  const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
  const local = isIPv4(host) && (host.startsWith('127.') || Object.values(networkInterfaces()).flat().some(entry => entry?.address === host))
  if (!local || url.protocol !== 'ws:') return false
  if (url.search) throw new Error('本机 LinkCalc 的 WebSocket 地址不能包含查询参数。')

  const configPath = join(dirname(executable), 'CalcConfig.ini')
  try {
    // 按字节保留运行包的 GBK/UTF-8 注释，仅替换 ASCII 配置值。
    const original = await readFile(configPath, 'latin1')
    let updated = original
    for (const [key, value] of Object.entries({ wsip: host, wsport: url.port || '80', wspath: url.pathname })) {
      const pattern = new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*)([^ \\t\\r\\n#;]*)([ \\t]*(?:[#;][^\\r\\n]*)?)(\\r?)$`, 'gm')
      if ([...original.matchAll(pattern)].length !== 1) throw new Error(`${key} 必须存在且只能出现一次。`)
      updated = updated.replace(pattern, (_match, prefix, _old, comment, cr) => `${prefix}${value}${comment}${cr}`)
    }
    if (updated === original) return false
    const pending = `${configPath}.${randomUUID()}.tmp`
    try {
      await writeFile(pending, updated, { encoding: 'latin1', flag: 'wx' })
      await rename(pending, configPath)
    } finally { await rm(pending, { force: true }) }
    return true
  } catch (error) {
    throw new Error(`无法同步 ${configPath}：${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
