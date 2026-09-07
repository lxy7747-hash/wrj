import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readAfsimLogFile } from '../server/local/afsim-log-reader.js'

/**
 * 只读解析一个明确指定的本地事件日志，并输出独立 JSON，不覆盖源文件或旧结果。
 * @param inputPath 用户指定的日志路径；不扫描其他目录，不启动文件监听。
 * @returns 新生成的结果路径。
 */
export async function parseAfsimLogFile(inputPath: string): Promise<string> {
  const parsed = await readAfsimLogFile(inputPath)
  const outputRoot = fileURLToPath(new URL('../output/afsim-log/', import.meta.url))
  await mkdir(outputRoot, { recursive: true })
  const outputDirectory = await mkdtemp(join(outputRoot, 'parsed-'))
  const outputPath = join(outputDirectory, 'parsed.json')
  await writeFile(outputPath, JSON.stringify(parsed, null, 2), { encoding: 'utf8', flag: 'wx' })
  console.log(JSON.stringify({ outputPath, valid: parsed.valid, nodes: parsed.nodes.length,
    communicationSystems: parsed.communicationSystems.length, ...parsed.summary }, null, 2))
  if (!parsed.valid) throw new Error(`日志存在 ${parsed.summary.errorCount} 个解析错误，请查看结果中的 issues 和来源行号。`)
  return outputPath
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  const inputPath = process.argv[2]
  try {
    if (!inputPath || process.argv.length !== 3) throw new Error('用法：npx tsx scripts/parse-afsim-log.ts <日志文件路径>')
    await parseAfsimLogFile(inputPath)
  } catch (error) {
    console.error(error instanceof Error ? error.message : '本地日志解析失败。')
    process.exitCode = 1
  }
}
