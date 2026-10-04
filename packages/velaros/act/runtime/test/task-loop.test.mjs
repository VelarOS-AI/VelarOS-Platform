import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { createRuntime, createShellCapabilityModule } from '../../../dist/act/runtime/index.js'
import { createLocalShellHost, createShellEnvironment } from '../../../dist/shell/local.js'

import { done, modelText, turn } from './support/model-turn.mjs'

const hash = (text) => createHash('sha256').update(text).digest('hex')
const modelLimits = { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 }
const originalSource = 'export const double = (value) => value;\n'
const repairedSource = 'export const double = (value) => value * 2;\n'
const originalTest = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { double } from '../src/double.mjs';
test('TASK_LOOP_NATIVE_ASSERTION', () => assert.equal(double(3), 6));
`
const expectedReport = '{"status":"repaired"}\n'

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'scriptact-task-loop-'))
  const project = join(root, 'project')
  await mkdir(join(project, 'src'), { recursive: true })
  await mkdir(join(project, 'test'))
  await writeFile(join(project, 'src/double.mjs'), originalSource)
  await writeFile(join(project, 'test/double.test.mjs'), originalTest)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, project }
}

function writeStep(path, text) {
  return { action: 'write', path, text }
}

function program(source) {
  return { execute: { source } }
}

function requestMessages(summary) {
  return JSON.parse(summary.messages).flatMap((message) => {
    if (message.role !== 'user') return []
    if (typeof message.content === 'string') return [message.content]
    return message.content.filter((item) => item.type === 'text').map((item) => item.text)
  })
}

for (const defect of ['artifact', 'protection']) {
  test(`INV-28/30/61 real task loop repairs ${defect} after native tests pass`, async (t) => {
    const { root, project } = await workspace(t)
    const command = `${JSON.stringify(process.execPath)} --test test/double.test.mjs`
    const task = {
      goal: 'Repair double and publish the repair status',
      inputs: ['src/double.mjs', 'test/double.test.mjs'],
      outputs: ['src/double.mjs', 'report.json'],
      protectedPaths: ['test/double.test.mjs'],
      publicTests: [{ command, cwd: '.', timeoutMs: 5000 }],
      success: ['The existing native test passes', 'report.json records status repaired'],
    }
    const submitted = JSON.stringify(task)
    // Node's outer test runner marks descendants as test workers; the native suite is independent.
    const environment = createShellEnvironment({
      env: () =>
        Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')
        ),
    })
    const host = createLocalShellHost({ cwd: project, environment })
    const commands = []
    const snapshots = []
    const requests = []
    let checks = 0
    t.after(async () => {
      await runtime?.close()
      await host.dispose()
      await environment.dispose()
    })
    const run = async (...args) => {
      assert.equal(args[0], command)
      assert.equal(resolve(args[1].cwd), project)
      const result = await host.runCommand(...args)
      commands.push({
        command: args[0],
        exitCode: result.exitCode,
        cleanupIncomplete: result.cleanupIncomplete,
      })
      return result
    }
    const runtime = await createRuntime({
      workspace: project,
      dataDir: join(root, 'state'),
      runner: nodeSubprocessCodeRunner,
      agents: false,
      search: false,
      memory: false,
      modules: [
        createShellCapabilityModule({
          instanceId: 'task-loop-shell',
          approval: {},
          shell: {
            resolveCwd: async (cwd) => {
              assert.equal(resolve(project, cwd ?? '.'), project)
              return project
            },
            runCommand: run,
          },
        }),
      ],
      context: {
        maintenance: false,
        completion: {
          verify: async (view, signal) => {
            const source = await readFile(join(project, 'src/double.mjs'), 'utf8')
            const protectedText = await readFile(join(project, 'test/double.test.mjs'), 'utf8')
            const report = await readFile(join(project, 'report.json'), 'utf8')
            const native = await run(command, { cwd: project, timeoutMs: 5000 }, false, signal)
            const passed =
              native.exitCode === 0 && protectedText === originalTest && report === expectedReport
            const label =
              defect === 'artifact' ? 'TASK_LOOP_CURRENT_ARTIFACT' : 'TASK_LOOP_PROTECTED_TEST'
            const result = {
              verified: passed,
              reason: passed ? 'Native tests, current artifacts and protection verified' : label,
              recovery: passed ? undefined : 'repair',
              report: {
                scope: JSON.stringify(view.scope),
                checkedAt: new Date().toISOString(),
                checks: [
                  {
                    label: 'Existing native test',
                    status: native.exitCode === 0 ? 'passed' : 'failed',
                  },
                  {
                    label: 'Protected test bytes',
                    status: protectedText === originalTest ? 'passed' : 'failed',
                    artifact: {
                      identity: 'test/double.test.mjs',
                      contentHash: hash(protectedText),
                    },
                  },
                  {
                    label: 'Current repair report',
                    status: report === expectedReport ? 'passed' : 'failed',
                    artifact: { identity: 'report.json', contentHash: hash(report) },
                  },
                ],
              },
            }
            snapshots.push({
              result,
              sourceHash: hash(source),
              reportHash: hash(report),
              protectedHash: hash(protectedText),
            })
            checks++
            return result
          },
        },
      },
      model: {
        id: 'task-loop-local-driver',
        limits: modelLimits,
        estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
        async *stream(request) {
          requests.push(request)
          const round = requests.length
          if (round === 1) {
            assert.match(modelText(request), /Repair double and publish the repair status/)
            assert.match(request.instructions + modelText(request), /Shell 和 Node/)
            yield turn(
              request,
              program(
                `import {run} from 'velaros:shell';import {output} from 'velaros';output(await run({command:${JSON.stringify(command)},timeoutMs:5000}));`
              )
            )
          } else if (round === 2) {
            assert.match(modelText(request), /TASK_LOOP_NATIVE_ASSERTION/)
            assert.match(modelText(request), /exitCode.{0,8}1/)
            const steps = [
              writeStep('src/double.mjs', repairedSource),
              writeStep(
                'report.json',
                defect === 'artifact' ? '{"status":"pending"}\n' : expectedReport
              ),
            ]
            if (defect === 'protection')
              steps.push(
                writeStep('test/double.test.mjs', `${originalTest}// modified protection\n`)
              )
            yield turn(
              request,
              program(
                `import {read,edit} from 'velaros:project';import {run} from 'velaros:shell';import {output} from 'velaros';const current=(await read({files:[{path:'src/double.mjs'}]})).files[0];if(current.text!==${JSON.stringify(originalSource)})throw Error('unexpected current source');await edit({steps:${JSON.stringify(steps)}});output(await run({command:${JSON.stringify(command)},timeoutMs:5000}));`
              )
            )
          } else if (round === 3 || round === 5) {
            yield* done(request)
            return
          } else if (round === 4) {
            assert.equal(checks, 1)
            assert.match(
              modelText(request),
              defect === 'artifact' ? /TASK_LOOP_CURRENT_ARTIFACT/ : /TASK_LOOP_PROTECTED_TEST/
            )
            const step =
              defect === 'artifact'
                ? writeStep('report.json', expectedReport)
                : writeStep('test/double.test.mjs', originalTest)
            yield turn(
              request,
              program(
                `import {edit} from 'velaros:project';import {run} from 'velaros:shell';import {output} from 'velaros';await edit({steps:${JSON.stringify([step])}});output(await run({command:${JSON.stringify(command)},timeoutMs:5000}));`
              )
            )
          } else assert.fail(`unexpected round ${round}`)
          yield { type: 'finish', reason: 'stop' }
        },
      },
    })
    const session = await runtime.openSession('task-loop')
    const events = []
    for await (const event of session.submit(submitted)) events.push(event)
    assert.equal(
      events.at(-1).status,
      'completed',
      JSON.stringify(events.filter((event) => event.type === 'error'))
    )
    assert.equal((await session.inspect()).status, 'completed')
    assert.equal(requests.length, 5)
    assert.deepEqual(
      events.filter((event) => event.type === 'verification').map((event) => event.verified),
      [false, true]
    )
    assert.deepEqual(
      snapshots.map((entry) => entry.result.verified),
      [false, true]
    )
    assert.equal(snapshots[0].sourceHash, hash(repairedSource))
    assert.equal(snapshots[1].sourceHash, hash(repairedSource))
    assert.notEqual(
      snapshots[0][defect === 'artifact' ? 'reportHash' : 'protectedHash'],
      snapshots[1][defect === 'artifact' ? 'reportHash' : 'protectedHash']
    )
    assert.deepEqual(
      commands.map((entry) => entry.exitCode),
      [1, 0, 0, 0, 0]
    )
    assert(commands.every((entry) => entry.cleanupIncomplete === false))
    assert.equal(await readFile(join(project, 'src/double.mjs'), 'utf8'), repairedSource)
    assert.equal(await readFile(join(project, 'report.json'), 'utf8'), expectedReport)
    assert.equal(await readFile(join(project, 'test/double.test.mjs'), 'utf8'), originalTest)
    const page = await runtime.trace('task-loop', { fullContent: true, limit: 8 })
    assert.equal(page.turns.length, 5)
    assert(page.turns.every((entry) => entry.modelAccounting.outcome === 'accepted'))
    assert(page.turns.every((entry) => entry.runId === events.at(-1).runId))
    assert(page.turns.every((entry) => !entry.requestSummary.messagesTruncated))
    assert(
      snapshots.every((entry) => JSON.parse(entry.result.report.scope).sessionId === 'task-loop')
    )
    assert(requestMessages(page.turns[0].requestSummary).some((text) => text.includes(submitted)))
  })
}

