// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { inspectScriptPackageFolder } from '../../src/features/scenarios/script-package-preflight'

const manifest = { scenarioId: 'SCN-TEST', revision: 2, entry: 'entry.txt', scriptFiles: ['entry.txt', 'section/part.txt'] }
function file(path: string, content: string) {
  return { webkitRelativePath: 'folder/' + path, size: new TextEncoder().encode(content).length, text: vi.fn(async () => content) }
}
const mapping = (data = manifest) => file('metadata/mapping.json', JSON.stringify(data))
const inspectEntry = (text: string) => inspectScriptPackageFolder([
  mapping({ ...manifest, scriptFiles: ['entry.txt'] }), file('metadata/input.json', '{}'), file('entry.txt', text),
])

describe('本机目录静态预检', () => {
  it('核对清单和递归相对引用，保留行号，且只读取声明文件', async () => {
    const ignored = file('notes/unused.txt', 'include missing.txt')
    const snapshot = file('metadata/input.json', '{}')
    const files = [
      mapping(), snapshot, ignored,
      file('entry.txt', ['include_once "section/part.txt"', '/*', 'include ghost.txt', '*/', 'include ./notes/unused.txt # comment'].join('\r\n')),
      file('section/part.txt', 'include ../entry.txt\n// include ignored.txt'),
    ]
    await expect(inspectScriptPackageFolder(files)).resolves.toEqual({
      folder: 'folder', identity: { scenarioId: 'SCN-TEST', revision: 2, entry: 'entry.txt' },
      entryState: 'present', filesExpected: 4, filesPresent: 4, referencesChecked: 3, errors: [],
      scriptFiles: [
        { path: 'entry.txt', state: 'checked', references: 2, referenceErrors: 0, referenceWarnings: 1, closedBlocks: 0, structureErrors: 0 },
        { path: 'section/part.txt', state: 'checked', references: 1, referenceErrors: 0, referenceWarnings: 0, closedBlocks: 0, structureErrors: 0 },
      ],
      warnings: ['entry.txt:5：引用文件未列入清单，内容未核验：notes/unused.txt'],
    })
    expect(ignored.text).not.toHaveBeenCalled()
    expect(snapshot.text).not.toHaveBeenCalled()
  })

  it('区分缺少包内文件与外部或动态引用，绝不读取目录外的文件', async () => {
    const result = await inspectScriptPackageFolder([
      mapping(), file('entry.txt', ['include ../../outside.txt', 'include missing.txt', 'include "$ROOT/unknown.txt"'].join('\n')),
    ])
    expect(result.identity).toEqual({ scenarioId: 'SCN-TEST', revision: 2, entry: 'entry.txt' })
    expect(result.filesPresent).toBe(2)
    expect(result.referencesChecked).toBe(1)
    expect(result.scriptFiles).toMatchObject([
      { path: 'entry.txt', state: 'checked', references: 3, referenceErrors: 1, referenceWarnings: 2 },
      { path: 'section/part.txt', state: 'missing' },
    ])
    expect(result.errors).toEqual(expect.arrayContaining([
      '缺少文件：metadata/input.json', '缺少文件：section/part.txt', 'entry.txt:2：包内引用缺少文件：missing.txt',
    ]))
    expect(result.warnings).toEqual(['entry.txt:1：外部或动态引用未核验。', 'entry.txt:3：外部或动态引用未核验。'])
  })

  it('接受旧修订和旧版根目录清单，优先使用新版清单', async () => {
    const historical = { ...manifest, scenarioId: 'SCN-HISTORY', revision: 1 }
    const files = [file('mapping.json', JSON.stringify(historical)), file('input.json', '{}'),
      file('entry.txt', 'include section/part.txt'), file('section/part.txt', '')]
    await expect(inspectScriptPackageFolder(files)).resolves.toMatchObject({
      identity: { scenarioId: 'SCN-HISTORY', revision: 1, entry: 'entry.txt' },
      filesExpected: 4, filesPresent: 4, referencesChecked: 1, errors: [],
    })
    await expect(inspectScriptPackageFolder([...files, file('metadata/mapping.json', '{broken')])).resolves.toMatchObject({
      identity: null, errors: expect.arrayContaining(['metadata/mapping.json:1：清单格式或声明路径无效。']),
    })
  })

  it('拒绝跨根、路径穿越和伪造清单路径', async () => {
    const entry = file('entry.txt', 'unused')
    const foreign = { ...entry, webkitRelativePath: 'other/entry.txt' }
    const escape = { ...entry, webkitRelativePath: 'folder/../entry.txt' }
    for (const invalid of [foreign, escape]) {
      const unsafe = await inspectScriptPackageFolder([mapping(), invalid])
      expect(unsafe.errors).toHaveLength(1)
    }
    const malformed = await inspectScriptPackageFolder([mapping({ ...manifest, scriptFiles: ['entry.txt', '../escape.txt'] }), entry])
    expect(malformed.errors.some(error => error.includes('清单格式或声明路径无效'))).toBe(true)
    expect(entry.text).not.toHaveBeenCalled()
  })

  it('接受 CRLF 下配对的结构，并忽略注释和引号中的结构标记', async () => {
    const text = [
      '# end_platform } "',
      'platform placeholder WSF_PLATFORM',
      '  route',
      '  /* end_platform',
      '     include missing.txt " } */',
      '  end_route',
      '  add comm placeholder_wire WSF_COMM_TRANSCEIVER',
      '    add medium placeholder_medium',
      '    end_medium',
      '  end_comm',
      '  add sensor placeholder_sensor WSF_NULL_SENSOR',
      '  end_sensor',
      '  placeholder_data {',
      '    "note \\" end_route } #"',
      "    'note \\' end_comm { // '",
      '  } // }',
      '  execute at_interval_of 5 sec',
      '    writeln("end_execute");',
      '  end_execute',
      'end_platform',
    ].join('\r\n')
    await expect(inspectEntry(text)).resolves.toMatchObject({
      errors: [], warnings: [], referencesChecked: 0,
      scriptFiles: [{ path: 'entry.txt', state: 'checked', closedBlocks: 6, structureErrors: 0 }],
    })
  })

  it.each([
    ['未闭合的结构块', '# comment\r\nplatform placeholder WSF_PLATFORM\r\n  route\r\n  end_route', /entry\.txt:2：.*未闭合.*platform|entry\.txt:2：.*platform.*未闭合/u],
    ['意外结束标记', '# comment\nend_route', /entry\.txt:2：.*end_route/u],
    ['未闭合的花括号', '# comment\nplaceholder_data {', /entry\.txt:2：.*花括号/u],
    ['意外右花括号', '# comment\n}', /entry\.txt:2：.*花括号/u],
    ['未闭合的双引号', '# comment\nplaceholder_value "unterminated', /entry\.txt:2：.*(?:引号|字符串)/u],
    ['未闭合的单引号', "# comment\nplaceholder_value 'unterminated", /entry\.txt:2：.*(?:引号|字符串)/u],
    ['未闭合的块注释', '# comment\n/* placeholder\nend_platform', /entry\.txt:2：块注释未闭合/u],
  ] as const)('定位%s的文件和行号', async (_, text, diagnostic) => {
    const result = await inspectEntry(text)
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(diagnostic)]))
    expect(result.scriptFiles[0]?.structureErrors).toBeGreaterThan(0)
  })

  it.each(['', '/* end_platform */\r\n# placeholder\r\n// }'])('入口没有脚本内容时报告第 1 行', async (text) => {
    const result = await inspectEntry(text)
    expect(result.errors).toContain('entry.txt:1：入口文件为空或只有注释。')
    expect(result.entryState).toBe('empty')
  })

  it('入口文件缺失时定位到清单中声明入口的行', async () => {
    const result = await inspectScriptPackageFolder([
      file('metadata/mapping.json', JSON.stringify(manifest, null, 2)),
      file('metadata/input.json', '{}'), file('section/part.txt', ''),
    ])
    expect(result.errors).toContain('metadata/mapping.json:4：入口文件缺失：entry.txt')
    expect(result.entryState).toBe('missing')
  })

  it.each(['include', 'include_once # no path'])('包含命令 %s 缺少路径时报告错误', async (text) => {
    const result = await inspectEntry(text)
    expect(result.errors).toContain('entry.txt:1：包含引用缺少文件路径。')
    expect(result.warnings).toEqual([])
    expect(result.referencesChecked).toBe(0)
  })
})
