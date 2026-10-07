import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createRuntime,
  createNodeExecutionEnvironment,
} from '../../../packages/velaros/dist/act/runtime/index.js'
import { createLocalShellHost } from '../../../packages/velaros/dist/execution/local.js'
import {
  runtimeCapabilityOptions,
  runtimeEditingPrompt,
  runtimeSubmissionOptions,
} from './runtime-capabilities.mjs'

for (const mode of ['on-demand', 'node', 'project'])
  for (const taskMode of ['request', 'goal'])
    test(`capability and task modes reach the real Node catalog and lifecycle: ${mode}/${taskMode}`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'velaros-capability-mode-'))
      const cwd = join(root, 'workspace')
      await mkdir(cwd)
      const shell = createLocalShellHost({ cwd })
      let runtime
      t.after(async () => {
        await runtime?.close()
        await shell.dispose()
        await rm(root, { recursive: true, force: true })
      })
      const requests = []
      runtime = await createRuntime({
        workspace: cwd,
        dataDir: join(root, 'data'),
        memory: false,
        ...runtimeCapabilityOptions(mode),
        node: createNodeExecutionEnvironment({ cwd, directory: join(root, 'runs'), host: shell }),
        model: {
          id: 'offline-capability-check',
          nativeTools: true,
          limits: { contextTokens: 65536, inputTokens: 32768, outputTokens: 12000 },
          estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
          async *stream(request) {
            requests.push(request)
            if (taskMode === 'goal' && requests.length === 2)
              yield {
                type: 'tool-call',
                value: {
                  id: 'goal-completion',
                  name: 'exec',
                  input: {
                    code: "import {goal} from 'velaros:system'; const current=await goal.get(); await goal.update({baseRevision:current.revision,status:'complete',reason:'已验证测试夹具'});",
                  },
                },
              }
            else yield { type: 'text', text: 'Completed the fixture.' }
            yield { type: 'finish', reason: 'stop' }
          },
        },
      })
      const session = await runtime.openSession('capability-check')
      await session.context.append({ kind: 'user', body: 'Check the available capabilities.' })
      const result = await session.execute({
        source:
          "import {readFile} from 'node:fs/promises'; const entries=JSON.parse(await readFile(process.env.VELAROS_HOST_DIR+'/index.json','utf8')); console.log(JSON.stringify(entries.capabilities.map(item=>item.module)));",
      })
      assert.equal(result.result.failed, undefined)
      const modules = JSON.parse(result.result.process.stdout)
      for (const name of ['velaros:project', 'velaros:code', 'velaros:agents', 'velaros:search'])
        assert.equal(
          modules.includes(name),
          name === 'velaros:project' ? mode !== 'node' : mode === 'on-demand',
          name
        )
      const command = await session.execute({
        source:
          "import {execa} from 'execa';console.log((await execa(process.execPath,['-p','21*2'])).stdout)",
      })
      assert.equal(command.result.process.stdout.trim(), '42')
      const objective = 'Finish the fixture'
      for await (const event of session.submit(
        objective,
        undefined,
        runtimeSubmissionOptions(taskMode, objective)
      ))
        assert.notEqual(event.type, 'error')
      assert.equal(requests.length, taskMode === 'goal' ? 3 : 1)
      const goal = await session.getGoal()
      if (taskMode === 'goal') {
        assert.equal(goal.objective, objective)
        assert.equal(goal.status, 'complete')
        assert.equal(goal.reason, '已验证测试夹具')
      } else assert.equal(goal, null)
      assert.deepEqual(
        requests[0].response.tools.map((tool) => tool.name),
        ['exec']
      )
      assert.equal(requests[0].instructions.includes('velaros:agents'), mode === 'on-demand')
      assert.equal(requests[0].instructions.includes('velaros:search'), mode === 'on-demand')
      assert.equal(requests[0].instructions.includes('velaros:project'), mode !== 'node')
    })

test('editing policies preserve the task and reject impossible project conditions before dispatch', () => {
  const prompt = 'Preserve existing APIs and implement the complete requested feature.'
  for (const mode of ['node', 'project', 'on-demand'])
    assert.equal(runtimeEditingPrompt(mode, 'adaptive', prompt), prompt)
  const guided = runtimeEditingPrompt('project', 'project', prompt)
  assert(guided.startsWith(prompt + '\n\n'))
  assert(guided.includes('velaros:project'))
  assert(guided.includes('generated build outputs may use standard Node.js and Execa'))
  assert.throws(() => runtimeEditingPrompt('node', 'project', prompt), /requires/)
  assert.throws(() => runtimeEditingPrompt('project', 'unknown', prompt), /Unknown/)
  assert.throws(() => runtimeEditingPrompt('unknown', 'adaptive', prompt), /Unknown/)
})

test('task submission defaults to ordinary requests and rejects unknown modes', () => {
  assert.deepEqual(runtimeSubmissionOptions(undefined, 'User task'), {})
  assert.deepEqual(runtimeSubmissionOptions('goal', 'User task'), { goal: 'User task' })
  assert.throws(() => runtimeSubmissionOptions('implicit', 'User task'))
  assert.throws(() => runtimeSubmissionOptions('goal', ''))
})
