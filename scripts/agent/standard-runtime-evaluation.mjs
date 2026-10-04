#!/usr/bin/env node
// 同一模型与生成配置，比较冻结的 ScriptAct 与标准 Node。凭据只从本机私有文件读取。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const output = resolve(
  process.argv[2] ?? join(root, '.velaros-workspace/bench/standard-runtime-20261004')
)
const split = process.argv[3] ?? 'development'
const repetitions = Number(process.argv[4] ?? 1)
const credentialPath =
  process.argv[5] ||
  join(root, '.velaros-workspace/bench/parallel-54/provider-hedgeho9-private.json')
const configuration = JSON.parse(await readFile(credentialPath, 'utf8')).chat
const suiteText = await readFile(
  resolve(process.argv[6] || join(root, 'scripts/agent/standard-runtime-cases.json')),
  'utf8'
)
const suite = JSON.parse(suiteText)
const freeze = JSON.parse(await readFile(join(output, 'suite-freeze.json'), 'utf8'))
if (freeze.evaluatorSha256)
  assert.equal(
    createHash('sha256')
      .update(await readFile(import.meta.filename))
      .digest('hex'),
    freeze.evaluatorSha256,
    'The evaluator must remain frozen'
  )
const variants = freeze.variants ?? [
  { id: 'baseline', node: false },
  { id: 'standard', node: true },
]
assert.ok(Array.isArray(variants) && variants.length >= 2)
assert.equal(new Set(variants.map((variant) => variant.id)).size, variants.length)
assert.ok(
  variants.every(
    (variant) => /^[a-z][a-z0-9-]*$/u.test(variant.id) && typeof variant.node === 'boolean'
  )
)
const nativeVariants = new Set(
  variants.filter((variant) => variant.node).map((variant) => variant.id)
)
assert.equal(
  createHash('sha256').update(suiteText).digest('hex'),
  freeze.suiteSha256,
  'The evaluation suite must remain frozen'
)
const modelId = 'gpt-5.6-sol'
const require = createRequire(join(output, 'standard/packages/model/package.json'))
const { createOpenAI } = await import(pathToFileURL(require.resolve('@ai-sdk/openai')))
const exec = promisify(execFile)
const results = []
const importAt = (variant, path) => import(pathToFileURL(join(output, variant, 'packages', path)))

// 绑定宿主实例的方法；展开实例只会复制自有字段，不能转交原型方法。
function shellCapability(createShellCapabilityModule, projectCapabilityPorts, shell, cwd, signal) {
  return createShellCapabilityModule({
    instanceId: cwd,
    shell: projectCapabilityPorts.shell(
      {
        getRootPath: () => cwd,
        runCommand: (...args) => shell.runCommand(...args),
        listBackgroundTasks: (...args) => shell.listBackgroundTasks(...args),
        refreshShellEnvironment: () => shell.refreshShellEnvironment(),
        terminateBackgroundTask: (...args) => shell.terminateBackgroundTask(...args),
      },
      signal
    ),
    approval: {
      awaitConfirmation: async () => {},
      awaitConfirmationDecision: async () => ({ approved: true, message: null }),
    },
  })
}

