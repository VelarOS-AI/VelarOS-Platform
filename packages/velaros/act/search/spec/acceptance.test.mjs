import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { ContextLimits, createContextRuntime } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { AppError } from '@velaros-ai/core/error'
import {
  codeProgramChecker,
  createCodeSurfaceSession,
  nodeSubprocessCodeRunner,
} from '@velaros-ai/script'

import { RecentContext } from '../../../dist/act/runtime/impl/RecentContext.js'
import { SearchLimits } from '../../../dist/act/search/contract/constants.js'
import {
  VelarEvidenceModule,
  VelarSearchModule,
} from '../../../dist/act/search/contract/surface.js'
import { AdvancedSearch } from '../../../dist/act/search/impl/AdvancedSearch.js'
import { evidenceModule, searchModule } from '../../../dist/act/search/index.js'
import { verifyModule } from '../../runtime/test/support/module-contract.mjs'

test('INV-1 search 的实际操作与模板一致', () =>
  verifyModule(searchModule, new URL('../template.js', import.meta.url)))
test('INV-1 evidence 的实际操作与模板一致', () =>
  verifyModule(evidenceModule, new URL('../evidence-template.js', import.meta.url)))

test('新搜索首次持久化采用当前正文引用格式，不依赖历史迁移', async (t) => {
  const storage = localContextStorage({ path: ':memory:' })
  t.after(() => storage.close())
  let sessionId
  const search = new AdvancedSearch({
    storage,
    evidence: { sources: () => [] },
    options: {
      defaultProfile: 'public',
      profiles: {
        public: {
          modelCalls: 2,
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
        },
      },
    },
    parentDeadline: () => undefined,
    view: () => ({ inspect: async () => ({ revision: 1 }) }),
    tools: {
      begin: async (id) => {
        sessionId = id
        throw new AppError('UNAVAILABLE', '公开夹具在持久占位后停止')
      },
    },
  })
  await assert.rejects(
    search.run(
      { query: 'public initial state' },
      {
        invocation: { sessionId: 'parent', id: 'claim', executionId: 'execution' },
        signal: new AbortController().signal,
      }
    ),
    { code: 'UNAVAILABLE' }
  )
  const state = await storage.load(sessionId)
  assert.equal(state.objectReferencesVersion, 1)
  assert(state.records.some((record) => record.title === 'search:state'))
  const context = createContextRuntime({ storage, sessionId })
  const recent = new RecentContext(sessionId, context, storage)
  assert.equal(await recent.currentBoundary(new AbortController().signal), 0)
})

/** 模板经真实操作类与隔离程序运行；宿主来源由用例固定，记录各次操作。 */
async function runTemplate(surface, definition, file, expression) {
  const calls = []
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities: {
      listOperations: () => ({ [surface.namespace]: Object.keys(definition.operations) }),
      invoke: async ({ operation, input }) => {
        calls.push({ operation, input })
        try {
          return {
            value: await definition.operations[operation].run(input, {
              signal: new AbortController().signal,
              invocation: {
                id: `call-${calls.length}`,
                sessionId: 'search',
                executionId: 'execution',
              },
              recordEffect() {},
            }),
          }
        } catch (error) {
          return { error: { code: error.code ?? 'UNKNOWN', message: error.message } }
        }
      },
    },
  })
  const template = await readFile(new URL(file, import.meta.url), 'utf8')
  const outcome = await session.submit({
    program: { source: `${template}\nexport default ${expression}` },
    granted: [{ namespace: surface.namespace, declarations: surface.declarations }],
    timeoutMs: 20_000,
  })
  assert.equal(outcome.checked, true)
  assert.equal(outcome.result.failed, undefined)
  return { value: outcome.result.value, calls }
}

test('INV-3 搜索模板保留局部报告、分页失败项和真实证据版本，不把当前页当全部', async () => {
  const ref = { sessionId: 'parent', id: 'report' }
  const stamp = {
    sourceId: 'docs',
    resourceId: 'a',
    revision: '2',
    contentHash: 'hash-a',
    observedAt: '2026-10-01T00:00:00.000Z',
    consistency: 'revision-checkable',
  }
  const items = [
    {
      id: 'a',
      ok: true,
      status: 'current',
      target: { kind: 'resource', sourceId: 'docs', resourceId: 'a' },
      text: 'current text',
      stamp,
      form: 'excerpt',
      mediaType: 'text/plain',
      complete: false,
    },
    { id: 'b', ok: false, status: 'missing' },
    {
      id: 'c',
      ok: true,
      status: 'current',
      target: { kind: 'resource', sourceId: 'docs', resourceId: 'c' },
      text: 'last text',
      stamp: { ...stamp, resourceId: 'c' },
      form: 'full',
      mediaType: 'text/plain',
      complete: true,
    },
  ]
  const published = {
    ref,
    searchId: 'search-1',
    profile: 'quick',
    status: 'partial',
    continuation: 'available',
    stopReason: 'read-budget',
    findings: [{ text: 'known finding', evidenceIds: ['a'] }],
    gaps: [{ code: 'LIMIT', detail: 'some sources unread' }],
    nextSteps: ['continue'],
    evidence: [
      {
        id: 'a',
        ref: { sessionId: 'search', id: 'evidence-a' },
        target: items[0].target,
        stamp,
        excerpt: 'large excerpt',
        complete: false,
      },
    ],
    coverage: { sources: ['docs'], queries: ['session'], limitsHit: ['reads'] },
    usage: { modelCalls: 1, reads: 1 },
  }
  const definition = searchModule.create({
    search: {
      profileInfo: () => [{ name: 'quick', default: true, limits: {} }],
      run: async () => published,
      read: async ({ offset, limit }) => ({
        mode: 'current',
        ref,
        items: items.slice(offset, offset + limit),
        total: items.length,
        modelCalled: false,
      }),
    },
  })
  const result = await runTemplate(
    VelarSearchModule,
    definition,
    '../template.js',
    `({report:await investigate('session'),first:await currentText(${JSON.stringify(ref)},0,1),second:await currentText(${JSON.stringify(ref)},1,1),last:await currentText(${JSON.stringify(ref)},2,1)})`
  )
  assert.equal(result.value.report.status, 'partial')
  assert.deepEqual(result.value.report.coverage, published.coverage)
  assert.deepEqual(result.value.report.gaps, published.gaps)
  assert.equal(result.value.report.evidence[0].excerpt, undefined)
  assert.deepEqual(result.value.first.items[0].stamp, stamp)
  assert.equal(result.value.first.items[0].complete, false)
  assert.equal(result.value.first.nextOffset, 1)
  assert.deepEqual(result.value.second.items, [{ id: 'b', gap: 'missing' }])
  assert.equal(result.value.second.nextOffset, 2)
  assert.equal(result.value.last.nextOffset, null)
  assert.equal(result.value.last.modelCalled, false)
  assert.deepEqual(
    result.calls.map(({ operation }) => operation),
    ['profiles', 'search', 'read', 'read', 'read']
  )
})

