import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createContextInvocationJournal,
  createContextRuntime,
  createEvidenceAccess,
} from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { modelRequestEncoder } from '@velaros-ai/kernel'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import { BudgetedModelDriver } from '../../../dist/act/runtime/impl/BudgetedModelDriver.js'
import { ModelToolRuntime } from '../../../dist/act/runtime/impl/ModelToolRuntime.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import { AdvancedSearch } from '../../../dist/act/search/impl/AdvancedSearch.js'
import { SearchActivation } from '../../../dist/act/search/impl/SearchActivation.js'

import { modelText } from './support/model-turn.mjs'
import { historyEntries, runtimeFrame } from './support/model-turn.mjs'
import { done, marker } from './support/model-turn.mjs'

const block = (request, head, source) =>
  `${marker(request)} ${head}\n${source}\n${marker(request)}\n`
const finish = { type: 'finish', reason: 'stop' }
const profile = {
  modelCalls: 4,
  modelTokens: 120000,
  finalizationTokens: 20000,
  timeoutMs: 20000,
  callTimeoutMs: 2000,
  finalizationMs: 3000,
  outputTokens: 2048,
  projectionChars: 48000,
  sourceQueries: 8,
  candidates: 32,
  reads: 8,
  readBytes: 64000,
}
const target = {
  kind: 'resource',
  sourceId: 'project',
  resourceId: 'auth.ts',
  selector: { kind: 'symbol', name: 'logout' },
}
async function fixture(t, handler, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'advanced-search-'))
  const path = join(root, 'state.sqlite')
  const storage = localContextStorage({ path })
  const f = {
    root,
    path,
    storage,
    frames: [],
    calls: 0,
    queries: 0,
    reads: 0,
    version: 1,
    allowed: true,
  }
  const model = {
    id: 'search-test',
    limits: { contextTokens: 150000, inputTokens: 140000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request, signal) {
      f.frames.push(request)
      f.calls++
      yield* handler(request, f, signal)
    },
  }
  const source = {
    id: 'project',
    capabilities: { snapshot: false, revision: true, conditionalWrite: 'atomic' },
    authorize: async () => f.allowed,
    search: async () => {
      f.queries++
      return [{ target, preview: 'logout resets auth', forms: ['excerpt'] }]
    },
    read: async () => {
      f.reads++
      const text = `logout v${f.version}`
      return {
        text,
        complete: true,
        form: 'excerpt',
        mediaType: 'text/plain',
        stamp: {
          sourceId: 'project',
          resourceId: 'auth.ts',
          revision: String(f.version),
          contentHash: createHash('sha256').update(text).digest('hex'),
          observedAt: new Date().toISOString(),
          consistency: 'revision-checkable',
        },
      }
    },
    validate: async (_scope, stamp) =>
      stamp.revision === String(f.version) ? 'current' : 'changed',
  }
  const config = {
    storage,
    runner: nodeSubprocessCodeRunner,
    modules: [],
    context: { sources: [source] },
    search: { model, defaultProfile: 'standard', profiles: { standard: profile } },
    ...options,
  }
  const runtime = await createRuntime(config)
  const session = await runtime.openSession('main')
  await session.context.append({ kind: 'user', body: 'Investigate auth' })
  Object.assign(f, { runtime, session, config, model, source })
  t.after(async () => {
    await runtime.close()
    await rm(root, { recursive: true, force: true })
  })
  return f
}
async function search(f, input = { query: 'Find logout' }) {
  const result = await f.session.execute({
    source: `import {search} from 'velaros:search';import {output} from 'velaros';output(await search(${JSON.stringify(input)}));`,
  })
  assert(result.checked, JSON.stringify(result))
  assert(!result.result.failed, JSON.stringify(result))
  return result.result.value.default
}
function findEvidence(request) {
  for (const item of historyEntries(request).reverse()) {
    if (item.origin === 'runtime-execution' && item.text) {
      const result = JSON.parse(item.text)
      if (result.result?.value?.default?.id && result.result.value.default.stamp)
        return result.result.value.default
    }
  }
}
async function* researcher(request) {
  assert.equal(request.contextStatus.mode, 'partitioned')
  const evidence = findEvidence(request)
  if (!evidence) {
    yield {
      type: 'text',
      text: block(
        request,
        'execute()',
        `import {read} from 'velaros:evidence';import {output} from 'velaros';output(await read({target:${JSON.stringify(target)}}));`
      ),
    }
    yield finish
  } else {
    yield {
      type: 'text',
      text: `${block(request, 'execute()', `import {output} from 'velaros';import {report} from 'velaros:evidence';await report(${JSON.stringify({ findings: [{ text: 'logout located', evidenceIds: [evidence.id] }], gaps: [], nextSteps: [] })});`)}${marker(request)} done`,
    }
    yield finish
  }
}

test('typed history discovery recalls results through the same ScriptAct scope without replay', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(request, 'execute()', "import {output} from 'velaros';output('recall-me');"),
      }
      yield finish
    } else {
      yield {
        type: 'text',
        text: `${block(request, 'execute()', "import {memory as memoryApi} from 'velaros:system';const {list,read}=memoryApi;import {output} from 'velaros';import {report} from 'velaros:evidence';const page=await list({kind:'history',limit:32});const result=page.items.find(item=>item.title.endsWith(':result'));if(!result)throw new Error('missing history');const original=await read({ref:result.ref});if(!original.text.includes('recall-me'))throw new Error('wrong history');await report({findings:[],gaps:[{code:'RECALLED',detail:String(result.sequence)}],nextSteps:[]});")}${marker(request)} done`,
      }
      yield finish
    }
  })
  const report = await search(f)
  assert.equal(f.calls, 2)
  assert(
    report.gaps.some((gap) => gap.code === 'RECALLED'),
    JSON.stringify(report)
  )
  assert.equal(f.reads, 0)
  const parentHistory = await f.session.execute({
    source:
      "import {memory as memoryApi} from 'velaros:system';const {list}=memoryApi;await list({});",
  })
  assert(!parentHistory.result.failed)
})

