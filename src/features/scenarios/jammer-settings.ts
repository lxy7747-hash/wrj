import type { Jammer, JammerBandParam } from '../../contracts/domain-models'

/** 国际海里与合同米制字段的换算；jammer_param 的触发/释放半径按海里写出。 */
export const METERS_PER_NAUTICAL_MILE = 1852
export const METERS_PER_KILOMETER = 1000
/** 界面按 km 编辑探测、干扰与释放范围（1～100 km），合同单位仍为米。 */
export const JAMMER_RANGE_METERS = { min: METERS_PER_KILOMETER, max: 100 * METERS_PER_KILOMETER }
/** 释放范围缺省比干扰范围多 5 海里（文档默认触发 30、释放 35 海里）。 */
export const JAMMER_RELEASE_MARGIN_METERS = 5 * METERS_PER_NAUTICAL_MILE
/** V1.2 GNZB-15 / XNZB-10：界面按 dBm 档位设置，合同仍保存 W。 */
export const JAMMER_POWER_DBM = { min: -10, max: 30, step: 5 } as const
/** 场景配置的干扰设备弹框允许更高功率；执行侧仍沿用 JAMMER_POWER_DBM 的受控档位。 */
export const JAMMER_EDITOR_POWER_DBM = { min: -10, max: 65, step: 5 } as const
export const wattsToDbm = (watts: number): number => 10 * Math.log10(watts * 1000)
export const dbmToWatts = (dbm: number): number => 10 ** ((dbm - 30) / 10)
/** 与 LinkCalcManager 插件一致的干扰辐射功率（dBW）换算：功率(dBm) - 30 + 天线增益(dBi) - 发射损耗(dB)。 */
export function computeJammerEirpDbw(powerDbm: number, antennaGainDbi: number, txLossDb = 0): number {
  return Number((powerDbm - 30 + antennaGainDbi - txLossDb).toFixed(2))
}
function isPowerDbmInRange(value: unknown, range: { min: number; max: number; step: number }): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  const { min, max, step } = range
  const tier = min + Math.round((value - min) / step) * step
  return tier >= min && tier <= max && Math.abs(value - tier) <= 1e-6
}
export function isControlledPowerDbm(value: unknown): value is number {
  return isPowerDbmInRange(value, JAMMER_POWER_DBM)
}
export function isJammerEditorPowerDbm(value: unknown): value is number {
  return isPowerDbmInRange(value, JAMMER_EDITOR_POWER_DBM)
}
/** -10～+30 dBm、步长 5 dB 的 9 个受控功率档位（dBm），供界面下拉与校验复用。 */
export const JAMMER_POWER_DBM_TIERS: readonly number[] = Array.from(
  { length: Math.round((JAMMER_POWER_DBM.max - JAMMER_POWER_DBM.min) / JAMMER_POWER_DBM.step) + 1 },
  (_, index) => JAMMER_POWER_DBM.min + index * JAMMER_POWER_DBM.step,
)
/** 判定合同瓦数是否落在受控 dBm 档位上；控制命令前后端使用同一容差。 */
export function isControlledPowerWatts(watts: unknown): watts is number {
  if (typeof watts !== 'number' || !Number.isFinite(watts) || watts <= 0) return false
  return isControlledPowerDbm(wattsToDbm(watts))
}
export const BARRAGE_BANDWIDTH_OPTIONS_MHZ = [100, 200, 400] as const
export const SPOT_BANDWIDTH_MHZ = 5

/** V1.2 新增宽带干扰源默认参数：2.4 GHz、200 MHz、30 dBm（1 W），触发 30 海里、释放 35 海里。 */
export const JAMMER_DEFAULTS = {
  defaultPower: 1, frequency: 2400, bandwidth: 200,
  // 探测范围文档未给出，取与干扰范围相同的 30 海里，避免新建即出现“干扰范围大于探测范围”提示。
  detectionRange: 30 * METERS_PER_NAUTICAL_MILE,
  jammingRange: 30 * METERS_PER_NAUTICAL_MILE, releaseRange: 35 * METERS_PER_NAUTICAL_MILE,
}

/** 2026-11-06 模板新增字段；不改写旧场景中的已存值。 */
export const JAMMER_CALC_DEFAULTS = {
  radarFrequency: 2400, radarBandwidth: 1, radarPower: 1000,
  noiseFigureDb: 3, gtDbk: -12, eirpDbw: 40, antennaGainDbi: 0, txLossDb: 0, sweepDutyCycle: 0.1,
} as const
export type ResolvedJammerBandParam = Required<JammerBandParam>

/** 读取干扰武器频段列表；旧场景缺省时由顶层字段回退为完整单频段副本。 */
export function readJammerBands(
  jammer: Pick<Jammer, 'frequency' | 'bandwidth' | 'weaponBands'> & Partial<Pick<Jammer, 'type' | 'sweepDutyCycle'>>,
): ResolvedJammerBandParam[] {
  const fallbackMode: Jammer['type'] = jammer.type ?? 'BARRAGE'
  const fallbackSweepDuty = jammer.sweepDutyCycle ?? JAMMER_CALC_DEFAULTS.sweepDutyCycle
  const normalize = (band: JammerBandParam): ResolvedJammerBandParam => {
    const mode = band.mode ?? fallbackMode
    const spotBandwidthMHz = mode === 'SPOT'
      ? (band.spotBandwidthMHz ?? (Number.isFinite(band.bandwidth) && band.bandwidth > 0 ? band.bandwidth : SPOT_BANDWIDTH_MHZ))
      : (band.spotBandwidthMHz ?? 0)
    const sweepDutyCycle = mode === 'SWEEP'
      ? (band.sweepDutyCycle ?? fallbackSweepDuty)
      : (band.sweepDutyCycle ?? 0)
    return {
      frequency: band.frequency,
      bandwidth: band.bandwidth,
      mode,
      spotBandwidthMHz,
      sweepDutyCycle,
    }
  }
  if (Array.isArray(jammer.weaponBands) && jammer.weaponBands.length > 0) {
    return jammer.weaponBands.map(normalize)
  }
  return [normalize({ frequency: jammer.frequency, bandwidth: jammer.bandwidth })]
}

export function readJammerParameters(jammer: Jammer): Jammer & Record<keyof typeof JAMMER_CALC_DEFAULTS, number> & { weaponBands: ResolvedJammerBandParam[] } {
  return { ...JAMMER_CALC_DEFAULTS, ...jammer, weaponBands: readJammerBands(jammer) }
}

/** 读取释放范围；旧记录缺省时按干扰范围加 5 海里。 */
export function readJammerReleaseRange(jammer: { jammingRange: number; releaseRange?: number }): number {
  return jammer.releaseRange ?? jammer.jammingRange + JAMMER_RELEASE_MARGIN_METERS
}

/** 干扰节点为设备载体，不是被干扰目标；与宽带压制等干扰方式分开。 */
export function isJammerPlatformType(type: unknown): boolean {
  return type === 'GROUND_JAMMER_DETECTION_STATION' || type === 'AIRBORNE_JAMMER_PLATFORM'
}
