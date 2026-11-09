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
import { AppError, createAbortError } from '@velaros-ai/core/error'
import { modelRequestEncoder } from '@velaros-ai/kernel'

import { BudgetedModelDriver } from '../../../dist/act/runtime/impl/BudgetedModelDriver.js'
import { ModelToolRuntime } from '../../../dist/act/runtime/impl/ModelToolRuntime.js'
import { RuntimeTrace } from '../../../dist/act/runtime/impl/RuntimeTrace.js'
import { AdvancedSearch } from '../../../dist/act/search/impl/AdvancedSearch.js'
import { SearchActivation } from '../../../dist/act/search/impl/SearchActivation.js'

import { done, historyEntries, marker, modelText, runtimeFrame } from './support/model-turn.mjs'
import { createTestRuntime as createRuntime } from './support/runtime-fixture.mjs'

const block = (request, head, source) =>
  `${marker(request)} ${head}\n${source}\n${marker(request)}\n`
const finish = { type: 'finish', reason: 'stop' }
const platformHasDefaultConfinement = process.platform === 'darwin' || process.platform === 'linux'
const readOnlySearch = {
  skip: platformHasDefaultConfinement
    ? false
    : 'This integration needs successful read-only search programs; unavailable-backend refusal, source IO and resumable failures are covered separately.',
}
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
const driverRequest = {
  instructions: '',
  materials: [],
  history: [],
  response: { type: 'text' },
  mode: 'work',
  outputTokens: profile.outputTokens,
}
async function consume(stream) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
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

test(
  'typed history discovery recalls results through the same ScriptAct scope without replay',
  readOnlySearch,
  async (t) => {
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
  }
)

test(
  'INV-29 search reuses ScriptAct, ordered history, shared storage and parent model accounting',
  readOnlySearch,
  async (t) => {
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
  }
)

