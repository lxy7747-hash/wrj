import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ScenarioDraft, ScriptContract } from '../../src/contracts/domain-models.js'
import { buildMissionPackage, SCENARIO_PREVIEW_FILE } from '../scripts/mission-generator.js'
import { stripScriptComments } from '../scripts/afsim-template-patch.js'

/** 交付/落盘的 TXT 脚本统一去除注释；mapping.json、input.json、README.txt 等资料文件不受影响。 */
function stripScriptFileComments(name: string, content: string, scriptFiles: readonly string[]): string {
  return scriptFiles.includes(name) ? stripScriptComments(content) : content
}

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

/**
 * 每次执行重新生成已保存修订的独占包，禁止复用旧输出或接受客户端脚本路径。
 * 本地运行包总是拆分共享介质（E1）；引擎缺少 link_calc 时以 local_link_stub 原位替代（D4）。
 */
export async function writeMissionPackage(directory: string, draft: ScenarioDraft, stripLinkCalc = false, outputDirectory?: string): Promise<string> {
  const generated = buildMissionPackage(draft, undefined, { linkCalc: stripLinkCalc ? 'STUB' : 'PRESERVE', ...(outputDirectory ? { outputDirectory } : {}) })
  await mkdir(resolve(directory), { recursive: true })
  const owned = await mkdtemp(join(resolve(directory), 'mission-'))
  try {
    await mkdir(join(owned, generated.manifest.output.resolvedDirectory), { recursive: true })
    for (const [name, content] of Object.entries(generated.files)) {
      await writeFile(join(owned, name), stripScriptFileComments(name, content, generated.manifest.scriptFiles), { encoding: 'utf8', flag: 'wx' })
    }
    return join(owned, generated.manifest.entry)
  } catch (error) {
    await rm(owned, { recursive: true, force: true })
    throw error
  }
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/**
 * 生成脚本包目录名：script-YYYYMMDDHHmmss，按本机时间命名，便于按生成时刻排序和识别。
 * @param now 生成时刻；测试可注入固定时间。
 */
export function scriptPackageDirectoryName(now: Date): string {
  return `script-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
}

/** 独占创建本次脚本包目录；同一秒内重复生成时追加 -2、-3……，不覆盖已有包。 */
async function createScriptPackageDirectory(root: string, now: Date): Promise<string> {
  const base = scriptPackageDirectoryName(now)
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const directory = join(root, attempt === 1 ? base : `${base}-${attempt}`)
    try {
      await mkdir(directory)
      return directory
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('同一秒内生成的脚本包过多，请稍后重试。')
}

/**
 * 独占生成目录，避免覆盖同修订旧文件；客户端不能指定路径或文件内容。
 * @param now 生成时刻，仅用于目录名；默认取当前本机时间。
 */
export async function writeScriptText(directory: string, script: ScriptContract, revision: number, draft?: ScenarioDraft, now: Date = new Date()): Promise<string> {
  const generated = draft ? buildMissionPackage(draft) : undefined
  const root = resolve(directory)
  await mkdir(root, { recursive: true })
  const owned = await createScriptPackageDirectory(root, now)
  const filename = `${script.scenarioId.replace(/[^A-Za-z0-9_-]/g, '_')}-r${revision}.txt`
  const metadata = generated ? join(owned, 'metadata') : owned
  const path = join(metadata, filename)
  try {
    await mkdir(metadata, { recursive: true })
    await writeFile(path, `\uFEFF# Mock 脚本预览，未经真实 AFSIM 运行验证。\r\n# 场景修订：${revision}\r\n${script.preview}`, { encoding: 'utf8', flag: 'wx' })
    if (generated) {
      await mkdir(join(owned, generated.manifest.output.resolvedDirectory), { recursive: true })
      // 仅调整保存包的布局；运行包及其历史结果读者继续使用原来的路径。
      const scriptFiles = generated.manifest.scriptFiles.filter(name => name !== SCENARIO_PREVIEW_FILE)
      for (const [name, content] of Object.entries(generated.files)) {
        let savedContent = content
        if (name === SCENARIO_PREVIEW_FILE) savedContent = content.replace(`include_once ${generated.manifest.entry}`, `include_once ../${generated.manifest.entry}`)
        if (name === 'mapping.json') savedContent = JSON.stringify({ ...generated.manifest, scriptFiles }, null, 2) + '\n'
        if (name === 'README.txt') savedContent += `本目录保存辅助资料；执行入口为上级目录的 ${generated.manifest.entry}，映射中的文件路径相对于包根目录。\n`
        savedContent = stripScriptFileComments(name, savedContent, generated.manifest.scriptFiles)
        await writeFile(join(scriptFiles.includes(name) ? owned : metadata, name), savedContent, { encoding: 'utf8', flag: 'wx' })
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
