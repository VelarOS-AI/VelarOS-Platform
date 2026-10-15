// 终态摘要跟随当前完成复核；已恢复的协议错误仍保存在原始事件里。
export function runtimeEventStatus(current, event) {
  if (event.type === 'state')
    return {
      status: event.status,
      failure: event.status === 'completed' ? null : current.failure,
    }
  if (event.type === 'verification')
    return { ...current, failure: event.verified ? null : event.reason }
  if (event.type === 'error') return { ...current, failure: event.message }
  if (event.type === 'interaction')
    return { ...current, failure: 'Unattended task requested input' }
  return current
}