test('INV-29 search reuses ScriptAct, ordered history, shared storage and parent model accounting', async (t) => {
  const f = await fixture(t, researcher)
  const report = await search(f)
  assert.equal(report.status, 'completed', JSON.stringify(report))
  assert.equal(report.evidence.length, 1)
  assert.equal(f.calls, 2)
  assert.equal(f.reads, 1)
  assert(f.frames[1].history.some((message) => message.role === 'assistant'))
  assert.equal(f.frames[1].contextStatus.mode, 'partitioned')
  const messages = modelRequestEncoder.messages(f.frames[1])
  assert(messages.some((message) => message.role === 'assistant'))
  assert.equal((await f.session.view.inspect()).usage.contextCalls, 2)
  assert.equal(report.usage.tokens, null)
  const delivery = report.delivery
  assert.equal(delivery.schemaVersion, 1)
  assert.equal(delivery.kind, 'search')
  assert.deepEqual(delivery.payload, report.ref)
  assert.equal(delivery.continuation.operation, 'search')
  assert.deepEqual(delivery.continuation.input, { resume: report.ref })
  const shared = delivery.artifacts.find((item) => item.kind === 'evidence')
  assert(shared)
  assert.equal(shared.ref.sessionId, 'main')
  assert.match((await f.session.context.read(shared.ref)).text, /logout v1/)
  const scripts = delivery.artifacts.filter((item) => item.kind === 'script')
  assert(scripts.length)
  assert(scripts.every((item) => item.ref.sessionId === 'main'))
  const saved = (
    await Promise.all(scripts.map(async (item) => (await f.session.context.read(item.ref)).text))
  ).find((text) => text.includes('velaros:evidence'))
  assert(saved)
  assert(
    (await f.storage.load('main')).records.some((record) => record.title === 'shared:provenance')
  )
  const manifest = JSON.parse((await f.session.context.read(delivery.ref)).text)
  assert.deepEqual(manifest.artifacts, delivery.artifacts)
  // 原始共享源码仍须显式提交，并受调用者的模块集合约束。
  const denied = await f.session.execute({ source: JSON.parse(saved).source })
  assert(denied.result.failed)
  assert.match(denied.result.process.stderr, /velaros:evidence/)
  assert.equal(f.reads, 1)
})

test('advanced search uses native Node calls with evidence ownership and report validation intact', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    assert.equal(request.response.type, 'tools')
    assert.deepEqual(
      request.response.tools.map((tool) => tool.name),
      ['node']
    )
    if (f.calls === 1) {
      yield {
        type: 'tool-call',
        value: {
          id: 'read',
          name: 'node',
          input: {
            code: `import {read} from 'velaros:evidence'; import {output} from 'velaros'; output(await read({target:${JSON.stringify(target)}}));`,
          },
        },
      }
    } else if (f.calls === 2) {
      const evidence = findEvidence(request)
      assert(evidence)
      yield {
        type: 'tool-call',
        value: {
          id: 'report',
          name: 'node',
          input: {
            code: `import {report} from 'velaros:evidence'; await report(${JSON.stringify({ findings: [{ text: 'logout located', evidenceIds: [evidence.id] }], gaps: [], nextSteps: [] })});`,
          },
        },
      }
    } else assert.fail('A validated native report should complete without another model request')
    yield finish
  })
  f.model.nativeTools = true
  const report = await search(f)
  assert.equal(report.status, 'completed', JSON.stringify(report))
  assert.equal(f.calls, 2)
  assert.equal(f.reads, 1)
  assert.equal(report.evidence.length, 1)
  assert.equal(report.findings[0].text, 'logout located')
  assert(f.frames[1].history.some((message) => message.toolExchange?.calls[0]?.id === 'read'))
})

for (const valid of [true, false])
  test(`native final search delivery requires a validated report: valid=${valid}`, async (t) => {
    const f = await fixture(t, async function* (request, f) {
      assert(f.calls <= 2)
      if (f.calls === 2) assert.equal(request.contextStatus.phase, 'finalizing')
      const evidence = JSON.parse(request.materials[0].text).partitions.runtime.modelTool.items[0]
      if (f.calls === 2) assert(evidence?.id)
      yield {
        type: 'tool-call',
        value: {
          id: `step-${f.calls}`,
          name: 'node',
          input: {
            code:
              f.calls === 1
                ? `import {read} from 'velaros:evidence'; console.log(await read({target:${JSON.stringify(target)}}));`
                : `import {report} from 'velaros:evidence'; await report(${JSON.stringify({ findings: [{ text: 'verified finding', evidenceIds: [valid ? evidence.id : 'unread-evidence'] }], gaps: [], nextSteps: [] })});`,
          },
        },
      }
      yield finish
    })
    f.model.nativeTools = true
    await f.runtime.close()
    f.runtime = await createRuntime({
      ...f.config,
      storage: localContextStorage({ path: f.path }),
      search: {
        model: f.model,
        defaultProfile: 'standard',
        profiles: { standard: { ...profile, modelCalls: 2 } },
      },
    })
    f.session = await f.runtime.openSession('main')
    const report = await search(f)
    assert.equal(f.calls, 2)
    assert.equal(report.status, valid ? 'completed' : 'partial', JSON.stringify(report))
    assert.equal(report.findings.length, valid ? 1 : 0)
    assert.equal(f.reads, 1)
  })

test('observe cannot start search through an alias and no model/source cost is incurred', async (t) => {
  const f = await fixture(t, researcher)
  const frames = []
  const mainModel = {
    ...f.model,
    async *stream(request) {
      frames.push(request)
      yield* done(request)
    },
  }
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
    model: mainModel,
  })
  const session = await runtime.openSession('main')
  try {
    await session.observe({
      source:
        "import {search as lookup} from 'velaros:search';import {output} from 'velaros';output(await lookup({query:'auth'}));",
    })
    const events = []
    for await (const event of session.submit('Observe')) events.push(event)
    assert.equal(f.calls, 0)
    assert.equal(f.reads, 0)
    assert(frames[0].materials[0].text.includes('OPERATION_MODE_DENIED'))
  } finally {
    await runtime.close()
  }
})

test('resume preserves history and leases, rejects stale checkpoints and current reads refresh without model calls', async (t) => {
  const f = await fixture(t, researcher)
  const first = await search(f)
  const second = await search(f, { resume: first.ref, query: 'Continue' })
  assert.equal(second.searchId, first.searchId)
  assert.notEqual(second.ref.id, first.ref.id)
  assert(f.frames[2].history.some((message) => message.role === 'assistant'))
  const calls = f.calls
  f.version = 2
  const current = await f.session.execute({
    source: `import {read} from 'velaros:search';import {output} from 'velaros';output(await read({ref:${JSON.stringify(second.ref)},mode:'current'}));`,
  })
  assert.equal(current.result.value.default.items[0].stamp.revision, '2')
  assert.equal(f.calls, calls)
  const stale = await f.session.execute({
    source: `import {search} from 'velaros:search';await search({resume:${JSON.stringify(first.ref)}});`,
  })
  assert(stale.result.failed)
  assert.equal(f.calls, calls)
})