test('task opt-in body delivery checks accepted request text, then repairs a reference-only delivery', async (t) => {
  const { root, project } = await workspace(t)
  const currentBody = 'CURRENT_TASK_ARTIFACT_57b2\nfirst line\nsecond line\n'
  await writeFile(join(project, 'delivery.txt'), currentBody)
  const submitted = JSON.stringify({
    goal: 'Deliver delivery.txt current full text',
    outputs: ['delivery.txt'],
    delivery: 'current-full-body',
  })
  const checks = []
  const requests = []
  const runtime = await createRuntime({
    workspace: project,
    dataDir: join(root, 'state'),
    runner: nodeSubprocessCodeRunner,
    agents: false,
    search: false,
    memory: false,
    context: {
      maintenance: false,
      completion: {
        verify: async (view) => {
          const current = await readFile(join(project, 'delivery.txt'), 'utf8')
          const page = await runtime.trace('delivery', { fullContent: true, limit: 8 })
          const accepted = page.turns.filter(
            (entry) => entry.modelAccounting.outcome === 'accepted'
          )
          assert.equal(view.scope.sessionId, 'delivery')
          assert(accepted.every((entry) => entry.request.ref.sessionId === view.scope.sessionId))
          assert(accepted.every((entry) => !entry.requestSummary.messagesTruncated))
          const delivered = accepted.some((entry) =>
            requestMessages(entry.requestSummary).some((text) => text.includes(current))
          )
          checks.push({
            delivered,
            currentHash: hash(current),
            accepted: accepted.length,
            scope: view.scope,
          })
          return {
            verified: delivered,
            reason: delivered
              ? 'Current task body delivered in accepted request'
              : 'TASK_BODY_NOT_DELIVERED: read current delivery.txt and present its full text',
            recovery: delivered ? undefined : 'repair',
            report: {
              scope: JSON.stringify(view.scope),
              checkedAt: new Date().toISOString(),
              checks: [
                {
                  label: 'Current full task body in accepted request',
                  status: delivered ? 'passed' : 'failed',
                  artifact: { identity: 'delivery.txt', contentHash: hash(current) },
                },
              ],
            },
          }
        },
      },
    },
    model: {
      id: 'task-delivery-local-driver',
      limits: modelLimits,
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
      async *stream(request) {
        requests.push(request)
        const round = requests.length
        if (round === 1 || round === 3) {
          if (round === 3) assert.match(modelText(request), /TASK_BODY_NOT_DELIVERED/)
          const mode = round === 1 ? 'reference' : 'full'
          yield turn(request, {
            observe: {
              source: `import {read} from 'velaros:project';import {output} from 'velaros';const file=(await read({files:[{path:'delivery.txt'}]})).files[0];output(file.text,{key:'task-body',purpose:'Deliver current task artifact',view:{mode:${JSON.stringify(mode)}}});`,
            },
          })
          yield { type: 'finish', reason: 'stop' }
        } else if (round === 2 || round === 4) yield* done(request)
        else assert.fail(`unexpected round ${round}`)
      },
    },
  })
  t.after(() => runtime.close())
  const session = await runtime.openSession('delivery')
  const events = []
  for await (const event of session.submit(submitted)) events.push(event)
  assert.equal(
    events.at(-1).status,
    'completed',
    JSON.stringify(events.filter((event) => event.type === 'error'))
  )
  assert.deepEqual(
    checks.map((entry) => entry.delivered),
    [false, true]
  )
  assert(checks.every((entry) => entry.currentHash === hash(currentBody)))
  assert.equal(requests.length, 4)
  assert(!modelText(requests[1]).includes(currentBody))
  assert(modelText(requests[3]).includes(currentBody))
  assert.deepEqual(
    events.filter((event) => event.type === 'verification').map((event) => event.verified),
    [false, true]
  )
})
