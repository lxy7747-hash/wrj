/** 国际海里与合同米制字段的换算；jammer_param 的触发/释放半径按海里写出。 */
export const METERS_PER_NAUTICAL_MILE = 1852
export const METERS_PER_KILOMETER = 1000
/** 界面按 km 编辑探测、干扰与释放范围（1～100 km），合同单位仍为米。 */
export const JAMMER_RANGE_METERS = { min: METERS_PER_KILOMETER, max: 100 * METERS_PER_KILOMETER }
/** 释放范围缺省比干扰范围多 5 海里（文档默认触发 30、释放 35 海里）。 */
export const JAMMER_RELEASE_MARGIN_METERS = 5 * METERS_PER_NAUTICAL_MILE
/** 《与前端字段确认说明》新增干扰源默认参数：2.4 GHz、50 MHz、200 W，触发 30 海里、释放 35 海里。 */
export const JAMMER_DEFAULTS = {
  defaultPower: 200, frequency: 2400, bandwidth: 50, triggerTimeS: 300,
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
