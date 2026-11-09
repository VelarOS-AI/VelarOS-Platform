import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'

import { createRuntime, openSessionControl } from '@velaros-ai/velaros'
import { localContextStorage } from '@velaros-ai/velaros/context/node'

const root = await mkdtemp(join(tmpdir(), 'velaros-installed-trace-'))
const path = join(root, 'context.sqlite')
const sessionId = 'persistent-trace'
const binding = { executionIdentity: 'installed-trace-actor', authorizationScope: 'installed-trace-policy' }
const evidence = 'installed-persistent-evidence-'.repeat(80)
const source = `import {echo} from 'consumer:trace'; await echo(${JSON.stringify(evidence)});`
const connections = []
const leases = []
const originalProcesses = new Map()
let runtime
let modelCalls = 0
let runnerCalls = 0
let processAttempts = 0
let writes = 0
let releaseRead
let acceptedRead
let closing

function connect() {
  const storage = localContextStorage({ path })
  const connection = { storage, closeCalls: 0, closed: false }
  const close = storage.close.bind(storage)
  storage.close = async () => {
    connection.closeCalls += 1
    await close()
    connection.closed = true
  }
  // 计数真实持久端口；缺失会话读取不能分配身份、正文、目录或提交状态。
  for (const name of ['allocateReferenceId', 'put', 'appendRecord', 'compareAndSwap', 'compareAndSwapMetadata', 'collect']) {
    if (!storage[name]) continue
    const original = storage[name].bind(storage)
    storage[name] = (...args) => { writes += 1; return original(...args) }
  }
  connections.push(connection)
  return connection
}

