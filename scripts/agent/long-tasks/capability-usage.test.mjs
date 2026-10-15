import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { createTraceArtifactWriter } from '../harbor/trace-artifact.mjs'
import { readCapabilityUsage, summarizeCapabilityUsage } from './capability-usage.mjs'

const invocation = (id, status = 'succeeded') => ({
  id,
  summary: { moduleId: 'velaros:agents', operation: 'start', status },
})

test('modern trace statistics process more history than the allowed heap and preserve final invocation states', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capability-memory-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const writer = createTraceArtifactWriter(directory)
  const refs = []
  for (let index = 0; index < 32; index++) {
    const data = {
      traces: [
        {
          ...turn('root', [invocation('same-id', index === 31 ? 'succeeded' : 'running')]),
          turnId: 'turn-' + index,
          request: { body: String(index) + 'x'.repeat(3 * 1024 ** 2) },
        },
      ],
    }
    refs.push((await writer.encode(data, { externalTurns: true })).value.data.traces[0])
  }
  const path = join(directory, 'traces.json')
  await writeFile(path, JSON.stringify({ artifactSchema: 3, data: { traces: refs } }))
  const script = `import {readCapabilityUsage} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'capability-usage.mjs')).href)}; console.log(JSON.stringify(await readCapabilityUsage(process.argv[1])));`
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ['--max-old-space-size=64', '--input-type=module', '-e', script, path],
      { encoding: 'utf8', timeout: 30000 }
    )
  )
  assert.equal(result.rootTurns, 32)
  assert.equal(result.uniqueCalls, 1)
  assert.equal(result.complete, true)
  assert.deepEqual(result.operations, [
    { moduleId: 'velaros:agents', operation: 'start', status: 'succeeded', count: 1 },
  ])
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
