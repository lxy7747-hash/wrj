import { ref } from 'vue'
import type { JammerPowerUnit } from './jammer-settings'

const STORAGE_KEY = 'wrj.jammerPowerUnit'

function readStoredUnit(): JammerPowerUnit {
  if (typeof window === 'undefined') return 'W'
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'dBm' ? 'dBm' : 'W'
  } catch {
    return 'W'
  }
}

/** 干扰功率界面显示与编辑单位偏好（默认 W，可切换 dBm；合同与脚本始终保存为 W）。 */
export const jammerPowerUnit = ref<JammerPowerUnit>(readStoredUnit())

export function setJammerPowerUnit(unit: unknown): void {
  const next: JammerPowerUnit = unit === 'dBm' ? 'dBm' : 'W'
  jammerPowerUnit.value = next
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // 忽略无存储权限环境
  }
}
