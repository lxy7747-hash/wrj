import { lstatSync, readFileSync } from 'node:fs'
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { MissionSafetyStatus } from '../simulations/mission-execution.js'

interface MissionGuardRecord {
  runId: string
  scenarioId: string
  revision: number
  pid?: number
  startedAt?: string
  runDirectory?: string
}

const BLOCKED = '上次真实 Mission 运行尚未确认结束；请管理员核实进程并解除未结清记录。'

/** 独占目录先于 spawn 创建；即使记录写到一半崩溃，目录本身也阻止再次启动。 */
export class MissionGuard {
  private readonly marker: string

  constructor(directory: string) { this.marker = join(directory, '.mission-active') }

  status(): MissionSafetyStatus | null {
    try {
      const directory = lstatSync(this.marker)
      if (!directory.isDirectory() || directory.isSymbolicLink()) return { message: BLOCKED }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return { message: BLOCKED }
    }
    try {
      const path = join(this.marker, 'record.json')
      const file = lstatSync(path)
      if (!file.isFile() || file.isSymbolicLink()) return { message: BLOCKED }
      const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof record !== 'object' || record === null || Array.isArray(record)) return { message: BLOCKED }
      const value = record as Partial<MissionGuardRecord>
      if (typeof value.runId !== 'string' || !value.runId
        || typeof value.scenarioId !== 'string' || !value.scenarioId
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return { message: BLOCKED }
      return { scenarioId: value.scenarioId, message: BLOCKED }
    } catch { return { message: BLOCKED } }
  }

  async claim(directory: string, record: MissionGuardRecord): Promise<void> {
    await mkdir(directory, { recursive: true })
    await mkdir(this.marker)
    await this.write(record)
  }

  async spawned(record: MissionGuardRecord): Promise<void> { await this.write(record) }

  private async write(record: MissionGuardRecord): Promise<void> {
    const pending = join(this.marker, 'record.pending')
    const handle = await open(pending, 'wx')
    try {
      await handle.writeFile(JSON.stringify(record))
      await handle.sync()
    } finally { await handle.close() }
    await rename(pending, join(this.marker, 'record.json'))
  }

  async clearAfterClose(): Promise<void> {
    try { await unlink(join(this.marker, 'record.pending')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await unlink(join(this.marker, 'record.json'))
    await rmdir(this.marker)
  }
}