test('last reserved call closes softly and blocks fresh evidence reads', async (t) => {
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        yield {
          type: 'text',
          text: block(request, 'execute()', "import {output} from 'velaros';output('work');"),
        }
        yield finish
      } else {
        assert.equal(request.contextStatus.phase, 'finalizing')
        assert.match(request.compiledPrompt, /最后的报告交付机会/)
        yield {
          type: 'text',
          text: `${block(request, 'execute()', `import {read,report} from 'velaros:evidence';import {output} from 'velaros';try{await read({target:${JSON.stringify(target)}})}catch{}await report({findings:[],gaps:[{code:'UNRESOLVED',detail:'budget ended'}],nextSteps:['continue']});`)}${marker(request)} done`,
        }
        yield finish
      }
    },
    {}
  )
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
    search: {
      model: f.model,
      defaultProfile: 'standard',
      profiles: { standard: { ...profile, modelCalls: 2 } },
    },
  })
  try {
    f.runtime = runtime
    f.session = await runtime.openSession('main')
    const report = await search(f)
    assert.equal(f.calls, 2)
    assert.equal(f.reads, 0)
    assert.equal(report.status, 'partial')
    assert(report.gaps.some((gap) => gap.code === 'UNRESOLVED'))
  } finally {
    await runtime.close()
  }
})

test('runtime rejects invented evidence citations and returns saved partial state', async (t) => {
  const f = await fixture(t, async function* (request) {
    yield {
      type: 'text',
      text: `${block(request, 'execute()', "import {output} from 'velaros';import {report} from 'velaros:evidence';await report({findings:[{text:'invented',evidenceIds:['fake']}],gaps:[],nextSteps:[]});")}${marker(request)} done`,
    }
    yield finish
  })
  const report = await search(f)
  assert.notEqual(report.status, 'completed')
  assert.equal(report.findings.length, 0)
  assert(f.calls <= profile.modelCalls)
})

test('a work request that would consume the final token reserve is recompiled as a delivery round', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          `import {read} from 'velaros:evidence';import {output} from 'velaros';output(await read({target:${JSON.stringify(target)}}));`
        ),
      }
      yield finish
    } else {
      assert.equal(request.contextStatus.phase, 'finalizing')
      const frame = JSON.parse(
        request.materials.find((item) => item.origin === 'runtime-view').text
      )
      const evidence = frame.partitions.runtime.modelTool.items[0]
      yield {
        type: 'text',
        text: `${block(request, 'execute()', `import {output} from 'velaros';import {report} from 'velaros:evidence';await report(${JSON.stringify({ findings: [{ text: 'verified logout', evidenceIds: [evidence.id] }], gaps: [], nextSteps: [] })});`)}${marker(request)} done`,
      }
      yield finish
    }
  })
  f.model.estimate = async (request) => ({
    tokens: request.compiledPrompt.includes('最后的报告交付机会') ? 1000 : 50000,
    precision: 'exact',
    basis: 'budget-boundary-fixture',
  })
  const result = await search(f)
  assert.equal(f.calls, 2)
  assert.equal(f.reads, 1)
  assert.equal(result.status, 'completed')
  assert.equal(result.findings.length, 1)
  assert.equal(result.usage.modelCalls, 2)
  // 真正派发仅两次；预算重编译不消耗最后一次模型交付机会。
  assert.equal(f.frames.length, 2)
})

test('final search delivery preserves verified evidence when a prior required preview cannot fit', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          `import {read} from 'velaros:evidence';import {output} from 'velaros';await read({target:${JSON.stringify(target)}});output('large'.repeat(1000),{key:'prior',required:true,view:{mode:'reference'}});`
        ),
      }
      yield finish
    } else {
      assert.equal(request.contextStatus.phase, 'finalizing')
      const frame = JSON.parse(
        request.materials.find((item) => item.origin === 'runtime-view').text
      )
      assert(frame.partitions.runtime.decision.missing.length)
      const evidence = frame.partitions.runtime.modelTool.items[0]
      yield {
        type: 'text',
        text: `${block(request, 'execute()', `import {output} from 'velaros';import {report} from 'velaros:evidence';await report(${JSON.stringify({ findings: [{ text: 'verified logout', evidenceIds: [evidence.id] }], gaps: [{ code: 'CONTEXT_PARTIAL', detail: 'prior preview unavailable' }], nextSteps: [] })});`)}${marker(request)} done`,
      }
      yield finish
    }
  })
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
    search: {
      model: f.model,
      defaultProfile: 'standard',
      profiles: { standard: { ...profile, modelCalls: 2 } },
    },
  })
  try {
    f.runtime = runtime
    f.session = await runtime.openSession('main')
    const report = await search(f)
    assert.equal(f.calls, 2)
    assert.equal(f.reads, 1)
    assert.equal(report.status, 'partial')
    assert.equal(report.stopReason, 'finished')
    assert.equal(report.findings.length, 1)
    assert.deepEqual(report.gaps, [
      { code: 'CONTEXT_PARTIAL', detail: 'prior preview unavailable' },
    ])
  } finally {
    await runtime.close()
  }
})

test('INV-35 finalization compiles against its reserved window after a batch of real reads', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          `import {read} from 'velaros:evidence';import {output} from 'velaros';for(let i=0;i<60;i++)await read({target:${JSON.stringify(target)}});output('batch complete');`
        ),
      }
      yield finish
    } else {
      assert.equal(request.contextStatus.phase, 'finalizing')
      assert.equal(request.contextStatus.inputLimit, 20000 - 2048 - 1024)
      const frame = JSON.parse(request.materials[0].text)
      const evidence = frame.partitions.runtime.modelTool.items[0]
      assert.equal(
        frame.partitions.runtime.mandatory.filter(
          (item) => item.operation === 'velaros:evidence.read'
        ).length,
        60
      )
      assert.match(request.compiledPrompt, /grouped-receipts/)
      const estimate = await f.model.estimate(request)
      assert(estimate.tokens + request.outputTokens + 1024 <= 20000)
      yield {
        type: 'text',
        text: `${block(request, 'execute()', `import {output} from 'velaros';import {report} from 'velaros:evidence';await report(${JSON.stringify({ findings: [{ text: 'verified batch', evidenceIds: [evidence.id] }], gaps: [], nextSteps: [] })});`)}${marker(request)} done`,
      }
      yield finish
    }
  })
  f.model.estimate = async (request) => ({
    tokens: modelRequestEncoder
      .messages(request)
      .reduce(
        (sum, item) =>
          sum +
          (typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).length,
        0
      ),
    precision: 'estimate',
    basis: 'actual-message-character-bound',
  })
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
    search: {
      model: f.model,
      defaultProfile: 'standard',
      profiles: { standard: { ...profile, modelCalls: 2, reads: 64, readBytes: 128000 } },
    },
  })
  try {
    f.runtime = runtime
    f.session = await runtime.openSession('main')
    const result = await f.session.execute({
      source:
        "import {search} from 'velaros:search';import {output} from 'velaros';const report=await search({query:'Find logout'});output({status:report.status,gaps:report.gaps,findings:report.findings.length});",
    })
    assert(result.checked && !result.result.failed, JSON.stringify(result))
    const report = result.result.value.default
    assert.equal(report.status, 'completed', JSON.stringify(report))
    assert.equal(f.calls, 2)
    assert.equal(f.reads, 60)
  } finally {
    await runtime.close()
  }
})

