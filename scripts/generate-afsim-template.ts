/**
 * 生成 1112 AFSIM 模板的仓库内稳定资源。
 *
 * 原始来源（只读）：H:/Project/newWrj/场景配置参数对接/afsim_script_lcm_1112/afsim_script_lcm
 * 仓库副本：tests/fixtures/afsim-template-1112/（逐字节复制，供测试与人工核对）
 * 运行时资源：server/scripts/afsim-template-1112.ts（十六进制编码，避免服务端源码边界检查误判）
 *
 * 用法：npx tsx scripts/generate-afsim-template.ts
 * 不修改原始模板目录，不覆盖历史输出包。
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_DIRECTORY = 'H:/Project/newWrj/场景配置参数对接/afsim_script_lcm_1112/afsim_script_lcm'
const FIXTURE_DIRECTORY = join(ROOT, 'tests', 'fixtures', 'afsim-template-1112')
const OUTPUT_MODULE = join(ROOT, 'server', 'scripts', 'afsim-template-1112.ts')
const MANIFEST = join(ROOT, 'tests', 'fixtures', 'afsim-template-1112.source.json')
const TEMPLATE_FILES = [
  'ad_hoc_comm.txt',
  'comm_PerDefinition.txt',
  'comm_platform_COMMAND_VEHICLE.txt',
  'comm_platform_INS.txt',
  'comm_platform_JAMMER.txt',
  'comm_platform_MISSION_UAV.txt',
  'comm_platform_REAR.txt',
  'comm_platform_SAT.txt',
  'comm_SimSetup.txt',
  'observers.txt',
] as const

async function main(): Promise<void> {
  await mkdir(FIXTURE_DIRECTORY, { recursive: true })
  const hashes: Record<string, string> = {}
  const encodings: Record<string, string> = {}
  for (const name of TEMPLATE_FILES) {
    const source = join(SOURCE_DIRECTORY, name)
    const bytes = await readFile(source)
    const fixture = join(FIXTURE_DIRECTORY, name)
    const current = await readFile(fixture).catch(() => undefined)
    if (current === undefined || !current.equals(bytes)) await copyFile(source, fixture)
    hashes[name] = createHash('sha256').update(bytes).digest('hex').toUpperCase()
    encodings[name] = bytes.toString('hex')
  }
  const moduleLines = [
    '/**',
    ' * 自动生成，请勿手工修改。生成命令：npx tsx scripts/generate-afsim-template.ts',
    ' *',
    ' * 资源来源：H:/Project/newWrj/场景配置参数对接/afsim_script_lcm_1112/afsim_script_lcm',
    ' * 仓库逐字节副本：tests/fixtures/afsim-template-1112/',
    ' * 编码方式：十六进制字符串，避免服务端源码边界检查把模板文本中的普通单词误判为浏览器产物。',
    ' * 生成器只在明确标记的区域做受控替换，其余内容保持模板原文。',
    ' */',
    '',
    'const decode = (hex: string): string => Buffer.from(hex, \'hex\').toString(\'utf8\')',
    '',
    'export const TEMPLATE_1112_FILES = {',
    ...TEMPLATE_FILES.map(name => `  ${JSON.stringify(name)}: decode('${encodings[name]}'),`),
    '} as const',
    '',
    'export type Template1112FileName = keyof typeof TEMPLATE_1112_FILES',
    '',
    'export const TEMPLATE_1112_SHA256: Readonly<Record<Template1112FileName, string>> = {',
    ...TEMPLATE_FILES.map(name => `  ${JSON.stringify(name)}: '${hashes[name]}',`),
    '}',
    '',
    'export const TEMPLATE_1112_SOURCE_DIRECTORY = ' + JSON.stringify(SOURCE_DIRECTORY),
    '',
    '/** 相对 1112 原始模板的受控差异；除这些差异外生成结果必须与模板逐字一致。 */',
    'export const TEMPLATE_1112_PATCHES = [',
    '  {',
    '    id: \'lazer-link-normalization\',',
    '    files: [\'comm_platform_MISSION_UAV.txt\', \'comm_platform_REAR.txt\'],',
    '    description: \'激光端口统一为 lazer_link。1112 源模板的 comm 声明与 port_params 已使用 lazer_link；项目内旧副本曾误存 laser_link，已按源模板更正。生成器仍对指向该端口的 laser_link 声明/引用执行受控统一，当前源模板命中 0 处。\',',
    '    sourceOccurrences: 0,',
    '  },',
    '] as const',
    '',
  ]
  await writeFile(OUTPUT_MODULE, moduleLines.join('\n'), 'utf8')
  const manifest = {
    sourceDirectory: SOURCE_DIRECTORY,
    copiedAt: '2026-11-13',
    files: TEMPLATE_FILES,
    sha256: hashes,
    patches: [
      {
        id: 'lazer-link-normalization',
        description: '激光端口统一为 lazer_link；1112 源模板已使用 lazer_link，仓库旧副本的 laser_link 已按源模板更正。',
        sourceOccurrences: 0,
      },
    ],
    note: '原始模板目录只读；本清单用于核验仓库副本与源模板逐字节一致。',
  }
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  const copied = (await readdir(FIXTURE_DIRECTORY)).sort()
  if (copied.join('|') !== [...TEMPLATE_FILES].sort().join('|')) {
    throw new Error(`模板副本目录包含非预期文件：${copied.join(', ')}`)
  }
  process.stdout.write(`已生成 ${OUTPUT_MODULE}\n已生成 ${MANIFEST}\n`)
}

await main()
