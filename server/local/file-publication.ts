import { rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

/** Windows 短暂文件占用时只重试原子发布，不改写数据或提前切换指针。 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await delay(100 * 2 ** attempt)
    }
  }
}