test('search cannot discover or execute unrelated world modules and cannot enable observe', async (t) => {
  let writes = 0
  const world = {
    binding: { moduleId: 'test:world', instanceId: 'world', generation: 1, schemaRevision: '1' },
    summary: 'world',
    operations: {
      write: {
        summary: 'write',
        effects: 'write',
        input: { type: 'null' },
        output: { type: 'null' },
        run: () => {
          writes++
          return null
        },
      },
    },
  }
  const f = await fixture(
    t,
    async function* (request, f) {
      if (f.calls === 1) {
        yield {
          type: 'text',
          text: block(
            request,
            'observe()',
            "import {output} from 'velaros';output('not allowed');"
          ),
        }
        yield finish
      } else if (f.calls === 2) {
        yield {
          type: 'text',
          text: block(request, 'execute()', "import {write} from 'test:world';await write();"),
        }
        yield finish
      } else {
        yield {
          type: 'text',
          text: `${block(request, 'execute()', "import {output} from 'velaros';import {report} from 'velaros:evidence';import {modules} from 'velaros:system';const list=await modules.list({});if(list.items.some(item=>item.specifier==='test:world'))throw new Error('scope leaked');await report({findings:[],gaps:[{code:'DENIED',detail:'no world capability'}],nextSteps:[]});")}${marker(request)} done`,
        }
        yield finish
      }
    },
    { modules: [world] }
  )
  const report = await search(f)
  assert.equal(writes, 0)
  assert.equal(report.status, 'partial')
  assert(f.calls <= 4)
})

test('parallel reads reserve source byte capacity before dispatch', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          `import {read} from 'velaros:evidence';import {output} from 'velaros';output(await Promise.allSettled([read({target:${JSON.stringify(target)},maxBytes:9}),read({target:${JSON.stringify(target)},maxBytes:9})]));`
        ),
      }
      yield finish
    } else {
      yield {
        type: 'text',
        text: `${block(request, 'execute()', "import {output} from 'velaros';import {report} from 'velaros:evidence';await report({findings:[],gaps:[{code:'LIMIT',detail:'read capacity'}],nextSteps:[]});")}${marker(request)} done`,
      }
      yield finish
    }
  })
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
    search: {
      model: f.model,
      defaultProfile: 'standard',
      profiles: { standard: { ...profile, readBytes: 9 } },
    },
  })
  try {
    f.runtime = runtime
    f.session = await runtime.openSession('main')
    const report = await search(f)
    assert.equal(f.reads, 1)
    assert.equal(report.usage.readBytes, 9)
  } finally {
    await runtime.close()
  }
})

test('revoked sources are absent from resumed history and snapshots are denied', async (t) => {
  const f = await fixture(t, researcher)
  const first = await search(f)
  f.allowed = false
  const denied = await f.session.execute({
    source: `import {read} from 'velaros:search';await read({ref:${JSON.stringify(first.ref)}});`,
  })
  assert(denied.result.failed)
  const oldCalls = f.calls
  await search(f, { resume: first.ref, query: 'Check permissions' })
  const resumed = f.frames[oldCalls]
  assert(!JSON.stringify(resumed.history).includes('logout v1'))
})

test('two concurrent searches share the parent budget and independent finalization reservations', async (t) => {
  const f = await fixture(t, async function* (request) {
    yield {
      type: 'text',
      text: `${block(request, 'execute()', "import {output} from 'velaros';import {report} from 'velaros:evidence';await report({findings:[],gaps:[{code:'NO_EVIDENCE',detail:'limited scope'}],nextSteps:[]});")}${marker(request)} done`,
    }
    yield finish
  })
  const outcome = await f.session.execute({
    source:
      "import {search} from 'velaros:search';import {output} from 'velaros';output(await Promise.all([search({query:'a'}),search({query:'b'})]));",
  })
  assert(!outcome.result.failed, JSON.stringify(outcome))
  assert.equal(outcome.result.value.default.length, 2)
  assert.equal(f.calls, 2)
  assert.equal((await f.session.view.inspect()).usage.contextCalls, 2)
})

test('a hung model is bounded at the request deadline and leaves a resumable failed report', async (t) => {
  const f = await fixture(t, async function* () {
    await new Promise(() => {})
    yield finish
  })
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
    search: {
      model: f.model,
      defaultProfile: 'standard',
      profiles: {
        standard: { ...profile, callTimeoutMs: 30, timeoutMs: 2000, finalizationMs: 100 },
      },
    },
  })
  try {
    f.runtime = runtime
    f.session = await runtime.openSession('main')
    const started = Date.now()
    const report = await search(f)
    assert(Date.now() - started < 1500)
    assert.equal(report.status, 'failed')
    assert.equal(report.continuation, 'available')
    assert.equal(f.calls, 1)
  } finally {
    await runtime.close()
  }
})

test('a two-call profile allows one exploration response before the reserved final report', async (t) => {
  const f = await fixture(t, researcher)
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
    search: {
      model: f.model,
      defaultProfile: 'standard',
      profiles: { standard: { ...profile, modelCalls: 2 } },
    },
  })
  try {
    f.runtime = runtime
    f.session = await runtime.openSession('main')
    const report = await search(f)
    assert.equal(report.status, 'completed', JSON.stringify(report))
    assert.equal(f.calls, 2)
    assert.equal(f.reads, 1)
    assert.equal(f.frames[1].contextStatus.phase, 'finalizing')
  } finally {
    await runtime.close()
  }
})

