import type { ScriptContract } from '../../contracts/domain-models'
import { apiFetch } from '../shared/api-fetch'
import { resolveMockOrigin, useAuthStore } from '../../stores/auth'
import { readApiFailure, readJson, unwrapSuccessData } from '../../stores/api-envelope'

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
