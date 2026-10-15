import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'
import {
  completionFileRequested,
  completionInvestigations,
  completionLocationRequirements,
  completionRequirements,
  completionUnresolvedVerdicts,
  completionVerdictProgress,
  completionVerdicts,
} from '../../../dist/act/runtime/utils/completion-review.js'

import { done, turn } from './support/model-turn.mjs'

const hash = (text) => createHash('sha256').update(text).digest('hex')

test('requirements preserve explicit evidence obligations and reject an unspecified classification', () => {
  const originals = [
    {
      ref: { sessionId: 's', id: 'u' },
      text: 'Do not publish. Deliver the requested publication audit.',
    },
  ]
  const base = {
    id: 'R1',
    label: 'Behavior constraint',
    artifacts: ['execution:recent'],
    anchors: [{ sourceId: 'u', quote: 'Do not publish.' }],
  }
  assert.throws(
    () => completionRequirements({ complete: true, requirements: [base] }, originals),
    /证据|需求/u
  )
  for (const evidenceKind of ['constraint', 'audit', 'execution', 'artifact']) {
    const actual = completionRequirements(
      { complete: true, requirements: [{ ...base, evidenceKind }] },
      originals
    )
    assert.equal(actual[0].evidenceKind, evidenceKind)
    assert.deepEqual(actual[0].anchors, base.anchors)
  }
})

test('ordinary constraints require scoped observations while explicit audits cannot be downgraded', () => {
  const requirement = {
    id: 'R1',
    label: 'Do not publish',
    evidenceKind: 'constraint',
    artifacts: ['execution:recent'],
    sourceRefs: [],
    anchors: [],
  }
  const materials = [
    { identity: 'execution:recent', text: 'actual task record: git push origin main; exit 0' },
  ]
  const check = {
    id: 'R1',
    status: 'passed',
    reason: 'Observed task behavior',
    evidence: [{ identity: 'execution:recent', quote: 'actual task record' }],
  }
  assert.throws(
    () => completionVerdicts({ checks: [check] }, [requirement], materials),
    /行为|observation/u
  )
  assert.equal(
    completionVerdicts(
      { checks: [{ ...check, observation: 'none-observed' }] },
      [requirement],
      materials
    )[0].observation,
    'none-observed'
  )
  assert.throws(
    () =>
      completionVerdicts(
        { checks: [{ ...check, observation: 'violation' }] },
        [requirement],
        materials
      ),
    /行为|observation/u
  )
  const failed = {
    ...check,
    status: 'failed',
    observation: 'violation',
    evidence: [{ identity: 'execution:recent', quote: 'git push origin main; exit 0' }],
  }
  assert.equal(
    completionVerdicts({ checks: [failed] }, [requirement], materials)[0].status,
    'failed'
  )
  assert.throws(
    () =>
      completionVerdicts(
        { checks: [{ ...check, observation: 'none-observed' }] },
        [{ ...requirement, evidenceKind: 'audit' }],
        materials
      ),
    /审计|行为|observation/u
  )
})
const input = 'Deliver the implementation, a usage guide, two examples, and a release entry.'
const requirements = [
  ['implementation', 'Implementation', 'file:src/module.ts'],
  ['guide', 'Usage guide', 'file:README.md'],
  ['examples', 'Two independent examples', 'file:examples/demo.ts'],
  ['release', 'Package release entry', 'file:package.json'],
]

for (const sample of [
  {
    name: 'escaped source line breaks',
    text: 'const value = "hello";\nconsole.log(value)',
    quote: String.raw`const value = "hello";\nconsole.log(value)`,
    canonical: 'const value = "hello";\nconsole.log(value)',
  },
  {
    name: 'partial serialized receipt',
    text: JSON.stringify({ stdout: 'first\nsecond' }).slice(1, -1),
    quote: 'first\nsecond',
    canonical: String.raw`first\nsecond`,
  },
  {
    name: 'escaped Unicode and tab',
    text: 'label=界\tnext',
    quote: String.raw`label=\u754c\tnext`,
    canonical: 'label=界\tnext',
  },
  {
    name: 'literal backslashes take direct-match priority',
    text: String.raw`C:\temp\new`,
    quote: String.raw`C:\temp\new`,
    canonical: String.raw`C:\temp\new`,
  },
])
  test(`JSON quote representation resolves to an exact canonical excerpt: ${sample.name}`, () => {
    const identity = 'file:proof.txt'
    const required = [
      { id: 'proof', label: 'Inspect proof', artifacts: [identity], evidenceKind: 'artifact' },
    ]
    const checks = [
      {
        id: 'proof',
        status: 'passed',
        reason: 'Read actual evidence',
        evidence: [{ identity, quote: sample.quote }],
      },
    ]
    const result = completionVerdicts({ checks }, required, [{ identity, text: sample.text }])
    assert.equal(result[0].evidence[0].quote, sample.canonical)
    assert(sample.text.includes(result[0].evidence[0].quote))
  })

test('JSON quote representation preserves identity, content, boundaries and the quote limit', () => {
  const identity = 'file:proof.txt'
  const required = [
    { id: 'proof', label: 'Inspect proof', artifacts: [identity], evidenceKind: 'artifact' },
  ]
  for (const [quote, materials] of [
    [String.raw`first\ncount=9`, [{ identity, text: 'first\ncount=3' }]],
    ['const a=1; next()', [{ identity, text: 'const a=1;\nnext()' }]],
    [String.raw`first\nsecond`, [{ identity: 'file:other.txt', text: 'first\nsecond' }]],
    [
      String.raw`first\nsecond`,
      [
        { identity, text: 'first\n' },
        { identity, text: 'second' },
      ],
    ],
    [String.raw`first\qsecond`, [{ identity, text: 'firstqsecond' }]],
    [
      `${'x'.repeat(4094)}\n\n`,
      [{ identity, text: JSON.stringify(`${'x'.repeat(4094)}\n\n`).slice(1, -1) }],
    ],
  ]) {
    const checks = [
      { id: 'proof', status: 'passed', reason: 'Claim', evidence: [{ identity, quote }] },
    ]
    assert.throws(() => completionVerdicts({ checks }, required, materials), /引文/u)
  }
})