test('the main model invokes typed search as a JS function and receives its report on the next runtime frame', async (t) => {
  let calls = 0
  const main = {
    id: 'main-test',
    limits: { contextTokens: 150000, inputTokens: 140000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    async *stream(request) {
      calls++
      assert.equal(request.contextStatus.mode, 'partitioned')
      if (calls === 1) {
        yield {
          type: 'text',
          text: block(
            request,
            'execute()',
            "import {search,read} from 'velaros:search';import {output} from 'velaros';const report=await search({query:'logout'});output({status:report.status,ref:report.ref});"
          ),
        }
        yield finish
      } else {
        assert.match(modelText(request), /completed/)
        yield* done(request)
      }
    },
  }
  const f = await fixture(t, researcher, { model: main })
  const events = []
  for await (const event of f.session.submit('Find logout')) events.push(event)
  assert.equal(events.at(-1).status, 'completed', JSON.stringify(events))
  assert.equal(calls, 2)
  assert.equal(f.calls, 2)
  const usage = (await f.session.view.inspect()).usage
  assert.equal(usage.mainCalls, 2)
  assert.equal(usage.contextCalls, 2)
})

test('report evidence can be recalled through the parent scope without calling the model again', async (t) => {
  const f = await fixture(t, researcher)
  const report = await search(f)
  const calls = f.calls
  const result = await f.session.execute({
    source: `import {read} from 'velaros:search';import {output} from 'velaros';output(await read({ref:${JSON.stringify(report.ref)},evidenceId:${JSON.stringify(report.evidence[0].id)},offset:0,limit:4}));`,
  })
  assert.equal(result.result.value.default.text, 'logo')
  assert.equal(result.result.value.default.mode, 'snapshot')
  assert.equal(f.calls, calls)
})

test('search resumes from persisted history after reopening the runtime without replaying evidence scripts', async (t) => {
  const f = await fixture(t, researcher)
  const first = await search(f)
  const calls = f.calls
  const reads = f.reads
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
  })
  try {
    f.runtime = runtime
    f.session = await runtime.openSession('main')
    const resumed = await search(f, {
      resume: first.ref,
      query: 'Continue from the saved evidence',
    })
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed))
    assert.equal(resumed.searchId, first.searchId)
    assert.equal(f.reads, reads)
    assert(f.frames[calls].history.some((message) => message.role === 'assistant'))
    assert.deepEqual(resumed.evidence[0].ref, first.evidence[0].ref)
  } finally {
    await runtime.close()
  }
})

test('host search profiles reject omitted required budgets before starting a runtime', async (t) => {
  const f = await fixture(t, researcher)
  for (const key of Object.keys(profile)) {
    const incomplete = { ...profile }
    delete incomplete[key]
    await assert.rejects(
      () =>
        createRuntime({
          ...f.config,
          search: {
            model: f.model,
            defaultProfile: 'standard',
            profiles: { standard: incomplete },
          },
        }),
      /搜索预算必须有限/
    )
  }
  assert.equal(f.calls, 0)
  assert.equal(f.reads, 0)
})

test('resume authorization checks obey the configured timeout even if a source ignores cancellation', async (t) => {
  const f = await fixture(t, researcher)
  const first = await search(f)
  const calls = f.calls
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
    search: {
      model: f.model,
      defaultProfile: 'standard',
      profiles: { standard: { ...profile, callTimeoutMs: 30 } },
    },
  })
  try {
    f.source.authorize = async () => new Promise(() => {})
    const session = await runtime.openSession('main')
    const started = Date.now()
    const outcome = await session.execute({
      source: `import {search} from 'velaros:search';await search({resume:${JSON.stringify(first.ref)}});`,
    })
    assert(outcome.result.failed)
    assert(Date.now() - started < 1500)
    assert.equal(f.calls, calls)
    f.source.authorize = async () => true
    f.session = session
    const resumed = await search(f, { resume: first.ref })
    assert.equal(resumed.status, 'completed')
    assert.equal(resumed.searchId, first.searchId)
  } finally {
    await runtime.close()
  }
})

async function lifecycle(t, hooks = {}) {
  const f = await fixture(t, researcher)
  const goal = await f.session.context.append({ kind: 'user', body: 'Search lifecycle' })
  await f.session.view.begin(goal.ref)
  f.call = {
    invocation: { sessionId: 'main', id: crypto.randomUUID(), executionId: crypto.randomUUID() },
    signal: new AbortController().signal,
  }
  await f.session.view.startStep(f.call.invocation.executionId)
  f.closes = 0
  const tools = new ModelToolRuntime({
    storage: f.storage,
    view: () => f.session.view,
    deadline: () => undefined,
  })
  tools.root('main')
  f.dependencies = {
    tools,
    storage: f.storage,
    evidence: createEvidenceAccess([f.source]),
    options: f.config.search,
    parentDeadline: () => undefined,
    view: () => f.session.view,
    open: async (id, activation) => {
      f.searchSessionId = id
      f.activation = activation
      return {
        async *submit() {
          await activation.report(
            { findings: [], gaps: [], nextSteps: [] },
            new AbortController().signal
          )
          yield { type: 'state', status: 'completed' }
        },
      }
    },
    close: async () => {
      f.closes++
    },
    ...hooks,
  }
  f.search = new AdvancedSearch(f.dependencies)
  f.state = async () => {
    const snapshot = await f.storage.load(f.searchSessionId)
    const record = snapshot.records.findLast((item) => item.title === 'search:state')
    return JSON.parse(await f.storage.get(f.searchSessionId, record.objectId))
  }
  return f
}

test('search cleanup attempts every release and preserves primary, budget and close failures', async (t) => {
  const f = await lifecycle(t)
  const primary = new Error('open failed')
  const budget = new Error('budget release failed')
  const close = new Error('session close failed')
  const original = f.dependencies.open
  f.dependencies.open = async (...args) => {
    await original(...args)
    throw primary
  }
  f.session.view.releaseModel = async () => {
    throw budget
  }
  f.dependencies.close = async () => {
    f.closes++
    throw close
  }
  await assert.rejects(f.search.run({ query: 'auth' }, f.call), (error) => {
    assert.equal(error.code, 'SEARCH_CLEANUP')
    assert(error instanceof AggregateError)
    assert.deepEqual(error.errors, [primary, budget, close])
    return true
  })
  assert.equal(f.closes, 1)
  assert.equal((await f.state()).activation, undefined)
  assert.throws(() => f.search.activation(f.searchSessionId), { code: 'SEARCH_SCOPE' })
})

