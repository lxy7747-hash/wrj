import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ScenarioDraft, ScriptContract } from '../../src/contracts/domain-models.js'
import { buildMissionPackage } from '../scripts/mission-generator.js'

const LINK_CALC_START = '  add processor link_calc WSF_LINK_CALC_PROCESSOR'
const LINK_CALC_END = '  end_processor'

/**
 * 去掉对接方插件处理器 link_calc 整段。仅在引擎探测确认缺少 WSF_LINK_CALC_PROCESSOR 时使用，
 * 否则会在读取输入时 FATAL；保存给对接方的 TXT 不经过这里，仍完整保留该段。
 */
export function withoutLinkCalc(content: string): string {
  const lines = content.split('\n')
  const start = lines.indexOf(LINK_CALC_START)
  if (start < 0) return content
  const end = lines.indexOf(LINK_CALC_END, start)
  if (end < 0) return content
  lines.splice(start, end - start + 1)
  return lines.join('\n')
}

/** 每次执行重新生成已保存修订的独占包，禁止复用旧输出或接受客户端脚本路径。 */
export async function writeMissionPackage(directory: string, draft: ScenarioDraft, stripLinkCalc = false): Promise<string> {
  const generated = buildMissionPackage(draft)
  await mkdir(resolve(directory), { recursive: true })
  const owned = await mkdtemp(join(resolve(directory), 'mission-'))
  try {
    await mkdir(join(owned, generated.manifest.output.resolvedDirectory), { recursive: true })
    for (const [name, content] of Object.entries(generated.files)) {
      await writeFile(join(owned, name), stripLinkCalc ? withoutLinkCalc(content) : content, { encoding: 'utf8', flag: 'wx' })
    }
    return join(owned, generated.manifest.entry)
  } catch (error) {
    await rm(owned, { recursive: true, force: true })
    throw error
  }
}

/** 独占生成目录，避免覆盖同修订旧文件；客户端不能指定路径或文件内容。 */
export async function writeScriptText(directory: string, script: ScriptContract, revision: number, draft?: ScenarioDraft): Promise<string> {
  const generated = draft ? buildMissionPackage(draft) : undefined
  const root = resolve(directory)
  await mkdir(root, { recursive: true })
  const owned = await mkdtemp(join(root, 'script-'))
  const filename = `${script.scenarioId.replace(/[^A-Za-z0-9_-]/g, '_')}-r${revision}.txt`
  const path = join(owned, filename)
  try {
    await writeFile(path, `\uFEFF# Mock 脚本预览，未经真实 AFSIM 运行验证。\r\n# 场景修订：${revision}\r\n${script.preview}`, { encoding: 'utf8', flag: 'wx' })
    if (generated) {
      await mkdir(join(owned, generated.manifest.output.resolvedDirectory), { recursive: true })
      for (const [name, content] of Object.entries(generated.files)) {
        await writeFile(join(owned, name), content, { encoding: 'utf8', flag: 'wx' })
      }
      return join(owned, generated.manifest.entry)
    }
    return path
  } catch (error) {
    // 仅移除本次独占目录，不接触其他脚本或用户数据。
    await rm(owned, { recursive: true, force: true })
    throw error
  }
}
