#!/usr/bin/env node
// 冻结快照上的固定工作量对照：同一源码与输出，分别使用各版本正式执行入口。
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2])
const rounds = 24
const at = (variant, file) => import(pathToFileURL(join(root, variant, 'packages', file)))
const results = []
for (const variant of ['previous', 'standard']) {
  const { createRuntime, createShellNodeEnvironment } = await at(
    variant,
    'velaros/dist/act/runtime/index.js'
  )
  const { createLocalShellHost } = await at(variant, 'velaros/dist/shell/local.js')
  const { localContextStorage } = await at(variant, 'context/dist/node.js')
  const directory = join(root, 'footprint', variant)
  const cwd = join(directory, 'workspace')
  await mkdir(cwd, { recursive: true })
  const requests = []
  const shell = createLocalShellHost({ cwd })
  const runtime = await createRuntime({
    node: createShellNodeEnvironment({ cwd, directory: join(directory, 'node'), shell }),
    storage: localContextStorage({ path: join(directory, 'state.sqlite') }),
    project: false,
    agents: false,
    search: false,
    memory: false,
    context: { maintenance: false },
    limits: { turns: rounds + 2, timeoutMs: 120000, outputTokens: 4000 },
    model: {
      id: 'deterministic-footprint',
      nativeTools: variant === 'standard',
      limits: { contextTokens: 1000000, inputTokens: 990000, outputTokens: 4000 },
      estimate: async () => ({
        tokens: 1000,
        precision: 'exact',
        basis: 'fixed control; compare encoded bytes independently',
      }),
      async *stream(request) {
        requests.push(request)
        const step = requests.length
        const marker = request.compiledPrompt.match(/当前帧标记：(@@\w+)。/)?.[1]
        if (step <= rounds) {
          const source = `import {appendFile} from 'node:fs/promises';await appendFile('steps.jsonl',JSON.stringify({step:${step},status:'checked',items:[false,0,null]})+'\\n');console.log(JSON.stringify({step:${step},status:'checked',items:[false,0,null]}));`
          yield variant === 'standard'
            ? {
                type: 'tool-call',
                value: { id: `call_${step}`, name: 'node', input: { code: source } },
              }
            : { type: 'text', text: `${marker} execute()\n${source}\n${marker}\n` }
        } else
          yield {
            type: 'text',
            text: variant === 'standard' ? '24 项已验证。' : `${marker} done\n24 项已验证。`,
          }
        yield { type: 'finish', reason: 'stop' }
      },
    },
  })
  try {
    const session = await runtime.openSession('footprint')
    for await (const event of session.submit('逐步完成 24 项记录，保留每次实际结果。'))
      assert.notEqual(event.type, 'error', JSON.stringify(event))
    assert.equal((await session.inspect()).status, 'completed')
    const records = (await readFile(join(cwd, 'steps.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.deepEqual(
      records,
      Array.from({ length: rounds }, (_, index) => ({
        step: index + 1,
        status: 'checked',
        items: [false, 0, null],
      }))
    )
    assert.equal(requests.length, rounds + 1)
    const measure = (request) => {
      const state = request.history.filter((message) =>
        /^(?:Runtime 本帧工作内存|当前运行状态)/u.test(message.content)
      )
      return {
        requestBytes: Buffer.byteLength(
          JSON.stringify({
            system: request.instructions,
            history: request.history,
            current: request.compiledPrompt,
            response: request.response,
          })
        ),
        transientStateBytes: state.reduce(
          (total, message) => total + Buffer.byteLength(message.content),
          0
        ),
        transientStateFrames: state.length,
      }
    }
    const frames = requests.map(measure)
    const result = {
      variant,
      executions: records.length,
      requests: requests.length,
      sumRequestBytes: frames.reduce((sum, frame) => sum + frame.requestBytes, 0),
      last: frames.at(-1),
      frames,
    }
    results.push(result)
    await writeFile(join(directory, 'requests.json'), JSON.stringify(requests, null, 2))
  } finally {
    await runtime.close()
    await shell.dispose()
  }
}
const { nodeCapabilityDeclarations, nodeOperationDeclarations } = await at(
  'standard',
  'script/dist/utils/node-client.js'
)
const documents = []
for (const module of ['sessions', 'project', 'browser', 'web', 'files', 'shell']) {
  const exports = await at('standard', `velaros/dist/${module}/contract/surface.js`)
  for (const surface of Object.values(exports)) {
    if (!surface?.specifier || !surface?.declarations || !surface?.methods) continue
    const fullBytes = Buffer.byteLength(
      nodeCapabilityDeclarations(surface.declarations, surface.specifier)
    )
    for (const [name, source] of Object.entries(
      nodeOperationDeclarations(surface.declarations, surface.specifier, surface.methods)
    ))
      documents.push({
        module: surface.specifier,
        operation: name,
        fullBytes,
        operationBytes: Buffer.byteLength(source),
      })
  }
}
const output = {
  rounds,
  measure:
    'UTF-8 serialized runtime request bytes; mock driver, no provider tokens or latency claim',
  results,
  documents,
}
await writeFile(join(root, 'footprint.json'), JSON.stringify(output, null, 2))
console.log(
  JSON.stringify({
    results: results.map(({ frames, ...result }) => result),
    documents: documents.length,
  })
)
