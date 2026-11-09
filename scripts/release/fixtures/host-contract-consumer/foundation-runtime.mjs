import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeRuntime } from '@velaros-ai/velaros/node'

const root = await mkdtemp(join(tmpdir(), 'velaros-installed-runtime-'))
const cwd = join(root, 'execution')
await mkdir(cwd)
let phase = 'complete'
let calls = 0
let interactions = 0
let cancellationReady
const model = {
  id: 'installed-consumer-model',
  limits: { contextTokens: 128000, inputTokens: 110000, outputTokens: 4096 },
  estimate: async () => ({ tokens: 1000, precision: 'estimate', basis: 'installed-consumer' }),
  async *stream(request) {
    const tag = [...request.protocol.matchAll(/当前帧标记：(@@\w+)。/gu)].at(-1)?.[1]
    assert(tag, 'The real Runtime supplies the current text protocol marker')
    calls += 1
    if (phase === 'complete' && calls > 1) {
      yield { type: 'text', text: `Executed the real command and received the answer.\n${tag} done` }
    } else {
      const source = phase === 'complete'
        ? "import {ask} from 'velaros:interaction';import {execa} from 'execa';import {writeFile} from 'node:fs/promises';const answer=await ask({message:'Confirm the isolated package test.'});const result=await execa(process.execPath,['-e',\"process.stdout.write('actual-command')\"],{stdin:'ignore'});await writeFile('receipt.txt',result.stdout+' '+answer.text);console.log(result.stdout);"
        : "import {execa} from 'execa';await execa(process.execPath,['-e',\"console.log('cancel-ready');setInterval(()=>{},1000)\"],{stdin:'ignore',stdout:'inherit'});"
      yield { type: 'text', text: `${tag} execute({async:false})\n${source}\n${tag}` }
    }
    yield { type: 'finish', reason: 'stop' }
  },
}
const options = {
  cwd,
  stateDirectory: join(root, 'state'),
  binding: { executionIdentity: 'isolated-consumer', authorizationScope: 'isolated-test-policy-v1' },
  localHost: { processConfinement: { mode: 'danger-full-access' } },
  protocol: { transport: 'text' },
  context: { maintenance: false },
  execution: { output: ({ text }) => { if (text.includes('cancel-ready')) cancellationReady?.() } },
  model,
}
let runtime
try {
  runtime = await createNodeRuntime(options)
  for (const module of ['velaros:project', 'velaros:images', 'velaros:search', 'velaros:agents'])
    assert.throws(() => runtime.describe(module), /未挂载/u)
  const session = await runtime.openSession('installed')
  const completed = []
  let answeredRequest
  for await (const event of session.submit('Run a real command, save its output, and ask me for input.')) {
    completed.push(event)
    if (event.type === 'interaction') {
      interactions += 1
      answeredRequest = { id: event.request.id, runId: event.request.runId, value: 'accepted' }
      await session.answer(answeredRequest)
    }
  }
  assert.equal(completed.at(-1)?.status, 'completed', JSON.stringify(completed))
  assert.equal(interactions, 1)
  assert.equal(await readFile(join(cwd, 'receipt.txt'), 'utf8'), 'actual-command accepted')
  await assert.rejects(session.answer(answeredRequest))
  phase = 'cancel'
  const ready = new Promise((resolve) => { cancellationReady = resolve })
  const cancelled = []
  const sending = (async () => { for await (const event of session.submit('Start the process and cancel it.')) cancelled.push(event) })()
  await Promise.race([ready, sending.then(() => assert.fail('Process must start before cancellation'))])
  session.cancel()
  await sending
  assert.equal(cancelled.at(-1)?.status, 'cancelled', JSON.stringify(cancelled))
  const trace = await runtime.trace('installed')
  assert(trace.turns.some((turn) => turn.executions?.length))
  await runtime.close()
  runtime = await createNodeRuntime(options)
  await runtime.openSession('installed')
  assert((await runtime.trace('installed')).turns.length >= trace.turns.length)
  console.log(JSON.stringify({ platform: process.platform, input: true, model: 'deterministic-driver', modelCalls: calls, command: true, file: true, interactions, cancellation: 'actual-child-process', restored: true }))
} finally {
  await runtime?.close()
  await rm(root, { recursive: true, force: true })
}