test('search publication keeps the durable claim and narrow capability scope until close completes', async (t) => {
  const f = await lifecycle(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  f.dependencies.close = async () => {
    f.closes++
    entered.resolve()
    await release.promise
  }
  const pending = f.search.run({ query: 'auth' }, f.call)
  try {
    await entered.promise
    const state = await f.state()
    assert(state.report)
    assert.equal(state.activation, f.call.invocation.id)
    assert.equal(f.search.allows(f.searchSessionId, 'test:world'), false)
    // 另一协调器只能凭同一个 SQLite claim 判定，不能依赖本实例的内存 Map。
    const other = new AdvancedSearch({
      ...f.dependencies,
      close: async () => {
        throw Error('must not close owner')
      },
    })
    await assert.rejects(
      other.run(
        { resume: state.report },
        { ...f.call, invocation: { ...f.call.invocation, id: crypto.randomUUID() } }
      ),
      { code: 'SEARCH_BUSY' }
    )
  } finally {
    release.resolve()
    await pending
  }
  const report = await pending
  assert.equal(report.status, 'completed')
  assert.equal((await f.state()).activation, undefined)
  assert.equal(f.closes, 1)
})

test('a denied search budget never closes a session it did not open', async (t) => {
  const f = await lifecycle(t)
  const failure = new Error('budget denied')
  f.session.view.reserveModel = async () => {
    throw failure
  }
  await assert.rejects(f.search.run({ query: 'auth' }, f.call), (error) => error === failure)
  assert.equal(f.closes, 0)
  assert.equal(f.activation, undefined)
})

test('a search cannot report success when its unused finalization reservation failed to release', async (t) => {
  const f = await lifecycle(t)
  const failure = new Error('release did not persist')
  f.session.view.releaseModel = async () => {
    throw failure
  }
  await assert.rejects(
    f.search.run({ query: 'auth' }, f.call),
    (error) => error.code === 'SEARCH_CLEANUP' && error.errors.includes(failure)
  )
  assert.equal(f.closes, 1)
  assert.equal((await f.state()).activation, undefined)
  assert((await f.state()).report)
})

test('failed durable claim release is surfaced after close and the in-memory activation is detached', async (t) => {
  const f = await lifecycle(t)
  const cas = f.storage.compareAndSwap.bind(f.storage)
  let closing = false
  f.dependencies.close = async () => {
    f.closes++
    closing = true
  }
  f.storage.compareAndSwap = async (...args) => {
    if (closing && args[0] === f.searchSessionId) throw new Error('claim release failed')
    return cas(...args)
  }
  try {
    await assert.rejects(
      f.search.run({ query: 'auth' }, f.call),
      (error) =>
        error.code === 'SEARCH_CLEANUP' &&
        error.errors.some((item) => item.message === 'claim release failed')
    )
    assert.equal(f.closes, 1)
    assert.equal((await f.state()).activation, f.call.invocation.id)
    assert.throws(() => f.search.activation(f.searchSessionId), { code: 'SEARCH_SCOPE' })
  } finally {
    f.storage.compareAndSwap = cas
  }
})

test('replacing the source set with the same cardinality removes old candidates and free history', async (t) => {
  const secret = 'private-source-a-preview'
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          "import {query} from 'velaros:evidence';import {output} from 'velaros';output(await query({source:'project',query:'auth'}));"
        ),
      }
      yield finish
    } else {
      if (f.calls > 2) assert(!JSON.stringify(request).includes(secret))
      yield {
        type: 'text',
        text: `${block(request, 'execute()', "import {output} from 'velaros';import {report} from 'velaros:evidence';await report({findings:[],gaps:[{code:'UNRESOLVED',detail:'read more'}],nextSteps:[]});")}${marker(request)} done`,
      }
      yield finish
    }
  })
  await f.runtime.close()
  f.source.search = async () => [{ target, preview: secret, forms: ['excerpt'] }]
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
    context: { sources: [f.source, { ...f.source, id: 'other' }] },
  })
  try {
    f.runtime = runtime
    f.session = await runtime.openSession('main')
    const first = await search(f, { query: 'auth', sources: ['project'] })
    assert(JSON.stringify(f.frames[1]).includes(secret))
    const resumed = await search(f, { resume: first.ref, sources: ['other'] })
    assert.equal(resumed.searchId, first.searchId)
    assert.equal(f.calls, 3)
    assert.equal(resumed.status, 'partial', JSON.stringify(resumed))
    assert(resumed.gaps.some((gap) => gap.code === 'UNRESOLVED'))
    assert(!JSON.stringify(f.frames[2]).includes(secret))
  } finally {
    await runtime.close()
  }
})

async function activationFixture(t) {
  const f = await fixture(t, researcher)
  const id = 'search:activation'
  const context = createContextRuntime({ sessionId: id, storage: f.storage })
  const counters = { reserved: 0, released: 0, dispatched: 0, saved: 0 }
  const dependencies = {
    profile,
    model: {
      ...f.model,
      async *stream() {
        counters.dispatched++
        yield finish
      },
    },
    evidence: createEvidenceAccess([f.source]),
    context,
    storage: f.storage,
    parent: {
      reserveModel: async () => {
        counters.reserved++
      },
      releaseModel: async () => {
        counters.released++
      },
    },
    scope: { sessionId: 'main', revision: 1 },
    deadline: Date.now() + 60000,
    save: async () => {
      counters.saved++
    },
  }
  const activation = new SearchActivation(
    {
      id: 'activation',
      parentSessionId: 'main',
      sessionId: id,
      query: 'auth',
      profile: 'standard',
      sources: ['project'],
      evidence: [],
      candidates: [],
      queries: [],
    },
    dependencies
  )
  return { activation, counters, dependencies, request: { outputTokens: 1000 } }
}

test('cancellation during search model estimation prevents dispatch and close releases only once', async (t) => {
  const f = await activationFixture(t)
  const entered = Promise.withResolvers()
  const estimate = Promise.withResolvers()
  const controller = new AbortController()
  f.dependencies.model.estimate = async () => {
    entered.resolve()
    return estimate.promise
  }
  const pending = f.activation.stream(f.request, controller.signal)[Symbol.asyncIterator]().next()
  await entered.promise
  controller.abort()
  estimate.resolve({ tokens: 1000 })
  await assert.rejects(pending, { name: 'AbortError' })
  await Promise.all([f.activation.close(), f.activation.close()])
  await f.activation.close()
  assert.deepEqual(f.counters, { reserved: 0, released: 1, dispatched: 0, saved: 0 })
})

test('cancellation while reserving a work call refunds only the unissued reservation', async (t) => {
  const f = await activationFixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const controller = new AbortController()
  f.dependencies.parent.reserveModel = async () => {
    f.counters.reserved++
    entered.resolve()
    await release.promise
  }
  const pending = f.activation.stream(f.request, controller.signal)[Symbol.asyncIterator]().next()
  await entered.promise
  controller.abort()
  release.resolve()
  await assert.rejects(pending, { name: 'AbortError' })
  await f.activation.close()
  assert.deepEqual(f.counters, { reserved: 1, released: 2, dispatched: 0, saved: 0 })
})

test('generic child calls share the cancelled-reservation guard and surface refund failures', async (t) => {
  const f = await activationFixture(t)
  const entered = Promise.withResolvers()
  const reserve = Promise.withResolvers()
  const controller = new AbortController()
  const failure = new Error('refund failed')
  f.dependencies.parent.reserveModel = async () => {
    f.counters.reserved++
    entered.resolve()
    await reserve.promise
  }
  f.dependencies.parent.releaseModel = async () => {
    f.counters.released++
    throw failure
  }
  const driver = new BudgetedModelDriver({
    model: f.dependencies.model,
    parent: f.dependencies.parent,
    signal: controller.signal,
  })
  const pending = driver
    .stream(f.request, new AbortController().signal)
    [Symbol.asyncIterator]()
    .next()
  await entered.promise
  controller.abort()
  reserve.resolve()
  await assert.rejects(
    pending,
    (error) => error.code === 'MODEL_RESERVATION_RELEASE' && error.errors.includes(failure)
  )
  assert.equal(f.counters.dispatched, 0)
  assert.equal(f.counters.released, 1)
  await assert.rejects(driver.close(), (error) =>
    error.errors.some((item) => item.code === 'MODEL_RESERVATION_RELEASE')
  )
})

