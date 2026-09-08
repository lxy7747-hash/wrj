/** 文档前向指令、返向视频默认值；信息量统一为 MB，速率为 Mbps。 */
export const BUSINESS_DEFAULTS = {
  FORWARD: { informationType: '目标指令', volumeMb: 0.000256, frequencyHz: 1, minDataRateMbps: 0.0256 },
  REVERSE: { informationType: '视频', volumeMb: 2, frequencyHz: 30, minDataRateMbps: 2 },
}
