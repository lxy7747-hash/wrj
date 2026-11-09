import type { EngineControlAction, EngineControlState } from '../../contracts/domain-models'

export function engineControlAction(command: string): EngineControlAction | undefined {
  if (command === 'PAUSE') return 'pause'
  if (command === 'RESUME') return 'resume'
  if (command === 'STOP') return 'stop'
  return undefined
}

export function isEngineControlState(value: unknown): value is EngineControlState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as EngineControlState
  return Object.keys(value).length === 3 && Object.keys(value).every(key => ['connected', 'action', 'delivery'].includes(key))
    && typeof state.connected === 'boolean'
    && (state.delivery === 'IDLE' ? state.action === null
      : ['SENDING', 'SENT', 'UNKNOWN'].includes(state.delivery) && ['pause', 'resume', 'stop'].includes(state.action!))
}

/** 只允许用户明确发起后续动作；无回执时不自动重发，也不把发送状态当作实际运行状态。 */
export function canSendEngineControl(state: EngineControlState, action: EngineControlAction): boolean {
  if (!state.connected || state.delivery === 'SENDING' || state.delivery === 'UNKNOWN' || state.action === 'stop') return false
  return action === 'stop' || (action === 'resume' ? state.action === 'pause' : state.action !== 'pause')
}

export function engineControlMessage(state: EngineControlState): string {
  const action = state.action ? { pause: '暂停', resume: '恢复', stop: '停止' }[state.action] : ''
  const connection = state.connected ? '' : '引擎 WebSocket 未连接。'
  if (state.delivery === 'IDLE') return `${connection}WebSocket 控制回执尚未接入，发送后需核实引擎实际状态。`
  if (state.delivery === 'SENDING') return `正在发送${action}命令，尚未确认引擎执行。`
  if (state.delivery === 'UNKNOWN') return `${connection}${action}命令发送结果不确定，请核实引擎；不会自动重发，配置保持锁定。`
  return `${connection}${action}命令已发送，执行结果待确认；回执尚未接入，配置保持锁定。`
}

export function stoppedReceptionMessage(state?: EngineControlState): string {
  const delivery = state?.action === 'stop'
    ? state.delivery === 'SENT' ? '停止命令已发送，执行结果待确认' : '停止命令发送结果不确定'
    : '停止命令未发送，连接不可用或前次命令结果不确定'
  return `本地播放已停止，数据已保存、配置已解锁；${delivery}，发送方状态未确认。`
}
