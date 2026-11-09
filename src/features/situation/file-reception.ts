import type { PlaybackFileSource, ScenarioId } from '../../contracts/domain-models'
import type { LocalReplaySnapshot } from '../replays/local-replay'
import type { InitialNodeSnapshot } from './initial-nodes'
import { selectFileCommunicationLinks } from './file-communication-links'

export function isPlaybackFileSource(value: unknown): value is PlaybackFileSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as PlaybackFileSource
  return Object.keys(value).length === 2 && Object.keys(value).every(key => ['eventSha256', 'positionSha256'].includes(key)) && [source.eventSha256, source.positionSha256]
    .every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))
}

export function playbackFileSource(snapshot: LocalReplaySnapshot): PlaybackFileSource {
  return { eventSha256: snapshot.initial.sha256, positionSha256: snapshot.sha256 }
}

export function fileReceptionScenarioId(source: PlaybackFileSource): ScenarioId {
  return `SCN-FILE-${source.eventSha256.slice(0, 16)}-${source.positionSha256.slice(0, 16)}`
}

/** 编号只在该文件快照内稳定，收发端口仍以原始记录为准。 */
export function fileReceptionLinks(snapshot: InitialNodeSnapshot, time = Infinity) {
  const all = selectFileCommunicationLinks(snapshot.connections ?? [], Infinity)
  const ids = new Map(all.map((link, index) => [link.id, `FILE-LINK-${index + 1}`]))
  return selectFileCommunicationLinks(snapshot.connections ?? [], time).map(link => ({ ...link, id: ids.get(link.id)! }))
}

export function fileReceptionMapping(snapshot: InitialNodeSnapshot) {
  const links = fileReceptionLinks(snapshot)
  return {
    manifest: { devices: links.flatMap(link => link.records.map(record => ({ linkId: link.id,
      source: { platformId: record.source.platformName, deviceId: record.source.communicationName },
      target: { platformId: record.target.platformName, deviceId: record.target.communicationName },
    }))) },
    bindings: Object.fromEntries(links.map(link => [link.id, {
      type: link.type, sourcePlatformId: link.sourcePlatformId, targetPlatformId: link.targetPlatformId, relayPlatformId: null,
    }])),
  }
}
