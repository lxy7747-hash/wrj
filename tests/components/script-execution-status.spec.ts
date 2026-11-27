// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { formatScriptExecutionLog, readScriptAcceptanceReview } from '../../src/features/scenarios/script-execution-status'

const repeated = 'platforms[0].label'
const status = {
  emitted: [
    { fieldPath: repeated, detail: '记录一' },
    { fieldPath: repeated, detail: '记录二' },
    { fieldPath: 'linkSettings.label', detail: '记录三' },
    { fieldPath: 'unclassified.label', detail: '仍显示于日志' },
  ],
  retainedSnapshot: [
    { fieldPath: repeated, detail: '同一路径的快照记录' },
    { fieldPath: 'uiExtensions.sensors[1].label', detail: '传感器快照' },
    { fieldPath: 'uiExtensions.jammers[2].label', detail: '干扰设备快照' },
  ],
  dependencyUnconfirmed: [{ fieldPath: 'references[0].label', detail: '待确认' }],
}
const fixture = { unrelated: { fieldPath: repeated, detail: '无关信息' }, executionStatus: status }
const mappingBody = JSON.stringify(fixture, null, 2)
const header = ['// ===== scenario.txt =====', '// 预览占位', '', '// ===== mapping.json =====', '// 说明']
function preview(json = mappingBody, eol = '\n'): string {
  return [...header, ...json.split('\n').map(line => '// ' + line), '', '// ===== input.json =====', '// {}'].join(eol)
}

