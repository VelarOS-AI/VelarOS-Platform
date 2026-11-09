// 截断或缺失的独立原文保持未知，不能把审计摘要当成完整事实。
export function traceBody(record) {
  return record && !record.truncated && record.body !== null ? JSON.parse(record.body) : null
}

// 只解析本次请求明确引用且发送前已经发布的帧，不按时间猜最近候选。
function requestFrame(trace) {
  const request = traceBody(trace.request),
    ref = request?.frameRef
  if (!ref || ref.sessionId !== trace.sessionId) return null
  const record = trace.records.find(
    (item) => item.ref.sessionId === ref.sessionId && item.ref.id === ref.id
  )
  if (!record || record.sequence >= trace.request.sequence) return null
  const frame = traceBody(record)
  return frame && record.title === `context:frame:${frame.frameId}` ? { record, frame } : null
}

// 帧审计只证明观察有正文进入请求；原始输出和来源仍从各自不可变记录读取。
// 它没有逐块展示正文，不能据此声称所有原始字段都完整可见。
export function observationEvidence(trace) {
  const current = requestFrame(trace)
  if (!current) return null
  const { frame } = current,
    observation = frame.observation
  if (
    !observation?.resultRef ||
    !frame.entries.some(
      (entry) =>
        entry.key === 'observation' &&
        entry.ref === observation.resultRef &&
        entry.bodyIncluded === true
    )
  )
    return null
  const record = trace.records.find(
    (item) => item.ref.sessionId === trace.sessionId && item.ref.id === observation.resultRef
  )
  if (!record || record.sequence >= current.record.sequence) return null
  const result = traceBody(record),
    collection = observation.freshness
  if (
    !result ||
    record.title !== `script:${result.executionId}:result` ||
    result.mode !== 'observe' ||
    result.checked !== true ||
    result.result.failed ||
    result.result.unsettled?.length ||
    !result.output ||
    result.output.issues.length ||
    !['collected', 'reused'].includes(collection?.status) ||
    collection.resultRef !== record.ref.id ||
    collection.executionId !== result.executionId
  )
    return null
  const source = trace.records.find(
    (item) => item.ref.sessionId === trace.sessionId && item.ref.id === collection.sourceRef
  )
  if (
    !source ||
    source.sequence >= record.sequence ||
    !record.sources.some(
      (ref) => ref.sessionId === source.ref.sessionId && ref.id === source.ref.id
    ) ||
    typeof traceBody(source)?.source !== 'string'
  )
    return null
  return {
    frameRef: current.record.ref,
    resultRef: record.ref,
    sourceRef: source.ref,
    executionId: result.executionId,
    outputs: result.output.blocks.map((block) => block.value),
  }
}

// 捕获身份、文件版本须同时出现在同一次 observe 的成功快照回执和独立 output 原文中。
export function observedFiles(trace) {
  const observation = observationEvidence(trace)
  if (!observation) return []
  const { outputs, ...provenance } = observation
  return trace.invocations.flatMap((record) => {
    const call = traceBody(record)
    if (
      !call ||
      call.prepared.sessionId !== trace.sessionId ||
      call.prepared.executionId !== observation.executionId ||
      call.prepared.mode !== 'observe' ||
      call.prepared.binding.moduleId !== 'velaros:project' ||
      call.prepared.operation !== 'snapshot' ||
      call.receipt?.outcome !== 'succeeded' ||
      call.receipt.value?.complete !== true
    )
      return []
    const capture = call.receipt.value,
      captures = outputs.filter(
        (value) =>
          value?.complete === true &&
          Array.isArray(value.value?.files) &&
          value.providerId === capture.providerId &&
          value.root === capture.root &&
          value.fingerprint === capture.fingerprint &&
          value.checkedAt === capture.checkedAt
      )
    return capture.value.files.flatMap((file) =>
      captures.some((output) =>
        output.value.files.some(
          (item) =>
            item?.path === file.path &&
            item.revision === file.revision &&
            item.startLine === file.startLine &&
            item.text === file.text
        )
      )
        ? [
            {
              file,
              invocationId: call.prepared.id,
              capture: {
                providerId: capture.providerId,
                root: capture.root,
                fingerprint: capture.fingerprint,
                checkedAt: capture.checkedAt,
              },
              ...provenance,
            },
          ]
        : []
    )
  })
}
