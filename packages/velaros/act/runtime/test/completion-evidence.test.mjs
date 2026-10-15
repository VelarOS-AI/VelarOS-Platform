import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { VelarCompletionEvidenceModule } from '../../../dist/act/runtime/contract/surface.js'
import { CompletionEvidence } from '../../../dist/act/runtime/impl/CompletionEvidence.js'
import {
  completionEvidenceInput,
  completionEvidencePage,
  completionEvidenceTool,
  completionEvidenceTrim,
} from '../../../dist/act/runtime/utils/completion-evidence.js'

const hash = (text) => createHash('sha256').update(text).digest('hex')

test('read ranges preserve Unicode, continuous offsets, full hashes and byte limits', () => {
  const text = '前🙂中🙂后'
  for (let offset = 0; offset <= text.length; offset++) {
    const page = completionEvidencePage(
      text,
      hash(text),
      { kind: 'read', identity: 'file:x', offset, limit: 1 },
      4
    )
    for (const fragment of page.fragments) {
      assert.equal(
        text.slice(fragment.offset, fragment.offset + fragment.text.length),
        fragment.text
      )
      assert(!fragment.text.includes('\ufffd'))
      assert(Buffer.byteLength(fragment.text) <= 4)
      assert.equal(fragment.sha256, hash(text))
    }
    if (offset < text.length) assert(page.fragments.length > 0)
  }
})

test('literal find reports complete matches and continuation; it never runs a pattern as code', () => {
  const text = `a.* literal ${'gap '.repeat(100)}a.* literal final`
  const first = completionEvidencePage(
    text,
    hash(text),
    { kind: 'find', identity: 'file:x', literal: 'a.*', limit: 1 },
    1000
  )
  assert.equal(first.fragments.length, 1)
  assert(first.nextOffset > 0)
  const second = completionEvidencePage(
    text,
    hash(text),
    { ...first.query, offset: first.nextOffset },
    1000
  )
  assert.equal(second.fragments.length, 1)
  assert.equal(second.nextOffset, null)
  assert.equal(
    completionEvidencePage(
      text,
      hash(text),
      { kind: 'find', identity: 'file:x', literal: 'no match' },
      1000
    ).fragments.length,
    0
  )
})

test('input protocol rejects execution fields, unbounded queries and invalid offsets', () => {
  for (const query of [
    { kind: 'exec', identity: 'file:x', code: 'danger' },
    { kind: 'read', identity: 'file:x', offset: -1, limit: 10 },
    { kind: 'read', identity: 'file:x', offset: 0, limit: 32001 },
    { kind: 'find', identity: 'file:x', literal: '' },
    { kind: 'find', identity: 'file:x', literal: 'x', command: 'publish' },
  ])
    assert.throws(() => completionEvidenceInput({ queries: [query] }), /证据/u)
  assert.throws(
    () =>
      completionEvidenceInput({
        queries: Array(17).fill({ kind: 'read', identity: 'file:x', offset: 0, limit: 10 }),
      }),
    /证据/u
  )
  const tool = completionEvidenceTool(
    VelarCompletionEvidenceModule.operations.retrieve.input,
    VelarCompletionEvidenceModule.operations.retrieve.summary
  )
  assert.equal(tool.name, 'retrieve_evidence')
  assert.equal(tool.schema.type, 'object')
  assert.deepEqual(tool.schema.required, ['queries'])
})

test('compiler trimming cannot fabricate or join discontiguous evidence', () => {
  const text = `🙂${'body '.repeat(100)}`
  const page = completionEvidencePage(
    text,
    hash(text),
    { kind: 'read', identity: 'file:x', offset: 0, limit: 100 },
    400
  )
  const batch = completionEvidenceTrim(
    { pages: [page], bytes: 100, remainingBytes: 1000, remainingQueries: 10 },
    9
  )
  assert(batch.bytes <= 9)
  const fragment = batch.pages[0].fragments[0]
  assert.equal(text.slice(0, fragment.text.length), fragment.text)
  assert.equal(fragment.omitted, true)
  assert.equal(batch.pages[0].nextOffset, fragment.text.length)
  assert(batch.pages[0].issue)
})

function evidenceSource(text, overrides = {}) {
  const identity = 'file:authorized'
  const fingerprint = {
    status: 'versioned',
    providerId: 'test',
    token: 'version-1',
    authorization: 'workspace',
    artifacts: [{ identity, contentHash: hash(text), revision: '1' }],
  }
  const metadata = { bytes: Buffer.byteLength(text), sha256: hash(text) }
  let reads = 0
  const evidence = new CompletionEvidence({
    snapshot: {
      fingerprint,
      materials: [{ identity, text: JSON.stringify(metadata), metadata }],
      issues: [],
    },
    artifacts: {
      read: async () => {
        reads++
        return { fingerprint, materials: [{ identity, text }], issues: [] }
      },
    },
    executions: [],
    storage: {},
    assertCurrent: async () => {},
    ...overrides,
  })
  return { evidence, identity, reads: () => reads }
}

test('evidence selection enforces shared query and byte budgets and never reads unlisted identities', async () => {
  const f = evidenceSource('body '.repeat(10000))
  const signal = new AbortController().signal
  const escaped = await f.evidence.retrieve(
    { queries: [{ kind: 'read', identity: 'file:../secret', offset: 0, limit: 20 }] },
    signal
  )
  assert.match(escaped.pages[0].issue, /PERMISSION/u)
  assert.equal(f.reads(), 0)
  for (let i = 0; i < 3; i++) {
    const batch = await f.evidence.retrieve(
      { queries: Array(16).fill({ kind: 'read', identity: f.identity, offset: 0, limit: 32000 }) },
      signal
    )
    assert(batch.bytes <= 32768)
    assert(batch.remainingBytes >= 0)
  }
  await f.evidence.retrieve(
    { queries: Array(15).fill({ kind: 'read', identity: f.identity, offset: 0, limit: 32000 }) },
    signal
  )
  await assert.rejects(
    f.evidence.retrieve(
      { queries: [{ kind: 'read', identity: f.identity, offset: 0, limit: 1 }] },
      signal
    ),
    /次数/u
  )
  assert.equal(f.reads(), 1)
})

test('late host reads cannot return evidence after parent cancellation', async () => {
  const cancel = new AbortController()
  const f = evidenceSource('source', {
    artifacts: {
      read: async () => {
        cancel.abort(new Error('parent cancelled'))
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { materials: [{ identity: 'file:authorized', text: 'late text' }] }
      },
    },
  })
  await assert.rejects(
    f.evidence.retrieve(
      { queries: [{ kind: 'read', identity: f.identity, offset: 0, limit: 10 }] },
      cancel.signal
    ),
    /parent cancelled/u
  )
})

test('a matching generation cannot legitimize a mismatched complete content hash', async () => {
  const text = 'original'
  const fingerprint = {
    status: 'versioned',
    providerId: 'test',
    token: 'version-1',
    authorization: 'workspace',
    artifacts: [{ identity: 'file:authorized', contentHash: hash(text), revision: '1' }],
  }
  const f = evidenceSource(text, {
    artifacts: {
      read: async () => ({
        fingerprint,
        materials: [{ identity: 'file:authorized', text: 'forged' }],
        issues: [],
      }),
    },
  })
  await assert.rejects(
    f.evidence.retrieve(
      { queries: [{ kind: 'read', identity: f.identity, offset: 0, limit: 10 }] },
      new AbortController().signal
    ),
    /哈希/u
  )
})
