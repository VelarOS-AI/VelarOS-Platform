import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openSessionControl } from '@velaros-ai/velaros'
import { localContextStorage } from '@velaros-ai/velaros/context/node'
import { createNodeRuntime, resolveNodeRuntimeBinding } from '@velaros-ai/velaros/node'

const root = await mkdtemp(join(tmpdir(), 'velaros-installed-control-'))
const cwd = join(root, 'execution')
const stateDirectory = join(root, 'state')
const path = join(stateDirectory, 'context.sqlite')
const sessionId = 'persistent-control'
const requestedBinding = { executionIdentity: 'installed-control-actor', authorizationScope: 'installed-control-policy-v1' }
const processConfinement = { mode: 'danger-full-access' }
const connections = []
const leases = []
let runtime
let processAttempts = 0
const originalProcesses = new Map()

function connect() {
  const storage = localContextStorage({ path })
  const connection = { storage, closeCalls: 0, closed: false }
  const close = storage.close.bind(storage)
  storage.close = async () => {
    connection.closeCalls += 1
    await close()
    connection.closed = true
  }
  connections.push(connection)
  return connection
}

async function open(binding, id = sessionId) {
  const connection = connect()
  const lease = await openSessionControl({ sessionId: id, storage: connection.storage, binding })
  leases.push(lease)
  return { lease, connection }
}

try {
  await mkdir(cwd)
  // 只用正式写口准备一次笔记与目标，不复跑已有模型/命令验收链。
  runtime = await createNodeRuntime({cwd,stateDirectory,binding:requestedBinding,localHost:{processConfinement},execution:{executable:process.execPath},context:{maintenance:false}})
  const session = await runtime.openSession(sessionId)
  await session.context.ingest({ text: 'Prepare persistent facts for idle session controls.' })
  const body = 'durable-control-tail'
  const seed = await session.execute({source:`import {memory} from 'velaros:system';
    await memory.update({key:'a',baseRevision:0,body:'first revision'});
    await memory.update({key:'a',baseRevision:1,body:${JSON.stringify(body)}});
    await memory.update({key:'b',baseRevision:0,body:'second note'});`})
  assert.equal(seed.result.failed, undefined, JSON.stringify(seed))
  assert(seed.calls.every((call) => call.ok), JSON.stringify(seed.calls))
  const seededGoal = await session.updateGoal({ baseRevision: 0, objective: 'Keep controls available after the Runtime closes.' })
  await runtime.close()
  runtime = undefined
  const directoryBeforeControls = (await readdir(stateDirectory)).sort()

  // 冷控制阶段任何命令/进程尝试都立即失败，binding解析也在此边界内。
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    originalProcesses.set(name, childProcess[name])
    childProcess[name] = () => { processAttempts += 1; assert.fail(`Storage-only controls attempted child_process.${name}`) }
  }
  syncBuiltinESMExports()
  const binding = await resolveNodeRuntimeBinding({cwd,binding:requestedBinding,executable:process.execPath,processConfinement})
  const first = await open(binding)
  assert.equal(first.lease.id, sessionId)
  for (const method of ['submit', 'execute', 'steer', 'answer', 'updateGoal']) assert.equal(method in first.lease, false, method)
  const notes = await first.lease.listNotes({ limit: 1 })
  assert.deepEqual(notes.items.map((entry) => [entry.key, entry.revision]), [['a', 2]])
  assert.equal(notes.nextAfter, 'a')
  assert.deepEqual((await first.lease.listNotes({ after: notes.nextAfter, limit: 1 })).items.map((entry) => entry.key), ['b'])
  const note = await first.lease.readNote({ key: 'a', revision: 2, offset: body.length - 4, limit: 4 })
  assert.equal(note.text, 'tail')
  assert.equal(note.totalChars, body.length)
  await assert.rejects(first.lease.readNote({ key: 'a', revision: 1 }), {code:'WORKSPACE_CONFLICT'})
  assert.deepEqual(await first.lease.getGoal(), seededGoal)

  const second = await open(binding)
  const race = await Promise.allSettled([first, second].map(({lease}) => lease.controlGoal({baseRevision:seededGoal.revision,action:'pause'})))
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(race.find((result) => result.status === 'rejected').reason.code, 'GOAL_CONFLICT')
  const paused = await first.lease.getGoal()
  assert.equal(paused.status, 'paused')
  const resumed = await second.lease.controlGoal({baseRevision:paused.revision,action:'resume'})
  assert.equal(resumed.status, 'active')
  assert.equal(resumed.revision, seededGoal.revision + 2)
  await Promise.all([first.lease.close(), second.lease.close()])
  await first.lease.close()
  assert.equal(first.connection.closeCalls, 1)
  assert.equal(second.connection.closeCalls, 1)
  await assert.rejects(first.lease.getGoal(), {code:'CLOSED'})

  const restored = await open(binding)
  assert.deepEqual(await restored.lease.getGoal(), resumed)
  assert.equal((await restored.lease.readNote({key:'a',revision:2})).text, body)
  for (const changed of [{...binding,executionIdentity:'another-actor'},{...binding,authorizationScope:'another-policy'}]) {
    const connection = connect()
    await assert.rejects(openSessionControl({sessionId,storage:connection.storage,binding:changed}), {code:'CONFLICT'})
    assert.equal(connection.closeCalls, 0, 'Failed open leaves its storage connection with the caller')
    assert(await connection.storage.loadMetadata(sessionId))
    await connection.storage.close()
  }
  const missing = await open(binding, 'never-run')
  assert.equal(await missing.lease.getGoal(), null)
  assert.deepEqual(await missing.lease.listNotes(), {items:[],nextAfter:null})
  await assert.rejects(missing.lease.readNote({key:'missing',revision:1}), {code:'NOT_FOUND'})
  await assert.rejects(missing.lease.controlGoal({baseRevision:0,action:'pause'}), {code:'NOT_FOUND'})
  assert.equal(await missing.connection.storage.loadMetadata('never-run'), null)
  assert.equal(processAttempts, 0)
  await Promise.all([restored.lease.close(), missing.lease.close()])
  assert.deepEqual((await readdir(stateDirectory)).sort(), directoryBeforeControls)
  console.log(JSON.stringify({platform:process.platform,seed:'one formal memory-write program; no model request',storage:'real SQLite',coldControl:true,nodeBindingResolved:true,notes:'paged and versioned',goalCas:'one concurrent winner',recovered:true,missingSession:'no metadata created',storageOwnership:true,controlProcessAttempts:processAttempts}))
} finally {
  for (const [name, original] of originalProcesses) childProcess[name] = original
  syncBuiltinESMExports()
  await runtime?.close()
  await Promise.allSettled(leases.map((lease) => lease.close()))
  await Promise.allSettled(connections.filter((connection) => !connection.closed).map((connection) => connection.storage.close()))
  await rm(root, {recursive:true,force:true})
}