test('INV-3 证据组合模板保留真实读取失败与未读候选，preview 不冒充证据', async () => {
  const candidates = ['a', 'b', 'c'].map((id) => ({
    id,
    target: { kind: 'resource', sourceId: 'docs', resourceId: id },
    preview: `candidate ${id}`,
    forms: ['full'],
  }))
  const stamp = {
    sourceId: 'docs',
    resourceId: 'a',
    revision: '1',
    contentHash: 'hash-a',
    observedAt: '2026-10-01T00:00:00.000Z',
    consistency: 'revision-checkable',
  }
  const definition = evidenceModule.create({
    search: {
      activation: () => ({
        query: async (source, query) => ({ source, query, candidates, empty: false }),
        inspect: async (target) => {
          if (target.resourceId === 'b')
            throw Object.assign(new Error('source no longer readable'), { code: 'NOT_FOUND' })
          return {
            id: 'read-a',
            target,
            ref: { sessionId: 'search', id: 'evidence-a' },
            excerpt: 'actual body',
            stamp,
            complete: false,
          }
        },
      }),
    },
  })
  const result = await runTemplate(
    VelarEvidenceModule,
    definition,
    '../evidence-template.js',
    "await collect('docs','session',2)"
  )
  assert.deepEqual(result.value.evidence, [
    {
      id: 'read-a',
      target: candidates[0].target,
      ref: { sessionId: 'search', id: 'evidence-a' },
      text: 'actual body',
      stamp,
      complete: false,
    },
  ])
  assert.deepEqual(result.value.gaps, [
    {
      candidateId: 'b',
      target: candidates[1].target,
      code: 'NOT_FOUND',
      message: 'source no longer readable',
    },
  ])
  assert.deepEqual(result.value.unread, [{ id: 'c', target: candidates[2].target }])
  assert.deepEqual(
    result.calls.map(({ operation }) => operation),
    ['query', 'read', 'read']
  )
})

test('搜索档位目录与调用使用同一组宿主名称，发现的名称可直接用于搜索', async () => {
  const names = ['quick', 'investigate']
  const info = names.map((name) => ({ name, default: name === 'investigate', limits: {} }))
  let selected
  const definition = searchModule.create({
    search: {
      profileInfo: () => info,
      run: async (input) => {
        selected = input.profile
        return { selected }
      },
    },
  })
  const call = () => ({
    signal: new AbortController().signal,
    invocation: { id: 'call', sessionId: 's', executionId: 'e' },
    recordEffect() {},
  })
  const operations = definition.operations
  const directory = await operations.profiles.run(null, call())
  assert.deepEqual(
    directory.map((item) => item.name),
    names
  )
  const profile = directory.find((item) => item.default).name
  assert.deepEqual(await operations.search.run({ query: 'session', profile }, call()), {
    selected: 'investigate',
  })
  assert.equal(selected, 'investigate')
})

test('INV-2 声明里写给模型的上限与常量表一致', () => {
  const report = `整份不超过 ${SearchLimits.reportChars} 个字符`
  for (const [surface, fragments] of [
    [
      VelarSearchModule,
      [
        `新搜索给 query（最多 ${SearchLimits.queryChars} 个字符）`,
        `sources 限定来源（最多 ${SearchLimits.sources} 个）`,
        `背景说明（最多 ${SearchLimits.contextChars} 个字符）；anchors 是已知相关的资源（最多 ${SearchLimits.anchors} 个）`,
        `limit 最多 ${ContextLimits.readChars} 个字符`,
        `按证据条目分页（limit 最多 ${SearchLimits.refreshItems} 条）`,
        report,
      ],
    ],
    [
      VelarEvidenceModule,
      [
        `query 用短关键词（1 到 ${SearchLimits.evidenceQueryChars} 个字符），limit 每次最多 ${SearchLimits.candidates} 个候选，默认 ${SearchLimits.defaultCandidates}`,
        `maxBytes 最多 ${SearchLimits.readBytes}，默认 ${SearchLimits.defaultReadBytes}`,
        report,
      ],
    ],
  ])
    for (const fragment of fragments)
      assert.ok(
        surface.declarations.includes(fragment),
        `${surface.specifier} 的声明里没有「${fragment}」`
      )
})
