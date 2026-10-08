// 真实 TCP/SSE 断流经过正式模型驱动与 ScriptAct；确定性服务只控制故障点，不用于能力评分。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createAiSdkModelDriver, createModelRuntimeComposition } from '@velaros-ai/model'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime } from '../../../packages/velaros/dist/act/runtime/index.js'
import {
  acquireTaskResources,
  archiveTaskResources,
  checkTaskResourceBudget,
  monitorTaskResources,
  registerTaskResources,
} from './resource-lifecycle.mjs'

async function exercise(root, phase, mode, outerSignal) {
  const directory = join(root, `${phase}-${mode}`)
  await mkdir(directory)
  const effects = join(directory, 'effects.jsonl')
  const count = async () =>
    (
      await readFile(effects, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return ''
        throw error
      })
    )
      .trim()
      .split('\n')
      .filter(Boolean).length
  let wires = 0,
    requests = 0,
    completeReplies = 0,
    effectCalls = 0,
    disconnects = 0
  let runtime
  let controller = new AbortController()
  const errors = []
  const server = createServer((req, res) => {
    void (async () => {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString())
      assert(++wires <= 12, 'bounded wire request budget')
      await appendFile(
        join(directory, 'wire.jsonl'),
        JSON.stringify({ sequence: wires, body }) + '\n'
      )
      assert.equal(req.url, '/v1/chat/completions')
      const tool = (await count()) === 0 ? 'exec' : 'done'
      assert(body.tools.some((item) => item.function.name === tool))
      const args = JSON.stringify(
        tool === 'exec'
          ? { code: "import {commit} from 'test:network-effect';await commit(null);" }
          : { message: 'Original network delivery completed exactly once.' }
      )
      const first = wires === 1
      if (first && phase === 'before-headers') {
        disconnects++
        req.socket.destroy()
        if (mode === 'reopen') controller.abort(new Error('fixture network disconnected'))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = {
        id: `wire-${wires}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fault-fixture',
      }
      const argumentsText =
        first && phase === 'partial-arguments' ? args.slice(0, Math.floor(args.length / 2)) : args
      res.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${wires}`,
                    type: 'function',
                    function: { name: tool, arguments: argumentsText },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`
      )
      if (first) {
        // 让客户端实际接收一个完整 SSE 数据帧，随后切断 TCP；完整参数仍不能代替完整响应。
        await new Promise((resolve) => setTimeout(resolve, 80))
        disconnects++
        res.destroy()
        if (mode === 'reopen') controller.abort(new Error('fixture network disconnected'))
        return
      }
      completeReplies++
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1000, completion_tokens: 30, total_tokens: 1030 } })}\n\n`
      )
      res.end('data: [DONE]\n\n')
    })().catch((error) => {
      errors.push(String(error))
      res.destroy(error)
      controller.abort(error)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const composition = createModelRuntimeComposition({
    environment: {},
    providerScripts: { configPaths: [] },
  })
  const provider = composition.modelAdapterRegistry.createLanguageModelFactory({
    provider: 'deepseek',
    apiKey: 'offline-fixture',
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
  })
  const driver = createAiSdkModelDriver({
    id: 'fault-fixture',
    model: provider('fault-fixture'),
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
  })
  const events = []
  let reopened = false
  try {
    for (let attempt = 0; attempt < (mode === 'reopen' ? 2 : 1); attempt++) {
      controller = new AbortController()
      runtime = await createRuntime({
        dataDir: join(directory, 'state'),
        runner: nodeSubprocessCodeRunner,
        protocol: { transport: 'tools' },
        context: { maintenance: false },
        agents: false,
        search: false,
        memory: false,
        limits: { turns: 6, timeoutMs: 30000 },
        modules: [
          {
            binding: {
              moduleId: 'test:network-effect',
              instanceId: directory,
              generation: 1,
              schemaRevision: '1',
            },
            summary: 'Fixture durable external operation',
            operations: {
              commit: {
                summary: 'Append one fsynced external effect',
                input: { type: 'null' },
                output: { type: 'null' },
                effects: 'write',
                run: async () => {
                  assert(completeReplies > 0, 'an incomplete network response must not execute')
                  assert.equal(++effectCalls, 1, 'duplicate external operation')
                  const handle = await open(effects, 'a', 0o600)
                  try {
                    await handle.writeFile(JSON.stringify({ id: randomUUID() }) + '\n')
                    await handle.sync()
                  } finally {
                    await handle.close()
                  }
                  return null
                },
              },
            },
          },
        ],
        model: {
          id: driver.id,
          nativeTools: driver.nativeTools,
          limits: driver.limits,
          estimate: (request) => driver.estimate(request),
          async *stream(request, signal) {
            assert(++requests <= 6, 'bounded model request budget')
            assert(
              JSON.stringify(request).includes('original-network-delivery'),
              'recovery lost the original task'
            )
            yield* driver.stream(request, signal)
          },
        },
      })
      const session = await runtime.openSession('network-recovery')
      const input =
        attempt === 0
          ? 'original-network-delivery: commit the external operation exactly once and retain the evidence.'
          : 'Continue the original task after checking durable effects.'
      const signal = AbortSignal.any([outerSignal, controller.signal, AbortSignal.timeout(30000)])
      for await (const event of session.submit(input, signal)) {
        events.push(event)
        await appendFile(join(directory, 'events.jsonl'), JSON.stringify({ attempt, event }) + '\n')
      }
      if (mode === 'reopen' && attempt === 0) {
        assert.equal(await count(), 0, 'partial response must leave no effects before restart')
        assert.notEqual(events.at(-1)?.status, 'completed')
        await runtime.close()
        runtime = null
        reopened = true
        continue
      }
      assert.equal(events.at(-1)?.status, 'completed', JSON.stringify(events.slice(-4)))
      const trace = await runtime.trace('network-recovery', { limit: 32, fullContent: true })
      await writeFile(join(directory, 'trace.json'), JSON.stringify(trace, null, 2))
      assert(trace.accounting.modelRequests.unknown >= 1, 'lost response usage must remain unknown')
      assert.equal(await count(), 1, 'the original operation must complete exactly once')
    }
    assert.equal(disconnects, 1)
    assert.equal(effectCalls, 1)
    assert.deepEqual(errors, [])
    return {
      phase,
      mode,
      wires,
      requests,
      disconnects,
      reopened,
      effects: await count(),
      status: 'passed',
    }
  } finally {
    await runtime?.close()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

export async function runNetworkRecovery(output) {
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output)
  const root = await mkdtemp(join(tmpdir(), 'vlr-network-recovery-'))
  const resource = await registerTaskResources(root, output)
  const release = await acquireTaskResources(resource)
  const controller = new AbortController()
  const stop = monitorTaskResources(resource, (error) => controller.abort(error))
  const rows = []
  try {
    await checkTaskResourceBudget(resource)
    for (const phase of ['before-headers', 'partial-arguments', 'complete-arguments']) {
      for (const mode of ['retry', 'reopen']) {
        const result = await exercise(root, phase, mode, controller.signal)
        rows.push(result)
        console.log(JSON.stringify(result))
        await writeFile(
          join(output, 'summary.json'),
          JSON.stringify(
            {
              scope:
                'Real loopback TCP/SSE failures through the production driver and runtime; deterministic responses, no paid model calls.',
              rows,
            },
            null,
            2
          )
        )
      }
    }
    return rows
  } catch (error) {
    await writeFile(join(root, 'failure.txt'), error.stack ?? String(error))
    throw error
  } finally {
    stop()
    await release()
    await archiveTaskResources(resource)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert(process.argv[2], 'Usage: network-recovery.mjs <fresh evidence directory>')
  await runNetworkRecovery(resolve(process.argv[2]))
}
