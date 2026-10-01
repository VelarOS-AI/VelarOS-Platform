import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { toTrajectory } from './atif.mjs'
import {
  createTraceArtifactWriter,
  decodeTraceArtifact,
  readInvocationBlobs,
} from './trace-artifact.mjs'

export async function snapshot(path, value) {
  const serialized = JSON.stringify(value, null, 2)
  await writeFile(`${path}.writing`, serialized)
  await rename(`${path}.writing`, path)
  return Buffer.byteLength(serialized)
}

// Progress is provisional: old asynchronous receipts can still change. The final
// export reconciles every page from authoritative runtime storage exactly once.
export function createTraceExporter({ trace, output, sessionId, instruction, identity, model }) {
  const sessions = new Map()
  const artifacts = createTraceArtifactWriter(output)
  const stats = { count: 0, totalMs: 0, maxMs: 0, bytesWritten: 0, finalSnapshots: 0 }
  const state = (id) => {
    if (!sessions.has(id)) sessions.set(id, new Map())
    return sessions.get(id)
  }
  const read = async (id, final) => {
    const known = state(id)
    const latest = Math.max(0, ...[...known.values()].map((turn) => turn.sequence))
    let after = final ? 0 : Math.max(0, latest - 1)
    const turns = []
    let branches = []
    do {
      const page = await trace({ sessionId: id, after, limit: 8, fullContent: true })
      turns.push(...page.turns)
      branches = page.branches
      after = page.nextAfter
    } while (after !== null)
    if (!final) {
      const refreshed = new Set(turns.map((turn) => turn.turnId))
      for (const turn of known.values()) {
        if (refreshed.has(turn.turnId)) continue
        if (turn.pending) {
          const page = await trace({
            sessionId: id,
            after: turn.sequence - 1,
            limit: 1,
            fullContent: true,
          })
          turns.push(...page.turns)
        }
      }
    } else known.clear()
    // Keep only cursors and unsettled identities between checkpoints. Historical
    // prompt bodies already live in runtime storage and the progress journal.
    for (const turn of turns)
      known.set(turn.turnId, {
        turnId: turn.turnId,
        sequence: turn.request.sequence,
        pending:
          turn.executions.some((execution) => ['running', 'unknown'].includes(execution.status)) ||
          turn.invocations.some((invocation) => invocation.summary.status === 'pending') ||
          turn.agents.some((agent) => ['running', 'waiting'].includes(agent.status)),
      })
    return { turns, branches }
  }
  return {
    stats,
    async export({ final = false, status, failure }) {
      const started = performance.now()
      const root = await read(sessionId, final)
      const branches = []
      for (const binding of root.branches)
        branches.push({ ...binding, turns: (await read(binding.sessionId, final)).turns })
      const value = { traces: root.turns, branches }
      const artifact = await artifacts.encode(
        final ? value : { schema: 1, rootSessionId: sessionId, provisional: true, ...value }
      )
      stats.bytesWritten += artifact.bytesWritten
      if (final) {
        stats.bytesWritten += await snapshot(join(output, 'traces.json'), artifact.value)
        stats.bytesWritten += await snapshot(
          join(output, 'trajectory.json'),
          toTrajectory({ sessionId, instruction, ...value, identity, model })
        )
        stats.finalSnapshots++
      } else {
        const line = JSON.stringify(artifact.value) + '\n'
        await appendFile(join(output, 'trace-progress.jsonl'), line)
        stats.bytesWritten += Buffer.byteLength(line)
      }
      const elapsed = performance.now() - started
      stats.count++
      stats.totalMs += elapsed
      stats.maxMs = Math.max(stats.maxMs, elapsed)
      await snapshot(join(output, 'status.json'), {
        status,
        failure,
        model,
        mainRequests: state(sessionId).size,
        branchRequests: root.branches.reduce(
          (sum, branch) => sum + state(branch.sessionId).size,
          0
        ),
        traceExport: stats,
        traceProgress: { path: 'trace-progress.jsonl', provisional: !final },
      })
    },
  }
}

// A killed append can leave one partial final line. Complete malformed records
// are errors, never silently discarded. This view must not supply final scores.
export function recoverTraceProgress(text, blobs = new Map()) {
  const records = text.split('\n')
  const incompleteTail = records.pop().length > 0
  const sessions = new Map()
  let branches = []
  let rootSessionId
  for (const line of records) {
    const page = decodeTraceArtifact(JSON.parse(line), blobs)
    if (page.schema !== 1 || page.provisional !== true) throw new Error('Unknown progress schema')
    if (!page.rootSessionId || (rootSessionId && rootSessionId !== page.rootSessionId))
      throw new Error('Progress root session changed')
    rootSessionId = page.rootSessionId
    branches = page.branches
    for (const turn of [...page.traces, ...branches.flatMap((branch) => branch.turns)]) {
      if (!sessions.has(turn.sessionId)) sessions.set(turn.sessionId, new Map())
      sessions.get(turn.sessionId).set(turn.turnId, turn)
    }
  }
  const turns = (id) =>
    [...(sessions.get(id)?.values() ?? [])].sort((a, b) => a.request.sequence - b.request.sequence)
  return {
    provisional: true,
    incompleteTail,
    traces: turns(rootSessionId),
    branches: branches.map((branch) => ({ ...branch, turns: turns(branch.sessionId) })),
  }
}

export async function readTraceProgress(path) {
  return recoverTraceProgress(
    await readFile(path, 'utf8'),
    await readInvocationBlobs(dirname(path), { allowIncompleteTail: true })
  )
}
