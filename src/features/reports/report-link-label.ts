import { LINK_TYPE_LABELS } from '../situation/situation-model'

const PREFIX_LINK_TYPES: Record<string, keyof typeof LINK_TYPE_LABELS> = {
  c: 'DATALINK', l: 'DATALINK', fiber: 'FIBER', sat: 'SAT', mw: 'MICROWAVE', microwave: 'MICROWAVE', laser: 'LASER',
}

function endpointLabel(token: string): string {
  if (token === 'command') return '指挥车'
  if (token === 'relay') return '中继节点'
  const uav = /^(mission_uav_|uav_?)(\d+)$/.exec(token)
  return uav ? `${uav[1] === 'mission_uav_' ? '任务无人机' : '无人机'} ${uav[2]}` : ''
}

/** 旧报表只有归档编号时，按已知命名约定显示中文，并为未识别的编号保留稳定序号。 */
export function reportLinkLabel(
  id: string,
  index: number | null,
  recordedType?: string,
  route?: readonly [string, string],
): string {
  const [, medium = '', direction, suffix = ''] = /^(c|l|fiber|sat|mw|microwave|laser)(?:_(forward|return|reverse))?(?:_(.+))?$/.exec(id.toLowerCase()) ?? []
  const type = recordedType && Object.hasOwn(LINK_TYPE_LABELS, recordedType)
    ? recordedType as keyof typeof LINK_TYPE_LABELS : PREFIX_LINK_TYPES[medium]
  const typeLabel = type ? LINK_TYPE_LABELS[type] : '链路'
  const name = type === 'DATALINK' && (medium === 'c' || medium === 'l') ? `${medium.toUpperCase()} 波段数传链路` : typeLabel
  const directionLabel = direction === 'forward' ? '前向' : direction ? '返向' : ''
  const endpoints = /^(command|relay|mission_uav_\d+|uav_?\d+)(?:_(command|relay|mission_uav_\d+|uav_?\d+))?$/.exec(suffix)
  const objectLabel = endpoints?.slice(1).filter(Boolean).map(endpointLabel).join('与')
  const routeLabel = route?.every(endpoint => endpoint !== '暂无数据' && /\p{Script=Han}/u.test(endpoint))
    ? route.join(' → ') : ''
  const title = directionLabel || objectLabel || index === null ? name : `${name} ${index + 1}`
  return [title, directionLabel, routeLabel || objectLabel].filter(Boolean).join(' · ')
}
