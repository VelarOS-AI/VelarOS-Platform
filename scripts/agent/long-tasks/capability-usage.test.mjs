import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createTraceArtifactWriter } from '../harbor/trace-artifact.mjs'
import { readCapabilityUsage, summarizeCapabilityUsage } from './capability-usage.mjs'

const invocation = (id, status = 'succeeded') => ({
  id,
  summary: { moduleId: 'velaros:agents', operation: 'start', status },
})
const turn = (sessionId, invocations, gaps = []) => ({ sessionId, invocations, gaps })

test('capability counts include children, separate their identities and retain final outcomes', () => {
  const result = summarizeCapabilityUsage({
    traces: [
      turn('root', [invocation('same-id', 'running')]),
      turn('root', [invocation('same-id'), invocation('failed', 'failed')]),
      turn('root', [invocation('same-id')]),
    ],
    branches: [{ turns: [turn('child', [invocation('same-id', 'cancelled')])] }],
  })
  assert.equal(result.complete, true)
  assert.equal(result.uniqueCalls, 3)
  assert.equal(result.rootTurns, 3)
  assert.equal(result.branchTurns, 1)
  assert.deepEqual(
    result.operations.map(({ status, count }) => ({ status, count })),
    [
      { status: 'cancelled', count: 1 },
      { status: 'failed', count: 1 },
      { status: 'succeeded', count: 1 },
    ]
  )
})

test('partial traces cannot imply no capability usage and malformed identities are rejected', () => {
  const result = summarizeCapabilityUsage({
    traces: [turn('root', [{ id: 'missing-summary' }], ['missing invocation detail'])],
  })
  assert.equal(result.complete, false)
  assert.equal(result.uniqueCalls, 1)
  assert.equal(result.missingSummaries, 1)
  assert.equal(result.traceGaps, 1)
  assert.deepEqual(result.operations, [])
  assert.throws(() => summarizeCapabilityUsage({ traces: [turn('', [])] }), /session identity/)
  assert.throws(
    () => summarizeCapabilityUsage({ traces: [turn('root', [{ summary: {} }])] }),
    /invocation identity/
  )
  assert.throws(() => summarizeCapabilityUsage({ traces: [{ sessionId: 'root' }] }), /inventory/)
})

test('inline and deduplicated artifacts agree; missing and corrupted evidence stay distinct', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capability-usage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const trace = {
    traces: [turn('root', [invocation('same-id')]), turn('root', [invocation('same-id')])],
    branches: [{ turns: [turn('child', [invocation('same-id')])] }],
  }
  const legacy = join(directory, 'legacy.json'),
    modern = join(directory, 'modern.json')
  await writeFile(legacy, JSON.stringify(trace))
  const writer = createTraceArtifactWriter(directory)
  const encoded = await writer.encode(trace)
  await writeFile(modern, JSON.stringify(encoded.value))
  assert.deepEqual(await readCapabilityUsage(modern), await readCapabilityUsage(legacy))
  assert.equal((await readCapabilityUsage(modern)).uniqueCalls, 2)
  assert.deepEqual(await readCapabilityUsage(join(directory, 'absent.json')), {
    available: false,
    complete: false,
    reason: 'trace-artifact-missing',
  })
  const blobs = join(directory, 'trace-invocations.jsonl')
  const text = await readFile(blobs, 'utf8')
  await writeFile(blobs, text.replace('succeeded', 'cancelled'))
  await assert.rejects(readCapabilityUsage(modern), /hash mismatch/)
})