async function open(id = sessionId) {
  const connection = connect()
  const lease = await openSessionControl({ sessionId: id, storage: connection.storage, binding })
  leases.push(lease)
  return { lease, connection }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function invocationChars(invocations) {
  return invocations.reduce((total, item) => total + item.body.length + item.summary.input.length + item.summary.output.length + (item.summary.projectChange?.diff.length ?? 0), 0)
}

// 只计公开回执已返回的正文；不解释原始存储，也不重建追踪内容。
function bodyChars(page) {
  return page.turns.reduce((total, turn) => total
    + [turn.request, turn.response, turn.decision, ...turn.records].reduce((sum, record) => sum + (record?.body?.length ?? 0), 0)
    + invocationChars(turn.invocations)
    + turn.executions.reduce((sum, entry) => sum + entry.source.length + (entry.processOutput?.length ?? 0), 0)
    + (turn.observation.registration?.source.length ?? 0)
    + (turn.observation.run?.source.length ?? 0)
    + turn.agents.reduce((sum, entry) => sum + entry.task.length + entry.answer.length, 0), 0)
    + page.sessionActivity.entries.reduce((total, entry) => total
      + entry.records.reduce((sum, record) => sum + (record.body?.length ?? 0), 0)
      + invocationChars(entry.invocations), 0)
}

try {
  // 正式 Runtime 写口生成 SQLite 事实与 Kernel 日志；注入执行器和模型均是本地确定性夹具。
  // 它们不证明真实 Node 执行或供应商模型；这两条链沿用先前发行证据。
  const seed = connect()
  runtime = await createRuntime({
    storage: seed.storage,
    binding,
    context: { maintenance: false },
    runner: {
      environment: 'node',
      cwd: root,
      async run(request, dispatch) {
        runnerCalls += 1
        assert(request.operations['consumer:trace'].includes('echo'))
        const result = await dispatch({ callId: 1, namespace: 'consumer:trace', operation: 'echo', input: evidence }, () => () => {})
        assert.equal(result.error, undefined, JSON.stringify(result))
        assert.equal(result.value, evidence)
        return { ok: true, value: result.value, logs: [] }
      },
    },
    modules: [{
      binding: { moduleId: 'consumer:trace', instanceId: 'installed-fixture', generation: 1, schemaRevision: '1' },
      summary: 'Local deterministic trace evidence',
      operations: { echo: { summary: 'Return fixture evidence', effects: 'read', input: { type: 'string' }, output: { type: 'string' }, run: async (input) => input } },
    }],
    protocol: { transport: 'text' },
    model: {
      id: 'installed-trace-deterministic-driver',
      limits: { contextTokens: 128000, inputTokens: 110000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'local trace fixture' }),
      async *stream(request) {
        const marker = [...request.protocol.matchAll(/当前帧标记：(@@\w+)。/gu)].at(-1)?.[1]
        assert(marker, 'The formal Runtime supplies this frame marker')
        modelCalls += 1
        assert(modelCalls <= 2, 'The deterministic fixture must complete in two requests')
        yield { type: 'text', text: modelCalls === 1
          ? `${evidence}\n${marker} execute({async:false})\n${source}\n${marker}`
          : `${evidence}\n${marker} done` }
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  const session = await runtime.openSession(sessionId)
  await session.context.ingest({ text: 'Persist independent session activity before any model request.' })
  for (let index = 0; index < 2; index += 1) {
    const receipt = await session.execute({ source })
    assert.equal(receipt.result.failed, undefined, JSON.stringify(receipt))
    assert(receipt.calls.every((call) => call.ok))
  }
  const events = []
  for await (const event of session.submit('Read the local evidence once and finish.')) events.push(event)
  assert.equal(events.at(-1)?.status, 'completed', JSON.stringify(events))
  assert.equal(modelCalls, 2)
  assert.equal(runnerCalls, 3)
  const firstQuery = { limit: 1, activityLimit: 1, fullContent: true, maxChars: 1 }
  const firstPage = await runtime.trace(sessionId, firstQuery)
  assert.equal(firstPage.turns.length, 1)
  assert.equal(firstPage.sessionActivity.entries.length, 1)
  assert.notEqual(firstPage.nextAfter, null)
  assert.notEqual(firstPage.sessionActivity.nextAfter, null)
  assert(bodyChars(firstPage) > 256, 'Full content retains evidence beyond a bounded preview')
  assert(firstPage.sessionActivity.entries[0].invocations.length > 0, 'The public dispatch produced a persistent journal receipt')
  const boundedQuery = { limit: 1, activityLimit: 1, maxChars: 256 }
  const nextQuery = { after: firstPage.nextAfter, activityAfter: firstPage.sessionActivity.nextAfter, limit: 1, activityLimit: 1, maxChars: 4096 }
  const queries = [undefined, firstQuery, boundedQuery, nextQuery]
  const baseline = await Promise.all(queries.map((query) => runtime.trace(sessionId, query)))
  assert(bodyChars(baseline[2]) <= boundedQuery.maxChars)
  assert(bodyChars(baseline[2]) < bodyChars(firstPage))
  assert.notEqual(baseline[3].turns[0].turnId, firstPage.turns[0].turnId)
  assert.notEqual(baseline[3].sessionActivity.entries[0].executionId, firstPage.sessionActivity.entries[0].executionId)
  const branches = await runtime.traceBranches(sessionId)
  assert.deepEqual(branches, [])
  await runtime.close()
  runtime = undefined
  writes = 0

  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    originalProcesses.set(name, childProcess[name])
    childProcess[name] = () => { processAttempts += 1; assert.fail(`Cold trace attempted child_process.${name}`) }
  }
  syncBuiltinESMExports()
  const current = await open()
  for (const method of ['submit', 'execute', 'steer', 'answer']) assert.equal(method in current.lease, false, method)
  assert.deepEqual(await current.lease.traceBranches(), branches)
  for (const [index, query] of queries.entries()) assert.deepEqual(await current.lease.trace(query), baseline[index])
  await assert.rejects(current.lease.trace({ maxChars: 0 }), { code: 'VALIDATION' })
  await assert.rejects(current.lease.trace({ sessionId: 'foreign-root' }), { code: 'PERMISSION' })
  // 真实归属支线的读回沿用共享 RuntimeTrace 既有测试；这里不伪造归属或搭建长模型链。
  const missing = await open('never-run')
  const empty = await missing.lease.trace()
  assert.deepEqual(empty.turns, [])
  assert.deepEqual(empty.sessionActivity.entries, [])
  assert.equal(empty.snapshotVersion, null)
  assert.equal(empty.nextAfter, null)
  assert.deepEqual(await missing.lease.traceBranches(), [])
  assert.equal(await missing.connection.storage.loadMetadata('never-run'), null)
  assert.equal(writes, 0, 'Cold reads, including a missing session, make zero persistent mutations')
  await missing.lease.close()

  // 仅坏数据负例经公开存储 CAS 改已有绑定；不手写任何 trace 或支线事实。
  const storage = current.connection.storage
  const saved = await storage.load(sessionId)
  const record = saved.records.find((entry) => entry.title === 'runtime:binding')
  assert(record)
  const changedBody = JSON.stringify({ ...JSON.parse(await storage.get(sessionId, record.objectId)), authorizationScope: 'revoked-policy' })
  const objectId = await storage.put(sessionId, changedBody)
  assert(await storage.compareAndSwap(sessionId, saved.version, { ...saved, version: saved.version + 1, records: saved.records.map((entry) => entry === record ? { ...entry, objectId, chars: changedBody.length } : entry) }))
  await assert.rejects(current.lease.trace(), { code: 'CONFLICT' })
  await assert.rejects(current.lease.traceBranches(), { code: 'CONFLICT' })
  const revoked = await storage.load(sessionId)
  assert(await storage.compareAndSwap(sessionId, revoked.version, { ...saved, version: revoked.version + 1 }))
  const restored = await current.lease.trace(boundedQuery)
  assert.deepEqual(await current.lease.traceBranches(), branches)

  const entered = deferred()
  const gate = deferred()
  releaseRead = gate.resolve
  const selectSnapshot = storage.selectSnapshot.bind(storage)
  storage.selectSnapshot = async (...args) => { entered.resolve(); await gate.promise; return selectSnapshot(...args) }
  acceptedRead = current.lease.trace(boundedQuery)
  await entered.promise
  let closeSettled = false
  closing = current.lease.close()
  void closing.then(() => { closeSettled = true }, () => { closeSettled = true })
  await setImmediate()
  assert.equal(closeSettled, false)
  assert.equal(current.connection.closeCalls, 0)
  await assert.rejects(current.lease.trace(), { code: 'CLOSED' })
  await assert.rejects(current.lease.traceBranches(), { code: 'CLOSED' })
  releaseRead()
  assert.deepEqual(await acceptedRead, restored)
  await closing
  await current.lease.close()
  assert.equal(current.connection.closeCalls, 1)
  assert.equal(modelCalls, 2)
  assert.equal(runnerCalls, 3)
  assert.equal(processAttempts, 0)
  console.log(JSON.stringify({ platform: process.platform, storage: 'real SQLite', seed: 'formal Runtime writes with deterministic injected runner/driver', coldTrace: true, publicRuntimeParity: true, paginationAndBudget: true, foreignBranch: 'PERMISSION', bindingRechecked: true, missingSessionWrites: 0, closeDrainsAcceptedTrace: true, coldProcessAttempts: processAttempts, ownedBranches: 'inherited shared RuntimeTrace regression' }))
} finally {
  releaseRead?.()
  await Promise.allSettled([acceptedRead, closing].filter(Boolean))
  await runtime?.close()
  await Promise.allSettled(leases.map((lease) => lease.close()))
  await Promise.allSettled(connections.filter((connection) => !connection.closed).map((connection) => connection.storage.close()))
  for (const [name, original] of originalProcesses) childProcess[name] = original
  syncBuiltinESMExports()
  await rm(root, { recursive: true, force: true })
}