test('closing a search during estimation cancels late dispatch and keeps a failed release idempotent', async (t) => {
  const f = await activationFixture(t)
  const entered = Promise.withResolvers()
  const estimate = Promise.withResolvers()
  const failure = new Error('final reserve release failed')
  f.dependencies.model.estimate = async () => {
    entered.resolve()
    return estimate.promise
  }
  f.dependencies.parent.releaseModel = async () => {
    f.counters.released++
    throw failure
  }
  const pending = f.activation
    .stream(f.request, new AbortController().signal)
    [Symbol.asyncIterator]()
    .next()
  await entered.promise
  await assert.rejects(f.activation.close(), (error) => error === failure)
  await assert.rejects(f.activation.close(), (error) => error === failure)
  estimate.resolve({ tokens: 1000 })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(f.counters.released, 1)
  assert.equal(f.counters.dispatched, 0)
})

test('formal ScriptAct reports cleanup failure and retains the published report for inspection', async (t) => {
  const f = await fixture(t, researcher)
  const release = f.session.view.releaseModel.bind(f.session.view)
  f.session.view.releaseModel = async () => {
    throw new Error('injected final reserve failure')
  }
  try {
    const result = await f.session.execute({
      source:
        "import {search} from 'velaros:search';import {output} from 'velaros';output(await search({query:'auth'}));",
    })
    assert(result.result.failed, JSON.stringify(result))
    const calls = await createContextInvocationJournal(f.storage).list('main')
    assert(
      calls.some(
        (call) =>
          call.prepared.binding.moduleId === 'velaros:search' &&
          call.receipt?.error?.code === 'SEARCH_CLEANUP'
      )
    )
    assert.match(JSON.stringify(result), /injected final reserve failure/)
    const searchSessionId = runtimeFrame(f.frames[0]).scope.sessionId
    const snapshot = await f.storage.load(searchSessionId)
    const record = snapshot.records.findLast((item) => item.title === 'search:state')
    const state = JSON.parse(await f.storage.get(searchSessionId, record.objectId))
    assert(state.report)
    assert.equal(state.activation, undefined)
    assert.equal(f.runtime.getSession(searchSessionId), undefined)
    assert.equal(
      JSON.parse((await f.session.view.readArtifact(state.report)).text).status,
      'completed'
    )
  } finally {
    f.session.view.releaseModel = release
  }
})

test(
  'cancelling a parent ScriptAct call closes its active search and releases the unused finalization budget',
  { timeout: 5000 },
  async (t) => {
    const entered = Promise.withResolvers()
    const f = await fixture(t, async function* (request, _f, signal) {
      entered.resolve(request)
      await new Promise((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', resolve, { once: true })
      })
      signal.throwIfAborted()
      yield finish
    })
    const controller = new AbortController()
    const pending = f.session.execute(
      { source: "import {search} from 'velaros:search';await search({query:'auth'});" },
      2,
      controller.signal
    )
    const request = await entered.promise
    const id = runtimeFrame(request).scope.sessionId
    const child = f.runtime.getSession(id)
    const closing = Promise.withResolvers()
    const release = Promise.withResolvers()
    const close = child.close.bind(child)
    child.close = async () => {
      closing.resolve()
      await release.promise
      await close()
    }
    let finished = false
    void pending.then(
      () => {
        finished = true
      },
      () => {
        finished = true
      }
    )
    controller.abort()
    try {
      await closing.promise
      assert.equal(finished, false, 'parent must await search cleanup')
      assert((await f.session.view.inspect()).lease, 'parent keeps its budget lease during cleanup')
    } finally {
      release.resolve()
    }
    await pending.catch((error) => {
      assert.match(String(error), /取消|abort/iu)
    })
    const snapshot = await f.storage.load(id)
    const record = snapshot.records.findLast((item) => item.title === 'search:state')
    const state = JSON.parse(await f.storage.get(id, record.objectId))
    assert.equal(state.activation, undefined)
    assert.equal(f.runtime.getSession(id), undefined)
    assert.equal((await f.session.view.inspect()).usage.contextCalls, 1)
    assert.equal(f.calls, 1)
  }
)

test(
  'INV-17 parent model cancellation settles nested search before ending its ContextView',
  { timeout: 5000 },
  async (t) => {
    const entered = Promise.withResolvers()
    const main = {
      id: 'main-cancel',
      limits: { contextTokens: 150000, inputTokens: 140000, outputTokens: 4096 },
      estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
      async *stream(request) {
        yield {
          type: 'text',
          text: block(
            request,
            'execute()',
            "import {search} from 'velaros:search';await search({query:'auth'});"
          ),
        }
        yield finish
      },
    }
    const f = await fixture(
      t,
      async function* (request, _f, signal) {
        entered.resolve(request)
        await new Promise((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', resolve, { once: true })
        })
        signal.throwIfAborted()
        yield finish
      },
      { model: main }
    )
    const controller = new AbortController()
    const events = []
    const pending = (async () => {
      for await (const event of f.session.submit('Investigate and cancel', controller.signal))
        events.push(event)
    })()
    const request = await entered.promise
    controller.abort()
    await pending
    const id = runtimeFrame(request).scope.sessionId
    assert.equal(events.at(-1).status, 'cancelled', JSON.stringify(events))
    assert.equal(f.runtime.getSession(id), undefined)
    const state = await f.session.view.inspect()
    assert.equal(state.lease, null)
    assert.equal(state.usage.contextCalls, 1)
    assert.equal(f.calls, 1)
  }
)

test(
  'cancelling during durable search reservation waits for undispatched budget refund',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, researcher)
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const reserve = f.session.view.reserveModel.bind(f.session.view)
    let reservations = 0
    f.session.view.reserveModel = async (role, tokens) => {
      await reserve(role, tokens)
      if (++reservations === 2) {
        entered.resolve()
        await release.promise
      }
    }
    const controller = new AbortController()
    const pending = f.session.execute(
      { source: "import {search} from 'velaros:search';await search({query:'auth'});" },
      2,
      controller.signal
    )
    const outcome = pending.catch((error) => {
      assert.match(String(error), /取消|abort/iu)
    })
    await entered.promise
    controller.abort()
    // 让取消到达驱动的收尾路径，再允许已落盘的预留返回。
    await new Promise((resolve) => setTimeout(resolve, 50))
    release.resolve()
    await outcome
    assert.equal(f.calls, 0)
    assert.equal((await f.session.view.inspect()).usage.contextCalls, 0)
  }
)

