// Vitest runs this file in Node, but the app typecheck deliberately omits Node globals.
// @ts-expect-error Node-only contract-boundary dependency.
import { createHash } from 'node:crypto'
// @ts-expect-error Node-only contract-boundary dependency.
import { readFileSync } from 'node:fs'
// @ts-expect-error Node-only contract-boundary dependency.
import { dirname, resolve } from 'node:path'
// @ts-expect-error Node-only contract-boundary dependency.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const directory = dirname(fileURLToPath(import.meta.url))
const sourcePath = resolve(directory, '../../frontend-technical-design-v1/contracts/domain-models.ts')
const contractPath = resolve(directory, '../../src/contracts/domain-models.ts')

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

describe('domain-models contract', () => {
  it('is byte-for-byte aligned with the authoritative frontend contract', () => {
    const source = readFileSync(sourcePath)
    const contract = readFileSync(contractPath)

    expect(sha256(contract)).toBe(sha256(source))

    const contractText = contract.toString('utf8')
    for (const exportedText of [
      'export type Iso8601Utc = string;',
      'export interface ScenarioConfig {',
      'export interface DeterministicFixtureSet {',
      'export interface ResetRequest { confirm: true; }',
      'export interface ResetResult {',
      'export type ApiResult<T> = ApiSuccess<T> | ApiFailure;',
      "export type WsTopic = 'simulation.frame' | 'runtime.state' | 'link.metric' | 'jammer.event' | 'switch.event';",
      'export interface RealtimeEnvelope<T> {',
      'export interface WsSubscribeRequest {',
      "export interface WsRejection { type: 'rejected'; code: 'LOOPBACK_ONLY' | 'TOPIC_FORBIDDEN' | 'INVALID_ENVELOPE' | 'SEQUENCE_GAP'; message: string; closeCode: 1008; }",
      'export const LINK_QUALITY_CSV_HEADER =',
      'export const EVENTS_CSV_HEADER =',
      'export const LINK_SWITCH_CSV_HEADER =',
    ]) {
      expect(contractText).toContain(exportedText)
    }
  })
})
