// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'

const { mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:fs/' + 'promises')
const { createHash } = await import('node:' + 'crypto')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
const { readInitialNodes } = await import('../../server/local/' + 'afsim-log-reader.js')
const { readLocalReplay } = await import('../../server/local/' + 'afsim-replay-reader.js')
const { readLocalReport } = await import('../../server/local/' + 'report-file.js')
const { LocalMissionResults } = await import('../../server/local/' + 'mission-results.js')
const { ScenarioProjection } = await import('../../server/scenarios/' + 'projection.js')
const { parseAfsimEventLog } = await import('../../src/features/data-exchange/' + 'afsim-event-log.js')
const { resolveManifestConnections } = await import('../../server/local/' + 'afsim-log-reader.js')
const roots: string[] = []

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function eventCsv(): string {
  const platforms = ['A', 'B', 'C', 'D', 'R']
  return [
    '! PLATFORM_ADDED,time<time>,event<string>,platform<string>,side<string>,type<string>,ps<double>,lat<lat>,lon<lon>',
    '! PLATFORM_INITIALIZED,time<time>,event<string>,platform<string>,side<string>,type<string>,lat<lat>,lon<lon>,alt<double>,heading<angle>,pitch<angle>,roll<angle>,ned_speed<double>',
    '! COMM_TURNED_ON,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>',
    '! LINK_ADDED_TO_MANAGER,source_platform<string>,source_comm<string>,source_address<string>,destination_platform<string>,destination_comm<string>,destination_address<string>',
    '! SIMULATION_COMPLETE,time<time>,event<string>,year<int>,month<int>,day<int>,hour<int>,minute<int>,second<int>',
    ...platforms.map((platform, index) => `0,PLATFORM_ADDED,${platform},blue,AIR,`),
    ...platforms.map((platform, index) => `0,PLATFORM_INITIALIZED,${platform},blue,AIR,${25 + index},${119 + index},3000,0,0,0,100`),
    // A 与 B 有意使用相同的端口名，二者状态必须按平台区分。
    '0,COMM_TURNED_ON,A,blue,Comm,microwave_link,WSF_RADIO_TRANSCEIVER',
    '0,COMM_TURNED_ON,B,blue,Comm,microwave_link,WSF_RADIO_TRANSCEIVER',
    '0,COMM_TURNED_ON,C,blue,Comm,microwave_link,WSF_RADIO_TRANSCEIVER',
    '0,COMM_TURNED_ON,D,blue,Comm,microwave_link,WSF_RADIO_TRANSCEIVER',
    '0,COMM_TURNED_ON,R,blue,Comm,sat_link,WSF_RADIO_TRANSCEIVER',
    '0,COMM_TURNED_ON,A,blue,Comm,comm_legacy_alpha_src,WSF_RADIO_TRANSCEIVER',
    '0,COMM_TURNED_ON,B,blue,Comm,comm_legacy_alpha_dst,WSF_RADIO_TRANSCEIVER',
    '1,LINK_ADDED_TO_MANAGER,A,microwave_link,0.1.0.1,C,microwave_link,0.1.0.2',
    '2,LINK_ADDED_TO_MANAGER,A,comm_legacy_alpha_src,0.1.0.3,B,comm_legacy_alpha_dst,0.1.0.4',
    '3,SIMULATION_COMPLETE,2026,11,1,0,0,3',
  ].join('\n')
}

const devices = [
  { linkId: 'NEW-1', linkType: 'MICROWAVE', source: { platformId: 'A', deviceId: 'microwave_link' }, target: { platformId: 'C', deviceId: 'microwave_link' } },
  { linkId: 'NEW-2', linkType: 'MICROWAVE', source: { platformId: 'A', deviceId: 'microwave_link' }, target: { platformId: 'D', deviceId: 'microwave_link' } },
  { linkId: 'NEW-OTHER', linkType: 'MICROWAVE', source: { platformId: 'B', deviceId: 'microwave_link' }, target: { platformId: 'D', deviceId: 'microwave_link' } },
  { linkId: 'NEW-RELAY', linkType: 'SAT', source: { platformId: 'A', deviceId: 'sat_link' }, target: { platformId: 'B', deviceId: 'sat_link' }, relayPlatformId: 'R', relayDeviceId: 'sat_link' },
  { linkId: 'LEGACY', linkType: 'SAT', source: { platformId: 'A', deviceId: 'comm_legacy_alpha_src' }, target: { platformId: 'B', deviceId: 'comm_legacy_alpha_dst' } },
]

describe('P5 platform-port matching', () => {
  it('keeps native ports, archived IDs, cross-platform collisions, shared ports, and relay ports distinct at formal server entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wrj-p5-port-')); roots.push(root)
    const entry = join(root, 'execution'), output = join(entry, 'nested'), eventPath = join(output, 'scenario_events.csv'), positionPath = join(output, 'position.csv'), resultDirectory = join(root, 'results')
    const draft = new ScenarioProjection().get('SCN-001').data
    await Promise.all([mkdir(output, { recursive: true }), mkdir(resultDirectory)])
    await Promise.all([
      writeFile(eventPath, eventCsv()),
      writeFile(positionPath, 'TIME,NAME,LON,LAT,ALT,SPEED,HEADING\n1,A,119,25,3000,100,0\n1,B,120,26,3000,100,0\n'),
    ])
    await writeFile(join(entry, 'mapping.json'), JSON.stringify({
      scenarioId: draft.config.scenario.id, revision: draft.revision, output: { resolvedDirectory: 'nested' }, devices,
    }))

    const [initial, replay, report] = await Promise.all([
      readInitialNodes(eventPath), readLocalReplay(eventPath, positionPath, true), readLocalReport(eventPath, positionPath),
    ])
    if (!report) throw new Error('report fixture missing')
    // A/B 同名端口不能合并成只按端口区分的设备状态。
    expect(initial.deviceEvents?.filter((event: { deviceId: string }) => event.deviceId === 'microwave_link').map((event: { platformId: string }) => event.platformId)).toEqual(['A', 'B', 'C', 'D'])
    expect(initial.connections).toEqual([expect.objectContaining({
      source: expect.objectContaining({ platformName: 'A', communicationName: 'microwave_link' }), target: expect.objectContaining({ platformName: 'C', communicationName: 'microwave_link' }),
    })])

    const results = new LocalMissionResults(resultDirectory)
    await results.capture(entry, draft, '2026-11-01T00:00:00Z', '2026-11-01T00:00:10Z')
    const stored = (await results.list())[0]!, snapshot = (await results.get(stored.resultId))!
    const deviceEvents = async (linkId: string) => (await results.filter(stored.resultId, snapshot.report.reportId, { linkId })).report.localEvidence?.deviceEvents ?? []

    // 只有一端的设备事件，作用于共享 A/microwave_link 的两条链路。
    expect((await deviceEvents('NEW-1')).some((event: { eventId: string }) => event.eventId === 'LOG-L16')).toBe(true)
    expect((await deviceEvents('NEW-2')).some((event: { eventId: string }) => event.eventId === 'LOG-L16')).toBe(true)
    // B 上的同名端口不属于 A 的事件。
    expect((await deviceEvents('NEW-OTHER')).some((event: { eventId: string }) => event.eventId === 'LOG-L16')).toBe(false)
    expect((await deviceEvents('NEW-OTHER')).some((event: { eventId: string }) => event.eventId === 'LOG-L17')).toBe(true)
    // 生成器 manifest 中的中继结构也要建立索引。
    expect((await deviceEvents('NEW-RELAY')).some((event: { eventId: string }) => event.eventId === 'LOG-L20')).toBe(true)
    // 归档编号保持不透明，按原样匹配旧 manifest 端点。
    expect((await deviceEvents('LEGACY')).some((event: { deviceId: string }) => event.deviceId === 'comm_legacy_alpha_src')).toBe(true)
    expect(snapshot.replay.initial.connections).toEqual(expect.arrayContaining([expect.objectContaining({
      source: expect.objectContaining({ communicationName: 'comm_legacy_alpha_src' }), target: expect.objectContaining({ communicationName: 'comm_legacy_alpha_dst' }), resolvedType: 'SAT',
    })]))
    // 两端都有的连接按精确端点对匹配，不会匹配到同样共享 A/microwave_link 的另一条链路。
    expect((await results.filter(stored.resultId, snapshot.report.reportId, { linkId: 'NEW-1' })).report.localEvidence?.connections).toHaveLength(1)
    expect((await results.filter(stored.resultId, snapshot.report.reportId, { linkId: 'NEW-2' })).report.localEvidence?.connections).toHaveLength(0)
    // 版本 1 的索引文件对按链路编码的旧编号仍然可用。
    const indexManifest = join(resultDirectory, `${stored.resultId}.report-index.json`)
    const indexPath = join(resultDirectory, `${stored.resultId}.report-index.ndjson`)
    const currentManifest = JSON.parse(await readFile(indexManifest, 'utf8')), currentIndex = await readFile(indexPath, 'utf8')
    const legacyIndex = [...currentIndex.split('\n').filter((line: string) => line && (() => { const row = JSON.parse(line) as { device?: string; sourceDeviceId?: string; targetDeviceId?: string }; return [row.device, row.sourceDeviceId, row.targetDeviceId].every(device => device === undefined || /^comm_.+_(?:src|dst)$/u.test(device)) })()), JSON.stringify({ time: 2.5, type: 'WEAPON_TURNED_ON', id: 'LEGACY-JAMMER', subject: 'A', device: 'prophet_jammer' })].join('\n') + '\n'
    await writeFile(indexPath, legacyIndex)
    await writeFile(indexManifest, JSON.stringify({ ...currentManifest, version: 1, rowCount: legacyIndex.trimEnd().split('\n').length, sha256: createHash('sha256').update(legacyIndex).digest('hex') }))
    await expect(results.filter(stored.resultId, snapshot.report.reportId, { linkId: 'LEGACY' })).resolves.toBeTruthy()
    // 版本 1 的新模板端口索引按“后写覆盖”匹配，因此明确判为不可用，
    // 而不是悄悄返回误导性的单链路筛选结果。
    await writeFile(indexPath, currentIndex)
    await writeFile(indexManifest, JSON.stringify({ ...currentManifest, version: 1 }))
    await expect(results.filter(stored.resultId, snapshot.report.reportId, { linkId: 'NEW-1' })).rejects.toThrow('FILTER_UNSUPPORTED')
    // 复现版本 1 的“后写覆盖”结果：NEW-1 已从所有共享端口的链路集合中消失。
    const collapsedIndex = currentIndex.split('\n').filter(Boolean).map((line: string) => {
      const row = JSON.parse(line) as { linkId?: string; linkIds?: string[] }
      if (row.linkIds) { row.linkId = row.linkIds.at(-1); delete row.linkIds }
      return JSON.stringify(row)
    }).join('\n') + '\n'
    await writeFile(indexPath, collapsedIndex)
    await writeFile(indexManifest, JSON.stringify({ ...currentManifest, version: 1, sha256: createHash('sha256').update(collapsedIndex).digest('hex') }))
    await expect(results.filter(stored.resultId, snapshot.report.reportId, { linkId: 'NEW-1' })).rejects.toThrow('FILTER_UNSUPPORTED')
    await expect(results.filter(stored.resultId, snapshot.report.reportId, {})).resolves.toBeTruthy()
  })

  it('classifies archived relay hops only from their exact ingress and egress manifest ports', () => {
    const log = parseAfsimEventLog([
      '! PLATFORM_ADDED,time<time>,event<string>,platform<string>,side<string>,type<string>,ps<double>,lat<lat>,lon<lon>',
      '! PLATFORM_INITIALIZED,time<time>,event<string>,platform<string>,side<string>,type<string>,lat<lat>,lon<lon>,alt<double>,heading<angle>,pitch<angle>,roll<angle>,ned_speed<double>',
      '! COMM_TURNED_ON,time<time>,event<string>,platform<string>,side<string>,type<string>,system<string>,system_type<string>',
      '! LINK_ADDED_TO_MANAGER,source_platform<string>,source_comm<string>,source_address<string>,destination_platform<string>,destination_comm<string>,destination_address<string>',
      ...['A', 'R', 'B'].map((platform, index) => `0,PLATFORM_ADDED,${platform},blue,AIR,`),
      ...['A', 'R', 'B'].map((platform, index) => `0,PLATFORM_INITIALIZED,${platform},blue,AIR,${25 + index},119,3000,0,0,0,100`),
      '0,COMM_TURNED_ON,A,blue,Comm,comm_relay_src,WSF_RADIO_TRANSCEIVER',
      '0,COMM_TURNED_ON,R,blue,Comm,comm_relay_ingress,WSF_RADIO_TRANSCEIVER',
      '0,COMM_TURNED_ON,R,blue,Comm,comm_relay_egress,WSF_RADIO_TRANSCEIVER',
      '0,COMM_TURNED_ON,B,blue,Comm,comm_relay_dst,WSF_RADIO_TRANSCEIVER',
      '1,LINK_ADDED_TO_MANAGER,A,comm_relay_src,0.1.0.1,R,comm_relay_ingress,0.1.0.2',
      '2,LINK_ADDED_TO_MANAGER,R,comm_relay_egress,0.1.0.3,B,comm_relay_dst,0.1.0.4',
    ].join('\n'))
    const connections = resolveManifestConnections(log, [{
      linkId: 'LEGACY-RELAY', linkType: 'SAT',
      source: { platformId: 'A', deviceId: 'comm_relay_src' }, target: { platformId: 'B', deviceId: 'comm_relay_dst' },
      relay: { platformId: 'R', ingressDeviceId: 'comm_relay_ingress', egressDeviceId: 'comm_relay_egress' },
    }])
    expect(connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ communicationName: 'comm_relay_src' }), target: expect.objectContaining({ communicationName: 'comm_relay_ingress' }), resolvedType: 'SAT' }),
      expect.objectContaining({ source: expect.objectContaining({ communicationName: 'comm_relay_egress' }), target: expect.objectContaining({ communicationName: 'comm_relay_dst' }), resolvedType: 'SAT' }),
    ]))
  })
})
