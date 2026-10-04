import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { createNodeCodeRunner } from '@velaros-ai/script'

import {
  createRuntime,
  createShellCapabilityModule,
  createShellNodeEnvironment,
} from '../../../dist/act/runtime/index.js'
import { memoryPrompt } from '../../../dist/act/runtime/utils/context-memory.js'
import { projectCapabilityPorts } from '../../../dist/project/index.js'
import { createLocalShellHost } from '../../../dist/shell/local.js'

async function fixture(t, extra = {}, mode = 'danger-full-access') {
  const root = await mkdtemp(join(tmpdir(), 'velaros-native-'))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  const shell = createLocalShellHost({ cwd, processConfinement: { mode, workspaceRoot: cwd } })
  const node = createShellNodeEnvironment({ cwd, directory: join(root, 'runs'), shell, ...extra })
  t.after(async () => {
    await shell.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { root, cwd, shell, node }
}

const request = (source, timeoutMs = 10_000, operations = {}) => ({
  source,
  timeoutMs,
  operations,
  modules: {},
  blobs: {},
  input: undefined,
})
const noCalls = async () => {
  throw Error('unexpected host call')
}

test('discovered host shell owns background tasks across separate Node executions', async (t) => {
  const f = await fixture(t)
  const runtime = await createRuntime({
    node: f.node,
    project: false,
    agents: false,
    search: false,
    memory: false,
    storage: localContextStorage({ path: join(f.root, 'background.sqlite') }),
    modules: [
      createShellCapabilityModule({
        instanceId: f.cwd,
        shell: projectCapabilityPorts.shell({
          getRootPath: () => f.cwd,
          runCommand: (...args) => f.shell.runCommand(...args),
          listBackgroundTasks: (...args) => f.shell.listBackgroundTasks(...args),
          refreshShellEnvironment: () => f.shell.refreshShellEnvironment(),
          terminateBackgroundTask: (...args) => f.shell.terminateBackgroundTask(...args),
        }),
        approval: {
          awaitConfirmation: async () => {},
          awaitConfirmationDecision: async () => ({ approved: true, message: null }),
        },
      }),
    ],
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('background-owner')
  await session.context.append({ kind: 'user', body: 'Start and stop a managed background task' })
  const discover = `
    import {readFile,writeFile} from 'node:fs/promises';
    import {join} from 'node:path'; import {pathToFileURL} from 'node:url';
    const root=process.env.VELAROS_HOST_DIR;
    const entry=JSON.parse(await readFile(join(root,'index.json'),'utf8')).find(item=>item.module==='velaros:shell');
    const shell=await import(pathToFileURL(join(root,entry.client)));
  `
  const started = await session.execute({
    source: `${discover}
    const started=await shell.run({command:'sleep 60',background:true});
    await writeFile('task.json',JSON.stringify(started.backgroundProcess));
    console.log(started.success);
  `,
  })
  assert.equal(started.result.failed, undefined, JSON.stringify(started))
  const { taskId } = JSON.parse(await readFile(join(f.cwd, 'task.json'), 'utf8'))
  assert.equal(
    (await f.shell.listBackgroundTasks({ taskId, sessionId: 'background-owner' }))[0].status,
    'running'
  )
  const stopped = await session.execute({
    source: `${discover}
    const {taskId}=JSON.parse(await readFile('task.json','utf8'));
    console.log(JSON.stringify({tasks:await shell.listTasks({taskId}),stop:await shell.stop({taskId})}));
  `,
  })
  assert.equal(stopped.result.failed, undefined, JSON.stringify(stopped))
  assert.equal(JSON.parse(stopped.result.process.stdout).stop.stopped, true)
})

test('standard Node resolves cwd ESM/npm, writes ordinary files and automatically captures stdout/stderr', async (t) => {
  const f = await fixture(t)
  const dependency = join(f.cwd, 'node_modules', 'fixture-package')
  await mkdir(dependency, { recursive: true })
  await writeFile(
    join(dependency, 'package.json'),
    JSON.stringify({ type: 'module', exports: './index.js' })
  )
  await writeFile(join(dependency, 'index.js'), 'export const value = 42')
  const runner = createNodeCodeRunner(f.node)
  const result = await runner.run(
    request(
      `import {writeFile} from 'node:fs/promises'; import {value} from 'fixture-package'; await writeFile('answer.txt', String(value)); console.log(value); console.error('diagnostic');`
    ),
    noCalls,
    () => {}
  )
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(await readFile(join(f.cwd, 'answer.txt'), 'utf8'), '42')
  assert.equal(result.process.stdout.trim(), '42')
  assert.equal(result.process.stderr.trim(), 'diagnostic')
  assert.match(await readFile(result.process.logPath, 'utf8'), /42/)
})

test('capability discovery uses normal files and dispatch preserves caught host errors', async (t) => {
  const f = await fixture(t)
  const runner = createNodeCodeRunner(f.node)
  const seen = []
  const result = await runner.run(
    request(
      `
    import {readFile} from 'node:fs/promises'; import {join} from 'node:path'; import {pathToFileURL} from 'node:url';
    const dir = process.env.VELAROS_HOST_DIR;
    const catalog = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
    const host = await import(pathToFileURL(join(dir,catalog[0].client)));
    console.log(await host.read({id:7}));
    try { await host.write({id:8}) } catch (error) { console.log(error.code) }
  `,
      10_000,
      { 'example:host': ['read', 'write'] }
    ),
    async (call, hold) => {
      seen.push(call)
      const release = hold()
      release()
      release()
      return call.operation === 'read'
        ? { value: 'host-value' }
        : { error: { code: 'PERMISSION', message: 'denied' } }
    },
    () => {}
  )
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.match(result.process.stdout, /host-value\nPERMISSION/)
  assert.deepEqual(
    seen.map((call) => call.callId),
    [1, 2]
  )
  assert.deepEqual(
    seen.map((call) => call.input),
    [{ id: 7 }, { id: 8 }]
  )
})

test('approval denial launches no process; approval waiting is outside the program clock', async (t) => {
  let launched = false
  const f = await fixture(t)
  const denied = createNodeCodeRunner({
    ...f.node,
    cwd: f.cwd,
    directory: join(f.root, 'denied'),
    authorize: async () => {
      throw Object.assign(Error('denied'), { code: 'PERMISSION' })
    },
    execute: async () => {
      launched = true
    },
  })
  const result = await denied.run(request('console.log(1)'), noCalls, () => {})
  assert.equal(result.ok, false)
  assert.equal(launched, false)
  const approved = createNodeCodeRunner({
    cwd: f.cwd,
    directory: join(f.root, 'approved'),
    authorize: async () => new Promise((resolve) => setTimeout(resolve, 150)),
    execute: async (_request, _output, signal) => {
      signal.throwIfAborted()
      return { exitCode: 0, signal: null, stdout: 'approved', stderr: '' }
    },
  })
  assert.equal((await approved.run(request('console.log(1)', 20), noCalls, () => {})).ok, true)
})

test('timeout and cancellation terminate real Node and retain failure output', async (t) => {
  const f = await fixture(t)
  const runner = createNodeCodeRunner(f.node)
  const timeout = await runner.run(
    request('console.log("before-timeout"); while(true) {}', 300),
    noCalls,
    () => {}
  )
  assert.equal(timeout.error.code, 'TIMEOUT')
  assert.match(timeout.process.stdout, /before-timeout/)
  const controller = new AbortController()
  const running = runner.run(
    request('console.log("started"); setInterval(()=>{},1000)'),
    noCalls,
    (text) => {
      if (text.includes('started')) controller.abort()
    },
    controller.signal
  )
  const cancelled = await running
  assert.equal(cancelled.error.code, 'ABORTED')
  assert.equal(cancelled.process.cleanupIncomplete, false)
})

test('parallel executions have separate directories, credentials and dispatch identities', async (t) => {
  const f = await fixture(t)
  const runner = createNodeCodeRunner(f.node)
  const source =
    'console.log(JSON.stringify({directory:process.env.VELAROS_HOST_DIR,token:process.env.VELAROS_HOST_TOKEN}))'
  const results = await Promise.all([
    runner.run(request(source), noCalls, () => {}),
    runner.run(request(source), noCalls, () => {}),
  ])
  const [a, b] = results.map((result) => JSON.parse(result.process.stdout))
  assert.notEqual(a.directory, b.directory)
  assert.notEqual(a.token, b.token)
})

test('runtime delivers native output to the next model turn with a small standard-library prompt', async (t) => {
  const f = await fixture(t)
  const requests = []
  const runtime = await createRuntime({
    node: f.node,
    project: false,
    agents: false,
    search: false,
    memory: false,
    storage: localContextStorage({ path: join(f.root, 'state.sqlite') }),
    model: {
      id: 'standard-node-test',
      limits: { contextTokens: 100_000, inputTokens: 90_000, outputTokens: 2000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
      async *stream(req) {
        requests.push(req)
        const marker = req.compiledPrompt.match(/(@@s\w+) execute/)[1]
        yield {
          type: 'text',
          text:
            requests.length === 1
              ? `${marker} execute()\nconsole.log('native-output-739');\n${marker}`
              : `${marker} done\nVerified.`,
        }
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('node')
  for await (const event of session.submit('Print and check native-output-739.')) void event
  assert.equal(requests.length, 2)
  assert.ok(requests[0].instructions.length < 2200, requests[0].instructions)
  const originalFrame = JSON.parse(
    requests[0].materials.find((item) => item.origin === 'runtime-view').text
  )
  assert.equal(originalFrame.presentation, 'node')
  assert.ok(originalFrame.partitions.observation.read)
  const ordinaryFrame = structuredClone(originalFrame)
  delete ordinaryFrame.presentation
  const compact = memoryPrompt(JSON.stringify(originalFrame))
  const full = memoryPrompt(JSON.stringify(ordinaryFrame))
  assert.ok(compact.length < full.length * 0.55, `${compact.length}/${full.length}`)
  assert.doesNotMatch(compact, /workspace：|observation：|observationAction|workspaceShare/)
  assert.match(requests[0].compiledPrompt, /当前运行状态/)

  const recovery = structuredClone(originalFrame)
  const state = recovery.partitions.runtime
  state.mandatory = [
    {
      id: 'failed',
      operation: 'host.write',
      outcome: 'failed',
      effect: 'partial',
      detail: 'recover-this-partial-write',
    },
    {
      id: 'unknown',
      operation: 'host.send',
      outcome: 'failed',
      effect: 'unknown',
      detail: 'verify-before-retrying',
    },
  ]
  state.jobs = [{ executionId: 'pending-job', status: 'running' }]
  state.goal = { status: 'blocked', objective: 'goal-must-remain', revision: 0 }
  state.progress.stalled = true
  state.decision.missing = [{ ref: 'missing-page', reason: 'required-body-unavailable' }]
  state.children = [
    { id: 'child', done: false },
    { id: 'child', done: false },
  ]
  state.modelTool = {
    payload: { emptyArray: [], emptyObject: {}, zero: 0, off: false, missing: null },
  }
  recovery.partitions.observation.safety = ['observation-protection-missing']
  recovery.partitions.workspace.capsule.nextObjective = 'workspace-objective'
  const recovered = memoryPrompt(JSON.stringify(recovery))
  for (const important of [
    'recover-this-partial-write',
    'verify-before-retrying',
    'pending-job',
    'goal-must-remain',
    'missing-page',
    'observation-protection-missing',
    'workspace-objective',
  ])
    assert.ok(recovered.includes(important), important)
  const projectedState = JSON.parse(recovered.split('runtime：\n')[1].split('\n')[0])
  assert.deepEqual(projectedState.children, state.children)
  assert.deepEqual(projectedState.modelTool, state.modelTool)
  assert.equal(projectedState.goal.revision, 0)
  assert.equal(projectedState.progress.stalled, true)
  assert.match(JSON.stringify(requests[1]), /native-output-739/)
  assert.equal((await session.inspect()).status, 'completed')
})

test('host filenames remain stable across catalog order and declarations are ordinary file modules', async (t) => {
  const f = await fixture(t)
  const runner = createNodeCodeRunner(f.node)
  const declaration = `/** 通用宿主约束。 */ declare module 'example:host' {
    export interface Item { readonly value: number; }
    /** 读取实际值。 */ export function read(input: {id: string}): Promise<Item>;
  }`
  const source = `
    import {readFile,readdir} from 'node:fs/promises'; import {join} from 'node:path';
    const root=process.env.VELAROS_HOST_DIR;
    const files=await readdir(root);
    const docs=await readFile(join(root,files.find(name=>name.includes('example')&&name.endsWith('.d.ts'))),'utf8');
    const index=JSON.parse(await readFile(join(root,'index.json'),'utf8'));
    const client=await readFile(join(root,index.find(item=>item.module==='example:host').client),'utf8');
    console.log(JSON.stringify({index,docs,client}));
  `
  const catalogs = []
  for (const operations of [
    { 'example:host': ['read'], 'example-host': ['read'] },
    { 'example-host': ['read'], 'example:host': ['read'] },
  ]) {
    const result = await runner.run(
      {
        ...request(source, 10000, operations),
        host: {
          sessionId: 'catalog',
          executionId: 'catalog',
          modules: { 'example:host': { summary: 'example', declarations: declaration } },
        },
      },
      noCalls,
      () => {}
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    const data = JSON.parse(result.process.stdout)
    assert.match(data.docs, /export function read/)
    assert.match(data.docs, /export interface Item/)
    assert.match(data.docs, /通用宿主约束|读取实际值/)
    assert.doesNotMatch(data.docs, /declare module/)
    assert.match(data.client, /import .*bridge\.mjs/)
    assert.doesNotMatch(data.client, /node:http|VELAROS_HOST_TOKEN/)
    assert.equal(new Set(data.index.map((item) => item.client)).size, 2)
    catalogs.push(data.index.find((item) => item.module === 'example:host').client)
  }
  assert.equal(catalogs[0], catalogs[1])
})

test(
  'native I/O remains inside the actual workspace sandbox',
  { skip: process.platform !== 'darwin' && process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t, {}, 'workspace-write')
    const outside = await mkdtemp(join(homedir(), '.velaros-node-confinement-'))
    t.after(() => rm(outside, { recursive: true, force: true }))
    const result = await createNodeCodeRunner(f.node).run(
      request(`
    import {writeFile} from 'node:fs/promises';
    await writeFile('inside.txt','allowed');
    try { await writeFile(${JSON.stringify(join(outside, 'outside.txt'))},'forbidden'); throw Error('escaped') }
    catch(error) { if(error.message==='escaped') throw error; console.log(error.code) }
  `),
      noCalls,
      () => {}
    )
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(await readFile(join(f.cwd, 'inside.txt'), 'utf8'), 'allowed')
    await assert.rejects(readFile(join(outside, 'outside.txt')), { code: 'ENOENT' })
    assert.equal(result.process.confinement.mode, 'workspace-write')
  }
)

test('native bridge rejects missing credentials before dispatch', async (t) => {
  const f = await fixture(t)
  const result = await createNodeCodeRunner(f.node).run(
    request(
      `
    import {request} from 'node:http';
    const status=await new Promise((resolve,reject)=>{
      const req=request({socketPath:process.env.VELAROS_HOST_SOCKET,path:'/',method:'POST'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});
      req.on('error',reject);req.end(JSON.stringify({namespace:'test',operation:'read'}));
    });console.log(status);
  `,
      10_000,
      { test: ['read'] }
    ),
    noCalls,
    () => {}
  )
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.process.stdout.trim(), '403')
})

test('native runtime archives long output and bounds escaped preview JSON, including failed programs', async (t) => {
  const f = await fixture(t)
  const runtime = await createRuntime({
    node: f.node,
    project: false,
    agents: false,
    search: false,
    memory: false,
    storage: localContextStorage({ path: join(f.root, 'large.sqlite') }),
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('large')
  await session.context.append({ kind: 'user', body: 'Check bounded native output' })
  const result = await session.execute({
    source: `console.log('\\0'.repeat(100000));console.error('last-error');process.exitCode=7;`,
  })
  assert.equal(result.checked, true)
  assert.equal(result.result.failed.code, 'PROGRAM_ERROR')
  assert.ok(JSON.stringify(result.result).length <= 60000)
  assert.match(result.result.process.stderr, /last-error/)
  assert.ok((await readFile(result.result.process.logPath)).length > 100000)
})

test('native syntax errors do not execute an earlier file mutation', async (t) => {
  const f = await fixture(t)
  const runtime = await createRuntime({
    node: f.node,
    project: false,
    agents: false,
    search: false,
    memory: false,
    storage: localContextStorage({ path: join(f.root, 'syntax.sqlite') }),
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('syntax')
  await session.context.append({ kind: 'user', body: 'Check invalid code' })
  await assert.rejects(
    session.execute({
      source:
        "import {writeFile} from 'node:fs/promises';await writeFile('forbidden','x');const = ;",
    }),
    { code: 'SCRIPT_CHECK', executed: false }
  )
  await assert.rejects(readFile(join(f.cwd, 'forbidden')), { code: 'ENOENT' })
})

test('business children inherit an explicitly enabled Node scope and retain their own process identity', async (t) => {
  const identities = []
  const f = await fixture(t, { output: (value) => identities.push(value.sessionId) })
  function driver(source) {
    let calls = 0
    return {
      id: 'child-native',
      limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 2000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
      async *stream(req) {
        const marker = req.compiledPrompt.match(/(@@s\w+) execute/)[1]
        assert.match(req.instructions, /真实 Node/)
        yield {
          type: 'text',
          text:
            ++calls === 1
              ? `${marker} execute()\n${source}\n${marker}`
              : `${marker} done\nFinished.`,
        }
        yield { type: 'finish', reason: 'stop' }
      },
    }
  }
  const runtime = await createRuntime({
    node: f.node,
    project: false,
    search: false,
    memory: false,
    context: { maintenance: false },
    storage: localContextStorage({ path: join(f.root, 'child.sqlite') }),
    model: driver(
      `import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';const dir=process.env.VELAROS_HOST_DIR;const index=JSON.parse(await readFile(dir+'/index.json','utf8'));const api=await import(pathToFileURL(dir+'/'+index.find(item=>item.module==='velaros:agents').client));const job=await api.start({task:'write child proof',profile:'worker'});console.log(await api.wait({id:job.id}));`
    ),
    agents: {
      concurrency: 1,
      maxChildren: 1,
      profiles: {
        worker: {
          node: true,
          modules: [],
          model: driver(
            `import {writeFile} from 'node:fs/promises';await writeFile('child-proof.txt','child node');console.log('child-finished');`
          ),
        },
      },
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('parent')
  for await (const event of session.submit('Delegate the file creation and verify the result.'))
    void event
  assert.equal((await session.inspect()).status, 'completed')
  assert.equal(await readFile(join(f.cwd, 'child-proof.txt'), 'utf8'), 'child node')
  assert.ok(identities.includes('parent'))
  assert.equal(new Set(identities).size, 2)
})