test('JSON quote representation in retrieved receipts completes without another producer turn', async (t) => {
  const identity = 'file:receipt.txt'
  const text = `header\n${JSON.stringify({ payload: JSON.stringify({ stdout: 'actual first\nactual second' }) })}\nfooter`
  const f = await fixture(t, {
    requirements: [['receipt', 'Inspect actual receipt', identity]],
    metadataArtifacts: [identity],
    artifactTexts: [[identity, text]],
    enableRead: true,
    retrieve: (material) =>
      !material.retrievedEvidence.length
        ? { queries: [{ kind: 'read', identity, offset: 0, limit: text.length - 3 }] }
        : undefined,
    reviewReply: (material, value) => ({
      ...value,
      checks: [
        {
          ...value.checks[0],
          evidence: [{ identity, quote: String.raw`actual first\nactual second` }],
        },
      ],
    }),
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.mainCalls, 1)
  assert.equal(f.verificationCalls, 2)
  assert.equal(f.reads.length, 1)
})

test('same-turn retrieval calls share one query and byte budget before a final verdict', async (t) => {
  const entries = [
    ['file:implementation.txt', 'implementation proof'],
    ['file:tests.txt', 'independent test proof'],
  ]
  const f = await fixture(t, {
    requirements: entries.map(([identity, marker], i) => [`proof-${i}`, marker, identity]),
    metadataArtifacts: entries.map(([identity]) => identity),
    artifactTexts: entries.map(([identity, marker]) => [
      identity,
      `${marker}\n${'x'.repeat(40000)}`,
    ]),
    enableRead: true,
    retrieve: (material) =>
      !material.retrievedEvidence.length
        ? entries.map(([identity]) => ({
            queries: [{ kind: 'read', identity, offset: 0, limit: 32000 }],
          }))
        : undefined,
    reviewReply: (material, value) => ({
      ...value,
      checks: value.checks.map((check, i) => ({
        ...check,
        evidence: [{ identity: entries[i][0], quote: entries[i][1] }],
      })),
    }),
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.mainCalls, 1)
  assert.equal(f.verificationCalls, 2)
  assert.deepEqual(
    f.reads,
    entries.map(([identity]) => identity)
  )
  assert.equal(f.verificationMaterial.retrievedEvidence.length, 1)
  const batch = f.verificationMaterial.retrievedEvidence[0]
  assert.equal(batch.pages.length, 2)
  assert.equal(batch.remainingQueries, 62)
  assert.equal(batch.bytes, 32768)
  assert.equal(batch.remainingBytes, 131072 - 32768)
  for (const page of batch.pages)
    for (const fragment of page.fragments)
      assert.equal(
        f.materials
          .get(fragment.identity)
          .slice(fragment.offset, fragment.offset + fragment.text.length),
        fragment.text
      )
})

for (const counts of [[8, 9], Array(17).fill(1)])
  test(`same-turn retrieval validates the combined query limit before reading: ${counts.join('+')}`, async (t) => {
    const identity = 'file:proof.txt'
    const f = await fixture(t, {
      requirements: [['proof', 'Inspect actual content', identity]],
      metadataArtifacts: [identity],
      artifactTexts: [[identity, 'current evidence']],
      enableRead: true,
      retrieve: (material, state) => {
        if (material.retrievedEvidence.length) return undefined
        if (material.evidenceErrors.length) assert.equal(state.reads.length, 0)
        return (material.evidenceErrors.length ? [1] : counts).map((count) => ({
          queries: Array.from({ length: count }, () => ({
            kind: 'read',
            identity,
            offset: 0,
            limit: 100,
          })),
        }))
      },
      reviewReply: (material, value) => ({
        ...value,
        checks: [{ ...value.checks[0], evidence: [{ identity, quote: 'current evidence' }] }],
      }),
    })
    assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
    assert.equal(f.mainCalls, 1)
    assert.equal(f.verificationCalls, 3)
    assert.deepEqual(f.reads, [identity])
    assert.equal(f.verificationMaterial.evidenceErrors.length, 1)
    assert.equal(f.verificationMaterial.retrievedEvidence[0].remainingQueries, 63)
  })

test('invalid read parameters return to the reviewer without losing the frozen completion attempt', async (t) => {
  const identity = 'file:large.txt'
  const f = await fixture(t, {
    requirements: [['code', 'Inspect current text', identity]],
    metadataArtifacts: [identity],
    enableRead: true,
    artifactTexts: [[identity, `verified current text\n${'long text '.repeat(10000)}`]],
    retrieve: (material) =>
      !material.retrievedEvidence.length
        ? {
            queries: [
              {
                kind: 'read',
                identity,
                offset: 0,
                limit: material.evidenceErrors?.length ? 100 : 32768,
              },
            ],
          }
        : undefined,
    reviewReply: (material, value) => ({
      ...value,
      checks: [{ ...value.checks[0], evidence: [{ identity, quote: 'verified current text' }] }],
    }),
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.mainCalls, 1)
  assert.equal(f.verificationCalls, 3)
  assert.equal(f.reads.length, 1)
  assert.equal(f.verificationMaterial.evidenceErrors.length, 1)
  assert.equal(f.verificationMaterial.retrievedEvidence.length, 1)
  assert.match(f.verificationMaterial.evidenceErrors[0].error, /32000/u)
})

test('repeated invalid queries consume the same fixed round budget and never become evidence', async (t) => {
  const identity = 'file:large.txt'
  const f = await fixture(t, {
    requirements: [['code', 'Inspect current text', identity]],
    metadataArtifacts: [identity],
    enableRead: true,
    retrieve: (material) =>
      material.evidenceAccess
        ? { queries: [{ kind: 'read', identity, offset: 0, limit: -1 }] }
        : undefined,
    reviewReply: (material, value) => ({
      ...value,
      checks: [
        {
          ...value.checks[0],
          status: 'unknown',
          reason: 'The read request could not be completed within the fixed limit.',
          evidence: [],
        },
      ],
    }),
  })
  assert.notEqual(f.events.at(-1).status, 'completed')
  assert.equal(f.verificationCalls, f.mainCalls * 5)
  assert.equal(f.reads.length, 0)
  assert.equal(f.verificationMaterial.evidenceErrors.length, 4)
  assert.equal(f.verificationMaterial.retrievedEvidence.length, 0)
})

for (const missingScope of ['once', 'always'])
  test(`a completeness declaration is required before a real completion verdict: ${missingScope}`, async (t) => {
    const f = await fixture(t, { missingScope })
    assert.equal(f.events.at(-1).status === 'completed', missingScope === 'once')
    assert.equal(f.verificationCalls, 2)
  })

test('review retrieves hidden file evidence directly without another producer turn', async (t) => {
  const identity = 'file:tests/large.test.ts'
  const marker = 'assert.deepEqual(actual, independentExpected)'
  const f = await fixture(t, {
    requirements: [['code', 'Verify implementation coverage', identity]],
    artifactTexts: [[identity, `${'unrelated setup\n'.repeat(25000) + marker}\n`]],
    metadataArtifacts: [identity],
    enableRead: true,
    retrieve: (material) =>
      !material.retrievedEvidence.length
        ? { queries: [{ kind: 'find', identity, literal: 'independentExpected', limit: 2 }] }
        : undefined,
    reviewReply: (material, value) => ({
      ...value,
      checks: [{ ...value.checks[0], evidence: [{ identity, quote: marker }] }],
    }),
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.mainCalls, 1)
  assert.equal(f.verificationCalls, 2)
  assert.deepEqual(f.reads, [identity])
  const fragment = f.verificationMaterial.retrievedEvidence[0].pages[0].fragments[0]
  assert.equal(fragment.sha256, hash(f.materials.get(identity)))
  assert(fragment.offset > 300000)
  assert.equal(fragment.omitted, true)
  assert.equal(
    f.materials.get(identity).slice(fragment.offset, fragment.offset + fragment.text.length),
    fragment.text
  )
})

test('unread sections cannot be quoted merely because the host holds the full source', async (t) => {
  const identity = 'file:large.txt'
  const f = await fixture(t, {
    requirements: [['code', 'Inspect content', identity]],
    artifactTexts: [
      [identity, `visible first section\n${'unrelated\n'.repeat(30000)}unseen assertion`],
    ],
    metadataArtifacts: [identity],
    enableRead: true,
    retrieve: (material) =>
      !material.retrievedEvidence.length
        ? { queries: [{ kind: 'read', identity, offset: 0, limit: 20 }] }
        : undefined,
    reviewReply: (material, value) => ({
      ...value,
      checks: [{ ...value.checks[0], evidence: [{ identity, quote: 'unseen assertion' }] }],
    }),
    rounds: 1,
  })
  assert.notEqual(f.events.at(-1).status, 'completed')
  assert(
    f.events.some(
      (event) =>
        event.type === 'verification' &&
        event.report.checks.some((check) => check.status === 'unknown')
    )
  )
  assert.equal(f.verificationCalls, f.mainCalls * 3)
})

test('on-demand execution evidence reaches old complete pairs beyond the recent text selection', async (t) => {
  const f = await fixture(t, {
    evidenceSetup: async (storage) => {
      await appendExecution(
        storage,
        'project',
        'old-required-validation',
        'independent validation exit 0'
      )
      for (let i = 0; i < 60; i++)
        await appendExecution(storage, 'project', `later-${i}`, `later output ${i}`)
    },
    retrieve: (material) => {
      if (material.retrievedEvidence.length >= 2) return undefined
      if (!material.retrievedEvidence.length)
        return {
          queries: [
            {
              kind: 'find',
              identity: 'execution:task',
              literal: 'independent validation exit 0',
              limit: 1,
            },
          ],
        }
      const old = material.evidenceCatalog.find((entry) =>
        entry.records?.some((record) => record.title === 'script:old-required-validation:result')
      )
      assert(old)
      assert(
        !material.executionEvidence.records.some(
          (record) => record.title === 'script:old-required-validation:result'
        )
      )
      return { queries: [{ kind: 'read', identity: old.identity, offset: 0, limit: 4000 }] }
    },
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  const page = f.verificationMaterial.retrievedEvidence[1].pages[0]
  const pair = JSON.parse(page.fragments[0].text)
  assert.equal(pair.records.length, 2)
  assert(pair.records[0].title === 'script:old-required-validation')
  assert(pair.records[1].text.includes('independent validation exit 0'))
})

test('authorization changes during retrieval invalidate even otherwise correct excerpts', async (t) => {
  const identity = 'file:large.txt'
  const f = await fixture(t, {
    requirements: [['code', 'Inspect current content', identity]],
    metadataArtifacts: [identity],
    artifactTexts: [[identity, 'original contents']],
    enableRead: true,
    onRead: (state) => {
      state.authorization = 'changed-authorization'
    },
    retrieve: (material) =>
      !material.retrievedEvidence.length
        ? { queries: [{ kind: 'read', identity, offset: 0, limit: 20 }] }
        : undefined,
  })
  assert.notEqual(f.events.at(-1).status, 'completed')
  assert.equal(f.verificationCalls, 1)
  const blocked = (await f.storage.load('project')).records.findLast(
    (record) => record.title === 'completion-blocked'
  )
  assert(blocked)
  assert.match(await f.storage.get('project', blocked.objectId), /授权|产物/u)
})

test('review stops read requests at its fixed round limit and still asks for a scoped final verdict', async (t) => {
  const identity = 'file:src/module.ts'
  const f = await fixture(t, {
    retrieve: (material) =>
      material.evidenceAccess
        ? { queries: [{ kind: 'read', identity, offset: 0, limit: 8 }] }
        : undefined,
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.verificationCalls, 5)
  assert.equal(f.mainCalls, 1)
  assert.equal(f.verificationMaterial.evidenceAccess, false)
  assert.equal(f.verificationMaterial.retrievedEvidence.length, 4)
})

test('retrieval growth preserves the complete static execution evidence prefix through quota exhaustion', async (t) => {
  const f = await fixture(t, {
    execution: true,
    retrieve: (material) =>
      material.evidenceAccess
        ? { queries: [{ kind: 'read', identity: 'file:src/module.ts', offset: 0, limit: 8 }] }
        : undefined,
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  const calls = f.reviewInputs.filter((item) => item.phase === 'completion-verification')
  assert.equal(calls.length, 5)
  const first = JSON.parse(calls[0].text)
  assert(first.executionEvidence.records.length > 0)
  const evidence = JSON.stringify(first.executionEvidence)
  const end = calls[0].text.indexOf(evidence) + evidence.length
  assert(end >= evidence.length)
  const prefix = calls[0].text.slice(0, end)
  for (const call of calls.slice(1)) {
    assert.deepEqual(JSON.parse(call.text).executionEvidence, first.executionEvidence)
    assert(
      call.text.startsWith(prefix),
      'New evidence must follow all unchanged execution evidence'
    )
  }
  assert.equal(JSON.parse(calls.at(-1).text).evidenceAccess, false)
})

test('retrieved pages shrink against the real compiler window before another model dispatch', async (t) => {
  const identity = 'file:large.txt'
  const f = await fixture(t, {
    requirements: [['code', 'Inspect content', identity]],
    enableRead: true,
    artifactTexts: [[identity, `complete marker\n${'padding '.repeat(10000)}`]],
    metadataArtifacts: [identity],
    modelLimits: { inputTokens: 8000, contextTokens: 20000 },
    verificationEstimate: (request) => {
      const material = JSON.parse(
        request.materials.find((item) => item.origin === 'completion-verification').text
      )
      return 1000 + (material.retrievedEvidence ?? []).reduce((sum, batch) => sum + batch.bytes, 0)
    },
    retrieve: (material) =>
      !material.retrievedEvidence.length
        ? { queries: [{ kind: 'read', identity, offset: 0, limit: 32000 }] }
        : undefined,
    reviewReply: (material, value) => ({
      ...value,
      checks: [{ ...value.checks[0], evidence: [{ identity, quote: 'complete marker' }] }],
    }),
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  const page = f.verificationMaterial.retrievedEvidence[0]
  assert(page.bytes < 7000)
  assert.match(page.pages[0].issue, /模型窗口/u)
  assert.equal(f.verificationCalls, 2)
})

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'velaros-completion-review-'))
  const criteria = options.requirements ?? requirements
  const storage = localContextStorage({ path: join(root, 'context.sqlite') })
  const f = {
    root,
    calls: [],
    reviewInputs: [],
    generation: 1,
    mainCalls: 0,
    mainInputs: [],
    requirementCalls: 0,
    extractionCalls: 0,
    locationCalls: 0,
    discoveryCalls: 0,
    discoveryInputs: [],
    verificationCalls: 0,
    materials: new Map(criteria.map((item) => [item[2], `Complete ${item[1]}`])),
    captures: [],
    reads: [],
  }
  for (const [identity, text] of options.artifactTexts ?? []) f.materials.set(identity, text)
  for (const identity of options.locationFiles ?? [])
    f.materials.set(identity, `Complete ${identity}`)
  const model = {
    id: 'review-fixture',
    limits: {
      inputTokens: 100000,
      contextTokens: 120000,
      outputTokens: 8192,
      ...options.modelLimits,
    },
    estimate: async (request) => ({
      tokens: request.materials.some((material) => material.origin === 'completion-verification')
        ? (options.verificationEstimate?.(request) ??
          options.verificationEstimateTokens ??
          options.reviewEstimateTokens ??
          1000)
        : request.materials.some((material) => material.origin.startsWith('completion-'))
          ? (options.reviewEstimateTokens ?? 1000)
          : 1000,
      precision: 'exact',
      basis: 'fixture',
    }),
    async *stream(request, signal) {
      const phase = request.materials.find((material) => material.origin.startsWith('completion-'))
      f.calls.push(phase?.origin ?? 'main')
      if (!phase) {
        f.mainCalls++
        f.mainInputs.push(request.compiledPrompt)
        if (f.mainCalls === 1 && options.evidenceSetup)
          await options.evidenceSetup(storage, await storage.load('project'))
        if (options.execution && f.mainCalls === 1) {
          yield turn(request, {
            execute: {
              source:
                "console.log(JSON.stringify({receipt:'checked actual output',text:'first\\nsecond'}));",
            },
          })
          yield { type: 'finish', reason: 'stop' }
          return
        }
        if (options.repair && f.mainCalls > 1) {
          f.materials.set(
            options.moveArtifact ?? 'file:examples/demo.ts',
            'Two working examples with different inputs'
          )
          f.generation++
        }
        yield* done(request, 'The requested project delivery is ready.')
        return
      }
      options.reviewDelay?.(signal)
      f.reviewInputs.push({
        phase: phase.origin,
        text: phase.text,
        cacheKey: request.cacheKey,
        instructions: request.instructions,
      })
      const failure = options.transient?.[phase.origin]
      if (failure && f.calls.filter((name) => name === phase.origin).length <= failure.count) {
        if (phase.origin === 'completion-verification') f.verificationCalls++
        yield { type: 'text', text: '{"incomplete":' }
        if (failure.usage) yield { type: 'usage', inputTokens: 17, outputTokens: 3 }
        if (failure.cancel) setTimeout(() => failure.cancel.abort(), 10)
        yield {
          type: 'error',
          code: failure.code ?? 'provider',
          message: 'upstream stream interrupted',
          retryAfterMs: failure.delay ?? 0,
        }
        return
      }
      const material = JSON.parse(phase.text)
      let value
      if (phase.origin === 'completion-requirements') {
        f.requirementCalls++
        if (material.locationCorrection) f.locationCalls++
        else f.extractionCalls++
        if (material.correction) f.requirementsCorrection = material.correction
        f.originals = material.originalInputs
        f.requirementMaterial = material
        value = {
          complete: true,
          requirements: [
            ...criteria,
            ...(options.execution ? [['execution', 'Execute and verify', 'execution:recent']] : []),
          ]
            .filter(([id]) => !options.revised || id !== 'examples')
            .map(([id, label, artifact]) => ({
              id,
              label,
              artifacts: [
                options.inferredLocation && id === 'guide' && !material.locationCorrection
                  ? 'file:guide.md'
                  : artifact,
                ...(options.inferredExecution && id === 'execution'
                  ? ['file:temporary-consumer.tgz']
                  : []),
              ],
              evidenceKind: artifact === 'execution:recent' ? 'execution' : 'artifact',
              anchors: [
                {
                  sourceId: material.originalInputs[0].ref.id,
                  quote: material.originalInputs[0].text.slice(0, 2048),
                },
              ],
            })),
        }
        if (material.locationCorrection) {
          value = {
            complete: true,
            locations: material.locationCorrection.unavailable.map((from) => ({
              from,
              to: options.locationFiles ?? [
                options.moveArtifact && f.mainCalls > 1 && from === 'file:examples/demo.ts'
                  ? options.moveArtifact
                  : from === 'file:guide.md'
                    ? 'file:README.md'
                    : from,
              ],
            })),
          }
          if (options.changeRequirement) value.requirements = [{ label: 'Reduced scope' }]
        }
        if (
          options.malformedRequirements === 'always' ||
          (options.malformedRequirements === 'once' && f.requirementCalls === 1)
        )
          value.requirements[0].artifacts = []
      } else if (phase.origin === 'completion-discovery') {
        f.discoveryCalls++
        f.discoveryInputs.push(material)
        value = options.discover?.(material, f) ?? { files: [] }
      } else {
        f.verificationCalls++
        f.verificationMaterial = material
        const validation = options.validate?.(material, f)
        if (validation) {
          assert.equal(request.response.type, 'tools')
          assert(request.response.tools.some((tool) => tool.name === 'validate_evidence'))
          yield {
            type: 'tool-call',
            value: {
              id: `validation-${f.verificationCalls}`,
              name: 'validate_evidence',
              input: validation,
            },
          }
          yield { type: 'usage', inputTokens: 101, outputTokens: 37 }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        const retrieval = options.retrieve?.(material, f)
        if (retrieval) {
          assert.equal(request.response.type, 'tools')
          assert.equal(request.response.tools[0].name, 'retrieve_evidence')
          for (const [index, input] of (Array.isArray(retrieval)
            ? retrieval
            : [retrieval]
          ).entries())
            yield {
              type: 'tool-call',
              value: {
                id: `evidence-${f.verificationCalls}-${index}`,
                name: 'retrieve_evidence',
                input,
              },
            }
          yield { type: 'usage', inputTokens: 101, outputTokens: 37 }
          yield { type: 'finish', reason: 'stop' }
          return
        }
        if (material.correction) f.correction = material.correction
        if (options.execution) {
          f.executionEvidence = material.executionEvidence
          assert(
            material.executionEvidence.records.some((record) => record.text.includes('console.log'))
          )
          assert(
            material.executionEvidence.records.some((record) => record.title.endsWith(':result'))
          )
        }
        value = {
          requirementsComplete:
            !options.incompleteScopeAlways &&
            !(options.incompleteScopeOnce && f.verificationCalls === 1),
          checks: material.required
            .filter(
              (item) => !material.adjudication || material.adjudication.pending.includes(item.id)
            )
            .map((item) => ({
              id: item.id,
              status:
                options.unknown === item.id
                  ? 'unknown'
                  : options.fail === item.id && (!options.repair || f.mainCalls === 1)
                    ? 'failed'
                    : 'passed',
              reason:
                options.fail === item.id && (!options.repair || f.mainCalls === 1)
                  ? 'The second requested example is missing.'
                  : 'The supplied artifact covers this criterion.',
              evidence: item.artifacts
                .map((identity) => ({
                  identity,
                  quote: [...material.materials, ...(material.executionEvidence?.records ?? [])]
                    .find((entry) => entry.identity === identity)
                    .text.slice(0, options.quoteChars ?? Infinity),
                }))
                .concat(
                  options.execution
                    ? [
                        {
                          identity: material.executionEvidence.records[0].identity,
                          quote: 'console.log',
                        },
                      ]
                    : []
                ),
            })),
        }
        if (material.correction && Object.hasOwn(options, 'invalidScopeCorrection'))
          value.requirementsComplete = options.invalidScopeCorrection
        if (options.stale) f.generation++
        if (
          options.fakeQuote ||
          (options.fakeTwice && f.verificationCalls <= 2) ||
          (options.fakeOnce && f.verificationCalls === 1)
        )
          value.checks[0].evidence[0].quote = 'fabricated evidence'
        if (options.movingFakeQuote)
          value.checks[f.verificationCalls === 1 ? value.checks.length - 1 : 0].evidence[0].quote =
            'fabricated evidence'
        if (options.partialCorrection && material.correction)
          value.checks = value.checks.filter((item) =>
            material.correction.pending?.includes(item.id)
          )
      }
      if (phase.origin === 'completion-verification' && options.reviewReply)
        value = await options.reviewReply(material, value, f)
      if (
        phase.origin === 'completion-verification' &&
        (options.missingScope === 'always' ||
          (options.missingScope === 'once' && f.verificationCalls === 1))
      )
        delete value.requirementsComplete
      if (options.reject === phase.origin) {
        yield {
          type: 'error',
          code: 'provider',
          message: options.rejectMessage ?? 'review request failed',
        }
        return
      }
      if (options.cancel && phase.origin === (options.cancelPhase ?? 'completion-verification')) {
        if (options.lateUsage) {
          options.cancel.abort()
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        yield { type: 'usage', inputTokens: 17, outputTokens: 3 }
        options.cancel.abort()
        throw options.cancel.signal.reason
      }
      yield { type: 'text', text: JSON.stringify(value) }
      if (!options.unknownUsage) yield { type: 'usage', inputTokens: 101, outputTokens: 37 }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const artifacts = {
    async capture(identities, maxBytes) {
      f.captures.push({ identities, maxBytes })
      options.onCapture?.(f, maxBytes)
      const materials = []
      const issues = []
      let remaining = maxBytes
      for (const identity of identities) {
        if (identity === options.missing || !f.materials.has(identity)) {
          issues.push(`${identity}: missing`)
          continue
        }
        const text = f.materials.get(identity)
        const bytes = Buffer.byteLength(text)
        if (
          options.metadataArtifacts?.includes(identity) ||
          (options.adaptiveMetadata && bytes > remaining)
        ) {
          const metadata = { bytes, sha256: hash(text) }
          if (options.metadataTamper === 'bytes') metadata.bytes = -1
          if (options.metadataTamper === 'hash') metadata.sha256 = '0'.repeat(64)
          const descriptor = JSON.stringify(metadata)
          remaining -= Buffer.byteLength(descriptor)
          materials.push({
            identity,
            text: options.metadataTamper === 'text' ? 'The data are correct.' : descriptor,
            metadata,
          })
          continue
        }
        if (bytes > remaining) {
          issues.push(`${identity}: Complete artifact exceeds the current read budget`)
          continue
        }
        remaining -= bytes
        materials.push({ identity, text })
      }
      if (issues.length)
        return {
          fingerprint: { status: 'unknown' },
          materials,
          issues,
          locations: options.locationHints,
        }
      return {
        fingerprint: {
          status: 'versioned',
          providerId: 'fixture',
          token: String(f.generation),
          authorization: f.authorization ?? 'workspace-v1',
          artifacts: materials.map((entry) => ({
            identity: entry.identity,
            contentHash: hash(f.materials.get(entry.identity)),
            revision: String(f.generation),
          })),
          cost: { coverage: 'complete', charges: [] },
        },
        materials,
        issues: [],
      }
    },
  }
  if (options.enableRead)
    artifacts.read = async (identity, expected, maxBytes, signal) => {
      signal.throwIfAborted()
      f.reads.push(identity)
      options.onRead?.(f)
      const snapshot = await artifacts.capture([...f.materials.keys()], 1_000_000)
      return { ...snapshot, materials: [{ identity, text: f.materials.get(identity) }] }
    }
  f.runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    protocol: { transport: 'text' },
    agents: false,
    search: false,
    limits: { turns: 1, ...options.limits },
    context: {
      maintenance: false,
      policy: { recoveryAttempts: 1 },
      limits: options.budget,
      completion: {
        kind: 'model-review',
        artifacts,
        discoverEvidence: options.discoverEvidence,
        counterexampleReview: options.counterexampleReview,
        validation: options.validation
          ? { execute: (request, signal) => options.validation(request, signal, f) }
          : undefined,
      },
    },
  })
  f.session = await f.runtime.openSession('project')
  f.storage = storage
  f.events = []
  t.after(async () => {
    await f.runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  if (options.beforeSubmit) await options.beforeSubmit(storage)
  for await (const event of f.session.submit(options.input ?? input, options.cancel?.signal))
    f.events.push(event)
  return f
}

function boundedReviewCriteria(count) {
  const requirements = Array.from({ length: count }, (_, index) => [
    `bounded-${index}`,
    `Deliver requested artifact ${index}`,
    `file:bounded-${index}.txt`,
  ])
  return {
    requirements,
    artifactTexts: requirements.map(([, label, identity]) => [
      identity,
      `${label}\n${'version-bound supporting text '.repeat(Math.ceil(35000 / count / 30))}`,
    ]),
  }
}

for (const count of [12, 24])
  test(`completion review covers ${count} requirements through bounded responses`, async (t) => {
    const f = await fixture(t, boundedReviewCriteria(count))
    const verification = f.events.find((event) => event.type === 'verification')
    assert.equal(verification?.verified, true)
    assert.equal(verification.report.checks.length, count)
    assert(verification.report.checks.every((check) => check.status === 'passed'))
    const inputs = f.reviewInputs
      .filter((entry) => entry.phase === 'completion-verification')
      .map((entry) => JSON.parse(entry.text))
    assert(inputs.length > 1, 'The full response exceeds the real bounded response channel')
    assert(
      inputs.every((entry) => entry.required.length === count),
      'Every batch sees full scope'
    )
    assert.deepEqual(
      inputs.flatMap((entry) => entry.adjudication.pending).sort(),
      boundedReviewCriteria(count)
        .requirements.map(([id]) => id)
        .sort()
    )
    assert.deepEqual(
      verification.report.checks.map((check) => check.id),
      boundedReviewCriteria(count).requirements.map(([id]) => id)
    )
  })

test('bounded review retains an early failed requirement through later passing batches', async (t) => {
  const f = await fixture(t, { ...boundedReviewCriteria(24), fail: 'bounded-1' })
  const verification = f.events.find((event) => event.type === 'verification')
  assert.equal(verification?.verified, false)
  assert.equal(verification.report.checks.length, 24)
  assert.equal(
    verification.report.checks.find((check) => check.id === 'bounded-1').status,
    'failed'
  )
  assert.equal(verification.report.checks.filter((check) => check.status === 'passed').length, 23)
})

test('bounded review overlaps at most one subsequent batch without waiting for the first response', async (t) => {
  let active = 0
  let maximum = 0
  let pairStarted = 0
  let release
  let firstSawNext = false
  const nextStarted = new Promise((resolve) => {
    release = resolve
  })
  const f = await fixture(t, {
    ...boundedReviewCriteria(24),
    async reviewReply(material, value) {
      active++
      maximum = Math.max(maximum, active)
      if (['bounded-0', 'bounded-8'].includes(material.adjudication.pending[0])) {
        if (++pairStarted === 2) release(true)
        const timer = setTimeout(() => release(false), 500)
        const overlapped = await nextStarted
        if (material.adjudication.pending[0] === 'bounded-0') firstSawNext = overlapped
        clearTimeout(timer)
      }
      active--
      return value
    },
  })
  assert.equal(firstSawNext, true, 'Next batch starts while the first response remains blocked')
  assert.equal(maximum, 2)
  assert.equal(f.verificationCalls, 3)
  assert.equal(f.events.at(-1).status, 'completed')
})

test('prefetched verdicts cannot cite evidence delivered only to another concurrent batch', async (t) => {
  const criteria = boundedReviewCriteria(16)
  const identity = criteria.requirements[0][2]
  const quote = 'delayed shared evidence body'
  let release
  const readCompleted = new Promise((resolve) => {
    release = resolve
  })
  const f = await fixture(t, {
    ...criteria,
    artifactTexts: [...criteria.artifactTexts, [identity, quote]],
    metadataArtifacts: [identity],
    enableRead: true,
    onRead() {
      release()
    },
    retrieve(material) {
      if (material.adjudication.pending[0] === 'bounded-0' && !material.retrievedEvidence.length)
        return { queries: [{ kind: 'read', identity, offset: 0, limit: 100 }] }
    },
    async reviewReply(material, value) {
      if (material.adjudication.pending[0] === 'bounded-8') {
        await readCompleted
        value.checks[0].evidence.push({ identity, quote })
      }
      return value
    },
  })
  const second = f.reviewInputs
    .filter((entry) => entry.phase === 'completion-verification')
    .map((entry) => JSON.parse(entry.text))
    .filter((entry) => entry.adjudication.pending[0] === 'bounded-8')
  assert.equal(second[0].retrievedEvidence.length, 0)
  assert(second[1].correction, 'Undelivered quote requires a new request with actual evidence')
  assert(second[1].retrievedEvidence.length > 0)
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
})

test('overlapping batches retain one global evidence retrieval allowance', async (t) => {
  const f = await fixture(t, {
    ...boundedReviewCriteria(24),
    retrieve: (material) =>
      material.evidenceAccess
        ? { queries: [{ kind: 'read', identity: 'file:bounded-0.txt', offset: 0, limit: 8 }] }
        : undefined,
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  const state = await f.storage.load('project')
  assert.equal(
    state.records.filter((record) => record.title === 'completion-review:evidence').length,
    4
  )
  assert.equal(f.mainCalls, 1)
})

test('overlapping validation requests cannot exceed the shared host execution allowance', async (t) => {
  let executions = 0
  const criteria = boundedReviewCriteria(24)
  const identity = criteria.requirements[0][2]
  const source = criteria.artifactTexts[0][1]
  const f = await fixture(t, {
    ...criteria,
    validate: (material) =>
      material.validationAccess
        ? {
            requirementIds: ['bounded-0'],
            artifacts: [{ identity, sha256: hash(source) }],
            code: 'console.log(1)',
          }
        : undefined,
    validation: async () => {
      executions++
      return {
        status: 'passed',
        exitCode: 0,
        stdout: '1',
        stderr: '',
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        cleanupComplete: true,
        durationMs: 1,
      }
    },
  })
  assert.equal(executions, 2)
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
})

test('an already failed prefetched request prevents later batch dispatch and remains accounted', async (t) => {
  let release
  const nextFinished = new Promise((resolve) => {
    release = resolve
  })
  const f = await fixture(t, {
    ...boundedReviewCriteria(24),
    async reviewReply(material, value) {
      if (material.adjudication.pending[0] === 'bounded-8') {
        release()
        throw new Error('prefetched provider failure')
      }
      if (material.adjudication.pending[0] === 'bounded-0') {
        await nextFinished
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return value
    },
  })
  assert.equal(f.verificationCalls, 2)
  assert.notEqual(f.events.at(-1).status, 'completed')
  const trace = await f.runtime.trace('project')
  assert(trace.branches.every((branch) => branch.status === 'closed'))
  assert.equal(trace.branches.length, 3)
})

test('cancellation drains both overlapping review streams and retains late usage after reopen', async (t) => {
  let release
  let started = 0
  const bothStarted = new Promise((resolve) => {
    release = resolve
  })
  const f = await fixture(t, {
    ...boundedReviewCriteria(24),
    cancel: new AbortController(),
    lateUsage: true,
    async reviewReply(_material, value) {
      if (++started === 2) release()
      await bothStarted
      return value
    },
  })
  assert.equal(started, 2)
  assert.equal(f.events.at(-1).status, 'cancelled')
  await f.runtime.close()
  const runtime = await createRuntime({
    storage: localContextStorage({ path: join(f.root, 'context.sqlite') }),
    runner: nodeSubprocessCodeRunner,
    agents: false,
    search: false,
  })
  try {
    const root = await runtime.trace('project')
    assert.equal(root.branches.length, 3)
    assert(root.branches.every((branch) => branch.status === 'closed'))
    const turns = []
    for (const branch of root.branches)
      turns.push(...(await runtime.trace('project', { sessionId: branch.sessionId })).turns)
    assert.equal(turns.filter((entry) => entry.modelAccounting.usage.inputTokens === 17).length, 2)
    assert.equal(turns.filter((entry) => entry.modelAccounting.usage.outputTokens === 3).length, 2)
  } finally {
    await runtime.close()
  }
})

test('overlapping review reserves from the same root physical request limit', async (t) => {
  const f = await fixture(t, { ...boundedReviewCriteria(24), budget: { modelCalls: 3 } })
  assert.equal(f.calls.length, 3)
  assert.equal(f.verificationCalls, 1)
  assert.notEqual(f.events.at(-1).status, 'completed')
  const trace = await f.runtime.trace('project')
  let dispatched = trace.turns.length
  for (const branch of trace.branches)
    dispatched += (await f.runtime.trace('project', { sessionId: branch.sessionId })).turns.length
  assert.equal(dispatched, 3)
})

test('temporary token reservation pressure falls back to settled serial admission without extra model calls', async (t) => {
  const f = await fixture(t, {
    ...boundedReviewCriteria(16),
    budget: { modelTokens: 16000 },
    async reviewReply(_material, value) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return value
    },
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.verificationCalls, 2)
  assert.equal(f.calls.length, 4)
})

test('bounded review refuses a verdict for a different batch', async (t) => {
  const f = await fixture(t, {
    ...boundedReviewCriteria(24),
    reviewReply(material, value) {
      if (material.adjudication) value.checks[0].id = 'bounded-23'
      return value
    },
  })
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
  assert(f.reviewInputs.some((entry) => entry.text.includes('完成复核事实身份无效')))
})

test('bounded review rejects a source revision change between batches', async (t) => {
  const f = await fixture(t, {
    ...boundedReviewCriteria(24),
    reviewReply(_material, value, current) {
      if (current.verificationCalls === 2) current.generation++
      return value
    },
  })
  assert.equal(f.events.find((event) => event.type === 'verification')?.verified, false)
  assert(f.verificationCalls > 1, 'The source changes after an earlier batch was adjudicated')
})

test('bounded review shares one correction allowance across every batch', async (t) => {
  let firstAttemptCalls = 0
  const f = await fixture(t, {
    ...boundedReviewCriteria(24),
    reviewReply(material, value, current) {
      if (current.mainCalls === 1) firstAttemptCalls++
      if (
        !material.correction &&
        ['bounded-0', 'bounded-8'].includes(material.adjudication.pending[0])
      )
        value.checks[0].evidence[0].quote = 'fabricated evidence'
      return value
    },
  })
  const verification = f.events.find((event) => event.type === 'verification')
  assert.equal(verification?.verified, false)
  assert.equal(firstAttemptCalls, 4)
  assert.equal(verification.report.checks.filter((check) => check.status === 'passed').length, 23)
  assert.equal(
    verification.report.checks.find((check) => check.id === 'bounded-8').status,
    'unknown'
  )
})

test('bounded review keeps a global scope omission across subsequent complete declarations', async (t) => {
  const f = await fixture(t, {
    ...boundedReviewCriteria(24),
    reviewReply(_material, value, current) {
      if (current.verificationCalls === 1) value.requirementsComplete = false
      return value
    },
  })
  const first = f.events.find((event) => event.type === 'verification')
  assert.equal(first?.verified, false)
  assert.match(first.reason, /清单存在遗漏/u)
})

test('bounded review scales batches down for a smaller declared output capacity', async (t) => {
  const f = await fixture(t, {
    ...boundedReviewCriteria(12),
    modelLimits: { outputTokens: 2048 },
  })
  assert(f.events.some((event) => event.type === 'verification' && event.verified))
  const inputs = f.reviewInputs
    .filter((entry) => entry.phase === 'completion-verification')
    .map((entry) => JSON.parse(entry.text))
  assert(inputs.every((entry) => entry.adjudication.pending.length <= 4))
  assert.equal(inputs.flatMap((entry) => entry.adjudication.pending).length, 12)
})

async function appendExecution(storage, sessionId, name, stdout) {
  const context = createContextRuntime({ storage, sessionId })
  const source = await context.append({
    kind: 'audit',
    title: `script:${name}`,
    body: JSON.stringify({ source: `console.log(${JSON.stringify(name)})` }),
  })
  return context.append({
    kind: 'audit',
    title: `script:${name}:result`,
    sources: [source.ref],
    body: JSON.stringify({ result: { process: { exitCode: 0, stdout, truncated: false } } }),
  })
}

async function appendAgentBinding(storage, root, sessionId, options = {}) {
  const context = createContextRuntime({ storage, sessionId: 'project' })
  await context.append({
    kind: 'audit',
    title: `model-tool:node:${sessionId}`,
    body: JSON.stringify({
      sessionId,
      parentSessionId: 'project',
      rootSessionId: 'project',
      rootTaskId: root.task.id,
      kind: 'agent',
      depth: 1,
      activationId: 'fixture',
      deadline: Date.now() + 10000,
      status: 'closed',
      ...options,
    }),
  })
}

test('completion evidence covers owned agent receipts and excludes other task scopes', async (t) => {
  const f = await fixture(t, {
    input: { text: input, task: 'new' },
    beforeSubmit: async (storage) => {
      await appendExecution(storage, 'project', 'old-root', 'previous user task')
    },
    evidenceSetup: async (storage, root) => {
      await appendExecution(storage, 'project', 'root-check', 'root receipt')
      for (const [id, options] of [
        ['owned', {}],
        ['other-task', { rootTaskId: 'previous-task' }],
        ['other-root', { rootSessionId: 'unrelated-root' }],
        ['maintenance', { kind: 'context' }],
      ]) {
        await appendAgentBinding(storage, root, id, options)
        await appendExecution(storage, id, `check-${id}`, `receipt ${id}`)
      }
    },
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  const evidence = f.verificationMaterial.executionEvidence
  assert.deepEqual([...new Set(evidence.records.map((record) => record.ref.sessionId))].sort(), [
    'owned',
    'project',
  ])
  assert(evidence.records.some((record) => record.text.includes('receipt owned')))
  assert(!evidence.records.some((record) => record.text.includes('previous user task')))
  assert.equal(evidence.omitted, 0)
})

test('oversized recent output cannot crowd out complete receipts or create empty evidence', async (t) => {
  const f = await fixture(t, {
    evidenceSetup: async (storage, root) => {
      await appendExecution(storage, 'project', 'small-root', 'complete root check')
      await appendExecution(storage, 'project', 'large-read', 'x'.repeat(40000))
      await appendAgentBinding(storage, root, 'owned')
      await appendExecution(storage, 'owned', 'pack-consumer', 'complete child package check')
    },
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  const evidence = f.verificationMaterial.executionEvidence
  assert(evidence.records.every((record) => record.text.length > 0 && !record.truncated))
  assert(evidence.records.some((record) => record.text.includes('complete root check')))
  assert(evidence.records.some((record) => record.text.includes('complete child package check')))
  assert.equal(evidence.omitted, 1)
  const titles = evidence.records.map((record) => record.title)
  assert.deepEqual(
    titles.filter((title) => title.startsWith('script:large-read')),
    []
  )
})

test('bounded execution selection balances root and agent histories and reports omitted results', async (t) => {
  const f = await fixture(t, {
    evidenceSetup: async (storage, root) => {
      await appendAgentBinding(storage, root, 'owned')
      for (let i = 0; i < 50; i++) {
        await appendExecution(storage, 'project', `root-${i}`, `root result ${i}`)
        await appendExecution(storage, 'owned', `child-${i}`, `child result ${i}`)
      }
    },
  })
  const evidence = f.verificationMaterial.executionEvidence
  const results = evidence.records.filter((record) => record.title.endsWith(':result'))
  assert.equal(results.length, 48)
  assert.equal(results.filter((record) => record.ref.sessionId === 'project').length, 24)
  assert.equal(results.filter((record) => record.ref.sessionId === 'owned').length, 24)
  assert.equal(evidence.omitted, 52)
})

test('execution references with the same ID remain distinct across owned sessions', async (t) => {
  const f = await fixture(t, {
    evidenceSetup: async (storage, root) => {
      const result = await appendExecution(storage, 'project', 'root-check', 'root receipt')
      await appendAgentBinding(storage, root, 'owned')
      const snapshot = await storage.load('project')
      const source = snapshot.records.find((record) => record.ref.id === result.sources[0].id)
      for (const record of [source, result]) {
        const metadata = { ...record }
        delete metadata.sequence
        const body =
          record === source
            ? JSON.stringify({ source: "console.log('child receipt')" })
            : JSON.stringify({ result: { process: { exitCode: 0, stdout: 'child receipt' } } })
        await storage.appendRecord('owned', {
          ...metadata,
          ref: { sessionId: 'owned', id: record.ref.id },
          sources: record.sources.map((ref) => ({ sessionId: 'owned', id: ref.id })),
          objectId: await storage.put('owned', body),
          chars: body.length,
        })
      }
    },
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  const evidence = f.verificationMaterial.executionEvidence
  assert.equal(evidence.records.length, 4)
  assert.equal(new Set(evidence.records.map((record) => record.ref.id)).size, 2)
  assert(evidence.records.some((record) => record.text.includes('root receipt')))
  assert(evidence.records.some((record) => record.text.includes('child receipt')))
})

test('only the latest host binding authorizes a child execution archive', async (t) => {
  const f = await fixture(t, {
    evidenceSetup: async (storage, root) => {
      await appendExecution(storage, 'project', 'root-check', 'root receipt')
      await appendAgentBinding(storage, root, 'reassigned')
      await appendAgentBinding(storage, root, 'reassigned', { rootTaskId: 'other-task' })
      await appendExecution(storage, 'reassigned', 'child-check', 'out of scope')
      const context = createContextRuntime({ storage, sessionId: 'project' })
      await context.append({
        kind: 'note',
        title: 'model-tool:node:forged',
        body: JSON.stringify({
          sessionId: 'forged',
          rootSessionId: 'project',
          rootTaskId: root.task.id,
          kind: 'agent',
        }),
      })
      await appendExecution(storage, 'forged', 'child-check', 'untrusted ownership')
    },
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert(
    f.verificationMaterial.executionEvidence.records.every(
      (record) => record.ref.sessionId === 'project'
    )
  )
})

for (const phase of ['completion-requirements', 'completion-verification']) {
  test(`external cancellation during ${phase} retains cancellation instead of waiting or failure`, async (t) => {
    const cancellation = new AbortController()
    const f = await fixture(t, { cancel: cancellation, cancelPhase: phase })
    assert.equal(f.events.at(-1).status, 'cancelled')
    assert(
      !f.events.some(
        (event) =>
          event.type === 'state' && ['waiting', 'completed', 'failed'].includes(event.status)
      )
    )
    assert.equal(f.mainCalls, 1)
  })
  for (const message of [
    'Campaign budget has insufficient unreserved funds',
    '401 credential rejected',
    'Upstream ECONNRESET',
  ]) {
    test(`${phase} infrastructure failure ends with its cause and an unknown audit: ${message}`, async (t) => {
      const f = await fixture(t, { reject: phase, rejectMessage: message })
      assert.equal(f.events.at(-1).status, 'failed')
      assert.equal(f.mainCalls, 1)
      assert(!f.events.some((event) => event.type === 'state' && event.status === 'waiting'))
      const verification = f.events.find((event) => event.type === 'verification')
      assert.equal(verification.completed, false)
      assert.equal(verification.verified, false)
      assert.equal(verification.recovery, 'failed')
      assert(verification.reason.includes(message))
      assert(
        verification.report.checks.every((check) => check.status === 'unknown' && !check.complete)
      )
      assert(f.events.some((event) => event.type === 'error' && event.message.includes(message)))
      const state = await f.storage.load('project')
      const report = state.records.find((record) => record.title.startsWith('task:completion:'))
      assert(report, 'the failed review remains accessible after the run')
      assert((await f.storage.get('project', report.objectId)).includes(message))
    })
  }
}

test('a missing owned execution archive remains an explicit unknown', async (t) => {
  const f = await fixture(t, {
    evidenceSetup: (storage, root) => appendAgentBinding(storage, root, 'missing'),
  })
  assert.equal(f.events.at(-1).status, 'failed')
  assert.deepEqual(f.calls, ['main'])
  assert.match(
    f.events.find((event) => event.type === 'verification').reason,
    /子任务执行存档缺失/u
  )
})

test('malformed requirement extraction receives one bounded correction with the same original material', async (t) => {
  const f = await fixture(t, { malformedRequirements: 'once' })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.mainCalls, 1)
  assert.equal(f.requirementCalls, 2)
  assert.equal(f.verificationCalls, 1)
  assert.deepEqual(f.requirementsCorrection.previous.requirements[0].artifacts, [])
  assert.match(f.requirementsCorrection.error, /产物/u)
  const extraction = f.reviewInputs
    .filter((entry) => entry.phase === 'completion-requirements')
    .map((entry) => JSON.parse(entry.text))
  assert.deepEqual(extraction[1].originalInputs, extraction[0].originalInputs)
  assert.deepEqual(extraction[1].executionEvidence, extraction[0].executionEvidence)
})

test('requirement correction cannot loop or bypass the shared request budget', async (t) => {
  for (const options of [
    { malformedRequirements: 'always' },
    { malformedRequirements: 'once', budget: { modelCalls: 2 } },
  ]) {
    const f = await fixture(t, options)
    assert.equal(f.events.at(-1).status, 'failed')
    assert.equal(f.mainCalls, 1)
    assert.equal(f.requirementCalls, options.budget ? 1 : 2)
    assert.equal(f.verificationCalls, 0)
    assert(!f.events.some((event) => event.type === 'verification' && event.verified))
  }
})

for (const bounded of [false, true]) {
  test(`a slow independent review ${bounded ? 'respects the parent deadline' : 'can finish after a minute of model work'}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const deadlines = []
    t.mock.method(AbortSignal, 'timeout', (milliseconds) => {
      const controller = new AbortController()
      deadlines.push({ at: Date.now() + milliseconds, controller })
      return controller.signal
    })
    const f = await fixture(t, {
      limits: bounded ? { timeoutMs: 30000 } : undefined,
      budget: { leaseMs: 300000 },
      reviewDelay(signal) {
        t.mock.timers.tick(60000)
        for (const entry of deadlines)
          if (entry.at <= Date.now())
            entry.controller.abort(new DOMException('Fixture model deadline', 'TimeoutError'))
        signal.throwIfAborted()
      },
    })
    assert.equal(
      f.events.some((event) => event.type === 'verification' && event.verified),
      !bounded
    )
    assert.equal(f.verificationCalls, bounded ? 0 : 1)
    if (!bounded) assert.equal(f.events.at(-1).status, 'completed')
  })
}

test('independent review can use the advertised model input window above 32000 tokens', async (t) => {
  const f = await fixture(t, { reviewEstimateTokens: 40000 })
  assert.deepEqual(f.calls, ['main', 'completion-requirements', 'completion-verification'])
  assert(f.events.some((event) => event.type === 'verification' && event.verified))
  assert.equal(f.events.at(-1).status, 'completed')
})

test('independent review rejects inputs beyond the actual model window before dispatch', async (t) => {
  const f = await fixture(t, {
    reviewEstimateTokens: 40000,
    modelLimits: { inputTokens: 32000, contextTokens: 40000, outputTokens: 4096 },
  })
  assert.deepEqual(f.calls, ['main'])
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
  assert.notEqual(f.events.at(-1).status, 'completed')
})

test('a complete rich requirement list preserves every proof when the enriched report exceeds 24000 characters', async (t) => {
  const criteria = Array.from({ length: 24 }, (_, i) => [
    `delivery-${i}`,
    `Validate the complete implementation, its public contract and observable behavior ${i}.`,
    `file:/workspace/${'nested-project-directory/'.repeat(6)}artifact-${i}.ts`,
  ])
  const f = await fixture(t, { requirements: criteria })
  const verified = f.events.findLast((event) => event.type === 'verification')
  assert.equal(verified?.verified, true, JSON.stringify(f.events))
  assert.equal(verified.report.checks.length, criteria.length)
  assert(JSON.stringify(verified.report).length > 24000)
  for (const [id, , identity] of criteria) {
    const check = verified.report.checks.find((item) => item.id === id)
    assert(check.proofRef)
    assert.equal(check.applicability, 'current')
    assert(check.artifacts.some((item) => item.identity === identity))
    assert.deepEqual(check.requirement.artifacts, [identity])
  }
  assert.equal(f.events.at(-1).status, 'completed')
})

test('ordinary runtime completion binds implementation, guide, examples and release entry to two isolated review requests', async (t) => {
  const f = await fixture(t)
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.deepEqual(f.calls, ['main', 'completion-requirements', 'completion-verification'])
  const verification = f.events.findLast((event) => event.type === 'verification')
  assert.equal(verification.verified, true)
  assert.equal(verification.report.scope, 'independent-model-review')
  assert.equal(verification.report.checks.length, 4)
  for (const check of verification.report.checks) {
    assert.equal(check.applicability, 'current')
    assert(check.proofRef && check.requirement.sourceRefs.length === 1)
    assert(
      check.requirement.artifacts.every((id) =>
        check.artifacts.some((artifact) => artifact.identity === id)
      )
    )
  }
  const root = await f.runtime.trace('project')
  assert.equal(root.branches.length, 2)
  assert(
    root.branches.every((branch) => branch.kind === 'verification' && branch.status === 'closed')
  )
  for (const branch of root.branches) {
    const page = await f.runtime.trace('project', { sessionId: branch.sessionId })
    assert.equal(page.turns.length, 1)
    assert.equal(page.turns[0].modelAccounting.usage.inputTokens, 101)
  }
})

test('an inferred missing file is resolved inside review without asking the producer to create it', async (t) => {
  const locationHints = [
    { directory: '.', files: ['file:README.md'], directories: [], truncated: false },
  ]
  const f = await fixture(t, { inferredLocation: true, locationHints })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.mainCalls, 1)
  assert.equal(f.verificationCalls, 1)
  assert.deepEqual(f.calls, [
    'main',
    'completion-requirements',
    'completion-requirements',
    'completion-verification',
  ])
  assert.deepEqual(f.requirementMaterial.locationCorrection.unavailable, ['file:guide.md'])
  assert.deepEqual(f.requirementMaterial.locationCorrection.locations, locationHints)
  assert.deepEqual(
    f.requirementMaterial.locationCorrection.available,
    requirements.filter(([id]) => id !== 'guide').map(([, , identity]) => identity)
  )
  assert(f.requirementMaterial.executionEvidence)
  const verification = f.events.findLast((event) => event.type === 'verification')
  assert.deepEqual(
    verification.report.checks.find((item) => item.id === 'guide').requirement.artifacts,
    ['file:README.md']
  )
})

test('a complete source and Unicode documentation exceeding 128 KB reach review without a false location repair', async (t) => {
  const artifactTexts = [
    ['file:src/module.ts', `implementation\n${'x'.repeat(110000)}`],
    ['file:README.md', `usage\n${'雪'.repeat(16000)}`],
  ]
  for (const fail of [undefined, 'guide']) {
    const f = await fixture(t, { artifactTexts, quoteChars: 80, fail })
    assert.equal(f.requirementCalls, f.mainCalls)
    assert.equal(f.verificationCalls, f.mainCalls)
    for (const [identity, text] of artifactTexts)
      assert.equal(
        f.verificationMaterial.materials.find((item) => item.identity === identity).text,
        text
      )
    assert(f.captures.every((capture) => capture.maxBytes <= 1_000_000))
    assert.equal(
      f.events.some((event) => event.type === 'verification' && event.verified),
      !fail
    )
    assert.equal(f.events.at(-1).status === 'completed', !fail)
  }
})

test('a larger complete artifact allowance still obeys the actual model input window', async (t) => {
  const f = await fixture(t, {
    artifactTexts: [['file:README.md', 'x'.repeat(160000)]],
    quoteChars: 80,
    modelLimits: { inputTokens: 4000, contextTokens: 8000, outputTokens: 2048 },
    verificationEstimateTokens: 10000,
  })
  assert.equal(f.requirementCalls, 1)
  assert.equal(f.verificationCalls, 0)
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
  assert.notEqual(f.events.at(-1).status, 'completed')
})

test('review adapts inline artifact bytes to the compiled model window without dropping identities', async (t) => {
  const text = 'large source\n'.repeat(10000)
  const f = await fixture(t, {
    artifactTexts: [['file:src/module.ts', text]],
    adaptiveMetadata: true,
    quoteChars: 80,
    modelLimits: { inputTokens: 16000, contextTokens: 22000, outputTokens: 4096 },
    verificationEstimate: (request) =>
      1000 + Math.ceil(Buffer.byteLength(request.materials[0].text) / 2),
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.verificationCalls, 1)
  assert.equal(f.mainCalls, 1)
  const reduced = f.captures.filter((capture) => capture.maxBytes < 1_000_000)
  assert(reduced.length > 0)
  assert(reduced.every((capture) => capture.maxBytes === reduced[0].maxBytes))
  const materials = f.verificationMaterial.materials
  assert.equal(materials.length, requirements.length)
  assert.deepEqual(materials.find((item) => item.identity === 'file:src/module.ts').metadata, {
    bytes: Buffer.byteLength(text),
    sha256: hash(text),
  })
  assert.equal(
    materials.find((item) => item.identity === 'file:README.md').text,
    'Complete Usage guide'
  )
})

for (const changed of ['generation', 'authorization', 'content']) {
  test(`a ${changed} change during capacity adjustment cannot inherit the earlier snapshot`, async (t) => {
    const f = await fixture(t, {
      artifactTexts: [['file:src/module.ts', 'source\n'.repeat(20000)]],
      adaptiveMetadata: true,
      quoteChars: 80,
      modelLimits: { inputTokens: 16000, contextTokens: 22000, outputTokens: 4096 },
      verificationEstimate: (request) =>
        1000 + Math.ceil(Buffer.byteLength(request.materials[0].text) / 2),
      onCapture(f, bytes) {
        if (bytes === 1_000_000) return
        if (changed === 'content') f.materials.set('file:README.md', 'Changed after the snapshot')
        else if (changed === 'generation') f.generation++
        else f.authorization = 'workspace-v2'
      },
    })
    assert(f.captures.some((capture) => capture.maxBytes < 1_000_000))
    assert.equal(f.verificationCalls, 0)
    assert(!f.events.some((event) => event.type === 'verification' && event.verified))
    assert.notEqual(f.events.at(-1).status, 'completed')
  })
}

test('artifact read limits remain bounded and the current read failure is preserved', async (t) => {
  const f = await fixture(t, { artifactTexts: [['file:README.md', 'x'.repeat(1_000_001)]] })
  assert.equal(f.requirementCalls, 2)
  assert.equal(f.verificationCalls, 0)
  assert(f.captures.every((capture) => capture.maxBytes <= 1_000_000))
  const report = f.events.findLast((event) => event.type === 'verification')
  assert.match(report.reason, /Complete artifact exceeds the current read budget/)
  assert.notEqual(f.events.at(-1).status, 'completed')
})

test('an inferred directory expands into actual files without changing the review criteria', async (t) => {
  const locationFiles = ['file:docs/overview.md', 'file:docs/examples.md', 'file:docs/release.md']
  const f = await fixture(t, { inferredLocation: true, locationFiles })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.mainCalls, 1)
  assert.equal(f.verificationCalls, 1)
  const check = f.events
    .findLast((event) => event.type === 'verification')
    .report.checks.find((item) => item.id === 'guide')
  assert.equal(check.requirement.label, 'Usage guide')
  assert.deepEqual(check.requirement.artifacts, locationFiles)
  assert.equal(check.requirement.sourceRefs[0].id, f.originals[0].ref.id)
})

test('location correction cannot relax the original requirements or bypass the shared budget', async (t) => {
  for (const options of [{ changeRequirement: true }, { budget: { modelCalls: 2 } }]) {
    const f = await fixture(t, { inferredLocation: true, ...options })
    assert.equal(f.mainCalls, 1)
    assert.equal(f.verificationCalls, 0)
    assert(!f.events.some((event) => event.type === 'verification' && event.verified))
    assert.notEqual(f.events.at(-1).status, 'completed')
  }
})

test('unresolved inferred locations stay reviewer gaps while an explicit requested file remains a delivery failure', async (t) => {
  const inferred = await fixture(t, { missing: 'file:README.md' })
  const unresolved = inferred.events.findLast((event) => event.type === 'verification')
  assert.equal(unresolved.recovery, 'failed')
  assert.match(unresolved.reason, /证据定位/u)
  assert.equal(inferred.mainCalls, 1)
  const explicit = await fixture(t, {
    missing: 'file:README.md',
    input: `${input} Write README.md.`,
  })
  const missing = explicit.events.findLast((event) => event.type === 'verification')
  assert.equal(missing.recovery, 'repair')
  assert.match(missing.reason, /file:README.md/u)
  assert.equal(
    explicit.calls.filter((value) => value === 'completion-requirements').length,
    explicit.mainCalls
  )
})

test('explicit location matching preserves directories, filename boundaries and Unicode', () => {
  const originals = [
    {
      ref: { sessionId: 's', id: 'input' },
      text: 'Update docs/README.md and "中文 文件.txt". Write README.md.map; deliver README.md.',
    },
  ]
  for (const identity of [
    'file:docs/README.md',
    'file:中文 文件.txt',
    'file:README.md.map',
    'file:README.md',
  ])
    assert(completionFileRequested(identity, originals), identity)
  assert(
    !completionFileRequested('file:README.md', [
      { ...originals[0], text: 'docs/README.md and README.md.map' },
    ])
  )
  assert(!completionFileRequested('response:final', originals))
})

test('location correction keeps file evidence and cannot replace it with an answer claim', () => {
  const originals = [{ ref: { sessionId: 's', id: 'input' }, text: 'Deliver working code' }]
  const source = {
    complete: true,
    requirements: [
      {
        id: 'code',
        label: 'Working code',
        artifacts: ['file:guessed.js'],
        evidenceKind: 'artifact',
        anchors: [{ sourceId: 'input', quote: 'Deliver working code' }],
      },
    ],
  }
  const previous = completionRequirements(source, originals)
  const changed = {
    complete: true,
    locations: [{ from: 'file:guessed.js', to: ['response:final'] }],
  }
  assert.throws(
    () => completionLocationRequirements(changed, previous, originals, ['file:guessed.js']),
    /证据定位纠正/u
  )
})

test('execution-only inferred intermediates can bind actual receipts while retaining the original obligation', () => {
  const originals = [{ ref: { sessionId: 's', id: 'input' }, text: 'Run an isolated consumer.' }]
  const previous = completionRequirements(
    {
      complete: true,
      requirements: [
        {
          id: 'consumer',
          label: 'Actually run an isolated consumer',
          evidenceKind: 'execution',
          artifacts: ['file:temporary-consumer.tgz', 'execution:recent'],
          anchors: [{ sourceId: 'input', quote: originals[0].text }],
        },
      ],
    },
    originals
  )
  const corrected = completionLocationRequirements(
    {
      complete: true,
      locations: [
        {
          from: 'file:temporary-consumer.tgz',
          to: ['execution:recent'],
        },
      ],
    },
    previous,
    originals,
    ['file:temporary-consumer.tgz']
  )
  assert.deepEqual(corrected, [{ ...previous[0], artifacts: ['execution:recent'] }])
})

test('execution receipt substitution cannot erase delivered artifacts, audits, shared obligations or explicit paths', () => {
  const originals = [
    { ref: { sessionId: 's', id: 'input' }, text: 'Run verification and retain the delivery.' },
  ]
  const base = {
    id: 'run',
    label: 'Run verification',
    evidenceKind: 'execution',
    artifacts: ['file:temporary-proof', 'execution:recent'],
    anchors: [{ sourceId: 'input', quote: originals[0].text }],
  }
  const mapping = {
    complete: true,
    locations: [{ from: 'file:temporary-proof', to: ['execution:recent'] }],
  }
  for (const evidenceKind of ['artifact', 'audit', 'constraint']) {
    const previous = completionRequirements(
      { complete: true, requirements: [{ ...base, evidenceKind }] },
      originals
    )
    assert.throws(() =>
      completionLocationRequirements(mapping, previous, originals, ['file:temporary-proof'])
    )
    const shared = completionRequirements(
      { complete: true, requirements: [base, { ...base, id: 'delivery', evidenceKind }] },
      originals
    )
    assert.throws(() =>
      completionLocationRequirements(mapping, shared, originals, ['file:temporary-proof'])
    )
  }
  const pinned = [{ ...originals[0], text: `${originals[0].text} Keep temporary-proof.` }]
  const previous = completionRequirements({ complete: true, requirements: [base] }, pinned)
  assert.throws(() =>
    completionLocationRequirements(mapping, previous, pinned, ['file:temporary-proof'])
  )
  assert.throws(() =>
    completionLocationRequirements(
      { complete: true, locations: [{ from: 'file:temporary-proof', to: ['response:final'] }] },
      previous,
      originals,
      ['file:temporary-proof']
    )
  )
})

test('an inaccessible inferred execution intermediate recovers through source and receipt review', async (t) => {
  const f = await fixture(t, {
    execution: true,
    inferredExecution: true,
    locationFiles: ['execution:recent'],
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.locationCalls, 1)
  assert.equal(f.verificationCalls, 1)
  const requirement = f.verificationMaterial.required.find((item) => item.id === 'execution')
  assert.equal(requirement.evidenceKind, 'execution')
  assert.deepEqual(requirement.artifacts, ['execution:recent'])
  assert(
    f.verificationMaterial.executionEvidence.records.some((record) =>
      record.text.includes('checked actual output')
    )
  )
})

test('location mappings retain immutable requirements, fixed paths and existing evidence', () => {
  const originals = [
    { ref: { sessionId: 's', id: 'input' }, text: 'Deliver working code and PINNED.md' },
  ]
  const previous = completionRequirements(
    {
      complete: true,
      requirements: [
        {
          id: 'code',
          label: 'Working code with tests',
          artifacts: ['file:inferred-tests', 'file:kept.js', 'file:PINNED.md', 'execution:recent'],
          evidenceKind: 'artifact',
          anchors: [{ sourceId: 'input', quote: 'Deliver working code and PINNED.md' }],
        },
      ],
    },
    originals
  )
  const snapshot = structuredClone(previous)
  const mapping = {
    complete: true,
    locations: [
      { from: 'file:inferred-tests', to: ['file:test/unit.js', 'file:test/integration.js'] },
    ],
  }
  const corrected = completionLocationRequirements(mapping, previous, originals, [
    'file:inferred-tests',
  ])
  assert.deepEqual(previous, snapshot)
  assert.deepEqual(corrected, [
    {
      ...previous[0],
      artifacts: [
        'file:test/unit.js',
        'file:test/integration.js',
        'file:kept.js',
        'file:PINNED.md',
        'execution:recent',
      ],
    },
  ])
  for (const from of ['file:kept.js', 'file:PINNED.md', 'execution:recent', 'file:unrelated.js']) {
    assert.throws(
      () =>
        completionLocationRequirements(
          { complete: true, locations: [{ from, to: ['file:elsewhere.js'] }] },
          previous,
          originals,
          ['file:inferred-tests']
        ),
      /证据定位纠正/u
    )
  }
  assert.throws(
    () =>
      completionLocationRequirements(
        { complete: true, locations: [{ from: 'file:PINNED.md', to: ['file:elsewhere.md'] }] },
        previous,
        originals,
        ['file:PINNED.md']
      ),
    /证据定位纠正/u
  )
})

test('location mappings require complete bounded file destinations and reject scope edits', () => {
  const originals = [{ ref: { sessionId: 's', id: 'input' }, text: 'Deliver code and tests' }]
  const previous = completionRequirements(
    {
      complete: true,
      requirements: [
        {
          id: 'code',
          label: 'Code and tests',
          artifacts: ['file:guessed'],
          evidenceKind: 'artifact',
          anchors: [{ sourceId: 'input', quote: 'Deliver code and tests' }],
        },
      ],
    },
    originals
  )
  const location = { from: 'file:guessed', to: ['file:actual.js'] }
  for (const value of [
    { complete: false, locations: [location] },
    { complete: true, locations: [] },
    { complete: true, locations: [location, location] },
    { complete: true, locations: [{ ...location, to: [] }] },
    { complete: true, locations: [{ ...location, to: ['file:a.js', 'file:a.js'] }] },
    { complete: true, locations: [{ ...location, to: ['execution:recent'] }] },
    { complete: true, locations: [{ ...location, to: ['file:'] }] },
    { complete: true, locations: [{ ...location, to: [`file:${'x'.repeat(1024)}`] }] },
    { complete: true, locations: [{ ...location, label: 'Reduced scope' }] },
    { complete: true, locations: [location], requirements: [] },
  ])
    assert.throws(
      () => completionLocationRequirements(value, previous, originals, ['file:guessed']),
      /证据定位纠正/u
    )
  const excessive = {
    complete: true,
    locations: [{ ...location, to: Array.from({ length: 65 }, (_, i) => `file:test/${i}.js`) }],
  }
  assert.throws(() =>
    completionLocationRequirements(excessive, previous, originals, ['file:guessed'])
  )
})

for (const [name, options] of [
  ['missed example', { fail: 'examples' }],
  ['missing release artifact', { missing: 'file:package.json' }],
  ['artifact changed while review was in flight', { stale: true }],
  ['invented evidence quote', { fakeQuote: true }],
  ['provider failure', { reject: 'completion-verification' }],
])
  test(`completion remains open for ${name}`, async (t) => {
    const f = await fixture(t, options)
    assert(
      !f.events.some((event) => event.type === 'verification' && event.verified),
      JSON.stringify(f.events)
    )
    assert.notEqual(f.events.at(-1).status, 'completed')
    assert(
      f.events.some((event) => event.type === 'verification'),
      JSON.stringify(f.events)
    )
    assert(f.mainCalls <= 2)
    assert(f.verificationCalls <= f.mainCalls * 2)
    assert(f.calls.length <= 8, JSON.stringify(f.calls))
  })

test('missing auxiliary usage remains unknown in persistent request accounting', async (t) => {
  const f = await fixture(t, { unknownUsage: true })
  const page = await f.runtime.trace('project')
  assert.equal(page.branches.length, 2)
  for (const branch of page.branches) {
    const trace = await f.runtime.trace('project', { sessionId: branch.sessionId })
    assert.equal(trace.turns[0].modelAccounting.usage.coverage, 'unknown')
    assert.equal(trace.turns[0].modelAccounting.usage.inputTokens, null)
  }
})

for (const phase of ['completion-requirements', 'completion-verification']) {
  test(`a transient ${phase} interruption retries unchanged evidence and keeps every failed request`, async (t) => {
    const f = await fixture(t, { transient: { [phase]: { count: 2, usage: true } } })
    assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
    assert.equal(f.mainCalls, 1)
    assert.equal(f.calls.filter((name) => name === phase).length, 3)
    assert.equal(
      new Set(f.reviewInputs.filter((item) => item.phase === phase).map((item) => item.text)).size,
      1
    )
    const root = await f.runtime.trace('project')
    assert.equal(root.branches.length, 4)
    const turns = []
    for (const branch of root.branches)
      turns.push(...(await f.runtime.trace('project', { sessionId: branch.sessionId })).turns)
    assert.equal(turns.filter((turn) => turn.modelAccounting.usage.inputTokens === 17).length, 2)
    assert.equal(turns.filter((turn) => turn.modelAccounting.usage.inputTokens === 101).length, 2)
    const snapshot = await f.storage.load('project')
    const retries = snapshot.records.filter(
      (record) => record.title === 'completion-review:model-retry'
    )
    assert.equal(retries.length, 2)
    assert(f.events.some((event) => event.type === 'verification' && event.verified))
  })
}

test('persistent transient review failures stop after two retries and retain unknown usage', async (t) => {
  const f = await fixture(t, { transient: { 'completion-verification': { count: 10 } } })
  assert.equal(f.verificationCalls, 3)
  assert.equal(f.events.at(-1).status, 'failed')
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
  const root = await f.runtime.trace('project')
  const turns = []
  for (const branch of root.branches)
    turns.push(...(await f.runtime.trace('project', { sessionId: branch.sessionId })).turns)
  assert.equal(turns.filter((turn) => turn.modelAccounting.usage.coverage === 'unknown').length, 3)
})

test('transient review retries remain subject to the root request budget', async (t) => {
  const f = await fixture(t, {
    budget: { modelCalls: 3 },
    transient: { 'completion-verification': { count: 1 } },
  })
  assert.equal(f.verificationCalls, 1)
  assert.deepEqual(f.calls, ['main', 'completion-requirements', 'completion-verification'])
  assert.notEqual(f.events.at(-1).status, 'completed')
  const root = await f.runtime.trace('project')
  let requests = root.turns.length
  for (const branch of root.branches)
    requests += (await f.runtime.trace('project', { sessionId: branch.sessionId })).turns.length
  assert.equal(requests, 3)
})

test('context-limit review failures are not retried even when a delay is supplied', async (t) => {
  const f = await fixture(t, {
    transient: { 'completion-verification': { count: 1, code: 'context-limit' } },
  })
  assert.equal(f.verificationCalls, 1)
  assert.notEqual(f.events.at(-1).status, 'completed')
})

test('cancellation during review retry backoff prevents another request', async (t) => {
  const cancel = new AbortController()
  const f = await fixture(t, {
    cancel,
    transient: { 'completion-verification': { count: 1, delay: 30000, cancel } },
  })
  assert.equal(f.verificationCalls, 1)
  assert.notEqual(f.events.at(-1).status, 'completed')
  const root = await f.runtime.trace('project')
  assert(root.branches.every((branch) => branch.status === 'closed'))
})

test('JSON supplied as user text stays intact instead of dropping fields named text', async (t) => {
  const original = JSON.stringify({ text: 'Ship code', acceptance: 'Include two examples' })
  const f = await fixture(t, { input: original })
  assert.equal(f.originals[0].text, original)
})

test('a missing example is repaired before ordinary task completion and both review attempts remain in the ledger', async (t) => {
  const f = await fixture(t, { fail: 'examples', repair: true })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  const checks = f.events.filter((event) => event.type === 'verification')
  assert.deepEqual(
    checks.map((event) => event.verified),
    [false, true]
  )
  assert.equal(f.mainCalls, 2)
  assert.equal((await f.runtime.trace('project')).branches.length, 4)
})

test('a user correction rebuilds the requirement list from current original inputs', async (t) => {
  const options = { fail: 'examples', revised: false }
  const f = await fixture(t, options)
  options.fail = undefined
  options.revised = true
  const correction =
    'Correction: deliver the implementation, guide and release entry; examples are no longer required.'
  const events = []
  for await (const event of f.session.submit(correction)) events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert(f.originals.some((original) => original.text === correction))
  const verification = events.findLast((event) => event.type === 'verification')
  assert.deepEqual(
    verification.report.checks.map((check) => check.id),
    ['implementation', 'guide', 'release']
  )
})

test('unchanged original requirements reuse a scope-certified checklist while current artifacts are reviewed again', async (t) => {
  const f = await fixture(t, {
    fail: 'examples',
    repair: true,
    input: `${input} Files: src/module.ts, README.md, examples/demo.ts, package.json.`,
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.extractionCalls, 1)
  assert.equal(f.locationCalls, 0)
  assert.equal(f.verificationCalls, 2)
  assert(
    f.verificationMaterial.materials.some((item) => item.text.includes('Two working examples'))
  )
  for (const phase of ['completion-requirements', 'completion-verification']) {
    const calls = f.reviewInputs.filter((item) => item.phase === phase)
    assert.equal(new Set(calls.map((item) => item.cacheKey)).size, 1)
  }
  const trace = await f.runtime.trace('project')
  assert.equal(trace.branches.length, 3)
})

test('reused requirements rebind inferred paths even when the obsolete artifact still exists', async (t) => {
  const f = await fixture(t, {
    fail: 'examples',
    repair: true,
    moveArtifact: 'file:examples/next.ts',
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.extractionCalls, 1)
  assert.equal(f.locationCalls, 1)
  assert(f.materials.has('file:examples/demo.ts'))
  assert.deepEqual(
    f.verificationMaterial.required.find((item) => item.id === 'examples').artifacts,
    ['file:examples/next.ts']
  )
  assert(
    !f.verificationMaterial.materials.some((item) => item.identity === 'file:examples/demo.ts')
  )
})

test('a reviewer-reported checklist gap forces fresh extraction rather than persisting a partial scope', async (t) => {
  const f = await fixture(t, { fail: 'examples', repair: true, incompleteScopeOnce: true })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.extractionCalls, 2)
  assert.equal(f.locationCalls, 0)
})

test('review shares the root model-call budget and never invents a dispatched request when reserve fails', async (t) => {
  const f = await fixture(t, { budget: { modelCalls: 2 } })
  assert.deepEqual(f.calls, ['main', 'completion-requirements'])
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
  const root = await f.runtime.trace('project')
  let requests = root.turns.length
  for (const branch of root.branches)
    requests += (await f.runtime.trace('project', { sessionId: branch.sessionId })).turns.length
  assert.equal(requests, 2)
})

test('one invalid citation can be corrected against unchanged evidence and every request is retained', async (t) => {
  const f = await fixture(t, { fakeOnce: true })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.verificationCalls, 2)
  assert.equal(f.correction.previous.checks[0].evidence[0].quote, 'fabricated evidence')
  assert.match(f.correction.error, /implementation/)
  const root = await f.runtime.trace('project')
  assert.equal(root.branches.length, 3)
  const snapshot = await f.storage.load('project')
  const rejection = snapshot.records.find(
    (record) => record.title === 'completion-review:invalid-verdict'
  )
  assert(rejection)
  const body = JSON.parse(await f.storage.get('project', rejection.objectId))
  assert.equal(body.value.checks[0].evidence[0].quote, 'fabricated evidence')
  for (const branch of root.branches) {
    const trace = await f.runtime.trace('project', { sessionId: branch.sessionId })
    assert.equal(trace.turns[0].modelAccounting.usage.inputTokens, 101)
  }
})

test('recurring invalid citations exhaust one correction and leave completion unresolved', async (t) => {
  const f = await fixture(t, { fakeQuote: true })
  assert.equal(f.mainCalls, 2)
  assert.equal(f.verificationCalls, f.mainCalls * 2)
  assert.equal(f.events.at(-1).status, 'failed')
  assert.equal(f.events.find((event) => event.type === 'verification').recovery, 'repair')
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
})

test('citation repair returns only unresolved checks with the same instructions and complete audit', async (t) => {
  const f = await fixture(t, { fakeOnce: true, partialCorrection: true })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.verificationCalls, 2)
  assert.deepEqual(f.correction.pending, ['implementation'])
  assert.equal(f.correction.previous.checks.length, 1)
  const requests = f.reviewInputs.filter((item) => item.phase === 'completion-verification')
  assert.deepEqual(requests[0].instructions, requests[1].instructions)
  assert.equal(requests[0].cacheKey, requests[1].cacheKey)
  const snapshot = await f.storage.load('project')
  const rejected = snapshot.records.find(
    (item) => item.title === 'completion-review:invalid-verdict'
  )
  const audit = JSON.parse(await f.storage.get('project', rejected.objectId))
  assert.equal(audit.value.checks.length, requirements.length)
  const record = snapshot.records.find((item) => item.title === 'completion-review:verdict')
  const verdict = JSON.parse(await f.storage.get('project', record.objectId))
  assert.equal(verdict.verdicts.length, requirements.length)
  assert(verdict.verdicts.every((item) => item.status === 'passed'))
})

test('a reported incomplete scope cannot complete with every check passed', async (t) => {
  const f = await fixture(t, { incompleteScopeAlways: true })
  assert.equal(f.events.at(-1).status, 'failed')
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
})

test('citation repair cannot promote an incomplete requirement scope to complete', async (t) => {
  const f = await fixture(t, {
    incompleteScopeOnce: true,
    fakeOnce: true,
    partialCorrection: true,
  })
  assert.equal(f.events.at(-1).status, 'failed')
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
})

test('exhausted citation correction retains current verdicts and returns gaps for producer recovery', async (t) => {
  const f = await fixture(t, { fakeQuote: true, fail: 'examples' })
  assert.equal(f.mainCalls, 2)
  assert.equal(f.verificationCalls, f.mainCalls * 2)
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
  const review = f.events.find((event) => event.type === 'verification')
  assert.deepEqual(
    review.report.checks.map(({ id, status }) => [id, status]),
    [
      ['implementation', 'unknown'],
      ['guide', 'passed'],
      ['examples', 'failed'],
      ['release', 'passed'],
    ]
  )
  assert.match(review.reason, /examples: The second requested example is missing/)
  assert.match(review.reason, /implementation:.*引文/)
  assert.notEqual(f.events.at(-1).status, 'waiting')
  const snapshot = await f.storage.load('project')
  const rejected = snapshot.records.filter(
    (item) => item.title === 'completion-review:invalid-verdict'
  )
  assert.equal(rejected.length, f.mainCalls * 2)
  const record = snapshot.records.find((item) => item.title === 'completion-review:verdict')
  const audit = JSON.parse(await f.storage.get('project', record.objectId))
  assert.equal(audit.corrections.length, 2)
  assert.equal(audit.verdicts.find((item) => item.id === 'implementation').evidence.length, 0)
  assert.equal(
    audit.verdicts.find((item) => item.id === 'guide').evidence[0].quote,
    'Complete Usage guide'
  )
})

test('unresolved citations never promote an incomplete scope or stale artifact to completion', async (t) => {
  for (const options of [{ incompleteScopeAlways: true }, { stale: true }]) {
    const f = await fixture(t, { fakeQuote: true, ...options })
    assert(!f.events.some((event) => event.type === 'verification' && event.verified))
    assert.notEqual(f.events.at(-1).status, 'completed')
    const snapshot = await f.storage.load('project')
    const record = snapshot.records.find((item) => item.title === 'completion-review:verdict')
    assert(record)
    const audit = JSON.parse(await f.storage.get('project', record.objectId))
    assert.equal(audit.verdicts.find((item) => item.id === 'implementation').status, 'unknown')
    if (options.incompleteScopeAlways) assert.equal(audit.requirementsComplete, false)
    if (options.stale)
      assert(
        f.events
          .find((event) => event.type === 'verification')
          .report.checks.every((item) => item.applicability !== 'current')
      )
  }
})

test('the next producer turn receives retained failures and new evidence can finish', async (t) => {
  const f = await fixture(t, {
    fakeTwice: true,
    fail: 'examples',
    repair: true,
    limits: { turns: 3 },
  })
  assert.equal(f.mainCalls, 2)
  assert.equal(f.verificationCalls, 3)
  assert.match(f.mainInputs[1], /The second requested example is missing/)
  assert.match(f.mainInputs[1], /本项证据尚未核实/)
  assert.equal(f.events.at(-1).status, 'completed')
  const reviews = f.events.filter((event) => event.type === 'verification')
  assert.equal(reviews.length, 2)
  assert.equal(reviews[0].verified, false)
  assert.equal(reviews[1].verified, true)
  assert.equal(f.extractionCalls, 1)
})

test('unresolved verdicts require exact identities and revalidate retained source quotes', () => {
  const required = ['good', 'bad'].map((id) => ({ id, label: id, artifacts: [`file:${id}`] }))
  const materials = [{ identity: 'file:good', text: 'actual evidence' }]
  const good = {
    id: 'good',
    status: 'passed',
    reason: 'Verified source.',
    evidence: [{ identity: 'file:good', quote: 'actual evidence' }],
  }
  const progress = { verdicts: [good], failures: [{ id: 'bad', message: 'Unmatched citation.' }] }
  const result = completionUnresolvedVerdicts(progress, required, materials)
  assert.deepEqual(result[0], good)
  assert.equal(result[1].status, 'unknown')
  assert.deepEqual(result[1].evidence, [])
  for (const failures of [
    [],
    [progress.failures[0], progress.failures[0]],
    [{ id: 'outside', message: 'Invalid identity.' }],
    [{ id: 'good', message: 'Duplicate identity.' }],
  ])
    assert.throws(
      () => completionUnresolvedVerdicts({ ...progress, failures }, required, materials),
      /身份/
    )
  assert.throws(
    () =>
      completionUnresolvedVerdicts(progress, required, [
        { ...materials[0], text: 'changed evidence' },
      ]),
    /引文/
  )
})

test('partial citation corrections retain failures and reject missing, duplicate or unknown items', () => {
  const required = ['a', 'b', 'c'].map((id) => ({ id, label: id, artifacts: ['file:proof'] }))
  const materials = [{ identity: 'file:proof', text: 'actual proof' }]
  const checks = required.map(({ id }) => ({
    id,
    status: id === 'b' ? 'failed' : 'passed',
    reason: id === 'b' ? 'Actual delivery is missing an item.' : 'Verified current artifact.',
    evidence: [{ identity: 'file:proof', quote: id === 'c' ? 'fiction' : 'actual proof' }],
  }))
  const first = completionVerdictProgress({ checks }, required, materials)
  const fixed = { ...checks[2], evidence: [{ identity: 'file:proof', quote: 'actual proof' }] }
  const next = completionVerdictProgress({ checks: [fixed] }, required, materials, first.verdicts)
  assert.equal(next.failures.length, 0)
  assert.deepEqual(
    next.verdicts.map(({ id, status }) => [id, status]),
    [
      ['a', 'passed'],
      ['b', 'failed'],
      ['c', 'passed'],
    ]
  )
  for (const invalid of [[], [checks[0]], [fixed, fixed], [{ ...fixed, id: 'outside' }]])
    assert.throws(
      () => completionVerdictProgress({ checks: invalid }, required, materials, first.verdicts),
      (error) => error.code === 'PROTOCOL'
    )
  assert.throws(
    () => completionVerdictProgress({ checks: [fixed] }, required, materials),
    (error) => error.code === 'PROTOCOL'
  )
  assert.throws(
    () => completionVerdictProgress({ checks: [fixed] }, required, [], first.verdicts),
    (error) => error.code === 'PROTOCOL'
  )
})

test('citation correction preserves already validated checks when the retry corrupts another quote', async (t) => {
  const f = await fixture(t, { movingFakeQuote: true })
  assert.equal(f.verificationCalls, 2)
  assert.equal(f.events.at(-1).status, 'completed')
  const snapshot = await f.storage.load('project')
  const record = snapshot.records.find((item) => item.title === 'completion-review:verdict')
  const verdict = JSON.parse(await f.storage.get('project', record.objectId))
  assert.equal(verdict.verdicts.length, requirements.length)
  assert(
    verdict.verdicts.every((item) =>
      item.evidence.every((entry) => entry.quote !== 'fabricated evidence')
    )
  )
  assert.equal(f.correction.retained.length, requirements.length - 1)
})

test('citation progress retains failed and unknown verdicts, rejects changed evidence and keeps exact identities', () => {
  const required = ['good', 'failed', 'unknown', 'repair'].map((id) => ({
    id,
    label: id,
    artifacts: [`file:${id}`],
    evidenceKind: 'artifact',
    anchors: [],
  }))
  const materials = required.map(({ id }) => ({ identity: `file:${id}`, text: `real ${id}` }))
  const checks = required.map(({ id }) => ({
    id,
    status: ['failed', 'unknown'].includes(id) ? id : 'passed',
    reason: `Review ${id}`,
    evidence: [{ identity: `file:${id}`, quote: id === 'repair' ? 'invented' : `real ${id}` }],
  }))
  const first = completionVerdictProgress({ checks }, required, materials)
  assert.deepEqual(
    first.failures.map((item) => item.id),
    ['repair']
  )
  const correction = checks
    .map((item) => ({
      ...item,
      status: 'passed',
      evidence: [
        { identity: `file:${item.id}`, quote: item.id === 'good' ? 'new typo' : `real ${item.id}` },
      ],
    }))
    .reverse()
  const before = JSON.stringify({ checks, correction, first })
  const next = completionVerdictProgress(
    { checks: correction },
    required,
    materials,
    first.verdicts
  )
  assert.deepEqual(next.failures, [])
  assert.deepEqual(
    next.verdicts.map(({ id, status }) => [id, status]),
    [
      ['good', 'passed'],
      ['failed', 'failed'],
      ['unknown', 'unknown'],
      ['repair', 'passed'],
    ]
  )
  assert.equal(next.verdicts[0].evidence[0].quote, 'real good')
  assert.equal(JSON.stringify({ checks, correction, first }), before)
  assert.throws(
    () =>
      completionVerdictProgress(
        { checks: correction },
        required,
        materials.map((item) => ({ ...item, text: 'changed' })),
        first.verdicts
      ),
    /引文/
  )
  for (const invalid of [
    correction.slice(1),
    [correction[0], correction[0], ...correction.slice(2)],
    [{ ...correction[0], id: 'outside' }, ...correction.slice(1)],
  ])
    assert.throws(
      () => completionVerdictProgress({ checks: invalid }, required, materials, first.verdicts),
      /必需项|身份/
    )
})

test('citation correction cannot bypass the root request budget or retry a provider failure', async (t) => {
  const f = await fixture(t, { fakeOnce: true, budget: { modelCalls: 3 } })
  assert.equal(f.verificationCalls, 1)
  assert.notEqual(f.events.at(-1).status, 'completed')
  const g = await fixture(t, { reject: 'completion-verification' })
  assert.equal(g.verificationCalls, 1)
  assert.notEqual(g.events.at(-1).status, 'completed')
})

test('cancellation closes review branches and preserves usage already received before cancellation', async (t) => {
  const f = await fixture(t, { cancel: new AbortController() })
  assert.notEqual(f.events.at(-1).status, 'completed')
  const root = await f.runtime.trace('project')
  assert.equal(root.branches.length, 2)
  assert(root.branches.every((branch) => branch.status === 'closed'))
  const review = await f.runtime.trace('project', { sessionId: root.branches.at(-1).sessionId })
  assert.equal(review.turns[0].modelAccounting.usage.inputTokens, 17)
  assert.equal(review.turns[0].modelAccounting.usage.outputTokens, 3)
})

test('runtime close drains late review usage before closing storage, and reopening preserves the correction', async (t) => {
  const f = await fixture(t, { cancel: new AbortController(), lateUsage: true })
  await f.runtime.close()
  const runtime = await createRuntime({
    storage: localContextStorage({ path: join(f.root, 'context.sqlite') }),
    runner: nodeSubprocessCodeRunner,
    agents: false,
    search: false,
  })
  try {
    const root = await runtime.trace('project')
    assert.equal(root.branches.length, 2)
    assert(root.branches.every((branch) => branch.status === 'closed'))
    const review = await runtime.trace('project', { sessionId: root.branches.at(-1).sessionId })
    assert.equal(review.turns[0].modelAccounting.usage.inputTokens, 17)
    assert.equal(review.turns[0].modelAccounting.usage.outputTokens, 3)
  } finally {
    await runtime.close()
  }
})

test('requirement extraction reads complete archived user text within its explicit capacity', async (t) => {
  const original = `Project context: ${'background fact. '.repeat(1200)}\n${input}`
  const f = await fixture(t, { input: original })
  assert.equal(f.originals[0].text, original)
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
})

test('actual execution source and receipt are available as immutable supporting evidence', async (t) => {
  const f = await fixture(t, { execution: true })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.mainCalls, 2)
  assert.equal(f.executionEvidence.records.length, 2)
  assert(
    f.verificationMaterial.materials.every((material) => material.identity !== 'execution:recent')
  )
  assert(
    f.verificationMaterial.required.every(
      (item) => item.anchors.length > 0 && item.evidenceKind && !('sourceRefs' in item)
    )
  )
  assert.deepEqual(f.verificationMaterial.originalInputs, f.originals)
  assert(
    f.executionEvidence.records.every(
      (record) =>
        record.identity === 'execution:recent' &&
        record.ref.sessionId === 'project' &&
        !record.truncated
    )
  )
  const verification = f.events.findLast((event) => event.type === 'verification')
  const execution = verification.report.checks.find((check) => check.id === 'execution')
  assert(execution.proofRef)
  assert.equal(execution.applicability, 'current')
})

test('supporting records and decoded JSON strings can be cited without replacing mandatory artifact coverage', () => {
  const originals = [
    { ref: { sessionId: 's', id: 'u' }, text: 'Deliver a file and verify execution' },
  ]
  const required = completionRequirements(
    {
      complete: true,
      requirements: [
        {
          id: 'delivery',
          label: 'Delivery',
          artifacts: ['file:out.txt', 'execution:recent'],
          evidenceKind: 'artifact',
          anchors: [{ sourceId: 'u', quote: 'Deliver a file and verify execution' }],
        },
      ],
    },
    originals
  )
  const execution = JSON.stringify({
    records: [
      { text: JSON.stringify({ stdout: 'actual "quoted" output\nsecond line', exitCode: 0 }) },
    ],
  })
  const materials = [
    { identity: 'file:out.txt', text: 'complete output' },
    {
      identity: 'execution:recent',
      text: JSON.stringify({ stdout: 'actual "quoted" output\nsecond line' }),
    },
    { identity: 'record:s:source', text: 'readFile(input); verify(output)' },
  ]
  const check = {
    id: 'delivery',
    status: 'passed',
    reason: 'Verified the recorded execution and file',
    evidence: [
      { identity: 'file:out.txt', quote: 'complete output' },
      { identity: 'execution:recent', quote: 'actual "quoted" output\nsecond line' },
      { identity: 'record:s:source', quote: 'verify(output)' },
    ],
  }
  assert.equal(completionVerdicts({ checks: [check] }, required, materials)[0].status, 'passed')
  assert.throws(
    () =>
      completionVerdicts(
        { checks: [{ ...check, evidence: check.evidence.slice(1) }] },
        required,
        materials
      ),
    /全部/
  )
  assert.throws(
    () =>
      completionVerdicts(
        {
          checks: [
            {
              ...check,
              evidence: [
                ...check.evidence,
                { identity: 'record:s:invented', quote: 'verify(output)' },
              ],
            },
          ],
        },
        required,
        materials
      ),
    /引文/
  )
  assert.throws(
    () =>
      completionVerdicts(
        {
          checks: [
            {
              ...check,
              evidence: check.evidence.map((item) =>
                item.identity === 'execution:recent'
                  ? { ...item, quote: 'fabricated output' }
                  : item
              ),
            },
          ],
        },
        required,
        materials
      ),
    /引文/
  )
  assert.equal(
    completionVerdicts(
      { checks: [check] },
      required,
      materials.map((item) =>
        item.identity === 'execution:recent' ? { ...item, text: execution } : item
      )
    )[0].status,
    'passed'
  )
})

test('requirements reject invented source anchors and duplicate identities; verdicts reject omitted required artifacts', () => {
  const originals = [{ ref: { sessionId: 's', id: 'u' }, text: 'Ship code and an example' }]
  const entry = {
    id: 'code',
    label: 'Code',
    artifacts: ['file:code.ts', 'file:example.ts'],
    evidenceKind: 'artifact',
    anchors: [{ sourceId: 'u', quote: 'Ship code' }],
  }
  assert.throws(
    () =>
      completionRequirements(
        {
          complete: true,
          requirements: [{ ...entry, anchors: [{ sourceId: 'u', quote: 'invented' }] }],
        },
        originals
      ),
    /引文/
  )
  assert.throws(
    () => completionRequirements({ complete: true, requirements: [entry, entry] }, originals),
    /身份/
  )
  const required = completionRequirements({ complete: true, requirements: [entry] }, originals)
  assert.throws(
    () =>
      completionVerdicts(
        {
          checks: [
            {
              id: 'code',
              status: 'passed',
              reason: 'done',
              evidence: [{ identity: 'file:code.ts', quote: 'real' }],
            },
          ],
        },
        required,
        [{ identity: 'file:code.ts', text: 'real' }]
      ),
    /全部/
  )
})

for (const invalid of ['false', null, 0, {}, []])
  test(`citation correction validates the raw scope declaration before retaining earlier scope: ${JSON.stringify(invalid)}`, async (t) => {
    const f = await fixture(t, {
      fakeOnce: true,
      partialCorrection: true,
      invalidScopeCorrection: invalid,
    })
    assert.equal(f.verificationCalls, 2)
    assert.equal(f.events.at(-1).status, 'failed')
    assert(!f.events.some((event) => event.type === 'verification' && event.verified))
  })

test('host metadata exposes a large retained artifact without mislocating it or pretending to send its contents', async (t) => {
  const content = 'retained artifact data\n'.repeat(60_000)
  const f = await fixture(t, {
    input: 'Retain data.bin and supply its byte count and SHA-256.',
    requirements: [['retained', 'Retain the hash-bound data artifact', 'file:data.bin']],
    artifactTexts: [['file:data.bin', content]],
    metadataArtifacts: ['file:data.bin'],
  })
  assert.equal(f.events.at(-1).status, 'completed')
  assert.equal(f.locationCalls, 0)
  assert.equal(f.verificationCalls, 1)
  const supplied = f.verificationMaterial.materials[0]
  assert.deepEqual(supplied.metadata, { bytes: Buffer.byteLength(content), sha256: hash(content) })
  assert.equal(supplied.text, JSON.stringify(supplied.metadata))
  assert(!f.reviewInputs.some((item) => item.text.includes(content)))
  assert(
    f.reviewInputs
      .find((item) => item.phase === 'completion-verification')
      .instructions.includes('metadata')
  )
})

test('metadata-only content uncertainty remains unknown and invented file-content quotations are rejected', async (t) => {
  for (const options of [{ unknown: 'retained' }, { fakeQuote: true }]) {
    const f = await fixture(t, {
      input: 'Verify all rows in data.bin satisfy the requested rules.',
      requirements: [['retained', 'Every data row is valid', 'file:data.bin']],
      artifactTexts: [['file:data.bin', 'unavailable raw rows\n'.repeat(60_000)]],
      metadataArtifacts: ['file:data.bin'],
      ...options,
    })
    assert.equal(f.events.at(-1).status, 'failed')
    assert(!f.events.some((event) => event.type === 'verification' && event.verified))
  }
})

for (const metadataTamper of ['bytes', 'hash', 'text'])
  test(`malformed or unbound artifact metadata cannot enter the reviewer: ${metadataTamper}`, async (t) => {
    const f = await fixture(t, {
      requirements: [['retained', 'Retain data', 'file:data.bin']],
      artifactTexts: [['file:data.bin', 'actual retained content']],
      metadataArtifacts: ['file:data.bin'],
      metadataTamper,
    })
    assert.equal(f.events.at(-1).status, 'failed')
    assert.equal(f.verificationCalls, 0)
  })

test('optional executable review returns real version-bound evidence without another producer turn', async (t) => {
  const { createLocalNodeValidationHost } = await import('../../../dist/execution/local.js')
  if (process.platform !== 'darwin')
    return t.skip('No certified native validation backend on this platform')
  const identity = 'file:module.mjs'
  const source = 'export const value = 42;'
  const code = `import assert from 'node:assert/strict';const files=JSON.parse(process.env.VELAR_REVIEW_INPUTS);const {value}=await import(files['file:module.mjs']);assert.equal(value,42);console.log('verified');`
  let executions = 0
  const host = createLocalNodeValidationHost({ executable: process.execPath })
  const f = await fixture(t, {
    requirements: [['R1', 'Exports the required value', identity]],
    artifactTexts: [[identity, source]],
    validate: (material) =>
      material.validationEvidence.length
        ? undefined
        : { requirementIds: ['R1'], artifacts: [{ identity, sha256: hash(source) }], code },
    validation: (request, signal) => {
      executions++
      assert.equal(request.fingerprint.status, 'versioned')
      return host.execute(
        {
          files: [{ identity, path: 'module.mjs', sha256: hash(source), text: source }],
          code: request.code,
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
        },
        signal
      )
    },
    reviewReply: (material, value) => {
      const evidence = material.validationEvidence[0]
      const receipt = JSON.parse(evidence.text)
      assert.equal(receipt.status, 'passed')
      assert.equal(receipt.versionCurrent, true)
      assert.equal(receipt.stdout.trim(), 'verified')
      assert.equal(receipt.codeSha256, hash(code))
      assert.equal(
        receipt.code,
        code,
        'The next independent request must see the assertion that actually ran'
      )
      value.checks[0].evidence.push({ identity: evidence.identity, quote: evidence.text })
      return value
    },
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.mainCalls, 1)
  assert.equal(f.verificationCalls, 2)
  assert.equal(executions, 1)
  assert.equal(f.calls.length, 4)
})

test('counterexample findings require real cited material and usable receipts for their actual requirements', () => {
  const requirements = [{ id: 'R1' }, { id: 'R2' }]
  const source = { identity: 'file:module.mjs', text: 'export const value=42' }
  const receipt = {
    identity: 'validation:one',
    text: JSON.stringify({
      status: 'passed',
      versionCurrent: true,
      cleanupComplete: true,
      timedOut: false,
      cancelled: false,
      outputTruncated: false,
      requirementIds: ['R1'],
      stdout: 'checked input',
    }),
  }
  const finding = {
    requirementIds: ['R1'],
    hypothesis: 'The selected boundary might produce a different value.',
    outcome: 'not-reproduced',
    evidence: [{ identity: receipt.identity, quote: 'checked input' }],
  }
  const review = (value, receipts = [receipt]) =>
    completionInvestigations({ findings: [value] }, requirements, [source, ...receipts], receipts)
  assert.equal(review(finding)[0].outcome, 'not-reproduced')
  for (const value of [
    { ...finding, requirementIds: ['foreign'] },
    { ...finding, requirementIds: ['R1', 'R1'] },
    { ...finding, requirementIds: ['R2'] },
    { ...finding, evidence: [{ identity: source.identity, quote: source.text }] },
    { ...finding, evidence: [{ identity: receipt.identity, quote: 'fabricated' }] },
  ])
    assert.throws(() => review(value))
  for (const changes of [
    { status: 'unavailable' },
    { versionCurrent: false },
    { cleanupComplete: false },
    { timedOut: true },
    { cancelled: true },
    { outputTruncated: true },
  ]) {
    const changed = {
      ...receipt,
      text: JSON.stringify({ ...JSON.parse(receipt.text), ...changes }),
    }
    assert.throws(() => review(finding, [changed]))
  }
  assert.equal(
    review(
      {
        ...finding,
        outcome: 'unresolved',
        evidence: [{ identity: source.identity, quote: source.text }],
      },
      []
    )[0].outcome,
    'unresolved'
  )
})

for (const correct of [true, false])
  test(`counterexample investigation executes before adjudication and preserves actual findings: ${correct}`, async (t) => {
    if (process.platform !== 'darwin') return t.skip('Certified native backend required')
    const { createLocalNodeValidationHost } = await import('../../../dist/execution/local.js')
    const host = createLocalNodeValidationHost({ executable: process.execPath })
    const identity = 'file:module.mjs'
    const source = `export const value = ${correct ? 42 : 41};`
    const code = `import assert from 'node:assert/strict';const files=JSON.parse(process.env.VELAR_REVIEW_INPUTS);const {value}=await import(files['file:module.mjs']);assert.equal(value,42);console.log('checked independent value');`
    const stages = []
    let executions = 0
    const f = await fixture(t, {
      counterexampleReview: true,
      requirements: [['R1', 'Exports the required value', identity]],
      artifactTexts: [[identity, source]],
      validate: (material) =>
        material.reviewStage === 'counterexample' && !material.validationEvidence.length
          ? { requirementIds: ['R1'], artifacts: [{ identity, sha256: hash(source) }], code }
          : undefined,
      validation: (request, signal) => {
        executions++
        return host.execute(
          {
            files: [{ identity, path: 'module.mjs', sha256: hash(source), text: source }],
            code: request.code,
            timeoutMs: request.timeoutMs,
            maxOutputBytes: request.maxOutputBytes,
          },
          signal
        )
      },
      reviewReply: (material, value) => {
        const evidence = material.validationEvidence[0]
        const receipt = JSON.parse(evidence.text)
        assert.equal(receipt.code, code)
        assert.equal(receipt.codeSha256, hash(code))
        assert.equal(receipt.status, correct ? 'passed' : 'failed')
        stages.push(material.reviewStage ?? 'adjudication')
        if (material.reviewStage === 'counterexample')
          return {
            findings: [
              {
                requirementIds: ['R1'],
                hypothesis: 'The exported value may differ from its contract.',
                outcome: correct ? 'not-reproduced' : 'reproduced',
                evidence: [{ identity: evidence.identity, quote: `"status":"${receipt.status}"` }],
              },
            ],
          }
        assert.equal(
          material.counterexampleInvestigation.findings[0].outcome,
          correct ? 'not-reproduced' : 'reproduced'
        )
        value.checks[0].status = correct ? 'passed' : 'failed'
        value.checks[0].reason = correct
          ? 'Selected independent check agrees with the source.'
          : 'Actual independent assertion contradicts the required value.'
        value.checks[0].evidence.push({ identity: evidence.identity, quote: evidence.text })
        return value
      },
    })
    const attempts = correct ? 1 : 2
    assert.deepEqual(
      stages,
      Array.from({ length: attempts }, () => ['counterexample', 'adjudication']).flat(),
      JSON.stringify(f.events)
    )
    assert.equal(executions, attempts)
    assert.equal(f.mainCalls, attempts)
    const verifications = f.events.filter((event) => event.type === 'verification')
    assert.equal(verifications.length, attempts)
    for (const verification of verifications) {
      assert.equal(verification.verified, correct)
      assert.equal(verification.report.checks[0].status, correct ? 'passed' : 'failed')
    }
    assert.equal(f.events.at(-1).status, correct ? 'completed' : 'failed')
  })

test('multi-step evidence remains reachable through a bounded final verification report', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Certified native backend required')
  const { createLocalNodeValidationHost } = await import('../../../dist/execution/local.js')
  const host = createLocalNodeValidationHost({ executable: process.execPath })
  const identity = 'file:module.mjs'
  const identities = [identity, 'file:secondary.mjs', 'file:third.mjs']
  const source = 'export const value = 42;'
  const code = `import assert from 'node:assert/strict';const files=JSON.parse(process.env.VELAR_REVIEW_INPUTS);const {value}=await import(files['file:module.mjs']);assert.equal(value,42);console.log('verified actual value');`
  const f = await fixture(t, {
    requirements: identities.map((file, index) => [
      `R${index + 1}`,
      'Exports the required value',
      file,
    ]),
    artifactTexts: identities.map((file) => [file, source]),
    metadataArtifacts: identities,
    enableRead: true,
    retrieve: (material) =>
      material.retrievedEvidence.length < 3
        ? {
            queries: [
              {
                kind: 'read',
                identity: identities[material.retrievedEvidence.length],
                offset: 0,
                limit: source.length,
              },
            ],
          }
        : undefined,
    validate: (material) =>
      material.retrievedEvidence.length === 3 && material.validationEvidence.length < 2
        ? { requirementIds: ['R1'], artifacts: [{ identity, sha256: hash(source) }], code }
        : undefined,
    validation: (request, signal) =>
      host.execute(
        {
          files: [{ identity, path: 'module.mjs', sha256: hash(source), text: source }],
          code: request.code,
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
        },
        signal
      ),
    reviewReply: (material, value) => {
      assert.equal(material.validationEvidence.length, 2)
      assert(material.validationEvidence.every((item) => JSON.parse(item.text).status === 'passed'))
      for (const [index, check] of value.checks.entries())
        check.evidence = [{ identity: identities[index], quote: source }]
      return value
    },
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.mainCalls, 1)
  assert.equal(f.reads.length, 3)
  const verification = f.events.find((event) => event.type === 'verification')
  assert.equal(verification.verified, true)
  assert.equal(verification.report.checks[0].evidenceRefs.length, 2)
  const state = await f.storage.load('project')
  const verdict = state.records.find((record) => record.title === 'completion-review:verdict')
  assert(verification.report.checks[0].evidenceRefs.some((ref) => ref.id === verdict.ref.id))
  const evidence = state.records.filter((record) =>
    [
      'completion-review:evidence',
      'completion-review:validation-request',
      'completion-review:validation-result',
    ].includes(record.title)
  )
  assert.equal(evidence.length, 7)
  for (const record of evidence) {
    assert(verdict.sources.some((ref) => ref.id === record.ref.id))
    assert((await f.storage.get('project', record.objectId)).length > 0)
  }
})

test('counterexample investigation cannot skip execution and use a model assertion as proof', async (t) => {
  let executions = 0
  const stages = []
  const f = await fixture(t, {
    counterexampleReview: true,
    requirements: [['R1', 'Implementation', 'file:module.mjs']],
    validation: async () => {
      executions++
      throw new Error('No call should be fabricated')
    },
    reviewReply: (material) => {
      stages.push(material.reviewStage)
      return {
        findings: [
          {
            requirementIds: ['R1'],
            hypothesis: 'Looks correct.',
            outcome: 'not-reproduced',
            evidence: [{ identity: 'file:module.mjs', quote: 'Complete Implementation' }],
          },
        ],
      }
    },
  })
  assert.deepEqual(stages, ['counterexample', 'counterexample'])
  assert.equal(executions, 0)
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
})

test('counterexample investigation shares the root model allowance before any investigation request', async (t) => {
  const f = await fixture(t, {
    counterexampleReview: true,
    budget: { modelCalls: 2 },
    validation: () => assert.fail('An exhausted model allowance cannot dispatch validation'),
    reviewReply: () => assert.fail('No investigation request can bypass the root budget'),
  })
  assert.equal(f.verificationCalls, 0)
  assert.notEqual(f.events.at(-1).status, 'completed')
})

test('cancellation during counterexample investigation retains actual usage and prevents adjudication', async (t) => {
  const f = await fixture(t, {
    counterexampleReview: true,
    cancel: new AbortController(),
    validation: () => assert.fail('Cancelled investigation cannot start execution'),
    reviewReply: (material) => {
      assert.equal(material.reviewStage, 'counterexample')
      return { findings: [] }
    },
  })
  assert.equal(f.verificationCalls, 1)
  assert.equal(f.events.at(-1).status, 'cancelled')
  const root = await f.runtime.trace('project')
  assert(root.branches.every((branch) => branch.status === 'closed'))
  const review = await f.runtime.trace('project', { sessionId: root.branches.at(-1).sessionId })
  assert.equal(review.turns[0].modelAccounting.usage.inputTokens, 17)
  assert.equal(review.turns[0].modelAccounting.usage.outputTokens, 3)
})

test('invalid validation input shares the same fixed attempt budget and cannot call the host', async (t) => {
  let executions = 0
  const f = await fixture(t, {
    requirements: [['R1', 'Implementation', 'file:module.mjs']],
    validate: (material) =>
      material.validationAccess
        ? {
            requirementIds: ['foreign'],
            artifacts: [{ identity: 'file:module.mjs', sha256: hash('Complete Implementation') }],
            code: 'console.log(1)',
          }
        : undefined,
    validation: async () => {
      executions++
      throw new Error('Must never run')
    },
  })
  assert.equal(executions, 0)
  assert.equal(f.verificationCalls, 3)
  assert.equal(f.verificationMaterial.validationAccess, false)
  assert.equal(f.verificationMaterial.validationErrors.length, 2)
  assert.deepEqual(f.verificationMaterial.validationEvidence, [])
})

test('a file generation change during validation cannot approve the original completion attempt', async (t) => {
  const f = await fixture(t, {
    requirements: [['R1', 'Implementation', 'file:module.mjs']],
    validate: (material) =>
      material.validationEvidence.length
        ? undefined
        : {
            requirementIds: ['R1'],
            artifacts: [{ identity: 'file:module.mjs', sha256: hash('Complete Implementation') }],
            code: 'console.log(1)',
          },
    validation: async (_request, _signal, state) => {
      state.generation++
      return {
        status: 'passed',
        exitCode: 0,
        stdout: '1',
        stderr: '',
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        cleanupComplete: true,
        durationMs: 1,
      }
    },
  })
  assert.notEqual(f.events.at(-1).status, 'completed')
  assert(
    f.verificationMaterial.validationEvidence.some(
      (evidence) => JSON.parse(evidence.text).versionCurrent === false
    )
  )
})

const discoveryFile = (identity, requirementIds = ['code']) => ({
  identity,
  requirementIds,
  reason: 'Read the original contract that determines this behavior',
})

test('supplemental discovery binds supporting contracts without adding delivery requirements', async (t) => {
  const f = await fixture(t, {
    requirements: [['code', 'Preserve declared behavior', 'file:code.js']],
    artifactTexts: [['file:CONTRACT.md', 'Existing compatibility contract']],
    discoverEvidence: true,
    discover: (material) => ({
      files: material.discovery.length ? [] : [discoveryFile('file:CONTRACT.md')],
    }),
    reviewReply: (material, value) => {
      assert.equal(material.required.length, 1)
      assert.deepEqual(material.required[0].artifacts, ['file:code.js'])
      assert(material.evidenceCatalog.some((entry) => entry.identity === 'file:CONTRACT.md'))
      value.checks[0].evidence.push({
        identity: 'file:CONTRACT.md',
        quote: 'Existing compatibility contract',
      })
      return value
    },
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.discoveryCalls, 2)
  assert(
    f.captures.some(
      (capture) =>
        capture.identities.includes('file:code.js') &&
        capture.identities.includes('file:CONTRACT.md')
    )
  )
  const state = await f.storage.load('project')
  assert(state.records.some((record) => record.title === 'completion-review:discovery'))
})

test('discovery missing paths remain locator feedback and cannot create new user deliverables', async (t) => {
  const f = await fixture(t, {
    requirements: [['code', 'Preserve declared behavior', 'file:code.js']],
    artifactTexts: [['file:actual-contract.md', 'Existing contract']],
    discoverEvidence: true,
    discover: (material) => {
      if (material.discovery.length)
        assert.match(material.discovery[0].issues.join(' '), /missing/u)
      return {
        files: [
          discoveryFile(
            material.discovery.length ? 'file:actual-contract.md' : 'file:guessed-contract.md'
          ),
        ],
      }
    },
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.discoveryCalls, 2)
  assert.deepEqual(f.verificationMaterial.required[0].artifacts, ['file:code.js'])
  assert(
    !f.verificationMaterial.evidenceCatalog.some(
      (entry) => entry.identity === 'file:guessed-contract.md'
    )
  )
  assert(
    f.verificationMaterial.evidenceCatalog.some(
      (entry) => entry.identity === 'file:actual-contract.md'
    )
  )
})

test('discovery is opt-in and cannot dispatch when disabled', async (t) => {
  const f = await fixture(t, {
    discoverEvidence: false,
    discover: () => assert.fail('Discovery not enabled'),
  })
  assert.equal(f.events.at(-1).status, 'completed')
  assert.equal(f.discoveryCalls, 0)
})

test('discovery cannot replace fixed requirements or introduce unrelated identities', async (t) => {
  for (const plan of [
    { files: [], requirements: [] },
    { files: [discoveryFile('file:contract.md', ['not-an-existing-requirement'])] },
    { files: [discoveryFile('response:final')] },
    { files: Array.from({ length: 9 }, (_, i) => discoveryFile(`file:contract-${i}`)) },
  ]) {
    const f = await fixture(t, {
      requirements: [['code', 'Original requirement', 'file:code.js']],
      discoverEvidence: true,
      discover: () => plan,
    })
    assert.equal(f.events.at(-1).status, 'failed', JSON.stringify(f.events))
    assert.equal(f.verificationCalls, 0)
  }
})

test('discovery detects original source changes while reading supporting files', async (t) => {
  const f = await fixture(t, {
    requirements: [['code', 'Original requirement', 'file:code.js']],
    artifactTexts: [['file:contract.md', 'Original contract']],
    discoverEvidence: true,
    discover: () => ({ files: [discoveryFile('file:contract.md')] }),
    onCapture: (fixture) => {
      const selected = fixture.captures.at(-1).identities
      if (selected.length === 1 && selected[0] === 'file:contract.md')
        fixture.materials.set('file:code.js', 'Changed implementation')
    },
  })
  assert.equal(f.events.at(-1).status, 'failed', JSON.stringify(f.events))
  assert.equal(f.verificationCalls, 0)
})

test('supplemental contract changes invalidate a previously passing verdict', async (t) => {
  const f = await fixture(t, {
    requirements: [['code', 'Original requirement', 'file:code.js']],
    artifactTexts: [['file:contract.md', 'Original contract']],
    discoverEvidence: true,
    discover: (material) => ({
      files: material.discovery.length ? [] : [discoveryFile('file:contract.md')],
    }),
    reviewReply: (material, value, fixture) => {
      fixture.materials.set('file:contract.md', 'Changed contract')
      return value
    },
  })
  const first = f.events.find((event) => event.type === 'verification')
  assert.equal(first.verified, false, JSON.stringify(first))
  assert.equal(first.report.checks[0].applicability, 'unknown')
})

test('discovery never dispatches beyond its two-round allowance', async (t) => {
  const f = await fixture(t, {
    requirements: [['code', 'Original requirement', 'file:code.js']],
    artifactTexts: [
      ['file:contract-0', 'first'],
      ['file:contract-1', 'second'],
      ['file:contract-2', 'third'],
    ],
    discoverEvidence: true,
    discover: (material) => ({
      files: [discoveryFile(`file:contract-${material.discovery.length}`)],
    }),
  })
  assert.equal(f.events.at(-1).status, 'completed', JSON.stringify(f.events))
  assert.equal(f.discoveryCalls, 2)
  assert(!f.captures.some((capture) => capture.identities.includes('file:contract-2')))
})

test('cancellation during discovery prevents file expansion and later verification', async (t) => {
  const cancellation = new AbortController()
  const f = await fixture(t, {
    requirements: [['code', 'Original requirement', 'file:code.js']],
    artifactTexts: [['file:contract.md', 'Original contract']],
    discoverEvidence: true,
    cancel: cancellation,
    discover: () => {
      cancellation.abort()
      return { files: [discoveryFile('file:contract.md')] }
    },
  })
  assert.equal(f.verificationCalls, 0)
  assert.equal(f.events.at(-1).status, 'cancelled', JSON.stringify(f.events))
  assert(!f.captures.some((capture) => capture.identities.includes('file:contract.md')))
})

test('discovery cannot bypass the parent physical request budget', async (t) => {
  const f = await fixture(t, {
    requirements: [['code', 'Original requirement', 'file:code.js']],
    discoverEvidence: true,
    budget: { modelCalls: 2 },
    discover: () => assert.fail('The shared request budget is already exhausted'),
  })
  assert.equal(f.discoveryCalls, 0)
  assert.equal(f.verificationCalls, 0)
  assert.notEqual(f.events.at(-1).status, 'completed')
})

test('discovery refuses changed workspace authorization even when file bytes agree', async (t) => {
  const f = await fixture(t, {
    requirements: [['code', 'Original requirement', 'file:code.js']],
    artifactTexts: [['file:contract.md', 'Original contract']],
    discoverEvidence: true,
    discover: () => ({ files: [discoveryFile('file:contract.md')] }),
    onCapture: (fixture) => {
      const selected = fixture.captures.at(-1).identities
      if (selected.length === 1 && selected[0] === 'file:contract.md')
        fixture.authorization = 'revoked'
    },
  })
  assert.equal(f.events.at(-1).status, 'failed')
  assert.equal(f.verificationCalls, 0)
})
