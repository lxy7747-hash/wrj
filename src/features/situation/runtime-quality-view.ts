import type { RuntimeLinkQuality } from '../data-exchange/runtime-link-quality'
import type { RuntimeQualityBinding, RuntimeQualitySnapshot } from '../../stores/runtime-quality'
import type { RuntimeLinkStatus } from '../data-exchange/runtime-link-decisions'

export const RUNTIME_STATUS_LABELS = { UNKNOWN: '待判定', UP: '正常', DEGRADED: '劣化', DOWN: '中断' } as const

const DECISION_REASONS: Record<string, string> = {
  GXB_OR_BER_MISSING: '缺少 GXB 或 BER 测量', RECEIVED_POWER_MISSING: '缺少接收功率测量',
  FAILURE_THRESHOLD_REACHED: '达到失效门限', AVAILABLE: '满足可用性门限',
  AVAILABILITY_THRESHOLD_NOT_MET: '未满足可用性门限', STABILITY_PENDING: '等待连续稳定帧',
  LINK_DISABLED: '链路已停用', SPATIAL_ISOLATION_NOT_MET: '未满足空域隔离门限',
  QUALITY_STATUS_MISSING: '缺少质量判定', INTERFERENCE_POWER_MISSING: '缺少接收干扰功率测量',
  CURRENT_ROUTE_RETAINED: '保持当前优选链路', NO_ELIGIBLE_CANDIDATE: '没有符合条件的候选链路',
  STABLE_CANDIDATE_SELECTED: '连续稳定候选通过', CURRENT_ROUTE_UNAVAILABLE: '原优选链路已不可用',
  QUALITY_IMPROVEMENT_THRESHOLD_MET: '达到质量改善门限', QUALITY_IMPROVEMENT_NOT_MET: '未达到质量改善门限',
  COOLDOWN_ACTIVE: '仍处于切换冷却窗口', INTERFERENCE: '受干扰触发切换', LINK_DOWN: '原链路中断触发切换',
  MEASUREMENT_MISSING: '本帧未提供该链路的测量', UP_PENDING: '等待恢复状态连续稳定',
  DEGRADED_PENDING: '等待劣化状态连续稳定', DOWN_PENDING: '等待中断状态连续稳定',
}

export function runtimeDecisionReason(reason: string): string { return DECISION_REASONS[reason] ?? reason }

export interface RuntimeLinkQualityView {
  linkId: string
  sourceName: string
  destinationName: string
  frameId: number
  simulationTime: number
  ageMs: number | null
  measurement: RuntimeLinkQuality
  assessment?: RuntimeLinkStatus
}

/** 连接显式绑定、已校验快照及同帧本机判定，不改写源测量。 */
export function selectRuntimeQualityViews(
  snapshot: RuntimeQualitySnapshot | null,
  bindings: readonly RuntimeQualityBinding[],
  links: readonly { linkId: string; sourceName: string; destinationName: string }[],
  currentTime: number,
  statuses?: ReadonlyMap<string, RuntimeLinkStatus>,
): Map<string, RuntimeLinkQualityView> {
  const views = new Map<string, RuntimeLinkQualityView>()
  if (!snapshot) return views
  for (const link of links) {
    const binding = bindings.find(item => item.linkId === link.linkId)
    // Canonical file records identify a configured link directly and intentionally
    // omit physical engine ports.  Native records remain strict full bindings.
    const measurement = snapshot.source === 'FILE_IMPORT'
      ? snapshot.data.links.find(item => item.linkId === link.linkId)
      : binding === undefined ? undefined : snapshot.data.links.find(item => item.linkId === binding.sourceLinkId
        && item.sourcePlatformId === binding.sourcePlatformId && item.destinationPlatformId === binding.destinationPlatformId
        && item.sourcePortId === binding.sourcePortId && item.destinationPortId === binding.destinationPortId)
    if (measurement) {
      // UI 运行时钟可能落后于反馈；此时年龄未知，不能冒充0毫秒的新鲜测量。
      const ageMs = (currentTime - snapshot.simulationTime) * 1000
      const assessment = statuses?.get(link.linkId)
      views.set(link.linkId, {
        linkId: link.linkId, sourceName: link.sourceName, destinationName: link.destinationName,
        frameId: snapshot.frameId, simulationTime: snapshot.simulationTime,
        ageMs: Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : null, measurement,
        ...(assessment?.linkId === link.linkId && assessment.frameId === snapshot.frameId && assessment.simulationTime === snapshot.simulationTime ? { assessment } : {}),
      })
    }
  }
  return views
}
