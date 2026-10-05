import assert from 'node:assert/strict'

import { readTraceArtifact } from '../harbor/trace-artifact.mjs'

// Root and child sessions can reuse invocation IDs. Count the last recorded
// snapshot of each session-local invocation, never the number of blob versions.
export function summarizeCapabilityUsage(trace) {
  assert(Array.isArray(trace.traces), 'Missing root trace inventory')
  const turns = [...trace.traces]
  for (const branch of trace.branches ?? []) {
    assert(Array.isArray(branch.turns), 'Missing child trace inventory')
    turns.push(...branch.turns)
  }
  const calls = new Map()
  let traceGaps = 0
  for (const turn of turns) {
    assert(typeof turn.sessionId === 'string' && turn.sessionId, 'Missing trace session identity')
    assert(Array.isArray(turn.invocations), 'Missing invocation inventory')
    traceGaps += turn.gaps?.length ?? 0
    for (const invocation of turn.invocations) {
      assert(typeof invocation.id === 'string' && invocation.id, 'Missing invocation identity')
      calls.set(JSON.stringify([turn.sessionId, invocation.id]), invocation.summary)
    }
  }
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
    rootTurns: trace.traces.length,
    branchTurns: turns.length - trace.traces.length,
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
}

// The canonical reader verifies modern blob hashes/session references and also
// supports legacy inline artifacts. A missing artifact is unknown, not zero use.
export async function readCapabilityUsage(path) {
  let trace
  try {
    trace = await readTraceArtifact(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { available: false, complete: false, reason: 'trace-artifact-missing' }
  }
  return summarizeCapabilityUsage(trace)
}