test(
  'advanced search uses native Node calls with evidence ownership and report validation intact',
  readOnlySearch,
  async (t) => {
    const f = await fixture(t, async function* (request, f) {
      assert.equal(request.response.type, 'tools')
      assert.deepEqual(
        request.response.tools.map((tool) => tool.name),
        ['blobs', 'exec', 'done']
      )
      if (f.calls === 1) {
        yield {
          type: 'tool-call',
          value: {
            id: 'read',
            name: 'exec',
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
            name: 'exec',
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
  }
)

for (const valid of [true, false])
  test(
    `native final search delivery requires a validated report: valid=${valid}`,
    readOnlySearch,
    async (t) => {
      const f = await fixture(t, async function* (request, f) {
        assert(f.calls <= 2)
        if (f.calls === 2) assert.equal(request.contextStatus.phase, 'finalizing')
        const evidence = JSON.parse(request.materials[0].text).partitions.runtime.modelTool.items[0]
        if (f.calls === 2) assert(evidence?.id)
        yield {
          type: 'tool-call',
          value: {
            id: `step-${f.calls}`,
            name: 'exec',
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
    }
  )

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
    assert(
      frames[0].materials[0].text.includes(
        process.platform === 'darwin' || process.platform === 'linux'
          ? 'OPERATION_MODE_DENIED'
          : 'SHELL_CONFINEMENT_UNAVAILABLE'
      )
    )
  } finally {
    await runtime.close()
  }
})

test(
  'resume preserves history and leases, rejects stale checkpoints and current reads refresh without model calls',
  readOnlySearch,
  async (t) => {
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
  }
)

test(
  'last reserved call closes softly and blocks fresh evidence reads',
  readOnlySearch,
  async (t) => {
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
          assert.match(request.protocol, /最后的报告交付机会/)
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
  }
)

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

test(
  'a work request that would consume the final token reserve is recompiled as a delivery round',
  readOnlySearch,
  async (t) => {
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
      tokens: request.protocol?.includes('最后的报告交付机会') ? 1000 : 50000,
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
  }
)

test(
  'final search delivery preserves verified evidence when a prior required preview cannot fit',
  readOnlySearch,
  async (t) => {
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
  }
)

test(
  'INV-35 finalization compiles against its reserved window after a batch of real reads',
  readOnlySearch,
  async (t) => {
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
  }
)

test(
  'search cannot discover or execute unrelated world modules and cannot enable observe',
  readOnlySearch,
  async (t) => {
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
  }
)

test('parallel reads reserve source byte capacity before dispatch', async (t) => {
  const f = await activationFixture(t)
  f.dependencies.profile = { ...profile, readBytes: 9 }
  try {
    const signal = new AbortController().signal
    const results = await Promise.allSettled([
      f.activation.inspect(target, 9, signal),
      f.activation.inspect(target, 9, signal),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.equal(rejected.reason.code, 'SOURCE_LIMIT')
    assert.equal(f.fixture.reads, 1)
    const report = await f.activation.finish('completed', signal)
    assert.equal(report.usage.readBytes, 9)
    assert.equal(report.evidence.length, 1)
  } finally {
    await f.activation.close()
  }
})

test(
  'revoked sources are absent from resumed history and snapshots are denied',
  readOnlySearch,
  async (t) => {
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
  }
)

test('two concurrent searches share the parent budget and independent finalization reservations', async (t) => {
  const f = await lifecycle(t)
  f.model.stream = async function* () {
    f.calls++
    yield finish
  }
  f.dependencies.open = async (_id, activation) => ({
    async *submit(_input, signal) {
      await consume(activation.stream(driverRequest, signal))
      await activation.report({ findings: [], gaps: [], nextSteps: [] }, signal)
      yield { type: 'state', status: 'completed' }
    },
  })
  const reports = await Promise.all(
    ['a', 'b'].map((query) =>
      f.search.run(
        { query },
        { ...f.call, invocation: { ...f.call.invocation, id: crypto.randomUUID() } }
      )
    )
  )
  assert.equal(reports.length, 2)
  assert(reports.every((report) => report.status === 'completed'))
  assert.notEqual(reports[0].searchId, reports[1].searchId)
  assert.equal(f.calls, 2)
  assert.equal((await f.session.view.inspect()).usage.contextCalls, 2)
  assert.equal(f.closes, 2)
  assert.equal(f.reads, 0)
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

test(
  'a two-call profile allows one exploration response before the reserved final report',
  readOnlySearch,
  async (t) => {
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
  }
)

test(
  'the main model invokes typed search as a JS function and receives its report on the next runtime frame',
  readOnlySearch,
  async (t) => {
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
  }
)

test(
  'report evidence can be recalled through the parent scope without calling the model again',
  readOnlySearch,
  async (t) => {
    const f = await fixture(t, researcher)
    const report = await search(f)
    const calls = f.calls
    const result = await f.session.execute({
      source: `import {read} from 'velaros:search';import {output} from 'velaros';output(await read({ref:${JSON.stringify(report.ref)},evidenceId:${JSON.stringify(report.evidence[0].id)},offset:0,limit:4}));`,
    })
    assert.equal(result.result.value.default.text, 'logo')
    assert.equal(result.result.value.default.mode, 'snapshot')
    assert.equal(f.calls, calls)
  }
)

test(
  'search resumes from persisted history after reopening the runtime without replaying evidence scripts',
  readOnlySearch,
  async (t) => {
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
  }
)

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
  const f = await lifecycle(t)
  let opens = 0
  f.dependencies.open = async (_id, activation) => ({
    async *submit(_input, signal) {
      if (++opens === 1) await activation.inspect(target, 64000, signal)
      await activation.report({ findings: [], gaps: [], nextSteps: [] }, signal)
      yield { type: 'state', status: 'completed' }
    },
  })
  const first = await f.search.run({ query: 'auth' }, f.call)
  assert.equal(first.evidence.length, 1)
  f.dependencies.options = {
    ...f.config.search,
    profiles: { standard: { ...profile, callTimeoutMs: 30 } },
  }
  f.source.authorize = async () => new Promise(() => {})
  const started = Date.now()
  await assert.rejects(f.search.run({ resume: first.ref }, f.call))
  assert(Date.now() - started < 1500)
  assert.equal(opens, 1, 'authorization times out before opening or dispatching a resumed session')
  assert.equal(f.calls, 0)
  f.source.authorize = async () => true
  const resumed = await f.search.run({ resume: first.ref }, f.call)
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed))
  assert.equal(resumed.searchId, first.searchId)
  assert.equal(opens, 2)
  assert.equal(f.reads, 1)
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

test('reserved delivery remains available after the last work call and rejects fresh source IO', async (t) => {
  const f = await lifecycle(t)
  f.dependencies.options = {
    ...f.config.search,
    profiles: { standard: { ...profile, modelCalls: 2 } },
  }
  f.model.stream = async function* () {
    f.calls++
    yield finish
  }
  f.dependencies.open = async (_id, activation) => ({
    async *submit(_input, signal) {
      await consume(activation.stream(driverRequest, signal))
      assert.equal(activation.phase().phase, 'finalizing')
      await consume(activation.stream(driverRequest, signal))
      await assert.rejects(activation.inspect(target, 64000, signal), { code: 'SEARCH_FINALIZING' })
      await activation.report(
        {
          findings: [],
          gaps: [{ code: 'UNRESOLVED', detail: 'budget ended' }],
          nextSteps: ['continue'],
        },
        signal
      )
      yield { type: 'state', status: 'completed' }
    },
  })
  const report = await f.search.run({ query: 'auth' }, f.call)
  assert.equal(report.status, 'partial')
  assert(report.gaps.some((gap) => gap.code === 'UNRESOLVED'))
  assert.equal(f.calls, 2)
  assert.equal((await f.session.view.inspect()).usage.contextCalls, 2)
  assert.equal(f.reads, 0)
  assert.equal(f.queries, 0)
})

test('a request that would spend the delivery reserve is rejected before dispatch and can deliver after recompilation', async (t) => {
  const f = await lifecycle(t)
  f.model.estimate = async (request) => ({
    tokens: request.instructions === 'delivery' ? 1000 : 50000,
    precision: 'exact',
    basis: 'delivery-reservation-fixture',
  })
  f.model.stream = async function* () {
    f.calls++
    yield finish
  }
  f.dependencies.open = async (_id, activation) => ({
    async *submit(_input, signal) {
      await consume(activation.stream(driverRequest, signal))
      await assert.rejects(consume(activation.stream(driverRequest, signal)), {
        code: 'CONTEXT_BUDGET',
      })
      assert.equal(f.calls, 1, 'rejected work must not consume a model call')
      assert.equal(activation.phase().phase, 'finalizing')
      assert.equal(activation.limits.inputTokens, profile.finalizationTokens)
      await consume(activation.stream({ ...driverRequest, instructions: 'delivery' }, signal))
      await activation.report({ findings: [], gaps: [], nextSteps: [] }, signal)
      yield { type: 'state', status: 'completed' }
    },
  })
  const report = await f.search.run({ query: 'auth' }, f.call)
  assert.equal(report.status, 'completed')
  assert.equal(f.calls, 2)
  assert.equal((await f.session.view.inspect()).usage.contextCalls, 2)
  assert.equal(f.reads, 0)
})

test('an active search authorizes only its actual evidence and system scope without world effects', async (t) => {
  const f = await lifecycle(t)
  f.dependencies.open = async (id, activation) => ({
    async *submit(_input, signal) {
      assert.equal(f.search.allows(id, 'velaros:evidence'), true)
      assert.equal(f.search.allows(id, 'test:world'), false)
      await assert.rejects(
        f.search.authorize(
          {
            ...f.call.invocation,
            sessionId: id,
            binding: { moduleId: 'test:world' },
            operation: 'write',
            input: null,
          },
          { effects: 'write' },
          signal
        ),
        { code: 'SEARCH_CAPABILITY_DENIED' }
      )
      await activation.report({ findings: [], gaps: [], nextSteps: [] }, signal)
      yield { type: 'state', status: 'completed' }
    },
  })
  await f.search.run({ query: 'auth' }, f.call)
  assert.equal(f.reads, 0)
  assert.equal(f.queries, 0)
  assert.equal(f.calls, 0)
})

test('revoking a source denies saved bodies and removes evidence before a resumed owner opens', async (t) => {
  const f = await lifecycle(t)
  let opens = 0
  f.dependencies.open = async (_id, activation) => ({
    async *submit(_input, signal) {
      if (++opens === 1) await activation.inspect(target, 64000, signal)
      else {
        assert.equal(activation.snapshot().evidence.length, 0)
        assert(!JSON.stringify(activation.material(profile.projectionChars)).includes('logout v1'))
      }
      await activation.report({ findings: [], gaps: [], nextSteps: [] }, signal)
      yield { type: 'state', status: 'completed' }
    },
  })
  const first = await f.search.run({ query: 'auth' }, f.call)
  assert.equal(first.evidence.length, 1)
  f.allowed = false
  await assert.rejects(f.search.read({ ref: first.ref }, f.call))
  const resumed = await f.search.run({ resume: first.ref }, f.call)
  assert.equal(resumed.searchId, first.searchId)
  assert.equal(resumed.evidence.length, 0)
  const snapshot = await f.storage.load(`search:main:${first.searchId}`)
  assert(snapshot.records.some((record) => record.title === 'search:history-reset'))
  assert.equal(f.reads, 1)
  assert.equal(opens, 2)
})

test('equal-size source replacement clears candidates and records the current history reset', async (t) => {
  const f = await lifecycle(t)
  const secret = 'private-source-a-preview'
  f.source.search = async () => {
    f.queries++
    return [{ target, preview: secret, forms: ['excerpt'] }]
  }
  f.dependencies.evidence = createEvidenceAccess([f.source, { ...f.source, id: 'other' }])
  let opens = 0
  f.dependencies.open = async (_id, activation) => ({
    async *submit(_input, signal) {
      if (++opens === 1) {
        await activation.query('project', 'auth', 1, signal)
        assert(JSON.stringify(activation.material(profile.projectionChars)).includes(secret))
      } else {
        assert.deepEqual(activation.snapshot().sources, ['other'])
        assert.equal(activation.snapshot().candidates.length, 0)
        assert(!JSON.stringify(activation.material(profile.projectionChars)).includes(secret))
      }
      await activation.report({ findings: [], gaps: [], nextSteps: [] }, signal)
      yield { type: 'state', status: 'completed' }
    },
  })
  const first = await f.search.run({ query: 'auth', sources: ['project'] }, f.call)
  const resumed = await f.search.run({ resume: first.ref, sources: ['other'] }, f.call)
  assert.equal(resumed.searchId, first.searchId)
  const id = `search:main:${first.searchId}`
  const snapshot = await f.storage.load(id)
  const reset = snapshot.records.findLast((record) => record.title === 'search:history-reset')
  assert(reset)
  assert.equal(JSON.parse(await f.storage.get(id, reset.objectId)).reason, 'authorization-changed')
  assert.equal(f.queries, 1)
  assert.equal(f.reads, 0)
  assert.equal(opens, 2)
})

test('candidate-only revocation resets live and resumed history without hiding authorization faults', async (t) => {
  const f = await lifecycle(t)
  const secret = 'private-candidate-preview'
  const authorize = f.source.authorize
  const fault = new AppError('UNAVAILABLE', 'fixture authorization backend failed')
  const failAuthorization = async () => {
    throw fault
  }
  f.source.search = async () => {
    f.queries++
    return [{ target, preview: secret, forms: ['excerpt'] }]
  }
  let opens = 0
  let previousHistory
  f.dependencies.open = async (id, activation) => {
    f.searchSessionId = id
    return {
      async *submit(_input, signal) {
        const context = createContextRuntime({ sessionId: id, storage: f.storage })
        if (++opens === 1) {
          await activation.query('project', 'auth', 1, signal)
          const history = await context.append({ kind: 'note', body: secret })
          assert.equal(activation.snapshot().evidence.length, 0)
          assert(JSON.stringify(activation.material(profile.projectionChars)).includes(secret))
          f.source.authorize = failAuthorization
          await assert.rejects(activation.refresh(signal), (error) => error === fault)
          assert.equal(activation.snapshot().candidates.length, 1)
          const controller = new AbortController()
          const cancellation = createAbortError('fixture refresh cancelled')
          controller.abort(cancellation)
          await assert.rejects(
            activation.refresh(controller.signal),
            (error) => error === cancellation
          )
          f.source.authorize = authorize
          f.allowed = false
          await activation.refresh(signal)
          assert.equal(activation.snapshot().candidates.length, 0)
          assert(!JSON.stringify(activation.material(profile.projectionChars)).includes(secret))
          await assert.rejects(activation.authorizeReference(history.ref, signal), {
            code: 'DENIED',
          })
          // 再留一份只含候选的检查点，独立验证下一次续查的预检。
          f.allowed = true
          await activation.query('project', 'auth', 1, signal)
          previousHistory = (await context.append({ kind: 'note', body: secret })).ref
        } else {
          assert.equal(activation.snapshot().evidence.length, 0)
          assert.equal(activation.snapshot().candidates.length, 0)
          assert(!JSON.stringify(activation.material(profile.projectionChars)).includes(secret))
          await assert.rejects(activation.authorizeReference(previousHistory, signal), {
            code: 'DENIED',
          })
        }
        await activation.report({ findings: [], gaps: [], nextSteps: [] }, signal)
        yield { type: 'state', status: 'completed' }
      },
    }
  }
  const first = await f.search.run({ query: 'auth' }, f.call)
  assert.equal(first.status, 'completed', JSON.stringify(first))
  f.source.authorize = failAuthorization
  await assert.rejects(f.search.run({ resume: first.ref }, f.call), (error) => error === fault)
  assert.equal(opens, 1)
  assert.equal((await f.state()).candidates.length, 1)
  f.source.authorize = authorize
  f.allowed = false
  const resumed = await f.search.run({ resume: first.ref }, f.call)
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed))
  assert.equal(resumed.searchId, first.searchId)
  assert.equal((await f.state()).candidates.length, 0)
  const snapshot = await f.storage.load(f.searchSessionId)
  const resets = snapshot.records.filter((record) => record.title === 'search:history-reset')
  assert.equal(resets.length, 2)
  assert.equal(
    JSON.parse(await f.storage.get(f.searchSessionId, resets.at(-1).objectId)).reason,
    'authorization-changed'
  )
  assert.equal(f.queries, 2)
  assert.equal(f.reads, 0)
  assert.equal(f.calls, 0)
  assert.equal(opens, 2)
})

test(
  'an unavailable read-only search backend archives failure without source IO and resumes the same failed search',
  {
    skip: platformHasDefaultConfinement
      ? 'This host provides the read-only backend exercised by the integration cases.'
      : false,
  },
  async (t) => {
    const f = await fixture(t, async function* (request, fixture) {
      if (fixture.calls > 1) assert.match(modelText(request), /SHELL_CONFINEMENT_UNAVAILABLE/)
      if (fixture.calls % 2 === 0) {
        // 记录拒绝后结束本次尝试，为同一持久任务的续查保留真实剩余额度。
        yield* done(request)
        return
      }
      yield {
        type: 'text',
        text: block(
          request,
          'execute()',
          `import {read} from 'velaros:evidence';await read({target:${JSON.stringify(target)}});`
        ),
      }
      yield finish
    })
    const first = await search(f)
    assert.equal(first.status, 'failed')
    assert.equal(first.continuation, 'available')
    assert.equal(first.evidence.length, 0)
    assert(first.gaps.some((gap) => gap.code === 'REPORT_MISSING'))
    const firstCalls = f.calls
    assert.equal(firstCalls, 2)
    assert.equal(first.usage.modelCalls, 2)
    await f.runtime.close()
    const traceStorage = localContextStorage({ path: f.path })
    const runtime = await createRuntime({ ...f.config, storage: traceStorage })
    try {
      f.runtime = runtime
      f.session = await runtime.openSession('main')
      const resumed = await search(f, { resume: first.ref })
      assert.equal(resumed.status, 'failed')
      assert.equal(resumed.searchId, first.searchId)
      assert.notDeepEqual(resumed.ref, first.ref)
      assert.equal(f.calls, profile.modelCalls)
      assert.equal(resumed.usage.modelCalls, profile.modelCalls - firstCalls)
      const exhausted = await search(f, { resume: resumed.ref })
      assert.equal(exhausted.status, 'failed')
      assert.equal(exhausted.searchId, first.searchId)
      assert.notDeepEqual(exhausted.ref, resumed.ref)
      assert.equal(exhausted.usage.modelCalls, 0)
      assert.equal(f.calls, profile.modelCalls, 'resume never resets the persisted model budget')
      assert.equal(f.reads, 0)
      assert.equal(f.queries, 0)
      const id = `search:main:${first.searchId}`
      const snapshot = await traceStorage.load(id)
      const stateRecord = snapshot.records.findLast((record) => record.title === 'search:state')
      const state = JSON.parse(await traceStorage.get(id, stateRecord.objectId))
      assert.deepEqual(state.report, exhausted.ref)
      assert.equal(state.activation, undefined)
      const trace = await new RuntimeTrace(
        id,
        traceStorage,
        createContextInvocationJournal(traceStorage)
      ).page({ limit: 20 })
      assert(
        trace.turns.some((turn) =>
          turn.executions.some(
            (execution) => execution.failure?.code === 'SHELL_CONFINEMENT_UNAVAILABLE'
          )
        )
      )
      assert.equal(runtime.getSession(id), undefined)
    } finally {
      await runtime.close()
    }
  }
)

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
    assert(error instanceof AppError)
    assert.deepEqual(error.errors, [primary, budget, close])
    assert(error.errors.every((item, index) => item === [primary, budget, close][index]))
    assert.equal(error.cause, undefined)
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

test(
  'replacing the source set with the same cardinality removes old candidates and free history',
  readOnlySearch,
  async (t) => {
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
  }
)

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
  return { fixture: f, activation, counters, dependencies, request: { outputTokens: 1000 } }
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
  await assert.rejects(pending, (error) => {
    assert(error instanceof AppError)
    assert.equal(error.code, 'MODEL_RESERVATION_RELEASE')
    assert(error.errors.includes(failure))
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(f.counters.dispatched, 0)
  assert.equal(f.counters.released, 1)
  await assert.rejects(driver.close(), (error) => {
    assert(error instanceof AppError)
    assert.equal(error.code, 'UNAVAILABLE')
    assert(error.errors.some((item) => item.code === 'MODEL_RESERVATION_RELEASE'))
    return true
  })
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
    const published = JSON.parse((await f.session.view.readArtifact(state.report)).text)
    assert.equal(published.status, platformHasDefaultConfinement ? 'completed' : 'failed')
    if (!platformHasDefaultConfinement) {
      assert(published.gaps.some((gap) => gap.code === 'REPORT_MISSING'))
      assert.equal(published.evidence.length, 0)
      assert.equal(f.reads, 0)
    }
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
    f.session.view.reserveModel = async (...args) => {
      await reserve(...args)
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

test(
  'INV-33 search keeps runtime evidence after execution output expires and finalizes from real IDs',
  readOnlySearch,
  async (t) => {
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
  }
)

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

test(
  'INV-33 exhausted query allowance still permits reading previously found candidates before final report',
  readOnlySearch,
  async (t) => {
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
  }
)

test(
  'a malformed gap is rejected at the call naming the wrong field and can be corrected without another search',
  readOnlySearch,
  async (t) => {
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
  }
)
