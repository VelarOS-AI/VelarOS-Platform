import assert from 'node:assert/strict'

test('completed children reuse individually while changed and failed children remain complete', () => {
  const done = {
    id: 'done',
    sessionId: 'child',
    status: 'completed',
    result: { sessionId: 'child', id: 'result' },
    profile: 'long'.repeat(200),
  }
  const running = { id: 'running', status: 'running', progress: 1 }
  const failed = { ...done, id: 'failed', status: 'failed', error: 'failure evidence' }
  const make = (children) => ({ ...frame([]), runtime: { children } })
  const previous = make([done, running, failed])
  const input = make([done, { ...running, progress: 2 }, failed])
  const before = structuredClone(input)
  const shown = nodeFrameState(input, previous).runtime.children
  assert.equal(shown[0].unchangedInEarlierFrame, true)
  assert.deepEqual(shown[0].result, done.result)
  assert.deepEqual(shown[1], input.runtime.children[1])
  assert.deepEqual(shown[2], failed)
  assert.deepEqual(input, before)
  assert.deepEqual(nodeFrameState(input).runtime.children, input.runtime.children)
  for (const change of [
    { result: { sessionId: 'child', id: 'new' } },
    { status: 'running' },
    { pending: [{ id: 'request' }] },
    { error: 'unexpected failure' },
  ]) {
    const changed = { ...done, ...change }
    assert.deepEqual(nodeFrameState(make([changed]), previous).runtime.children, [changed])
  }
  assert.deepEqual(nodeFrameState(make([done, done]), previous).runtime.children, [done, done])
  assert.deepEqual(nodeFrameState(make([done]), make([done, done])).runtime.children, [done])
})

import { test } from 'node:test'

import { nodeFrameState } from '../../../dist/act/runtime/utils/node-context.js'

function frame(jobs, presentation = 'node') {
  return {
    presentation,
    runtime: { jobs },
    task: {},
    workspace: {},
    notes: [],
    observed: {},
    status: {},
  }
}

function project(jobs, previous) {
  return nodeFrameState(frame(jobs), previous && frame(previous)).runtime
}

for (const status of ['succeeded', 'failed', 'cancelled', 'unknown']) {
  test(`running -> ${status} uses authoritative state and keeps result reference`, () => {
    const job = {
      executionId: 'execution',
      status,
      resultRef: 'original-result',
      output: { stdout: 'All tests passed!'.repeat(1000) },
      error: 'preserve raw diagnostics',
    }
    const before = [{ executionId: 'execution', status: 'running' }]
    const input = frame([job])
    const snapshot = structuredClone(input)
    const runtime = nodeFrameState(input, frame(before)).runtime
    assert.deepEqual(runtime.jobs, [job])
    assert.deepEqual(runtime.jobChanges.items, [
      {
        executionId: 'execution',
        status,
        resultRef: 'original-result',
        previousStatus: 'running',
        terminal: status !== 'unknown',
      },
    ])
    assert.match(runtime.jobChanges.meaning, /不等于业务验证通过/)
    assert.match(runtime.jobChanges.meaning, /无需继续等待该执行/)
    assert.equal(JSON.stringify(runtime.jobChanges).includes('All tests passed!'), false)
    assert.deepEqual(input, snapshot)
  })
}

test('first and restored frames expose terminal state without pretending a transition', () => {
  const jobs = [{ executionId: 'done', status: 'succeeded', resultRef: 'result' }]
  for (const previous of [undefined, frame(jobs, undefined), frame(jobs, 'legacy')]) {
    // A non-node predecessor is not a reusable display baseline.
    if (previous) delete previous.presentation
    const runtime = nodeFrameState(frame(jobs), previous).runtime
    assert.deepEqual(runtime.jobs, jobs)
    assert.equal(runtime.jobChanges.items[0].previousStatus, undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(runtime.jobChanges.items)), [
      { ...jobs[0], terminal: true },
    ])
  }
})

test('grouping and ungrouping alone produce no changes; new terminal and changed refs do', () => {
  const previous = [
    { executionId: 'a', status: 'succeeded', resultRef: 'ra' },
    { executionId: 'b', status: 'succeeded', resultRef: 'rb' },
  ]
  const grouped = [
    { representation: 'completed-jobs', status: 'succeeded', results: { a: 'ra', b: 'rb' } },
  ]
  assert.equal(project(grouped, previous).jobChanges, undefined)
  assert.equal(project(previous, grouped).jobChanges, undefined)
  const current = [{ ...grouped[0], results: { a: 'ra', b: 'rb2', c: 'rc' } }]
  assert.deepEqual(JSON.parse(JSON.stringify(project(current, grouped).jobChanges.items)), [
    {
      executionId: 'b',
      status: 'succeeded',
      resultRef: 'rb2',
      previousStatus: 'succeeded',
      terminal: true,
    },
    { executionId: 'c', status: 'succeeded', resultRef: 'rc', terminal: true },
  ])
})

test('unchanged large jobs reuse history without repeating changes or logs', () => {
  const jobs = [
    { executionId: 'a', status: 'failed', resultRef: 'r', error: 'failure'.repeat(100) },
  ]
  const runtime = project(jobs, jobs)
  assert.equal(runtime.jobChanges, undefined)
  assert.equal(runtime.jobs, undefined)
  assert.ok(runtime.unchangedInEarlierFrame.includes('jobs'))
  assert.deepEqual(project(jobs).jobs, jobs)
})

test('stdout changes never imply completion and missing jobs never imply success', () => {
  const job = { executionId: 'a', status: 'running', output: { stdout: 'working' } }
  assert.equal(
    project([{ ...job, output: { stdout: 'PASS, exitCode 0' } }], [job]).jobChanges,
    undefined
  )
  assert.equal(project([], [job]).jobChanges, undefined)
  assert.equal(
    project([{ executionId: 'a', status: 'queued' }]).jobChanges.items[0].terminal,
    false
  )
})

test('missing or removed result refs, unknown statuses and malformed entries stay conservative', () => {
  const jobs = [
    { executionId: 'a', status: 'failed' },
    { executionId: 'b', status: 'future-state', resultRef: 'raw' },
    { odd: true },
    null,
  ]
  const runtime = project(jobs, [{ executionId: 'a', status: 'failed', resultRef: 'old' }])
  assert.deepEqual(runtime.jobs, jobs)
  assert.equal(runtime.jobChanges.items[0].resultRef, undefined)
  assert.equal(runtime.jobChanges.items[1].terminal, false)
  assert.equal(runtime.jobChanges.items.length, 2)
  assert.equal(project(undefined).jobChanges, undefined)
})

test('ambiguous previous execution identity is not silently used as a baseline', () => {
  const job = { executionId: 'a', status: 'succeeded', resultRef: 'r' }
  const changes = project([job], [job, job]).jobChanges.items
  assert.equal(changes[0].previousStatus, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [{ ...job, terminal: true }])
})
