// 用途：在真实共享调度器上核对首个可处理结果、交互、所有权与等待资源回收。
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'

import { createAgentSupervisor } from '@velaros-ai/agent'
import { localContextStorage } from '@velaros-ai/context/node'

import { AgentsLimits } from '../../../dist/act/agents/contract/constants.js'
import { agentsOperations } from '../../../dist/act/agents/impl/AgentsOperations.js'

const deferred = () => {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function waiting(f, count) {
  const deadline = Date.now() + 1000
  while (
    f.waits.length < count ||
    f.waits.some((signal) => getEventListeners(signal, 'abort').length === 0)
  ) {
    assert(Date.now() < deadline, 'Grouped wait did not register its cancellation listeners')
    await new Promise((done) => setTimeout(done, 1))
  }
}
async function fixture(t) {
  const storage = localContextStorage({ path: ':memory:' })
  const controls = new Map()
  const waits = []
  const run = new AbortController()
  const waitController = new AbortController()
  const supervisor = createAgentSupervisor({
    storage,
    concurrency: 8,
    maxChildren: 16,
    async open(job, _request, signal) {
      const first = deferred()
      const finish = deferred()
      const abort = () => {
        first.resolve('cancelled')
        finish.resolve()
      }
      signal.addEventListener('abort', abort, { once: true })
      controls.set(job.id, { first, finish, signal })
      return {
        async *submit() {
          yield { type: 'state', runId: job.id, status: 'thinking' }
          const step = await first.promise
          if (step === 'ask') {
            yield {
              type: 'interaction',
              runId: job.id,
              request: { id: 'question', runId: job.id, kind: 'input', message: 'Need a choice' },
            }
            await finish.promise
          }
          yield { type: 'state', runId: job.id, status: signal.aborted ? 'cancelled' : 'completed' }
        },
        async answer() {},
        async steer() {},
        cancel() {
          abort()
        },
        async close() {
          signal.removeEventListener('abort', abort)
        },
      }
    },
  })
  t.after(async () => {
    await supervisor.close()
    await storage.close()
  })
  const agents = new Proxy(supervisor, {
    get(target, key) {
      if (key === 'wait')
        return (...args) => {
          waits.push(args[2])
          return target.wait(...args)
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const ctx = {
    agents,
    sessionId: 'parent',
    abortSignal: waitController.signal,
    runSignal: () => run.signal,
    profiles: () => [],
  }
  return {
    supervisor,
    controls,
    waits,
    ctx,
    waitController,
    start: (parent) =>
      supervisor.start(parent ?? 'parent', { task: 'work', profile: 'worker' }, run.signal),
  }
}

test(
  'INV-7 first completed child is returned while slower children keep running',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t)
    const slow = await f.start()
    const fast = await f.start()
    const pending = agentsOperations.waitAny({ ids: [slow.id, fast.id] }, f.ctx)
    await waiting(f, 2)
    f.controls.get(fast.id).first.resolve('complete')
    const result = await pending
    assert.equal(result.id, fast.id)
    assert.equal(result.status, 'completed')
    assert.equal((await f.supervisor.status('parent', slow.id)).status, 'running')
    assert.equal(f.controls.get(slow.id).signal.aborted, false)
    assert.equal(f.waits.length, 2)
    for (const signal of f.waits) assert.equal(getEventListeners(signal, 'abort').length, 0)
  }
)
test(
  'INV-7 a child question wakes the parent without waiting for unrelated work',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t)
    const slow = await f.start()
    const asking = await f.start()
    const pending = agentsOperations.waitAny({ ids: [slow.id, asking.id] }, f.ctx)
    await waiting(f, 2)
    f.controls.get(asking.id).first.resolve('ask')
    const result = await pending
    assert.equal(result.status, 'waiting')
    assert.equal(result.pending[0].id, 'question')
    assert.equal(f.controls.get(asking.id).signal.aborted, false)
    assert.equal(f.controls.get(slow.id).signal.aborted, false)
  }
)
test(
  'INV-7 cancelling a grouped wait preserves the caller reason and leaves children running',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t)
    const jobs = [await f.start(), await f.start()]
    const reason = { cancel: 'wait only' }
    const pending = agentsOperations.waitAny({ ids: jobs.map((x) => x.id) }, f.ctx)
    await waiting(f, 2)
    f.waitController.abort(reason)
    await assert.rejects(pending, (error) => error === reason)
    for (const job of jobs) {
      assert.equal((await f.supervisor.status('parent', job.id)).status, 'running')
      assert.equal(f.controls.get(job.id).signal.aborted, false)
    }
    for (const signal of f.waits) assert.equal(getEventListeners(signal, 'abort').length, 0)
  }
)
test(
  'INV-7 every target is authorized even when another target has already completed',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t)
    const ready = await f.start()
    const foreign = await f.start('other-parent')
    f.controls.get(ready.id).first.resolve('complete')
    await f.supervisor.wait('parent', ready.id, new AbortController().signal)
    await assert.rejects(agentsOperations.waitAny({ ids: [ready.id, foreign.id] }, f.ctx), {
      code: 'PERMISSION',
    })
    await assert.rejects(agentsOperations.waitAny({ ids: [ready.id, 'missing'] }, f.ctx), {
      code: 'NOT_FOUND',
    })
    assert.equal(f.waits.length, 0)
  }
)
test('INV-7 target sets are bounded, nonempty and unique before any wait starts', async (t) => {
  const f = await fixture(t)
  for (const ids of [
    [],
    [''],
    ['same', 'same'],
    Array.from({ length: AgentsLimits.waitTargets + 1 }, (_, i) => String(i)),
  ])
    await assert.rejects(agentsOperations.waitAny({ ids }, f.ctx), { code: 'VALIDATION' })
  assert.equal(f.waits.length, 0)
})
test(
  "overlapping grouped waits cannot consume each other's completion wakeup",
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t)
    const slow = await f.start()
    const ready = await f.start()
    const first = agentsOperations.waitAny({ ids: [slow.id, ready.id] }, f.ctx)
    const second = agentsOperations.waitAny({ ids: [ready.id, slow.id] }, f.ctx)
    await waiting(f, 4)
    f.controls.get(ready.id).first.resolve('complete')
    const results = await Promise.all([first, second])
    assert(results.every((x) => x.id === ready.id && x.status === 'completed'))
    assert.equal(f.controls.get(slow.id).signal.aborted, false)
  }
)
