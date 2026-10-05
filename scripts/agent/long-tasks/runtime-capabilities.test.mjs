import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createRuntime,
  createShellNodeEnvironment,
} from '../../../packages/velaros/dist/act/runtime/index.js'
import { createLocalShellHost } from '../../../packages/velaros/dist/shell/local.js'
import { runtimeCapabilityOptions } from './runtime-capabilities.mjs'

for (const mode of ['on-demand', 'shell-node'])
  test(`capability ablation reaches the real Node catalog and ordinary execution: ${mode}`, async (t) => {
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
      node: createShellNodeEnvironment({ cwd, directory: join(root, 'runs'), shell }),
      model: {
        id: 'offline-capability-check',
        nativeTools: true,
        limits: { contextTokens: 65536, inputTokens: 32768, outputTokens: 12000 },
        estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
        async *stream(request) {
          requests.push(request)
          yield { type: 'text', text: 'Completed the fixture.' }
          yield { type: 'finish', reason: 'stop' }
        },
      },
    })
    const session = await runtime.openSession('capability-check')
    await session.context.append({ kind: 'user', body: 'Check the available capabilities.' })
    const result = await session.execute({
      source:
        "import {readFile} from 'node:fs/promises'; const entries=JSON.parse(await readFile(process.env.VELAROS_HOST_DIR+'/index.json','utf8')); console.log(JSON.stringify(entries.map(item=>item.module)));",
    })
    assert.equal(result.result.failed, undefined)
    const modules = JSON.parse(result.result.process.stdout)
    for (const name of ['velaros:project', 'velaros:code', 'velaros:agents', 'velaros:search'])
      assert.equal(modules.includes(name), mode === 'on-demand', name)
    const command = await session.execute({
      language: 'shell',
      source: 'printf shell-capability-check',
    })
    assert.equal(command.result.process.stdout, 'shell-capability-check')
    for await (const event of session.submit('Finish the fixture'))
      assert.notEqual(event.type, 'error')
    assert.equal(requests.length, 1)
    assert.deepEqual(
      requests[0].response.tools.map((tool) => tool.name),
      ['shell', 'node']
    )
    assert.equal(requests[0].instructions.includes('velaros:agents'), mode === 'on-demand')
    assert.equal(requests[0].instructions.includes('velaros:search'), mode === 'on-demand')
  })
