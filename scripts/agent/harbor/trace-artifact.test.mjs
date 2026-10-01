import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createTraceArtifactWriter,
  decodeTraceArtifact,
  parseInvocationBlobs,
  readInvocationBlobs,
  readTraceArtifact,
} from './trace-artifact.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-trace-artifact-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const invocation = (status) => ({
  id: 'same-call',
  executionId: 'execute',
  chars: 10000,
  body: JSON.stringify({ stdout: '正文\n'.repeat(3000), artifactSchema: 2, sha256: 'user data' }),
  truncated: false,
  summary: { status, output: 'literal user data {"artifactSchema":2}', input: '{}' },
})
const turn = (sessionId, status) => ({ sessionId, invocations: [invocation(status)] })

test('entities preserve every field, content version and session; legacy artifacts remain readable', async (t) => {
  const directory = await fixture(t)
  const writer = createTraceArtifactWriter(directory)
  const data = {
    traces: [turn('root', 'pending'), turn('root', 'succeeded'), turn('root', 'succeeded')],
    branches: [{ sessionId: 'child', turns: [turn('child', 'succeeded')] }],
  }
  const encoded = await writer.encode(data)
  const blobText = await readFile(join(directory, 'trace-invocations.jsonl'), 'utf8')
  assert.equal(blobText.trimEnd().split('\n').length, 3)
  assert.equal(encoded.bytesWritten, Buffer.byteLength(blobText))
  const repeated = await writer.encode(data)
  assert.equal(repeated.bytesWritten, 0)
  assert.deepEqual(decodeTraceArtifact(encoded.value, parseInvocationBlobs(blobText)), data)
  assert.deepEqual(decodeTraceArtifact(data), data)
  const path = join(directory, 'traces.json')
  await writeFile(path, JSON.stringify(encoded.value))
  assert.deepEqual(await readTraceArtifact(path), data)
  await writeFile(join(directory, 'expected.json'), JSON.stringify(data))
  execFileSync(
    'python3',
    [
      '-c',
      `
import json, sys
from pathlib import Path
sys.path.insert(0, 'scripts/agent/harbor')
from trace_artifact import read_trace_artifact
root = Path(sys.argv[1])
assert read_trace_artifact(root / 'traces.json') == json.loads((root / 'expected.json').read_text())
`,
      directory,
    ],
    { cwd: process.cwd() }
  )
  const restarted = createTraceArtifactWriter(directory)
  assert.equal((await restarted.encode(data)).bytesWritten, 0)
})

test('missing, corrupt, foreign-session and incomplete blob evidence fails explicitly', async (t) => {
  const directory = await fixture(t)
  const encoded = await createTraceArtifactWriter(directory).encode({
    traces: [turn('root', 'pending')],
  })
  const text = await readFile(join(directory, 'trace-invocations.jsonl'), 'utf8')
  assert.throws(() => decodeTraceArtifact(encoded.value), /Missing trace invocation blob/)
  assert.throws(() => parseInvocationBlobs(text.replace('正文', 'other')), /hash mismatch/)
  assert.throws(() => parseInvocationBlobs(text + '{'), /Incomplete/)
  assert.throws(
    () => parseInvocationBlobs(text + '{}\n', { allowIncompleteTail: true }),
    /reference/
  )
  const blobs = parseInvocationBlobs(text + '{', { allowIncompleteTail: true })
  assert.deepEqual(decodeTraceArtifact(encoded.value, blobs), { traces: [turn('root', 'pending')] })
  const foreign = structuredClone(encoded.value)
  foreign.data.traces[0].sessionId = 'other'
  assert.throws(() => decodeTraceArtifact(foreign, blobs), /crosses sessions/)
  assert.throws(() => decodeTraceArtifact({ artifactSchema: 9 }), /schema/)
  await writeFile(join(directory, 'trace-invocations.jsonl'), text + '{')
  await assert.rejects(readInvocationBlobs(directory), /Incomplete/)
  assert.equal((await readInvocationBlobs(directory, { allowIncompleteTail: true })).size, 1)
})
