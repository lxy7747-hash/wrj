// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
const { mkdtemp, readFile, rm, writeFile, cp } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { dirname, join } = await import('node:' + 'path')
const { createHash } = await import('node:' + 'crypto')
const { fileURLToPath } = await import('node:' + 'url')
const { compareAfsimTemplates, formatTemplateComparison } = await import('../../scripts/' + 'compare-afsim-template.js')

type ComparisonChange = { previous?: { text: string }; next?: { text: string } }
type ComparisonFile = { file: string; added: ComparisonChange[]; changed: ComparisonChange[]; uiConfigurationMarkers: ComparisonChange[] }
type Comparison = { addedFiles: string[]; deletedFiles: string[]; files: ComparisonFile[] }

const referenceDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'afsim-template-20261101')
const temporaryDirectories: string[] = []

afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function copyTemplate(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'afsim-template-compare-'))
  temporaryDirectories.push(directory)
  await cp(referenceDirectory, directory, { recursive: true })
  return directory
}

describe('AFSIM 新模板只读比对', () => {
  it('报告新增、删除、改动和界面配置标记，不改写原始模板', async () => {
    const original = await readFile(join(referenceDirectory, 'comm_platform_REAR.txt'))
    const originalHash = createHash('sha256').update(original).digest('hex')
    const candidate = await copyTemplate()
    const rear = join(candidate, 'comm_platform_REAR.txt')
    await writeFile(rear, (await readFile(rear, 'utf8')).replace('power 20 W    //界面配置', 'power 21 W    //界面配置').replace('    on\n', '    on\n    new_partner_statement enabled\n'))
    await writeFile(join(candidate, 'new-template.txt'), '//界面配置：对接方新增字段\nnew statement\n')
    await rm(join(candidate, 'observers.txt'))

    const comparison = await compareAfsimTemplates(candidate) as Comparison
    const rearChanges = comparison.files.find(file => file.file === 'comm_platform_REAR.txt')!
    expect(comparison.addedFiles).toContain('new-template.txt')
    expect(comparison.deletedFiles).toContain('observers.txt')
    expect(rearChanges.added.some(change => change.next?.text === 'new_partner_statement enabled')).toBe(true)
    expect(rearChanges.changed.some(change => change.previous?.text === 'power 20 W' && change.next?.text === 'power 21 W')).toBe(true)
    expect(rearChanges.uiConfigurationMarkers.some(change => change.previous?.text === 'power 20 W' && change.next?.text === 'power 21 W')).toBe(true)
    expect(comparison.files.find(file => file.file === 'new-template.txt')!.uiConfigurationMarkers[0]!.next?.text).toContain('界面配置')
    expect(formatTemplateComparison(comparison)).toContain('界面配置标记')
    expect(createHash('sha256').update(await readFile(join(referenceDirectory, 'comm_platform_REAR.txt'))).digest('hex')).toBe(originalHash)
  })

  it('规范化空白、注释、数值、单位、时间、路径和 JSON 语义，但保留 JSON 键顺序差异', async () => {
    const candidate = await copyTemplate()
    const equivalentReference = await copyTemplate()
    const setup = join(candidate, 'comm_SimSetup.txt')
    await writeFile(setup, [
      '// 仅用于验证注释被忽略',
      'start_date 2025-09-15',
      'start_time 0:00',
      'end_time 90 min',
      'file output\\same.txt',
      'metadata {"a":1,"b":2.0}',
      '',
    ].join('\r\n'))
    await writeFile(join(equivalentReference, 'comm_SimSetup.txt'), [
      'start_date sep 15 2025',
      'start_time 00:00:00',
      'end_time 5400 sec',
      'file output/same.txt',
      'metadata {"a":1.0,"b":2}',
      '',
    ].join('\n'))

    const comparison = await compareAfsimTemplates(candidate, equivalentReference) as Comparison
    expect(comparison.files).toEqual([])

    const secondCandidate = await copyTemplate()
    await writeFile(join(secondCandidate, 'comm_SimSetup.txt'), 'metadata {"b":2,"a":1}\n')
    const secondReference = await copyTemplate()
    await writeFile(join(secondReference, 'comm_SimSetup.txt'), 'metadata {"a":1,"b":2}\n')
    const orderOnly = await compareAfsimTemplates(secondCandidate, secondReference) as Comparison & { files: Array<ComparisonFile & { changed: Array<ComparisonChange & { reason?: string }> }> }
    expect(orderOnly.files[0]!.changed[0]!.reason).toBe('JSON 键顺序发生变化')
  })

  it('忽略对接方目录里的引擎运行日志与输出目录，报告中按文件名分组', async () => {
    const candidate = await copyTemplate()
    await writeFile(join(candidate, 'mission.log'), 'start 1\ncomplete 5400\n')
    const { mkdir } = await import('node:' + 'fs/promises')
    await mkdir(join(candidate, 'output'), { recursive: true })
    await writeFile(join(candidate, 'output', 'scenario_events.txt'), 'not a template\n')
    expect(await compareAfsimTemplates(candidate) as Comparison).toMatchObject({ addedFiles: [], deletedFiles: [], files: [] })

    const rear = join(candidate, 'comm_platform_REAR.txt')
    await writeFile(rear, (await readFile(rear, 'utf8')).replace('power 20 W    //界面配置', 'power 21 W    //界面配置'))
    const text = formatTemplateComparison(await compareAfsimTemplates(candidate))
    expect(text).toContain('\ncomm_platform_REAR.txt\n')
    expect(text).not.toContain('[object Object]')
  })

  it('不会把带前导零的标识符或 JSON 字符串内容当成可规范化数值', async () => {
    const reference = await copyTemplate()
    const candidate = await copyTemplate()
    await writeFile(join(reference, 'comm_SimSetup.txt'), [
      'native_id comm_legacy-01',
      'metadata {"platform_name":"sat-01","label":"two  spaces"}',
      '',
    ].join('\n'))
    await writeFile(join(candidate, 'comm_SimSetup.txt'), [
      'native_id comm_legacy-1',
      'metadata {"platform_name":"sat-1","label":"two spaces"}',
      '',
    ].join('\n'))

    const comparison = await compareAfsimTemplates(candidate, reference) as Comparison
    const changed = comparison.files.find(file => file.file === 'comm_SimSetup.txt')!.changed
    expect(changed).toHaveLength(2)
    expect(changed.some(change => change.previous?.text === 'native_id comm_legacy-01' && change.next?.text === 'native_id comm_legacy-1')).toBe(true)
    expect(changed.some(change => change.previous?.text.includes('"two  spaces"') && change.next?.text.includes('"two spaces"'))).toBe(true)
  })
})
