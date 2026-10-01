import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTraceExporter, readTraceProgress, recoverTraceProgress } from './trace-export.mjs'
import { toTrajectory } from './atif.mjs'
import { readInvocationBlobs, readTraceArtifact } from './trace-artifact.mjs'

test('progress is incremental, refreshes old pending work and reconciles final root and branch snapshots', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'harbor-trace-export-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  let count = 0
  let phase = 'running'
  const fetched = []
  const turn = (id, sequence) => ({
    sessionId: id,
    turnId: id + sequence,
    request: { sequence, body: '{}' },
    response: { body: 'x'.repeat(2000) },
    records: [],
    invocations: [],
    agents:
      sequence === 3 ? [{ sessionId: 'child', status: count < 12 ? 'waiting' : 'completed' }] : [],
    executions: sequence === 1 ? [{ status: phase }] : [],
    nextTurnId: sequence < count ? id + (sequence + 1) : null,
    snapshotVersion: count,
  })
  const binding = { sessionId: 'child' }
  const trace = async ({ sessionId, after, limit }) => {
    const all = Array.from({ length: sessionId === 'root' ? count : 1 }, (_, i) =>
      turn(sessionId, i + 1)
    )
    const turns = all.filter((item) => item.request.sequence > after).slice(0, limit)
    fetched.push(...turns.map((item) => item.turnId))
    return {
      turns,
      branches: [binding],
      nextAfter: all.some(
        (item) => item.request.sequence > (turns.at(-1)?.request.sequence ?? after)
      )
        ? turns.at(-1).request.sequence
        : null,
    }
  }
  const identity = { sourceCommit: 'fixture' }
  const exporter = createTraceExporter({
    trace,
    output,
    sessionId: 'root',
    instruction: 'fixture',
    model: 'controlled',
    identity,
  })
  for (count = 1; count <= 20; count++) {
    if (count === 8) phase = 'succeeded'
    await exporter.export({ status: 'running', failure: null })
  }
  count = 20
  assert(fetched.filter((id) => id === 'root1').length >= 8, 'pending receipts must be refreshed')
  assert(fetched.length < 100, 'completed historical requests must not be recopied each turn')
  const progress = await readFile(join(output, 'trace-progress.jsonl'), 'utf8')
  const recovered = recoverTraceProgress(progress + '{"schema":', await readInvocationBlobs(output))
  assert.equal(recovered.traces.length, 20)
  assert.equal(recovered.incompleteTail, true)
  assert.equal(recovered.traces[0].executions[0].status, 'succeeded')
  assert.equal(recovered.traces[2].agents[0].status, 'completed')
  assert.throws(() => recoverTraceProgress(progress + '{}\n'), /schema/)
  await assert.rejects(readFile(join(output, 'traces.json')), { code: 'ENOENT' })
  await exporter.export({ final: true, status: 'completed', failure: null })
  const expected = {
    traces: Array.from({ length: 20 }, (_, i) => turn('root', i + 1)),
    branches: [{ ...binding, turns: [turn('child', 1)] }],
  }
  assert.deepEqual(await readTraceArtifact(join(output, 'traces.json')), expected)
  assert.deepEqual(
    JSON.parse(await readFile(join(output, 'trajectory.json'), 'utf8')),
    JSON.parse(
      JSON.stringify(
        toTrajectory({
          sessionId: 'root',
          instruction: 'fixture',
          model: 'controlled',
          identity,
          ...expected,
        })
      )
    )
  )
  assert.equal(exporter.stats.finalSnapshots, 1)
  assert.equal(
    JSON.parse(await readFile(join(output, 'status.json'), 'utf8')).traceProgress.provisional,
    false
  )
})

test('versioned progress retains pending-to-settled evidence and deduplicates repeated full invocations', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'harbor-trace-versions-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  let status = 'pending'
  const turn = (sessionId) => ({
    sessionId,
    turnId: `${sessionId}:turn`,
    request: { sequence: 1, body: '{}' },
    response: { body: 'done' },
    records: [],
    agents: [],
    executions: [],
    invocations: [
      {
        id: 'shared-id',
        executionId: 'run',
        body: JSON.stringify({ receipt: { outcome: status, value: '证据'.repeat(10000) } }),
        truncated: false,
        summary: {
          moduleId: 'fixture',
          operation: 'read',
          status,
          input: '{}',
          output: '证据'.repeat(10000),
        },
      },
    ],
  })
  const exporter = createTraceExporter({
    output,
    sessionId: 'root',
    instruction: 'offline',
    identity: { sourceCommit: 'fixture' },
    model: 'fixture',
    trace: async ({ sessionId }) => ({
      turns: [turn(sessionId)],
      branches: [{ sessionId: 'child' }],
      nextAfter: null,
    }),
  })
  await exporter.export({ status: 'running' })
  status = 'succeeded'
  await exporter.export({ status: 'running' })
  const blobs = await readFile(join(output, 'trace-invocations.jsonl'), 'utf8')
  assert.equal(blobs.trimEnd().split('\n').length, 4)
  await exporter.export({ final: true, status: 'completed' })
  assert.equal(await readFile(join(output, 'trace-invocations.jsonl'), 'utf8'), blobs)
  const progress = await readTraceProgress(join(output, 'trace-progress.jsonl'))
  assert.equal(progress.traces[0].invocations[0].summary.status, 'succeeded')
  assert.equal(progress.branches[0].turns[0].invocations[0].summary.status, 'succeeded')
  assert.deepEqual(await readTraceArtifact(join(output, 'traces.json')), {
    traces: [turn('root')],
    branches: [{ sessionId: 'child', turns: [turn('child')] }],
  })
  await rm(join(output, 'trace-invocations.jsonl'))
  await assert.rejects(
    readTraceArtifact(join(output, 'traces.json')),
    /Missing trace invocation blob/
  )
  await assert.rejects(
    readTraceProgress(join(output, 'trace-progress.jsonl')),
    /Missing trace invocation blob/
  )
})
