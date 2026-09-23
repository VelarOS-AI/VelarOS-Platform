/** 本帧会变的协议、阶段与恢复说明在最后一条消息末尾（系统提示在会话内不变）。 */
export function frameText(request) {
  return request.compiledPrompt ?? ''
}
/** 从真实请求读取本帧标记，测试不跨帧复用控制文本。 */
export function marker(request) {
  const value = frameText(request).match(/当前帧标记：(\S+)。普通/)
  if (!value) throw Error('missing frame marker')
  return value[1]
}
/** 构造文本协议完整程序段；字面量和裸源码由解析器测试覆盖。 */
export function turn(request, submission = {}, message = '') {
  const tag = marker(request)
  const blocks = Object.entries(submission)
    .filter(([, value]) => value != null)
    .map(
      ([kind, program]) => `${tag} ${kind}({format:"program"})\n${JSON.stringify(program)}\n${tag}`
    )
  return { type: 'text', text: [message, ...blocks].filter(Boolean).join('\n') }
}
/** 完成必须显式声明，Runtime 仍负责验收。 */
export async function* done(request, message = '') {
  yield { type: 'text', text: `${message}${message ? '\n' : ''}${marker(request)} done` }
  yield { type: 'finish', reason: 'stop' }
}

/** 旧行为回归按新分区读取同一语义字段；生产请求仅包含分区格式。 */
export function runtimeFrame(text) {
  const frame = JSON.parse(text)
  if (!frame.partitions) return frame
  const p = frame.partitions
  const results = p.recent.results.map((result) => {
    const raw = p.recent.history
      .map((message) => JSON.parse(message.content))
      .find(
        (item) =>
          item.origin === 'runtime-execution' && item.ref.id === result.ref && item.bodyIncluded
      )
    return { ...result, ...(raw ? { text: raw.text } : {}) }
  })
  return {
    id: frame.id,
    ...p.runtime,
    goals: p.task.goals,
    capsule: p.workspace.capsule,
    observation: p.observation,
    ...p.recent,
    results,
    workspace: p.workspace,
    memoryStatus: frame.memoryStatus,
  }
}

/** 按实际消息顺序观察正文，分区正文与有序历史由同一请求共同发送。 */
export function modelText(request) {
  return [...(request.history ?? [])]
    .map((item) => (typeof item.content === 'string' ? item.content : JSON.stringify(item.content)))
    .concat(request.compiledPrompt ?? '')
    .join('\n')
}
