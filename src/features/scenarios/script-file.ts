import type { ScriptContract } from '../../contracts/domain-models'
import { apiFetch } from '../shared/api-fetch'
import { resolveMockOrigin, useAuthStore } from '../../stores/auth'
import { readApiFailure, readJson, unwrapSuccessData } from '../../stores/api-envelope'
import {
  isScriptEngineLoadCheckResult,
  type EngineLoadedPlatform,
  type ScriptEngineLoadCheckResult,
  type ScriptPackageEngineLoadCheckRequest,
} from './script-engine-load-contract'

export type { EngineLoadedPlatform, ScriptEngineLoadCheckResult, ScriptPackageEngineLoadCheckRequest }
export { isScriptEngineLoadCheckResult }

export async function saveScriptText(script: ScriptContract): Promise<string> {
  const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scripts/${encodeURIComponent(script.scriptId)}/local-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Role': useAuthStore().role },
    body: JSON.stringify({ checksum: script.checksum }),
  })
  const body = await readJson(response)
  if (!response.ok) throw new Error(readApiFailure(body)?.error.message ?? 'TXT 写入请求失败。')
  const data = unwrapSuccessData(body)
  if (typeof data !== 'object' || data === null || !('scriptId' in data) || data.scriptId !== script.scriptId
    || !('configVersion' in data) || data.configVersion !== script.configVersion
    || !('path' in data) || typeof data.path !== 'string' || !data.path.trim()) throw new Error('TXT 写入响应格式不正确。')
  return data.path
}

/** 按需把结构预检所选脚本包送至本机 AFSIM 引擎执行加载检查，不影响毫秒级静态预检。 */
export async function checkScriptPackageEngineLoad(payload: ScriptPackageEngineLoadCheckRequest): Promise<ScriptEngineLoadCheckResult> {
  const response = await apiFetch(`${resolveMockOrigin()}/api/v1/scripts/package/engine-load-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Demo-Role': useAuthStore().role },
    body: JSON.stringify(payload),
  })
  const body = await readJson(response)
  if (!response.ok) throw new Error(readApiFailure(body)?.error.message ?? '引擎加载检查请求失败。')
  const data = unwrapSuccessData(body)
  if (!isScriptEngineLoadCheckResult(data) || data.folder !== payload.folder || data.entry !== payload.entry) {
    throw new Error('引擎加载检查响应格式不正确。')
  }
  return data
}
