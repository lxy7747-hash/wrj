// @vitest-environment node
import { describe, expect, it } from 'vitest'
const { engineNameMap, toScenarioId, toScenarioEvent, toScenarioDevices, toScenarioCsvRow } = await import('../../server/local/' + 'engine-name-mapping.js')

describe('模板实例名回映射', () => {
  it('仅显式标记的新包启用；单次映射避免原编号与其他实例名冲突', () => {
    const platforms = [{ platformId: 'mission_uav_02', name: 'mission_uav_01' }, { platformId: 'AIR-02', name: 'mission_uav_02' }]
    expect(engineNameMap({ platforms })).toBeUndefined()
    expect(toScenarioId(undefined, 'mission_uav_01')).toBe('mission_uav_01')
    const names = engineNameMap({ platformNaming: 'TEMPLATE_INSTANCE', platforms })
    expect(toScenarioId(names, 'mission_uav_01')).toBe('mission_uav_02')
    expect(toScenarioId(names, 'mission_uav_02')).toBe('AIR-02')
    expect(toScenarioId(names, 'external_platform')).toBe('external_platform')
  })
  it.each([undefined, [], [{}], [{ platformId: '', name: 'uav' }], [{ platformId: 'A', name: ['uav'] }],
    [{ platformId: 'A', name: 'uav' }, { platformId: 'B', name: 'uav' }],
    [{ platformId: 'A', name: 'uav' }, { platformId: 'A', name: 'relay' }],
  ])('拒绝畸形或重复对照表 %#', platforms => {
    expect(() => engineNameMap({ platformNaming: 'TEMPLATE_INSTANCE', platforms })).toThrow(/映射|重复/)
  })
  it('平台字段、消息目的节点和设备端点转换一次；设备编号和原始文本保持原样', () => {
    const names = new Map([['uav', 'AIR-01'], ['rear', 'CMD-01']])
    const event = { id: 'LOG-L1', time: 0, type: 'MESSAGE_HOP', sourceLine: 1, endLine: 1, subject: 'uav',
      fields: { platform: 'uav', receiver: 'uav', destination: 'rear', Destination: 'rear', message_platform: 'rear', target_platform: 'rear', local_platform: 'uav', weapon_platform: 'rear', target: 'rear', system_platform: 'uav', system: 'uav' }, unparsedText: 'uav' }
    expect(toScenarioEvent(names, event)).toMatchObject({ subject: 'AIR-01', fields: { platform: 'AIR-01', receiver: 'AIR-01',
      destination: 'CMD-01', Destination: 'CMD-01', message_platform: 'CMD-01', target_platform: 'CMD-01', local_platform: 'AIR-01', weapon_platform: 'CMD-01', target: 'CMD-01', system_platform: 'uav', system: 'uav' }, unparsedText: 'uav' })
    const devices = [{ linkId: 'uav', source: { platformId: 'uav', deviceId: 'uav' }, target: { platformId: 'rear', deviceId: 'rear' },
      relay: { platformId: 'uav', deviceId: 'relay' }, relayPlatformId: 'rear' }]
    expect(toScenarioDevices(names, devices)).toEqual([{ linkId: 'uav', source: { platformId: 'AIR-01', deviceId: 'uav' },
      target: { platformId: 'CMD-01', deviceId: 'rear' }, relay: { platformId: 'AIR-01', deviceId: 'relay' }, relayPlatformId: 'CMD-01' }])
    expect(devices[0]!.source.platformId).toBe('uav')
    expect(toScenarioCsvRow(names, ['SourcePlatform', 'DestPlatform', 'Comment'], 'uav,rear,"a,b"')).toBe('AIR-01,CMD-01,"a,b"')
    expect(event.subject).toBe('uav')
  })
})