// 两侧在任何模型调用之前经过同一真实命令探针，装配失败不能计作模型表现。
async function preflight(variant) {
  const directory = join(output, 'preflight', variant)
  const cwd = join(directory, 'workspace')
  await mkdir(cwd, { recursive: true })
  const {
    createRuntime,
    createShellCapabilityModule,
    createShellNodeEnvironment,
    createCapabilityModule,
  } = await importAt(variant, 'velaros/dist/act/runtime/index.js')
  const { projectCapabilityPorts } = await importAt(variant, 'velaros/dist/project/index.js')
  const { createLocalShellHost } = await importAt(variant, 'velaros/dist/shell/local.js')
  const { localContextStorage } = await importAt(variant, 'context/dist/node.js')
  const { sessionsOperations } = await importAt(variant, 'velaros/dist/sessions/index.js')
  const { VelarSessionsModule } = await importAt(variant, 'velaros/dist/sessions/contracts.js')
  const hostCases = suite.cases.filter((item) => item.split === split && item.sessions)
  let peers = hostCases[0]?.sessions ?? []
  const shell = createLocalShellHost({ cwd })
  let runtime
  try {
    runtime = await createRuntime({
      workspace: cwd,
      project: false,
      agents: false,
      memory: false,
      search: false,
      modules: [
        shellCapability(createShellCapabilityModule, projectCapabilityPorts, shell, cwd),
        ...(hostCases.length
          ? [
              createCapabilityModule({
                surface: VelarSessionsModule,
                implementation: sessionsOperations,
                instanceId: 'fixture-preflight',
                context: (call) => ({
                  abortSignal: call.signal,
                  sessions: { list: async () => peers },
                }),
              }),
            ]
          : []),
      ],
      storage: localContextStorage({ path: join(directory, 'state.sqlite') }),
      ...(nativeVariants.has(variant)
        ? { node: createShellNodeEnvironment({ cwd, directory: join(directory, 'node'), shell }) }
        : {}),
    })
    const session = await runtime.openSession('probe')
    await session.context.append({
      kind: 'user',
      body: 'Verify real shell execution before evaluating the model',
    })
    const call = `await run({command:${JSON.stringify(`node -e "process.stdout.write('preflight-shell-ok')"`)},background:false})`
    const source = !nativeVariants.has(variant)
      ? `import {run} from 'velaros:shell'; export default ${call};`
      : `import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {pathToFileURL} from 'node:url';const dir=process.env.VELAROS_HOST_DIR;const item=JSON.parse(await readFile(join(dir,'index.json'),'utf8')).find(x=>x.module==='velaros:shell');const {run}=await import(pathToFileURL(join(dir,item.client)));console.log(JSON.stringify(${call}));`
    const result = await session.execute({ source })
    assert.equal(result.checked, true, JSON.stringify(result))
    assert.equal(result.result.failed, undefined, JSON.stringify(result))
    assert.ok(
      result.calls.some((call) => call.call === 'velaros:shell.run' && call.ok),
      JSON.stringify(result)
    )
    assert.match(JSON.stringify(result), /preflight-shell-ok/)
    // 夹具经过两侧真实 Kernel 的输出合同；错误夹具在任何付费请求前失败。
    for (const spec of hostCases) {
      peers = spec.sessions
      const host = await session.execute({
        source: "import {list} from 'velaros:sessions'; console.log(JSON.stringify(await list()))",
      })
      assert.equal(host.checked, true, `${variant}/${spec.id}: ${JSON.stringify(host)}`)
      assert.equal(host.result.failed, undefined, `${variant}/${spec.id}: ${JSON.stringify(host)}`)
      assert.deepEqual(JSON.parse(host.result.process.stdout.trim()), peers)
    }
    await writeFile(
      join(directory, 'result.json'),
      JSON.stringify(
        { passed: true, result, validatedHostCases: hostCases.map((spec) => spec.id) },
        null,
        2
      )
    )
    console.log(JSON.stringify({ preflight: variant, passed: true }))
  } finally {
    await runtime?.close()
    await shell.dispose()
  }
}