test('INV-33 search keeps runtime evidence after execution output expires and finalizes from real IDs', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute({retain:1})',
          `import {read} from 'velaros:evidence';import {output} from 'velaros';output(await read({target:${JSON.stringify(target)}}));`
        ),
      }
      yield finish
      return
    }
    if (f.calls === 2) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          "import {output} from 'velaros';output('continue after one exposure');"
        ),
      }
      yield finish
      return
    }
    const material = JSON.parse(request.materials[0].text).partitions.runtime.modelTool
    assert.equal(material.origin, 'search-evidence')
    assert.equal(material.total, 1)
    assert.equal(material.omitted, 0)
    assert.equal(material.items[0].excerpt, 'logout v1')
    assert.equal(material.items[0].stamp.revision, '1')
    assert.equal(material.items[0].excerptTruncated, false)
    // 结果租约已经退出帧尾展示（冻结的历史正文保留到容量不足时退卡）；可引用的证据来自 Runtime 事实目录
    assert(
      !JSON.parse(request.materials[0].text).partitions.recent.results.some((item) =>
        JSON.stringify(item).includes('logout v1')
      ),
      '结果租约已经退出帧尾展示'
    )
    // 此前的帧留在对话里，未变化的事实目录不在本帧增量里重发
    assert(modelText(request).includes(material.items[0].id), '原始模型请求包含同一事实目录')
    yield {
      type: 'text',
      text: `${block(request, 'execute()', `import {output} from 'velaros';import {report} from 'velaros:evidence';await report(${JSON.stringify({ findings: [{ text: 'logout located after output expiry', evidenceIds: [material.items[0].id] }], gaps: [], nextSteps: [] })});`)}${marker(request)} done`,
    }
    yield finish
  })
  const result = await search(f)
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(f.reads, 1)
  assert.equal(f.calls, 3)
  assert.equal(result.findings.length, 1)
})

test('INV-33 search evidence directory respects capacity and drops changed evidence before projection', async (t) => {
  const f = await fixture(t, researcher)
  const state = {
    id: 'directory',
    parentSessionId: 'main',
    sessionId: 'search:directory',
    query: 'auth',
    profile: 'standard',
    sources: ['project'],
    evidence: [],
    candidates: [],
    queries: [],
  }
  const activation = new SearchActivation(state, {
    profile,
    model: f.model,
    evidence: createEvidenceAccess([f.source]),
    context: createContextRuntime({ sessionId: 'search:directory', storage: f.storage }),
    storage: f.storage,
    parent: { reserveModel: async () => {}, releaseModel: async () => {} },
    scope: { sessionId: 'main', revision: 1 },
    deadline: Date.now() + 20000,
    save: async () => {},
  })
  t.after(() => activation.close())
  for (let i = 0; i < 3; i++) await activation.inspect(target, 8000, new AbortController().signal)
  assert.equal(activation.material(1), undefined)
  const bounded = activation.material(900)
  assert(JSON.stringify(bounded).length <= 900)
  assert.equal(bounded.total, 3)
  assert.equal(bounded.items.length + bounded.omitted, 3)
  assert(bounded.items.length > 0 && bounded.omitted > 0)
  f.version = 2
  await activation.refresh(new AbortController().signal)
  assert.equal(activation.material(900).total, 0)
})

test('INV-33 exhausted query allowance still permits reading previously found candidates before final report', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          "import {query} from 'velaros:evidence';import {output} from 'velaros';output(await query({source:'project',query:'logout',limit:1}));"
        ),
      }
      yield finish
      return
    }
    const catalog = JSON.parse(request.materials[0].text).partitions.runtime.modelTool
    if (f.calls === 2) {
      assert.equal(request.contextStatus.phase, 'work')
      assert.equal(catalog.items.length, 0)
      assert.equal(catalog.candidates.length, 1)
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          `import {read} from 'velaros:evidence';import {output} from 'velaros';output(await read({target:${JSON.stringify(catalog.candidates[0].target)}}));`
        ),
      }
      yield finish
      return
    }
    assert.equal(request.contextStatus.phase, 'finalizing')
    assert.equal(catalog.candidates.length, 0)
    assert.equal(catalog.items.length, 1)
    yield {
      type: 'text',
      text: `${block(request, 'execute()', `import {output} from 'velaros';import {report} from 'velaros:evidence';await report(${JSON.stringify({ findings: [{ text: 'Read after query limit', evidenceIds: [catalog.items[0].id] }], gaps: [], nextSteps: [] })});`)}${marker(request)} done`,
    }
    yield finish
  })
  // 使用同一正式装配，仅收紧查询档位；其余额度仍可供后续读取。
  await f.runtime.close()
  const runtime = await createRuntime({
    ...f.config,
    storage: localContextStorage({ path: f.path }),
    search: {
      model: f.model,
      defaultProfile: 'standard',
      profiles: { standard: { ...profile, sourceQueries: 1 } },
    },
  })
  try {
    f.runtime = runtime
    f.session = await runtime.openSession('main')
    const report = await search(f)
    assert.equal(report.status, 'completed', JSON.stringify(report))
    assert.equal(f.queries, 1)
    assert.equal(f.reads, 1)
    assert.equal(f.calls, 3)
  } finally {
    await runtime.close()
  }
})

test('a malformed gap is rejected at the call naming the wrong field and can be corrected without another search', async (t) => {
  const f = await fixture(t, async function* (request, f) {
    if (f.calls === 1) {
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          `import {read} from 'velaros:evidence';import {output} from 'velaros';output(await read({target:${JSON.stringify(target)}}));`
        ),
      }
    } else {
      const evidence = JSON.parse(
        request.materials.find((item) => item.origin === 'runtime-view').text
      ).partitions.runtime.modelTool.items[0]
      assert(evidence)
      // 写错形状的结论在调用时被入参校验拒绝，报错指出哪个字段错在哪
      if (f.calls === 3) assert.match(modelText(request), /gaps\[0\] 应当是 object/)
      const gaps =
        f.calls === 2
          ? ['Not all related paths have been verified']
          : [{ code: 'UNRESOLVED', detail: 'Not all related paths have been verified' }]
      yield {
        type: 'text',
        text: `${block(request, 'execute()', `import {output} from 'velaros';import {report} from 'velaros:evidence';await report(${JSON.stringify({ findings: [{ text: 'Real logout evidence', evidenceIds: [evidence.id] }], gaps, nextSteps: [] })});`)}${marker(request)} done`,
      }
    }
    yield finish
  })
  const report = await search(f)
  assert.equal(f.calls, 3)
  assert.equal(f.reads, 1)
  assert.equal(f.queries, 0)
  assert.equal(report.findings.length, 1)
  assert.equal(report.gaps[0].code, 'UNRESOLVED')
  assert.equal(report.status, 'partial')
})
