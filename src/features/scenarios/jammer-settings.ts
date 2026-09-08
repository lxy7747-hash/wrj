/** 国际海里与合同米制字段的换算；仅用于输入展示，不修改存量数据。 */
export const METERS_PER_NAUTICAL_MILE = 1852
export const JAMMER_RANGE_METERS = { min: METERS_PER_NAUTICAL_MILE, max: 24 * METERS_PER_NAUTICAL_MILE }
/** 文档新增干扰源默认参数；中心频率优先读取场景数传链路。 */
export const JAMMER_DEFAULTS = { defaultPower: 100, bandwidth: 20, triggerTimeS: 300, detectionRange: JAMMER_RANGE_METERS.max }