async function runCase(variant, spec, repetition) {
  const directory = join(output, 'runs', `${split}-${spec.id}-${repetition}-${variant}`)
  await mkdir(directory, { recursive: true })
  const cwd = join(directory, 'workspace')
  await mkdir(cwd)
  for (const [file, contents] of Object.entries(spec.files)) {
    const path = join(cwd, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
  await exec('git', ['init', '--quiet'], { cwd })
  const {
    createRuntime,
    createShellCapabilityModule,
    createCapabilityModule,
    createShellNodeEnvironment,
  } = await importAt(variant, 'velaros/dist/act/runtime/index.js')
  const { localContextStorage } = await importAt(variant, 'context/dist/node.js')
  const { createLocalShellHost } = await importAt(variant, 'velaros/dist/shell/local.js')
  const { projectCapabilityPorts } = await importAt(variant, 'velaros/dist/project/index.js')
  const { sessionsOperations } = await importAt(variant, 'velaros/dist/sessions/index.js')
  const { VelarSessionsModule } = await importAt(variant, 'velaros/dist/sessions/contracts.js')
  const { createAiSdkModelDriver } = await importAt(variant, 'model/dist/index.js')
  const shell = createLocalShellHost({ cwd })
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(Error('evaluation deadline')), 240_000)
  const wire = []
  const provider = createOpenAI({
    apiKey: configuration.apiKey,
    baseURL: configuration.baseURL,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      body.reasoning = { effort: 'high', summary: 'auto' }
      body.text = { ...body.text, verbosity: 'medium' }
      body.max_output_tokens = 12000
      body.store = false
      wire.push({ at: new Date().toISOString(), body })
      return fetch(url, { ...init, body: JSON.stringify(body) })
    },
  })
  const driver = createAiSdkModelDriver({
    id: modelId,
    model: provider.responses(modelId),
    limits: { contextTokens: 128000, inputTokens: 111904, outputTokens: 12000 },
  })
  const turns = []
  const model = {
    id: driver.id,
    nativeTools: driver.nativeTools,
    limits: driver.limits,
    estimate: (request) => driver.estimate(request),
    async *stream(request, signal) {
      if (turns.length >= 8) {
        abort.abort(Error('request limit'))
        return
      }
      const turn = {
        request,
        estimate: await driver.estimate(request),
        deltas: [],
        started: Date.now(),
      }
      turns.push(turn)
      for await (const delta of driver.stream(request, signal)) {
        turn.deltas.push(delta)
        yield delta
      }
      turn.elapsedMs = Date.now() - turn.started
    },
  }
  const hostCalls = []
  const modules = [
    shellCapability(createShellCapabilityModule, projectCapabilityPorts, shell, cwd, abort.signal),
  ]
  if (spec.sessions)
    modules.push(
      createCapabilityModule({
        surface: VelarSessionsModule,
        implementation: sessionsOperations,
        instanceId: 'peers',
        context: (call) => ({
          abortSignal: call.signal,
          sessions: {
            list: async () => {
              hostCalls.push('list')
              return spec.sessions
            },
          },
        }),
      })
    )
  let runtime, session, status, error
  const events = []
  const started = Date.now()
  try {
    runtime = await createRuntime({
      workspace: cwd,
      project: { code: false, images: false },
      search: false,
      agents: false,
      memory: false,
      model,
      modules,
      storage: localContextStorage({ path: join(directory, 'context.sqlite') }),
      residentModules: [
        { module: 'velaros:project' },
        { module: 'velaros:shell' },
        { module: 'velaros:interaction' },
        { module: 'velaros:widget' },
      ],
      ...(nativeVariants.has(variant)
        ? { node: createShellNodeEnvironment({ cwd, directory: join(directory, 'node'), shell }) }
        : {}),
      environment: () => ({ cwd }),
      context: { maintenance: false },
      limits: { turns: 8, timeoutMs: 240000, outputTokens: 12000 },
    })
    session = await runtime.openSession('evaluation')
    for await (const event of session.submit(spec.prompt, abort.signal)) events.push(event)
    status = (await session.inspect()).status
  } catch (caught) {
    error = String(caught).replaceAll(configuration.apiKey, '[redacted]')
  } finally {
    clearTimeout(deadline)
    await runtime?.close()
    await shell.dispose()
  }
  const elapsedMs = Date.now() - started
  let passed = true,
    gradeError
  try {
    const assertArtifacts = async () => {
      for (const [file, value] of Object.entries(spec.expected ?? {}))
        assert.deepEqual(JSON.parse(await readFile(join(cwd, file), 'utf8')), value)
    }
    await assertArtifacts()
    // 独立重跑交付的标准脚本，防止仅写死验收产物而没有可复用程序。
    for (const script of spec.rerun ?? []) {
      assert(script.endsWith('.mjs') && !script.includes('..'))
      await exec(process.execPath, [script], { cwd, timeout: 10000, maxBuffer: 64000 })
      await assertArtifacts()
    }
    for (const file of spec.unchanged ?? [])
      assert.equal(await readFile(join(cwd, file), 'utf8'), spec.files[file], `${file} changed`)
    if (spec.requiresHost) assert.ok(hostCalls.length >= (spec.minimumHostCalls ?? 1))
    if (spec.grade)
      await exec(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';${spec.grade}`,
        ],
        { cwd, timeout: 10000, maxBuffer: 64000 }
      )
  } catch (caught) {
    passed = false
    gradeError = String(caught)
  }
  const usages = turns.map((turn) => turn.deltas.findLast((delta) => delta.type === 'usage'))
  const completeUsage = usages.length > 0 && usages.every(Boolean)
  const inputTokens = completeUsage
    ? usages.reduce((sum, usage) => sum + usage.inputTokens, 0)
    : null
  const outputTokens = completeUsage
    ? usages.reduce((sum, usage) => sum + usage.outputTokens, 0)
    : null
  const result = {
    variant,
    case: spec.id,
    split,
    repetition,
    passed,
    completed: status === 'completed',
    status: status ?? null,
    requests: turns.length,
    firstTurnExecuted: (() => {
      const start = events.findIndex((event) => event.type === 'turn')
      const next = events.findIndex((event, index) => index > start && event.type === 'turn')
      return events
        .slice(start, next < 0 ? undefined : next)
        .some((event) => event.type === 'state' && event.status === 'executing')
    })(),
    elapsedMs,
    inputTokens,
    outputTokens,
    referenceCostUncachedUSD: completeUsage ? (inputTokens * 4 + outputTokens * 20) / 1e6 : null,
    systemChars: turns[0]?.request.instructions.length ?? null,
    error,
    gradeError,
    hostCalls: hostCalls.length,
  }
  await writeFile(
    join(directory, 'trace.json'),
    JSON.stringify({ result, turns, wire, events }, null, 2)
  )
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2))
  results.push(result)
  await writeFile(
    join(output, `${split}-results.json`),
    JSON.stringify(
      {
        model: modelId,
        reasoning: 'high',
        maxOutputTokens: 12000,
        pricing: 'reference only; input $4/M, output $20/M; cache discounts excluded',
        suiteSha256: freeze.suiteSha256,
        results,
      },
      null,
      2
    )
  )
  console.log(JSON.stringify(result))
}

for (const { id, manifestSha256 } of variants) {
  const manifestText = await readFile(join(output, id, 'manifest.json'), 'utf8')
  if (manifestSha256)
    assert.equal(createHash('sha256').update(manifestText).digest('hex'), manifestSha256)
  for (const [path, digest] of Object.entries(JSON.parse(manifestText).files)) {
    assert(path.startsWith('packages/') && !path.split('/').includes('..'))
    assert.equal(
      createHash('sha256')
        .update(await readFile(join(output, id, path)))
        .digest('hex'),
      digest,
      `${id}/${path} changed after freezing`
    )
  }
  await preflight(id)
}
for (let repetition = 0; repetition < repetitions; repetition++)
  for (const [index, spec] of suite.cases.filter((item) => item.split === split).entries()) {
    const offset = (index + repetition) % variants.length
    for (const variant of [...variants.slice(offset), ...variants.slice(0, offset)])
      await runCase(variant.id, spec, repetition)
  }
