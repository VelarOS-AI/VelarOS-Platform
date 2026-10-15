import assert from 'node:assert/strict'

import { visitTraceArtifact } from '../harbor/trace-artifact.mjs'

function compactInvocation(invocation) {
  const summary = invocation.summary
  return {
    id: invocation.id,
    summary: summary && {
      moduleId: summary.moduleId,
      operation: summary.operation,
      status: summary.status,
    },
  }
}

// Root and child sessions can reuse invocation IDs. Count the last recorded
// snapshot of each session-local invocation, never the number of blob versions.
function capabilityCounter() {
  const calls = new Map()
  let traceGaps = 0
  let rootTurns = 0
  let branchTurns = 0
  return {
    add(turn, { branchIndex = null } = {}) {
      assert(typeof turn.sessionId === 'string' && turn.sessionId, 'Missing trace session identity')
      assert(Array.isArray(turn.invocations), 'Missing invocation inventory')
      if (branchIndex === null) rootTurns++
      else branchTurns++
      traceGaps += turn.gaps?.length ?? 0
      for (const invocation of turn.invocations) {
        assert(typeof invocation.id === 'string' && invocation.id, 'Missing invocation identity')
        calls.set(
          JSON.stringify([turn.sessionId, invocation.id]),
          compactInvocation(invocation).summary
        )
      }
    },
    result() {
      let missingSummaries = 0
      const counts = new Map()
      for (const summary of calls.values()) {
        if (
          !summary ||
          !['moduleId', 'operation', 'status'].every(
            (key) => typeof summary[key] === 'string' && summary[key]
          )
        ) {
          missingSummaries++
          continue
        }
        const key = JSON.stringify([summary.moduleId, summary.operation, summary.status])
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return {
        available: true,
        complete: traceGaps === 0 && missingSummaries === 0,
        rootTurns,
        branchTurns,
        uniqueCalls: calls.size,
        traceGaps,
        missingSummaries,
        operations: [...counts]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, count]) => {
            const [moduleId, operation, status] = JSON.parse(key)
            return { moduleId, operation, status, count }
          }),
      }
    },
  }
}

export function summarizeCapabilityUsage(trace) {
  assert(Array.isArray(trace.traces), 'Missing root trace inventory')
  const counter = capabilityCounter()
  for (const turn of trace.traces) counter.add(turn)
  for (const [branchIndex, branch] of (trace.branches ?? []).entries()) {
    assert(Array.isArray(branch.turns), 'Missing child trace inventory')
    for (const turn of branch.turns) counter.add(turn, { branchIndex })
  }
  return counter.result()
}

// The canonical reader verifies modern blob hashes/session references and also
// supports legacy inline artifacts. A missing artifact is unknown, not zero use.
export async function readCapabilityUsage(path) {
  const counter = capabilityCounter()
  try {
    await visitTraceArtifact(path, counter.add, { projectInvocation: compactInvocation })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { available: false, complete: false, reason: 'trace-artifact-missing' }
  }
  return counter.result()
}