describe('生成验收证据索引', () => {
  it('仅索引正确的状态数组，保留重复路径的精确独立行号，兼容 CRLF', () => {
    const review = readScriptAcceptanceReview(preview(mappingBody, '\r\n'))!
    expect(review.map(({ status: entryStatus, group }) => [entryStatus, group])).toEqual([
      ['emitted', 'platform'], ['emitted', 'platform'], ['emitted', 'communication'],
      ['retainedSnapshot', 'platform'], ['retainedSnapshot', 'sensor'], ['retainedSnapshot', 'jammer'],
      ['dependencyUnconfirmed', 'timeline'],
    ])
    const bodyLines = mappingBody.split('\n')
    const repeatedLines = bodyLines.map((line, index) => /^ {8}"fieldPath": "platforms\[0\]\.label",$/u.test(line) ? index + 1 : null)
      .filter(line => line !== null)
    expect(review.filter(row => row.fieldPath === repeated).map(row => row.location)).toEqual(
      repeatedLines.map(fileLine => ({ fileName: 'mapping.json', fileLine, previewLine: header.length + fileLine })),
    )
    for (const row of review) {
      expect(row.location).not.toBeNull()
      expect(bodyLines[row.location!.fileLine - 1]!.trim()).toContain(JSON.stringify(row.fieldPath))
    }
    expect(formatScriptExecutionLog(preview())).toContain('[已写入执行] unclassified.label：仍显示于日志')
  })

  it('有效非标准格式仍可查看事实，但不猜测行号；缺少或损坏的状态返回空缺', () => {
    const nonCanonical = mappingBody.replace('  "executionStatus": {', ' "executionStatus": {')
    const rows = readScriptAcceptanceReview(preview(nonCanonical))
    expect(rows).toHaveLength(7)
    expect(rows!.every(row => row.location === null)).toBe(true)
    expect(readScriptAcceptanceReview('// ===== scenario.txt =====')).toBeNull()
    expect(readScriptAcceptanceReview(preview('{\n  "executionStatus": false\n}'))).toBeNull()
    expect(readScriptAcceptanceReview(preview('{\n  "executionStatus": {\n}'))).toBeNull()
  })

  it('只在入口文件确有对应引用时提供原文行号', () => {
    const input = preview(JSON.stringify({ ...fixture, entry: 'sample.txt' }, null, 2))
    const withEntry = input.replace('// 预览占位', 'include_once sample.txt')
    expect(readScriptAcceptanceReview(withEntry)?.at(-1)).toMatchObject({
      fieldPath: 'references.entry', status: 'emitted', group: 'timeline',
      location: { fileName: 'scenario.txt', fileLine: 1, previewLine: 2 },
    })
    expect(readScriptAcceptanceReview(input)?.some(row => row.fieldPath === 'references.entry')).toBe(false)
  })

  it('已写入条目优先定位本次预览的 TXT 原文，其他状态保留清单行号', () => {
    const paths = ['scenario.startTime', 'scenario.duration', 'platforms[0].id', 'platforms[0].initialPosition', 'platforms[0].waypoints', 'platforms[0].loiterWaypoints', 'links[0]']
    const data = {
      entry: 'sample.txt', platforms: [{ name: 'fixture', generatedType: 'SAMPLE_TYPE' }],
      executionStatus: {
        emitted: paths.map(fieldPath => ({ fieldPath, detail: '合成记录' })),
        retainedSnapshot: [{ fieldPath: 'scenario.duration', detail: '合成快照' }, { fieldPath: 'platforms[0].waypoints[0].arrivalTime', detail: '运动快照' }],
        dependencyUnconfirmed: [{ fieldPath: 'platforms[0].id', detail: '合成依赖' }],
      },
    }
    const sections = [
      '// ===== ignored.txt =====', 'end_time elsewhere',
      '// ===== sample.txt =====', 'start_date example', '  end_time example  ',
      '// ===== entities.txt =====', 'platform fixture SAMPLE_TYPE', '  position example', '  route', '    label LOITER', 'end_platform', '',
    ].join('\r\n')
    const input = sections + preview(JSON.stringify(data, null, 2), '\r\n')
    const rows = readScriptAcceptanceReview(input)!
    expect(rows.map(row => [row.group, row.location?.fileName, row.location?.fileLine]).slice(0, 6)).toEqual([
      ['timeline', 'sample.txt', 1], ['timeline', 'sample.txt', 2], ['platform', 'entities.txt', 1],
      ['platform', 'entities.txt', 2], ['motion', 'entities.txt', 3], ['motion', 'entities.txt', 4],
    ])
    expect(input.split('\r\n')[rows[1]!.location!.previewLine - 1]).toBe('  end_time example  ')
    expect(rows.slice(6).map(row => [row.group, row.location?.fileName])).toEqual([
      ['communication', 'mapping.json'],
      ['timeline', 'mapping.json'],
      ['motion', 'mapping.json'],
      ['platform', 'mapping.json'],
    ])

    const ambiguous = input.replace('  end_time example  ', '  end_time example  \r\nend_time duplicate')
    expect(readScriptAcceptanceReview(ambiguous)?.[1]?.location?.fileName).toBe('mapping.json')
    const routeOnly = input.replace('  position example\r\n  route', '  route\r\n    position example')
    expect(readScriptAcceptanceReview(routeOnly)?.[3]?.location?.fileName).toBe('mapping.json')
  })

  it('通信和干扰条目定位唯一的实际定义段，快照、依赖和衍生项仍定位清单', () => {
    const paths = ['links[0]', 'deviceParameters.ports.FIXTURE.port', 'informationDemand[0]', 'jammers[0]', 'linkSettings.switchCooldownS']
    const data = { executionStatus: {
      emitted: paths.map(fieldPath => ({ fieldPath, detail: '合成写入记录' })),
      retainedSnapshot: [{ fieldPath: 'jammers[0]', detail: '合成快照' }],
      dependencyUnconfirmed: [{ fieldPath: 'links[0]', detail: '合成依赖' }],
    } }
    const sections = [
      '// ===== example.txt =====', '    jammer_param {}',
      '// ===== comm_platform_REAR.txt =====', '    traffic_type []',
      '  add processor link_calc SAMPLE_BLOCK',
      '    port_params []', '    traffic_type []', '    jammer_param {}', '  end_processor', '',
    ].join('\n')
    const input = sections + preview(JSON.stringify(data, null, 2))
    const rows = readScriptAcceptanceReview(input)!
    expect(rows.map(row => [row.location?.fileName, row.location?.fileLine]).slice(0, 4)).toEqual([
      ['comm_platform_REAR.txt', 2], ['comm_platform_REAR.txt', 3],
      ['comm_platform_REAR.txt', 4], ['comm_platform_REAR.txt', 5],
    ])
    const link = rows[0]!.location!
    expect(input.split('\n').slice(link.previewLine - 1, link.endPreviewLine)).toEqual([
      '  add processor link_calc SAMPLE_BLOCK', '    port_params []', '    traffic_type []', '    jammer_param {}', '  end_processor',
    ])
    expect(rows.slice(4).map(row => row.location?.fileName)).toEqual(['mapping.json', 'mapping.json', 'mapping.json'])

    const ambiguous = input.replace('    port_params []', '    port_params []\n    port_params []')
    expect(readScriptAcceptanceReview(ambiguous)?.[0]?.location?.fileName).toBe('mapping.json')
    const missing = input.replace('    jammer_param {}\n  end_processor', '  end_processor')
    expect(readScriptAcceptanceReview(missing)?.[3]?.location?.fileName).toBe('mapping.json')
  })
})
