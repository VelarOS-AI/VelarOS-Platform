import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { actionAdapter, operationProgram } from './action-adapter.mjs'
import { cases, development } from './cases.mjs'
import { awaitGatewaySettlement } from './settlement.mjs'
const execute = promisify(execFile)

test('the next attempt waits for late upstream settlement; remaining unknown usage is not replaced by zero', async (t) => {
  let polls = 0
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture')
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        activeUpstreamRequests: ++polls < 3 ? 1 : 0,
        activeModelDiscoveryRequests: 0,
        unknownUsage: 1,
      })
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const result = await awaitGatewaySettlement(
    `http://127.0.0.1:${server.address().port}/v1`,
    'fixture',
    { timeoutMs: 1000, pollMs: 1 }
  )
  assert.equal(polls, 3)
  assert.equal(result.state.unknownUsage, 1)
})

test('unsettled upstream work exhausts the deadline instead of allowing another attempt', async (t) => {
  const server = createServer((_, response) =>
    response.end(JSON.stringify({ activeUpstreamRequests: 1, activeModelDiscoveryRequests: 0 }))
  )
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await assert.rejects(
    awaitGatewaySettlement(`http://127.0.0.1:${server.address().port}`, 'fixture', {
      timeoutMs: 15,
      pollMs: 2,
    }),
    /timed out|aborted/i
  )
})

for (const item of cases)
  test(`independent grader rejects baseline and accepts positive control: ${item.id}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'vlr-mechanism-preflight-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const grader = join(root, 'grade.mjs')
    await writeFile(grader, item.grade)
    await execute(process.execPath, ['--check', grader])
    async function files(values) {
      for (const [path, text] of Object.entries(values)) {
        await mkdir(dirname(join(workspace, path)), { recursive: true })
        await writeFile(join(workspace, path), text)
      }
    }
    await files(item.files)
    await assert.rejects(execute(process.execPath, [grader, workspace, '1'], { timeout: 20000 }))
    await files(item.control)
    for (let phase = 1; phase <= item.prompts.length; phase++)
      await execute(process.execPath, [grader, workspace, String(phase)], { timeout: 20000 })
  })

test('development grader has an independent known answer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vlr-mechanism-dev-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'grade.mjs'), development.grade)
  await writeFile(join(root, 'result.txt'), development.files['note.txt'].toUpperCase())
  await execute(process.execPath, [join(root, 'grade.mjs'), root])
})

test('individual operations preserve literal arguments and permit shell composition', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vlr-mechanism-tools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const text = 'literal ` ${notCode} " 中文\n'
  const calls = [
    { name: 'writeFile', input: { path: 'a.txt', content: text } },
    { name: 'readFile', input: { path: 'a.txt' } },
    { name: 'listFiles', input: { path: '.' } },
    {
      name: 'runCommand',
      input: { command: "node -e 'console.log([1,2,3].map(x=>x*x).reduce((a,b)=>a+b,0))'" },
    },
  ]
  const outputs = []
  for (const call of calls) {
    const result = await execute(
      process.execPath,
      ['--input-type=module', '-e', operationProgram(call)],
      { cwd: root }
    )
    outputs.push(result.stdout)
  }
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), text)
  assert.equal(outputs[1], text + '\n')
  assert.equal(JSON.parse(outputs[3]).stdout, '14\n')
  assert.throws(() => operationProgram({ name: 'readFile', input: { path: 'a', extra: 'field' } }))
  assert.throws(() => operationProgram({ name: 'unregistered', input: {} }))
})

test('adapter transforms only business tools and restores original tool identities in subsequent history', async () => {
  const seen = []
  const base = {
    id: 'fixture',
    nativeTools: true,
    limits: { contextTokens: 1000, inputTokens: 800, outputTokens: 100 },
    estimate: async (request) => {
      seen.push(request)
      return { tokens: 50, precision: 'exact', basis: 'fixture' }
    },
    async *stream(request) {
      seen.push(request)
      yield {
        type: 'tool-call',
        value: { id: 'call-1', name: 'readFile', input: { path: 'x.txt' } },
      }
      yield { type: 'usage', inputTokens: 50, outputTokens: 7 }
      yield { type: 'finish', reason: 'stop' }
    },
  }
  const model = actionAdapter(base, 'tools'),
    request = {
      instructions: 'original',
      materials: [],
      history: [],
      response: { type: 'tools', tools: [{ name: 'exec' }, { name: 'done' }] },
      mode: 'work',
    }
  const output = await Array.fromAsync(model.stream(request, new AbortController().signal))
  assert.equal(output[0].value.name, 'exec')
  assert.match(output[0].value.input.code, /readFile/)
  assert.equal(output[1].type, 'usage')
  await model.estimate({
    ...request,
    history: [
      {
        role: 'assistant',
        content: '',
        toolExchange: {
          text: '',
          calls: [output[0].value],
          results: [{ id: 'call-1', name: 'exec', output: 'contents' }],
        },
      },
      { role: 'user', content: 'contents', toolResult: { callId: 'call-1', toolName: 'exec' } },
    ],
  })
  assert.equal(seen.at(-1).history[0].toolExchange.calls[0].name, 'readFile')
  assert.equal(seen.at(-1).history[1].toolResult.toolName, 'readFile')
  const review = { ...request, response: { type: 'json' }, mode: 'maintenance' }
  await model.estimate(review)
  assert.equal(seen.at(-1), review)
})
