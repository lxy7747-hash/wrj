/** 国际海里与合同米制字段的换算；jammer_param 的触发/释放半径按海里写出。 */
export const METERS_PER_NAUTICAL_MILE = 1852
export const METERS_PER_KILOMETER = 1000
/** 界面按 km 编辑探测、干扰与释放范围（1～100 km），合同单位仍为米。 */
export const JAMMER_RANGE_METERS = { min: METERS_PER_KILOMETER, max: 100 * METERS_PER_KILOMETER }
/** 释放范围缺省比干扰范围多 5 海里（文档默认触发 30、释放 35 海里）。 */
export const JAMMER_RELEASE_MARGIN_METERS = 5 * METERS_PER_NAUTICAL_MILE
/** V1.2 GNZB-15 / XNZB-10：界面按 dBm 档位设置，合同仍保存 W。 */
export const JAMMER_POWER_DBM = { min: -10, max: 30, step: 5 } as const
export const wattsToDbm = (watts: number): number => 10 * Math.log10(watts * 1000)
export const dbmToWatts = (dbm: number): number => 10 ** ((dbm - 30) / 10)
export function isControlledPowerDbm(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  const { min, max, step } = JAMMER_POWER_DBM
  const tier = min + Math.round((value - min) / step) * step
  return tier >= min && tier <= max && Math.abs(value - tier) <= 1e-6
}
export const BARRAGE_BANDWIDTH_OPTIONS_MHZ = [100, 200, 400] as const
export const SPOT_BANDWIDTH_MHZ = 5

/** V1.2 新增宽带干扰源默认参数：2.4 GHz、200 MHz、30 dBm（1 W），触发 30 海里、释放 35 海里。 */
export const JAMMER_DEFAULTS = {
  defaultPower: 1, frequency: 2400, bandwidth: 200, triggerTimeS: 300,
  // 探测范围文档未给出，取与干扰范围相同的 30 海里，避免新建即出现“干扰范围大于探测范围”提示。
  detectionRange: 30 * METERS_PER_NAUTICAL_MILE,
  jammingRange: 30 * METERS_PER_NAUTICAL_MILE, releaseRange: 35 * METERS_PER_NAUTICAL_MILE,
}

/** 读取释放范围；旧记录缺省时按干扰范围加 5 海里。 */
export function readJammerReleaseRange(jammer: { jammingRange: number; releaseRange?: number }): number {
  return jammer.releaseRange ?? jammer.jammingRange + JAMMER_RELEASE_MARGIN_METERS
}

/** 干扰节点为设备载体，不是被干扰目标；与宽带压制等干扰方式分开。 */
export function isJammerPlatformType(type: unknown): boolean {
  return type === 'GROUND_JAMMER_DETECTION_STATION' || type === 'AIRBORNE_JAMMER_PLATFORM'
}
