// 用途：审计原生评测中的现成补丁访问，保留原始成绩并单独判定比较资格。
export function isSolutionPatchURL(value) {
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      /\/(?:commit|commits|pull|pulls)\/[^/]+\.(?:patch|diff)$/i.test(url.pathname)
    )
  } catch {
    return false
  }
}

const empty = () => ({ confirmedSolutionPatchAccess: false, requiresReview: false, findings: [] })

export function scriptPolicyAudit(pages) {
  const result = empty()
  const executions = new Map()
  for (const page of pages)
    for (const turn of page.turns)
      for (const script of turn.executions) {
        const prior = executions.get(script.executionId)
        if (!prior || script.calls.length > prior.calls.length)
          executions.set(script.executionId, script)
      }
  for (const script of executions.values())
    for (const call of script.calls) {
      if (call.module !== 'velaros:web' || call.operation !== 'read') continue
      let input, output
      try {
        input = JSON.parse(call.input)
      } catch {
        result.requiresReview = true
        result.findings.push({ operation: 'web.read', reason: 'unreadable_input' })
        continue
      }
      if (!isSolutionPatchURL(input.url)) continue
      try {
        output = JSON.parse(call.output)
      } catch {
        output = null
      }
      const deliveredChars = typeof output?.text === 'string' ? output.text.length : 0
      const confirmed = call.status === 'succeeded' && deliveredChars > 0
      result.confirmedSolutionPatchAccess ||= confirmed
      result.requiresReview ||= !confirmed
      result.findings.push({
        operation: 'web.read',
        url: input.url,
        status: call.status,
        deliveredChars,
        confirmed,
      })
    }
  return result
}

export function codexPolicyAudit(text) {
  const result = empty()
  for (const line of text.split('\n').filter(Boolean)) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type !== 'item.completed' || event.item?.type !== 'command_execution') continue
    const command = event.item.command ?? ''
    for (const url of command.match(/https?:\/\/[^\s'"<>]+/g) ?? []) {
      if (!isSolutionPatchURL(url)) continue
      result.requiresReview = true
      result.findings.push({ operation: 'command_execution', url, reason: 'review_delivery' })
    }
  }
  return result
}
