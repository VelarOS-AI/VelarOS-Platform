/** 本帧会变的协议、阶段与恢复说明在最后一条消息末尾（系统提示在会话内不变）。 */
export function frameText(request) {
  return request.compiledPrompt ?? ''
}
/** 从真实请求读取本帧标记，测试不跨帧复用控制文本。 */
export function marker(request) {
  const value = [...frameText(request).matchAll(/当前帧标记：(@@\w+)。/g)].at(-1)
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

/** 从真实历史中按宿主段标识读取底座，不依赖用户输入的条数。 */
export function baseText(request) {
  return (
    request.history?.find(
      (message) =>
        typeof message.content === 'string' && message.content.startsWith('Runtime 段底座（')
    )?.content ?? ''
  )
}

/** 段底座里的笔记卡片元数据；正文在卡片的下一行。 */
export function baseNotes(request) {
  const base = baseText(request)
  return base.split('\n').flatMap((line) => {
    if (!line.startsWith('{"key":')) return []
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/**
 * 请求里的段内历史条目：首行是元数据的消息解析成对象，结果正文取「当次输出」之后的部分；段底座这类非条目消息跳过。
 */
export function historyEntries(request) {
  const entries = []
  for (const message of request.history ?? []) {
    if (typeof message.content !== 'string' || !message.content.startsWith('{')) continue
    const newline = message.content.indexOf('\n')
    let meta
    try {
      meta = JSON.parse(newline < 0 ? message.content : message.content.slice(0, newline))
    } catch {
      continue
    }
    const body = newline < 0 ? '' : message.content.slice(newline + 1)
    const marker = '当次输出：\n'
    const sourceMarker = '当次源码：\n'
    const output = body.indexOf(marker)
    entries.push({
      role: message.role,
      ...meta,
      source: body.startsWith(sourceMarker)
        ? body.slice(sourceMarker.length, output < 0 ? undefined : output - 1)
        : undefined,
      text: output < 0 ? body : body.slice(output + marker.length),
    })
  }
  return entries
}

/**
 * 旧行为回归按新分区读取同一语义字段；生产请求仅包含分区格式。
 * 传整个请求时，段内历史里的结果正文按引用并回 results[].text。
 */
export function runtimeFrame(input) {
  const request = typeof input === 'string' ? undefined : input
  const text = request
    ? request.materials.findLast((item) => item.origin === 'runtime-view').text
    : input
  const frame = JSON.parse(text)
  if (!frame.partitions) return frame
  const p = frame.partitions
  const bodies = new Map(
    (request ? historyEntries(request) : [])
      .filter((item) => item.origin === 'runtime-execution' && item.bodyIncluded)
      .map((item) => [item.ref.id, item])
  )
  const results = p.recent.results.map((result) => {
    const entry = bodies.get(result.ref)
    if (!entry) return result
    return { ...result, text: entry.text, source: entry.source ?? result.source }
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
