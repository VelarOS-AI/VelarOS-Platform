import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'

import { ProgramContext } from '../../../dist/act/runtime/impl/ProgramContext.js'
import { createNodeExecutionEnvironment, createRuntime } from '../../../dist/act/runtime/index.js'
import { createLocalShellHost } from '../../../dist/execution/local.js'

import { marker, runtimeFrame } from './support/model-turn.mjs'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const terminal = ['succeeded', 'failed', 'cancelled', 'unknown']
const done = (request, transport) =>
  transport === 'tools'
    ? { type: 'tool-call', value: { id: 'done', name: 'done', input: { message: 'Verified.' } } }
    : { type: 'text', text: `${marker(request)} done\nVerified.` }
const held = `import {existsSync} from 'node:fs'; import {writeFile} from 'node:fs/promises'; import {setTimeout} from 'node:timers/promises'; await writeFile('started','yes'); console.log('started'); while(!existsSync('release')) await setTimeout(10); await writeFile('first','yes'); console.log('finished');`
const dependent = `import {readFile,writeFile} from 'node:fs/promises'; await writeFile('second',await readFile('first','utf8'));`

async function fixture(t, transport, onRequest, config = {}, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'velar-execution-'))
  const storage = localContextStorage({ path: join(root, 'state.sqlite') })
  const shell = createLocalShellHost({
    cwd: root,
    processConfinement: { mode: 'danger-full-access', workspaceRoot: root },
  })
  const node = createNodeExecutionEnvironment({
    cwd: root,
    directory: join(root, 'runs'),
    host: shell,
  })
  const f = {
    root,
    frames: [],
    requests: [],
    events: [],
    storage,
    controller: new AbortController(),
  }
  f.runtime = await createRuntime({
    node,
    storage,
    project: false,
    agents: false,
    search: false,
    memory: false,
    protocol: { transport, yieldAfterMs: 40, ...config },
    context: { maintenance: false },
    ...extra,
    model: {
      id: 'offline-execution-test',
      nativeTools: transport === 'tools',
      limits: { contextTokens: 128000, inputTokens: 120000, outputTokens: 4000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
      async *stream(request) {
        f.requests.push(request)
        f.frames.push(runtimeFrame(request))
        assert(f.requests.length < 8, 'unbounded model loop')
        const programs = await onRequest(f, request)
        if (programs?.type === 'error') {
          yield programs
          return
        }
        if (programs?.type === 'text') yield programs
        else if (programs) {
          if (transport === 'tools') {
            for (const [index, input] of programs.entries())
              yield {
                type: 'tool-call',
                value: { id: `call-${f.requests.length}-${index}`, name: 'exec', input },
              }
          } else
            yield {
              type: 'text',
              text: programs
                .map(
                  ({ code, options = {} }) =>
                    `${marker(request)} execute(${JSON.stringify(options)})\n${code}\n${marker(request)}`
                )
                .join('\n'),
            }
        } else yield done(request, transport)
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  f.session = await f.runtime.openSession('execution')
  f.programs = new ProgramContext('execution', f.session.context, storage)
  f.collect = async (options) => {
    for await (const event of f.session.submit(
      'Run and verify the programs.',
      f.controller.signal,
      options
    ))
      f.events.push(event)
    assert(
      f.controller.signal.aborted || !f.events.some((event) => event.type === 'error'),
      JSON.stringify(f.events.filter((event) => event.type === 'error'))
    )
  }
  t.after(async () => {
    await f.runtime.close()
    await shell.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return f
}

for (const transport of ['tools', 'text']) {
  test(`${transport}: a result completed during model generation wakes text-only waiting beside a live service`, async (t) => {
    let serviceId
    let shortId
    let shortResultRef
    const signal = new AbortController().signal
    const f = await fixture(t, transport, async (f) => {
      if (f.requests.length === 1)
        return [
          { code: held, options: { async: true } },
          {
            code: `import {existsSync} from 'node:fs';import {writeFile} from 'node:fs/promises';import {setTimeout} from 'node:timers/promises';await writeFile('short-started','yes');while(!existsSync('short-release'))await setTimeout(10);console.log('UNSEEN_UI_RESULT_296');`,
            options: { async: true },
          },
        ]
      if (f.requests.length === 2) {
        await waitFile(f.root, 'started')
        await waitFile(f.root, 'short-started')
        const jobs = (await f.programs.state()).jobs
        serviceId = jobs[0].executionId
        shortId = jobs[1].executionId
        await writeFile(join(f.root, 'short-release'), 'yes')
        await until(
          async () => (await f.session.executions.read({ executionId: shortId }, signal)).complete
        )
        shortResultRef = (await f.session.executions.read({ executionId: shortId }, signal))
          .resultRef
        assert(shortResultRef)
        assert.equal(
          f.frames.at(-1).results.some((item) => item.ref === shortResultRef),
          false
        )
        assert.equal(
          (await f.session.executions.read({ executionId: serviceId }, signal)).status,
          'running'
        )
        return { type: 'text', text: 'Waiting for UI verification to finish.' }
      }
      if (f.requests.length === 3) {
        const result = f.frames.at(-1).results.find((item) => item.ref === shortResultRef)
        assert(result, 'next frame must contain the completed execution result')
        assert.match(result.text, /UNSEEN_UI_RESULT_296/)
        assert.equal(
          (await f.session.executions.read({ executionId: serviceId }, signal)).status,
          'running'
        )
        return [{ code: '', options: { control: { kind: 'stop', executionId: serviceId } } }]
      }
    })
    const watchdog = setTimeout(() => f.controller.abort(), 15000)
    try {
      await f.collect()
      assert.equal(
        f.controller.signal.aborted,
        false,
        'completed result was lost while waiting on the service'
      )
      // stop 的回执与目标终态可能分别发布，各自最多补送一帧。
      assert(f.requests.length >= 4 && f.requests.length <= 5)
      assert.equal(f.events.at(-1).status, 'completed')
      assert.equal(
        (await f.session.executions.read({ executionId: serviceId }, signal)).status,
        'cancelled'
      )
    } finally {
      clearTimeout(watchdog)
      f.controller.abort()
    }
  })

  test(`${transport}: async ownership guidance matches completion waiting for a stopped temporary service`, async (t) => {
    const f = await fixture(t, transport, async (f, request) => {
      assert.match(request.instructions, /异步执行仍属于本任务/)
      assert.match(request.instructions, /完成声明不会停止或分离仍在运行的程序/)
      assert.match(request.instructions, /临时服务器验收后用控制 stop 停止，再 read\/wait 确认退出/)
      assert.match(request.instructions, /只有当前能力目录明确提供独立持久后台入口/)
      assert.doesNotMatch(request.instructions, /长负载用受管后台|立即后台/)
      if (f.requests.length === 1) return [{ code: held, options: { async: true } }]
    })
    let finished = false
    const running = f.collect().then(() => {
      finished = true
    })
    try {
      await waitFile(f.root, 'started')
      await until(async () => f.requests.length >= 2)
      await until(async () => {
        const snapshot = await f.storage.load('execution')
        const decision = snapshot.records.findLast((record) => record.title === 'model-response')
        if (!decision) return false
        const body = JSON.parse(await f.storage.get('execution', decision.objectId))
        return body.status === 'accepted' && body.decoded?.done === true
      })
      await pause(80)
      assert.equal(finished, false, 'done cannot detach or terminate a running service')
      const target = (await f.programs.state()).jobs[0].executionId
      const signal = new AbortController().signal
      assert.equal(
        (await f.session.executions.read({ executionId: target }, signal)).status,
        'running'
      )
      await f.session.executions.stop({ executionId: target }, 'test-controller', signal)
      await running
      const result = await f.session.executions.read({ executionId: target }, signal)
      assert.equal(result.status, 'cancelled')
      assert.equal(result.complete, true)
      assert.equal(f.events.at(-1).status, 'completed')
    } finally {
      f.controller.abort()
      await running
    }
  })

  test(`${transport}: the delivered model frame shows the shrinking host deadline`, async (t) => {
    const deadline = Date.now() + 60000
    const f = await fixture(t, transport, async (f, request) => {
      const time = f.frames.at(-1).executionTime
      assert.equal(time.deadline, deadline)
      assert.equal(time.remainingMs, deadline - time.observedAt)
      assert(time.observedAt <= Date.now())
      assert.equal(time.runWindowRenewable, true)
      assert(time.runWindowDeadline > time.observedAt)
      assert(
        request.compiledPrompt.includes(JSON.stringify(time)),
        'deadline omitted from rendered prompt'
      )
      if (f.requests.length === 1)
        return [{ code: "console.log('checkpoint');", options: { async: false } }]
    })
    await f.collect({ deadline })
    assert.equal(f.requests.length, 2)
    assert(f.frames[1].executionTime.remainingMs < f.frames[0].executionTime.remainingMs)
    assert.equal(f.events.at(-1).status, 'completed')
  })

  test(`${transport}: a renewable window is not reported as a known hard deadline`, async (t) => {
    const f = await fixture(t, transport, async (f, request) => {
      const time = f.frames.at(-1).executionTime
      assert.equal(time.deadline, null)
      assert.equal(time.remainingMs, null)
      assert.equal(time.runWindowRenewable, true)
      assert(request.compiledPrompt.includes(JSON.stringify(time)))
    })
    await f.collect()
    assert.equal(f.events.at(-1).status, 'completed')
  })

  test(`${transport}: the host deadline reaches children and stops foreground work`, async (t) => {
    let childEntered = false
    let childStopped = false
    const child = {
      id: 'deadline-child',
      nativeTools: transport === 'tools',
      limits: { contextTokens: 128000, inputTokens: 120000, outputTokens: 4000 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
      async *stream(request, signal) {
        const time = runtimeFrame(request).executionTime
        assert.equal(time.deadline, deadline)
        assert.equal(time.runWindowRenewable, false)
        assert(request.compiledPrompt.includes(JSON.stringify(time)))
        childEntered = true
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true })
          if (signal.aborted) resolve()
        })
        childStopped = true
        yield { type: 'finish', reason: 'stop' }
      },
    }
    const f = await fixture(
      t,
      transport,
      async (f) => {
        assert.equal(f.requests.length, 1)
        return [
          {
            code: `import {start} from 'velaros:agents'; await start({task:'bounded child',profile:'worker'});\n${held}`,
            options: { async: false, timeoutMs: 60000 },
          },
        ]
      },
      {},
      {
        agents: {
          concurrency: 1,
          maxChildren: 1,
          profiles: { worker: { model: child, modules: [], limits: { timeoutMs: 60000 } } },
        },
      }
    )
    const deadline = Date.now() + 4000
    for await (const event of f.session.submit('Run and verify the programs.', undefined, {
      deadline,
    }))
      f.events.push(event)
    for (const event of f.events.filter((event) => event.type === 'error'))
      assert.equal(event.message, '宿主提交期限已到')
    assert(childEntered && childStopped, 'child must start and receive cancellation')
    assert.equal(await readFile(join(f.root, 'started'), 'utf8'), 'yes')
    await assert.rejects(readFile(join(f.root, 'first')), { code: 'ENOENT' })
    assert.equal(f.events.at(-1).status, 'cancelled')
    assert((await f.programs.state()).jobs.every((job) => terminal.includes(job.status)))
    const snapshot = await f.storage.load('execution')
    const result = snapshot.records.find((record) => /^script:.*:result$/.test(record.title ?? ''))
    const timing = JSON.parse(await f.storage.get('execution', result.objectId)).timing
    assert.equal(timing.requestedTimeoutMs, 60000)
    assert(timing.effectiveTimeoutMs > 0 && timing.effectiveTimeoutMs <= 4000)
  })

  test(`${transport}: steering wakes explicit foreground execution without cancelling its process`, async (t) => {
    let executionId
    const f = await fixture(t, transport, async (f) => {
      if (f.requests.length === 1)
        return [{ code: held, options: { async: false } }, { code: dependent }]
      if (f.requests.length === 2) {
        const jobs = f.frames.at(-1).jobs
        assert.equal(jobs.find((j) => j.executionId === executionId).status, 'running')
        assert.equal(jobs.find((j) => j.executionId !== executionId).status, 'queued')
        assert(JSON.stringify(f.requests.at(-1)).includes('Release the same foreground program.'))
        if (transport === 'tools') {
          const results = f.requests.at(-1).history.flatMap((m) => m.toolExchange?.results ?? [])
          assert(results.some((r) => r.output.executionId === executionId))
        }
        const turnId = f.events.find((event) => event.type === 'turn').turnId
        const traced = await f.session.trace(turnId)
        assert.deepEqual(
          traced.executions.map((item) => item.status),
          ['running', 'queued']
        )
        assert.equal(traced.executions[1].durationMs, null)
        await assert.rejects(readFile(join(f.root, 'second')), { code: 'ENOENT' })
        await writeFile(join(f.root, 'release'), 'go')
        await until(async () =>
          (await f.programs.state()).jobs.every((j) => j.status === 'succeeded')
        )
      }
    })
    const running = f.collect()
    const watchdog = setTimeout(() => f.controller.abort(), 3000)
    try {
      await waitFile(f.root, 'started')
      executionId = (await f.programs.state()).jobs.find((j) => j.status === 'running').executionId
      await f.session.steer('Release the same foreground program.')
      await running
      assert.equal(f.controller.signal.aborted, false, 'foreground execution blocked steering')
      assert.equal((await f.programs.state()).jobs.length, 2)
      assert.equal(await readFile(join(f.root, 'second'), 'utf8'), 'yes')
      assert.equal(f.events.at(-1).status, 'completed')
    } finally {
      clearTimeout(watchdog)
      f.controller.abort()
      await running
    }
  })

  test(`${transport}: a background failure wakes explicit foreground execution`, async (t) => {
    let executionId
    const background = `${held
      .replaceAll("'started'", "'background-started'")
      .replaceAll("'release'", "'background-release'")
      .replaceAll("'first'", "'background-finished'")}\nprocess.exit(23);`
    const f = await fixture(t, transport, async (f) => {
      if (f.requests.length === 1)
        return [
          { code: background, options: { async: true } },
          { code: held, options: { async: false } },
        ]
      if (f.requests.length === 2) {
        const jobs = f.frames.at(-1).jobs
        assert.equal(jobs.find((j) => j.executionId !== executionId).status, 'failed')
        assert.equal(jobs.find((j) => j.executionId === executionId).status, 'running')
        await writeFile(join(f.root, 'release'), 'go')
        await until(
          async () =>
            (await f.programs.state()).jobs.find((j) => j.executionId === executionId).status ===
            'succeeded'
        )
      }
    })
    const running = f.collect()
    const watchdog = setTimeout(() => f.controller.abort(), 3000)
    try {
      await waitFile(f.root, 'background-started')
      await waitFile(f.root, 'started')
      for (const job of (await f.programs.state()).jobs) {
        const program = JSON.parse((await f.programs.readProgram(job.sourceRef)).text)
        if (program.source.trim() === held.trim()) executionId = job.executionId
      }
      assert(executionId)
      await writeFile(join(f.root, 'background-release'), 'go')
      await running
      assert.equal(
        f.controller.signal.aborted,
        false,
        'foreground execution hid a background failure'
      )
      assert.equal((await f.programs.state()).jobs.length, 2)
      assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
    } finally {
      clearTimeout(watchdog)
      f.controller.abort()
      await running
    }
  })

  for (const sameProgram of [false, true])
    test(`${transport}: a completed child wakes explicit foreground execution, same program=${sameProgram}`, async (t) => {
      const childStarted = Promise.withResolvers()
      const childRelease = Promise.withResolvers()
      let executionId
      const child = {
        id: 'foreground-child',
        nativeTools: transport === 'tools',
        limits: { contextTokens: 128000, inputTokens: 120000, outputTokens: 4000 },
        estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
        async *stream(request) {
          childStarted.resolve()
          await childRelease.promise
          yield done(request, transport)
          yield { type: 'finish', reason: 'stop' }
        },
      }
      const f = await fixture(
        t,
        transport,
        async (f) => {
          if (f.requests.length === 1 && sameProgram)
            return [
              {
                code: `import {start} from 'velaros:agents'; await start({task:'Finish the child task.',profile:'worker'});\n${
                  held
                }`,
                options: { async: false },
              },
            ]
          if (f.requests.length === 1)
            return [
              {
                code: "import {start} from 'velaros:agents'; await start({task:'Finish the child task.',profile:'worker'});",
                options: { async: false },
              },
            ]
          if (f.requests.length === 2 && !sameProgram) {
            await childStarted.promise
            return [{ code: held, options: { async: false } }]
          }
          if (f.requests.length === (sameProgram ? 2 : 3)) {
            const job = f.frames.at(-1).jobs.find((j) => j.executionId === executionId)
            assert.equal(job.status, 'running')
            await writeFile(join(f.root, 'release'), 'go')
            await until(async () =>
              (await f.programs.state()).jobs.every((j) => j.status === 'succeeded')
            )
          }
        },
        {},
        {
          agents: {
            concurrency: 1,
            maxChildren: 1,
            profiles: { worker: { model: child, modules: [] } },
          },
        }
      )
      const running = f.collect()
      const watchdog = setTimeout(() => {
        childRelease.resolve()
        f.controller.abort()
      }, 3000)
      try {
        await waitFile(f.root, 'started')
        executionId = (await f.programs.state()).jobs.at(-1).executionId
        childRelease.resolve()
        await running
        assert.equal(
          f.controller.signal.aborted,
          false,
          'foreground execution hid the child result'
        )
        assert.equal((await f.programs.state()).jobs.length, sameProgram ? 1 : 2)
        assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
        assert.equal(f.events.at(-1).status, 'completed')
      } finally {
        clearTimeout(watchdog)
        childRelease.resolve()
        f.controller.abort()
        await running
      }
    })

  test(`${transport}: steering wakes passive wait while preserving the real background process`, async (t) => {
    let executionId
    const f = await fixture(t, transport, async (f) => {
      if (f.requests.length === 1) return [{ code: held.replace("console.log('started');", '') }]
      if (f.requests.length === 2) {
        const [job] = f.frames.at(-1).jobs
        executionId = job.executionId
        assert.equal(job.status, 'running')
        await until(async () => {
          try {
            return (await readFile(join(f.root, 'started'), 'utf8')) === 'yes'
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
            return false
          }
        })
        return { type: 'text', text: 'The program is still running; waiting for its result.' }
      }
      if (f.requests.length === 3) {
        const [job] = f.frames.at(-1).jobs
        assert.equal(job.executionId, executionId)
        assert.equal(job.status, 'running')
        assert.equal(await readFile(join(f.root, 'started'), 'utf8'), 'yes')
        await writeFile(join(f.root, 'release'), 'go')
        await until(async () => (await f.programs.state()).jobs[0].status === 'succeeded')
      }
    })
    const running = f.collect()
    const watchdog = setTimeout(() => f.controller.abort(), 3000)
    try {
      await until(() =>
        f.events.some((event) => event.type === 'state' && event.status === 'waiting')
      )
      await f.session.steer('Keep the same program running and release its checkpoint now.')
      await running
      assert.equal(f.controller.signal.aborted, false, 'steering must wake the passive wait')
      assert(f.requests.length >= 3 && f.requests.length <= 4)
      assert(JSON.stringify(f.requests[2]).includes('Keep the same program running'))
      assert.equal((await f.programs.state()).jobs.length, 1)
      assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
      assert.equal(f.events.at(-1).status, 'completed')
    } finally {
      clearTimeout(watchdog)
      f.controller.abort()
      await running
    }
  })

  test(`${transport}: one retryable model failure preserves the already-running execution`, async (t) => {
    let executionId
    const f = await fixture(t, transport, async (f) => {
      if (f.requests.length === 1) return [{ code: held }]
      if (f.requests.length === 2) {
        const [job] = f.frames.at(-1).jobs
        assert.equal(job.status, 'running')
        executionId = job.executionId
        return { type: 'error', code: 'provider', message: 'server_error', retryAfterMs: 0 }
      }
      if (f.requests.length === 3) {
        const [job] = f.frames.at(-1).jobs
        assert.equal(job.executionId, executionId)
        assert.equal(job.status, 'running')
        await writeFile(join(f.root, 'release'), 'go')
        for (let attempt = 0; attempt < 200; attempt++) {
          if ((await f.programs.state()).jobs.every((job) => job.status === 'succeeded')) return
          await pause(10)
        }
        assert.fail('The original execution did not finish after its release')
      }
    })
    await f.collect()
    assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
    assert.equal((await f.programs.state()).jobs.length, 1)
    assert.equal(f.events.filter((event) => event.type === 'rejected').length, 1)
    assert.equal(f.events.at(-1).status, 'completed')
  })

  test(`${transport}: ordinary execution returns all queued identities before dependency completion`, async (t) => {
    const f = await fixture(t, transport, async (f) => {
      if (f.requests.length === 1) return [{ code: held }, { code: dependent }]
      if (f.requests.length === 2) {
        const jobs = f.frames.at(-1).jobs
        assert.equal(jobs.length, 2)
        assert.equal(jobs.filter((job) => job.status === 'queued').length, 1)
        assert.equal(jobs.filter((job) => job.status === 'running').length, 1)
        await assert.rejects(readFile(join(f.root, 'second')), { code: 'ENOENT' })
        if (transport === 'tools') {
          const results = f.requests.at(-1).history.flatMap((m) => m.toolExchange?.results ?? [])
          const running = results.find((r) => r.output.status === 'running').output
          assert.equal(running.effect, 'unknown')
          assert(jobs.some((j) => j.executionId === running.executionId))
          const queued = results.find((r) => r.output.status === 'queued').output
          assert.equal(queued.effect, 'none')
        }
        await writeFile(join(f.root, 'release'), 'go')
      }
    })
    await f.collect()
    assert.equal(await readFile(join(f.root, 'second'), 'utf8'), 'yes')
    assert((await f.programs.state()).jobs.every((j) => j.status === 'succeeded'))
    const settled = await f.session.trace(f.events.find((event) => event.type === 'turn').turnId)
    assert(settled.executions.every((item) => item.status === 'succeeded'))
  })

  for (const async of [true, false])
    test(`${transport}: explicit async=${async} keeps its scheduling contract`, async (t) => {
      const f = await fixture(t, transport, async (f) => {
        if (f.requests.length === 1)
          return [
            {
              code: async
                ? held
                : `import {writeFile} from 'node:fs/promises'; import {setTimeout} from 'node:timers/promises'; await setTimeout(160); await writeFile('first','yes');`,
              options: { async },
            },
          ]
        if (f.requests.length === 2) {
          if (async) {
            assert(
              f.frames.at(-1).jobs.some((j) => j.status === 'running' || j.status === 'queued')
            )
            await writeFile(join(f.root, 'release'), 'go')
          } else {
            assert(f.frames.at(-1).jobs.every((j) => j.status === 'succeeded'))
            assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
          }
        }
      })
      await f.collect()
      assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
    })
}

test('mixed background work overlaps while dependent ordinary programs remain ordered', async (t) => {
  const f = await fixture(t, 'tools', async (f) => {
    if (f.requests.length === 1)
      return [
        { code: held, options: { async: true } },
        {
          code: `import {writeFile} from 'node:fs/promises'; await writeFile('independent','yes');`,
        },
        {
          code: `import {readFile,writeFile} from 'node:fs/promises'; await writeFile('ordered',await readFile('independent','utf8'));`,
        },
      ]
    if (f.requests.length === 2) {
      const deadline = Date.now() + 4000
      while (true) {
        try {
          const content = await readFile(join(f.root, 'ordered'), 'utf8')
          if (content === 'yes') break
          assert.equal(content, '', 'only the not-yet-written file may be observed while writing')
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        assert(Date.now() < deadline)
        await pause(10)
      }
      await assert.rejects(readFile(join(f.root, 'first')), { code: 'ENOENT' })
      await writeFile(join(f.root, 'release'), 'go')
    }
  })
  await f.collect()
  assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
})

test('cancellation after a bounded return settles queued dependencies without starting them', async (t) => {
  const f = await fixture(t, 'tools', async (f) => {
    if (f.requests.length === 1) return [{ code: held }, { code: dependent }]
    f.controller.abort()
  })
  await f.collect()
  assert(f.events.some((e) => e.type === 'state' && e.status === 'cancelled'))
  await assert.rejects(readFile(join(f.root, 'second')), { code: 'ENOENT' })
  assert((await f.programs.state()).jobs.every((j) => terminal.includes(j.status)))
})

test('direct host execution waits for completion despite a shorter model return window', async (t) => {
  const f = await fixture(t, 'tools', async () => {
    throw Error('unexpected model request')
  })
  await f.session.context.append({ kind: 'user', body: 'Verify direct host execution' })
  const result = await f.session.execute({
    source: `import {setTimeout} from 'node:timers/promises'; import {writeFile} from 'node:fs/promises'; await setTimeout(160); await writeFile('host','done');`,
  })
  assert.equal(result.checked, true)
  assert.equal(await readFile(join(f.root, 'host'), 'utf8'), 'done')
  assert.equal(f.requests.length, 0)
})

async function until(check) {
  const deadline = Date.now() + 8000
  while (!(await check())) {
    assert(Date.now() < deadline, 'condition timed out')
    await pause(10)
  }
}

async function waitFile(root, name) {
  await until(async () => {
    try {
      return (await readFile(join(root, name), 'utf8')) === 'yes'
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return false
    }
  })
}

test('running stdout/stderr has stable bounded cursors and survives terminal settlement', async (t) => {
  let target
  let snapshot
  const f = await fixture(t, 'tools', async (f) => {
    if (f.requests.length === 1)
      return [
        {
          code: held.replace(
            "console.log('started');",
            "process.stdout.write('x'.repeat(40000)); console.error('diagnostic-only');"
          ),
        },
      ]
    if (f.requests.length === 2) {
      target = f.frames.at(-1).jobs[0].executionId
      await until(async () => {
        snapshot = await f.session.executions.read(
          { executionId: target },
          new AbortController().signal
        )
        return snapshot.totalChars >= 40016
      })
      assert.equal(snapshot.status, 'running')
      assert.equal(snapshot.complete, false)
      assert.equal(snapshot.truncated, true)
      assert(snapshot.output.reduce((n, c) => n + c.text.length, 0) <= 8000)
      const last = await f.session.executions.read(
        { executionId: target, cursor: 40000 },
        new AbortController().signal
      )
      assert(last.output.some((c) => c.stream === 'stderr' && c.text.includes('diagnostic-only')))
      assert.deepEqual(
        await f.session.executions.read(
          { executionId: target, cursor: 40000 },
          new AbortController().signal
        ),
        last
      )
      const other = await f.runtime.openSession('other')
      await assert.rejects(
        other.executions.read({ executionId: target }, new AbortController().signal),
        { code: 'NOT_FOUND' }
      )
      await assert.rejects(
        f.session.executions.stop({ executionId: target }, target, new AbortController().signal),
        { code: 'VALIDATION' }
      )
      await writeFile(join(f.root, 'release'), 'go')
    }
  })
  await f.collect()
  const final = await f.session.executions.read(
    { executionId: target, cursor: snapshot.nextCursor },
    new AbortController().signal
  )
  assert.equal(final.status, 'succeeded')
  assert.equal(final.complete, true)
  assert(final.totalChars > snapshot.totalChars)
  const state = await f.programs.state()
  assert.equal(state.jobs.find((j) => j.executionId === target).output.totalChars, final.totalChars)
  assert(f.requests.length <= 4, 'output burst must not produce per-line model requests')
})

test('model execution controls stop one background process and keep the other running', async (t) => {
  let target
  const f = await fixture(t, 'tools', async (f) => {
    if (f.requests.length === 1)
      return [
        { code: held, options: { async: true } },
        {
          code: held
            .replaceAll("'first'", "'other-finished'")
            .replaceAll("'started'", "'other-started'"),
          options: { async: true },
        },
      ]
    if (f.requests.length === 2) {
      target = f.frames.at(-1).jobs[0].executionId
      return [
        {
          code: `import {executions} from 'velaros:system'; const before=await executions.read({executionId:${JSON.stringify(target)}}); const stopped=await executions.stop({executionId:${JSON.stringify(target)}}); console.log(JSON.stringify({before,stopped}));`,
          options: { async: false },
        },
      ]
    }
    if (f.requests.length === 3) {
      await until(
        async () =>
          !['queued', 'running'].includes(
            (await f.session.executions.read({ executionId: target }, new AbortController().signal))
              .status
          )
      )
      const stopped = await f.session.executions.read(
        { executionId: target },
        new AbortController().signal
      )
      assert.equal(stopped.stopRequested, true)
      assert.equal(stopped.status, 'cancelled')
      await assert.rejects(readFile(join(f.root, 'first')), { code: 'ENOENT' })
      await writeFile(join(f.root, 'release'), 'go')
    }
  })
  await f.collect()
  assert.equal(await readFile(join(f.root, 'other-finished'), 'utf8'), 'yes')
  const control = (await f.programs.state()).jobs.at(-1)
  assert.equal(control.status, 'succeeded')
})

test('host can stop a queued job while the execution slots are occupied', async (t) => {
  let queued
  const f = await fixture(
    t,
    'tools',
    async (f) => {
      if (f.requests.length === 1) return [{ code: held }, { code: dependent }]
      if (f.requests.length === 2) {
        queued = f.frames.at(-1).jobs.find((j) => j.status === 'queued').executionId
        const result = await f.session.executions.stop(
          { executionId: queued },
          'host',
          new AbortController().signal
        )
        assert.equal(result.stopRequested, true)
        await writeFile(join(f.root, 'release'), 'go')
      }
    },
    { concurrency: 1 }
  )
  await f.collect()
  assert.equal(
    (await f.session.executions.read({ executionId: queued }, new AbortController().signal)).status,
    'cancelled'
  )
  await assert.rejects(readFile(join(f.root, 'second')), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
})

for (const transport of ['text', 'tools'])
  test(`${transport}: the control lane stops a running program with every ordinary slot occupied`, async (t) => {
    let target
    const f = await fixture(
      t,
      transport,
      async (f) => {
        if (f.requests.length === 1) return [{ code: held }]
        if (f.requests.length === 2) {
          target = f.frames.at(-1).jobs[0].executionId
          await until(async () => {
            try {
              await readFile(join(f.root, 'started'))
              return true
            } catch {
              return false
            }
          })
          return [{ code: '', options: { control: { kind: 'read', executionId: target } } }]
        }
        if (f.requests.length === 3)
          return [{ code: '', options: { control: { kind: 'stop', executionId: target } } }]
      },
      { concurrency: 1, maxBlocks: 1 }
    )
    await f.collect()
    const result = await f.session.executions.read(
      { executionId: target },
      new AbortController().signal
    )
    assert.equal(result.status, 'cancelled')
    assert.equal(result.stopRequested, true)
    await assert.rejects(readFile(join(f.root, 'first')), { code: 'ENOENT' })
    // 控制进程可先于被停止的进程组收束；额外一帧是目标终态唤醒，不是再次轮询。
    assert(
      f.requests.length >= 4 && f.requests.length <= 5,
      JSON.stringify(f.frames.map((frame) => frame.jobs))
    )
    assert.equal(
      (await f.programs.state()).jobs.length,
      3,
      'one ordinary job plus exactly one read and one stop'
    )
    await Array.fromAsync(f.session.submit({ task: 'new', text: 'Start an independent new task.' }))
    await assert.rejects(
      f.session.executions.read({ executionId: target }, new AbortController().signal),
      { code: 'NOT_FOUND' }
    )
  })

test(
  'a real control process stops one of four occupied slots and advances a queued program within its deadline',
  { timeout: 60000 },
  async (t) => {
    let target
    let queued
    let started
    let elapsed
    const f = await fixture(
      t,
      'tools',
      async (f) => {
        if (f.requests.length === 1)
          return Array.from({ length: 4 }, (_, index) => ({
            code: held
              .replaceAll("'started'", `'started-${index}'`)
              .replaceAll("'first'", `'first-${index}'`),
            options: { async: true },
          }))
        if (f.requests.length === 2) {
          await until(async () => {
            try {
              await Promise.all(
                Array.from({ length: 4 }, (_, index) => readFile(join(f.root, `started-${index}`)))
              )
              return true
            } catch {
              return false
            }
          })
          const jobs = (await f.programs.state()).jobs
          assert.equal(jobs.filter((job) => job.status === 'running').length, 4)
          target = jobs[0].executionId
          return [
            {
              code: "import {writeFile} from 'node:fs/promises'; await writeFile('queue-advanced','yes');",
              options: { async: true },
            },
          ]
        }
        if (f.requests.length === 3) {
          const jobs = (await f.programs.state()).jobs
          queued = jobs.find((job) => job.status === 'queued')?.executionId
          assert(queued, 'the fifth ordinary program must wait for a slot')
          started = performance.now()
          return [{ code: '', options: { control: { kind: 'stop', executionId: target } } }]
        }
        if (f.requests.length === 4) {
          elapsed = performance.now() - started
          assert(elapsed < 5000, `control preparation, process start and stop took ${elapsed} ms`)
          await until(
            async () =>
              (await f.programs.state()).jobs.find((job) => job.executionId === queued)?.status ===
              'succeeded'
          )
          assert.equal(await readFile(join(f.root, 'queue-advanced'), 'utf8'), 'yes')
          await writeFile(join(f.root, 'release'), 'go')
        }
      },
      { concurrency: 4, maxBlocks: 8 }
    )
    await f.collect()
    const stopped = await f.session.executions.read(
      { executionId: target },
      new AbortController().signal
    )
    assert.equal(stopped.status, 'cancelled')
    assert.equal(stopped.stopRequested, true)
    assert.equal(
      (await f.programs.state()).jobs.find((job) => job.executionId === queued)?.status,
      'succeeded'
    )
    t.diagnostic(
      `real four-slot stop including host directory and process preparation: ${Math.round(elapsed)} ms`
    )
  }
)

test('stopping an execution does not wait behind the write lock held by its in-flight call', async (t) => {
  let entered = false
  let stopped = false
  let target
  const module = {
    binding: {
      moduleId: 'test:slow-write',
      instanceId: 'slow',
      generation: 1,
      schemaRevision: '1',
    },
    summary: 'Cancellable write boundary',
    operations: {
      hold: {
        summary: 'Wait for cancellation',
        effects: 'write',
        input: { type: 'null' },
        output: { type: 'null' },
        run: async (_input, call) => {
          entered = true
          try {
            await new Promise((_resolve, reject) => {
              const cancel = () => reject(call.signal.reason)
              call.signal.addEventListener('abort', cancel, { once: true })
              if (call.signal.aborted) cancel()
            })
          } finally {
            stopped = true
            call.recordEffect('none')
          }
        },
      },
    },
  }
  const f = await fixture(
    t,
    'tools',
    async (f) => {
      if (f.requests.length === 1)
        return [{ code: "import {hold} from 'test:slow-write'; await hold(null);" }]
      if (f.requests.length === 2) {
        target = f.frames.at(-1).jobs[0].executionId
        await until(() => entered)
        return [{ code: '', options: { control: { kind: 'stop', executionId: target } } }]
      }
    },
    { concurrency: 1 },
    { modules: [module] }
  )
  await f.collect()
  assert(entered && stopped)
  assert.equal(
    (await f.session.executions.read({ executionId: target }, new AbortController().signal))
      .stopRequested,
    true
  )
})

test('a stalled control call has a wall deadline even while the Node capability clock is paused', async (t) => {
  let entered = false
  let interrupted = false
  let originalRead
  const f = await fixture(
    t,
    'tools',
    async (f) => {
      if (f.requests.length === 1) return [{ code: held }]
      if (f.requests.length === 2) {
        const target = f.frames.at(-1).jobs[0].executionId
        originalRead = f.session.executions.read
        f.session.executions.read = async (_input, signal) => {
          entered = true
          await new Promise((_resolve, reject) => {
            const stop = () => {
              interrupted = true
              reject(signal.reason)
            }
            signal.addEventListener('abort', stop, { once: true })
            if (signal.aborted) stop()
          })
        }
        return [
          {
            code: '',
            options: { control: { kind: 'read', executionId: target }, timeoutMs: 3000 },
          },
        ]
      }
      if (f.requests.length === 3) {
        f.session.executions.read = originalRead
        assert(interrupted)
        await writeFile(join(f.root, 'release'), 'go')
      }
    },
    { concurrency: 1 }
  )
  const watchdog = setTimeout(() => f.controller.abort(), 8000)
  t.after(() => clearTimeout(watchdog))
  await f.collect()
  clearTimeout(watchdog)
  assert(entered && interrupted)
  assert.equal(
    f.controller.signal.aborted,
    false,
    'the control must stop before the parent watchdog'
  )
  assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
})

for (const transport of ['tools', 'text']) {
  test(`${transport}: completion wait survives the short control deadline with all ordinary slots full`, async (t) => {
    let target
    let waitingAt
    let release
    const f = await fixture(
      t,
      transport,
      async (f) => {
        if (f.requests.length === 1) return [{ code: held, options: { async: true } }]
        if (f.requests.length === 2) {
          await waitFile(f.root, 'started')
          target = f.frames.at(-1).jobs[0].executionId
          waitingAt = Date.now()
          release = setTimeout(() => void writeFile(join(f.root, 'release'), 'go'), 6100)
          return [
            {
              code: '',
              options: { control: { kind: 'wait', executionId: target, waitMs: 10000 } },
            },
          ]
        }
        assert(Date.now() - waitingAt >= 6000, 'waiting returned before target completion')
        assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
        assert.equal(
          (await f.programs.state()).jobs.find((job) => job.executionId === target).status,
          'succeeded'
        )
      },
      { concurrency: 1, maxBlocks: 1 }
    )
    t.after(() => clearTimeout(release))
    await f.collect()
    // Parallel completion may wake the model while the wait control records its own result.
    assert((await f.programs.state()).jobs.every((job) => job.status === 'succeeded'))
    // The target and its wait control can finish separately. Every follow-up above must
    // already see the target complete; one later control-result turn is not polling.
    assert(
      f.requests.length >= 3 && f.requests.length <= 4,
      'only target completion and wait-control completion may wake the model'
    )
    const snapshot = await f.session.executions.wait(
      { executionId: target },
      'host',
      f.controller.signal
    )
    assert.equal(snapshot.complete, true)
    assert(snapshot.output.some((chunk) => chunk.text.includes('finished')))
  })

  test(`${transport}: steering can stop the target during a completion wait with no ordinary capacity`, async (t) => {
    let target
    let entered = false
    const f = await fixture(
      t,
      transport,
      async (f) => {
        if (f.requests.length === 1) return [{ code: held, options: { async: true } }]
        if (f.requests.length === 2) {
          await waitFile(f.root, 'started')
          target = f.frames.at(-1).jobs[0].executionId
          const wait = f.session.executions.wait
          f.session.executions.wait = (...args) => {
            entered = true
            return wait(...args)
          }
          return [{ code: '', options: { control: { kind: 'wait', executionId: target } } }]
        }
        if (f.requests.length === 3) {
          assert(entered)
          assert(JSON.stringify(f.requests.at(-1)).includes('Stop the existing task now.'))
          return [{ code: '', options: { control: { kind: 'stop', executionId: target } } }]
        }
      },
      { concurrency: 1, maxBlocks: 1 }
    )
    const running = f.collect()
    const watchdog = setTimeout(() => f.controller.abort(), 8000)
    try {
      await until(() => entered)
      await f.session.steer('Stop the existing task now.')
      await running
      assert.equal(f.controller.signal.aborted, false, 'wait blocked the stop control')
      const jobs = (await f.programs.state()).jobs
      assert.equal(jobs.length, 3)
      assert.equal(jobs.find((job) => job.executionId === target).status, 'cancelled')
      assert(
        jobs.filter((job) => job.executionId !== target).every((job) => job.status === 'succeeded')
      )
      assert.equal(f.requests.length, 4)
      await assert.rejects(readFile(join(f.root, 'first')), { code: 'ENOENT' })
    } finally {
      clearTimeout(watchdog)
      f.controller.abort()
      await running
    }
  })
}

test('completion wait validates scope and duration, times out normally, and cancellation preserves the target', async (t) => {
  const f = await fixture(t, 'tools', async (f) => {
    if (f.requests.length === 1) return [{ code: held, options: { async: true } }]
    await waitFile(f.root, 'started')
    const target = f.frames.at(-1).jobs[0].executionId
    const wait = (input, signal = f.controller.signal) =>
      f.session.executions.wait({ executionId: target, ...input }, 'host', signal)
    for (const waitMs of [0, -1, 60001, 1.5, NaN, '100'])
      await assert.rejects(wait({ waitMs }), { code: 'VALIDATION' })
    await assert.rejects(
      f.session.executions.wait({ executionId: target }, target, f.controller.signal),
      { code: 'VALIDATION' }
    )
    const other = await f.runtime.openSession('other-wait')
    await assert.rejects(
      other.executions.wait({ executionId: target }, 'host', f.controller.signal),
      { code: 'NOT_FOUND' }
    )
    const before = Date.now()
    const timed = await wait({ waitMs: 40, limit: 2 })
    assert(Date.now() - before >= 35)
    assert.equal(timed.status, 'running')
    assert.equal(timed.complete, false)
    assert(timed.output.reduce((sum, part) => sum + part.text.length, 0) <= 2)
    const cancellation = new AbortController()
    const reason = new Error('cancel only the waiter')
    const pending = wait({ waitMs: 60000 }, cancellation.signal)
    cancellation.abort(reason)
    await assert.rejects(pending, (error) => error === reason)
    assert.equal(
      (await f.session.executions.read({ executionId: target }, f.controller.signal)).status,
      'running'
    )
    const completing = wait({ waitMs: 2000, cursor: timed.nextCursor })
    await writeFile(join(f.root, 'release'), 'go')
    const completed = await completing
    assert.equal(completed.status, 'succeeded')
    assert.equal(completed.complete, true)
    assert(completed.nextCursor > timed.nextCursor)
    const finalStarted = Date.now()
    assert.deepEqual(
      await wait({ cursor: completed.nextCursor }),
      await f.session.executions.read(
        { executionId: target, cursor: completed.nextCursor },
        f.controller.signal
      )
    )
    assert(Date.now() - finalStarted < 1000, 'terminal target must return immediately')
    const job = (await f.programs.state()).jobs[0]
    await f.programs.job({
      executionId: 'unknown-old-process',
      sourceRef: job.sourceRef,
      batchId: job.batchId,
      status: 'running',
    })
    const unknown = await f.session.executions.wait(
      { executionId: 'unknown-old-process' },
      'host',
      f.controller.signal
    )
    assert.equal(unknown.status, 'unknown')
    assert.equal(unknown.complete, false)
    // Unknown liveness cannot establish goal completion; end this fixture through cancellation.
    f.controller.abort()
  })
  await f.collect()
  assert.equal(await readFile(join(f.root, 'first'), 'utf8'), 'yes')
})

test('a second wait is bounded and stopping the wait program leaves its target alive', async (t) => {
  let target
  let entered = false
  let waiter
  const f = await fixture(
    t,
    'tools',
    async (f) => {
      if (f.requests.length === 1) return [{ code: held, options: { async: true } }]
      if (f.requests.length === 2) {
        await waitFile(f.root, 'started')
        target = f.frames.at(-1).jobs[0].executionId
        const wait = f.session.executions.wait
        f.session.executions.wait = (...args) => {
          entered = true
          return wait(...args)
        }
        return [{ code: '', options: { control: { kind: 'wait', executionId: target } } }]
      }
      if (f.requests.length === 3) {
        waiter = f.frames.at(-1).jobs.find((job) => job.executionId !== target).executionId
        return [{ code: '', options: { control: { kind: 'wait', executionId: target } } }]
      }
      if (f.requests.length === 4) {
        assert(JSON.stringify(f.requests.at(-1)).includes('SCRIPT_QUEUE_LIMIT'))
        assert.equal((await f.programs.state()).jobs.length, 2)
        return [{ code: '', options: { control: { kind: 'stop', executionId: waiter } } }]
      }
      if (f.requests.length === 5) {
        assert.equal(
          (await f.session.executions.read({ executionId: waiter }, f.controller.signal)).status,
          'cancelled'
        )
        assert.equal(
          (await f.session.executions.read({ executionId: target }, f.controller.signal)).status,
          'running'
        )
        return [{ code: '', options: { control: { kind: 'stop', executionId: target } } }]
      }
    },
    { concurrency: 1, maxBlocks: 1 }
  )
  const running = f.collect()
  const watchdog = setTimeout(() => f.controller.abort(), 8000)
  try {
    await until(() => entered)
    await f.session.steer('Check another wait and then stop only the waiter.')
    await running
    assert.equal(
      f.controller.signal.aborted,
      false,
      JSON.stringify({
        requests: f.requests.length,
        jobs: (await f.programs.state()).jobs,
        frames: f.frames.map((frame) => frame.jobs),
        events: f.events.filter((event) => event.type === 'error'),
      })
    )
    assert.equal(f.requests.length, 6)
  } finally {
    clearTimeout(watchdog)
    f.controller.abort()
    await running
  }
})
