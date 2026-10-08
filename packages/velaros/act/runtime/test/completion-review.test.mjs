import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../dist/act/runtime/index.js'
import {
  completionRequirements,
  completionVerdicts,
} from '../../../dist/act/runtime/utils/completion-review.js'

import { done, turn } from './support/model-turn.mjs'

const hash = (text) => createHash('sha256').update(text).digest('hex')
const input = 'Deliver the implementation, a usage guide, two examples, and a release entry.'
const requirements = [
  ['implementation', 'Implementation', 'file:src/module.ts'],
  ['guide', 'Usage guide', 'file:README.md'],
  ['examples', 'Two independent examples', 'file:examples/demo.ts'],
  ['release', 'Package release entry', 'file:package.json'],
]

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'velaros-completion-review-'))
  const storage = localContextStorage({ path: join(root, 'context.sqlite') })
  const f = {
    root,
    calls: [],
    generation: 1,
    mainCalls: 0,
    verificationCalls: 0,
    materials: new Map(requirements.map((item) => [item[2], `Complete ${item[1]}`])),
  }
  const model = {
    id: 'review-fixture',
    limits: { inputTokens: 100000, contextTokens: 120000, outputTokens: 8192 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request) {
      const phase = request.materials.find((material) => material.origin.startsWith('completion-'))
      f.calls.push(phase?.origin ?? 'main')
      if (!phase) {
        f.mainCalls++
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
          f.materials.set('file:examples/demo.ts', 'Two working examples with different inputs')
          f.generation++
        }
        yield* done(request, 'The requested project delivery is ready.')
        return
      }
      const material = JSON.parse(phase.text)
      let value
      if (phase.origin === 'completion-requirements') {
        f.originals = material.originalInputs
        value = {
          complete: true,
          requirements: [
            ...requirements,
            ...(options.execution ? [['execution', 'Execute and verify', 'execution:recent']] : []),
          ]
            .filter(([id]) => !options.revised || id !== 'examples')
            .map(([id, label, artifact]) => ({
              id,
              label,
              artifacts: [artifact],
              anchors: [
                {
                  sourceId: material.originalInputs[0].ref.id,
                  quote: material.originalInputs[0].text.slice(0, 2048),
                },
              ],
            })),
        }
      } else {
        f.verificationCalls++
        f.verificationMaterial = material
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
          checks: material.required.map((item) => ({
            id: item.id,
            status:
              options.fail === item.id && (!options.repair || f.mainCalls === 1)
                ? 'failed'
                : 'passed',
            reason:
              options.fail === item.id && (!options.repair || f.mainCalls === 1)
                ? 'The second requested example is missing.'
                : 'The supplied artifact covers this criterion.',
            evidence: item.artifacts
              .map((identity) => ({
                identity,
                quote: [...material.materials, ...(material.executionEvidence?.records ?? [])].find(
                  (entry) => entry.identity === identity
                ).text,
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
        if (options.stale) f.generation++
        if (options.fakeQuote || (options.fakeOnce && f.verificationCalls === 1))
          value.checks[0].evidence[0].quote = 'fabricated evidence'
      }
      if (options.reject === phase.origin) {
        yield { type: 'error', code: 'provider', message: 'review request failed' }
        return
      }
      if (options.cancel && phase.origin === 'completion-verification') {
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
    async capture(identities) {
      const materials = identities
        .filter((identity) => identity !== options.missing)
        .map((identity) => ({ identity, text: f.materials.get(identity) }))
      if (options.missing)
        return {
          fingerprint: { status: 'unknown' },
          materials,
          issues: [`${options.missing}: missing`],
        }
      return {
        fingerprint: {
          status: 'versioned',
          providerId: 'fixture',
          token: String(f.generation),
          authorization: 'workspace-v1',
          artifacts: materials.map((entry) => ({
            identity: entry.identity,
            contentHash: hash(entry.text),
            revision: String(f.generation),
          })),
          cost: { coverage: 'complete', charges: [] },
        },
        materials,
        issues: [],
      }
    },
  }
  f.runtime = await createRuntime({
    storage,
    runner: nodeSubprocessCodeRunner,
    model,
    protocol: { transport: 'text' },
    agents: false,
    search: false,
    limits: { turns: 1 },
    context: {
      maintenance: false,
      policy: { recoveryAttempts: 1 },
      limits: options.budget,
      completion: { kind: 'model-review', artifacts },
    },
  })
  f.session = await f.runtime.openSession('project')
  f.storage = storage
  f.events = []
  t.after(async () => {
    await f.runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  for await (const event of f.session.submit(options.input ?? input, options.cancel?.signal))
    f.events.push(event)
  return f
}

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
    assert(f.calls.length <= 6)
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
  assert.equal(f.verificationCalls, 2)
  assert.equal(f.events.at(-1).status, 'waiting')
  assert(!f.events.some((event) => event.type === 'verification' && event.verified))
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
    f.verificationMaterial.required.every((item) => !('anchors' in item) && !('sourceRefs' in item))
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
