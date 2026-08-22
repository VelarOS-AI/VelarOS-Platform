/**
 * 上下文治理 v3 · S3 批断言电池（检索面与数据丢失）。
 *
 * 每条钉死一个已验证的缺陷：
 *  ① **超大 user 正文可召回**（U6/U10）：全文落了盘就必须取得回来——账本记录 id 与
 *     `ctx-user-payload:` 两种句柄都要能解析，否则"正文在磁盘上、模型永远拿不到"；
 *  ② **非 jsonPath 的 offset**（U31）：30 万字的正文必须能顺序读，不能每次都回第一页；
 *  ③ **context-handle 分页参数直传**（U9）：`tool:*` 句柄的 jsonPath/offset 不许在工具层被吞；
 *  ④ **索引指纹早于构建采集**（U7）：构建期间落盘的 blob 不许被算进"这份索引已包含"的指纹；
 *  ⑤ **索引内存缓存**（retrieval 优化2）：指纹不变时不重读整份索引。
 */
import assert from 'node:assert/strict'

import type { ModelMessage } from 'ai'
import { describe, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '../src/agent/context/ContextPayloadStore'
import { ProviderRequestCompiler } from '../src/agent/context/ProviderRequestCompiler'
import { compileProviderSendRequest } from '../src/agent/context/ProviderSendRequest'
import { ContextGovernanceSessionRegistry } from '../src/agent/context/residency/ContextGovernanceSession'
import { ChatContextRetrievalService } from '../src/agent/context/retrieval/ContextRetrievalService'
import type {
  ChatContextRetrievalIndexSaveOptions,
  ChatContextRetrievalIndexSnapshot,
  ChatContextRetrievalIndexStore,
} from '../src/agent/context/retrieval/IndexSnapshot'
import type {
  RetrievalPayloadStorePort,
  RetrievalStateStorePort,
} from '../src/agent/context/retrieval/sessionStorePorts'
import type {
  ChatContextRetrievalIndexSourceFingerprint,
  ChatSessionPayloadSnapshot,
  ChatSessionToolResultPayload,
} from '../src/protocol'
import { inferRecallRefKind } from '../src/tool-library/builtin/ContextRetrieval'

const SessionId = 'session-s3'

interface FakePayloadStoreOptions {
  toolResults?: Record<string, ChatSessionToolResultPayload>
}

/** 只实现检索面真正消费的两个方法；其余字段结构化满足端口即可。 */
function createPayloadStore(options: FakePayloadStoreOptions = {}): RetrievalPayloadStorePort & {
  loads: number
} {
  const toolResults = options.toolResults ?? {}
  return {
    loads: 0,
    async loadSessionPayloads(sessionId: string): Promise<ChatSessionPayloadSnapshot> {
      this.loads += 1
      return {
        sessionId,
        userMessages: {},
        assistantMessages: {},
        toolResults,
      }
    },
    async loadToolPayload(_sessionId: string, key: string) {
      return toolResults[key] ?? null
    },
  }
}

function createStateStore(): RetrievalStateStorePort {
  return {
    async loadSessionMessages() {
      return []
    },
    async loadSessionMessage() {
      return null
    },
  }
}

interface RecordingIndexStore extends ChatContextRetrievalIndexStore {
  calls: string[]
  savedFingerprints: Array<Nullable<ChatContextRetrievalIndexSourceFingerprint>>
  fingerprint: ChatContextRetrievalIndexSourceFingerprint
}

/**
 * 把宿主索引存储的调用顺序录下来。
 *
 * `readSourceFingerprint` 返回当前值：测试通过在 build 期间改动它来模拟"构建中途有新 blob 落盘"。
 */
function createIndexStore(): RecordingIndexStore {
  return {
    calls: [],
    savedFingerprints: [],
    fingerprint: { stateMtimeMs: 1, payloadMtimeMs: 1, payloadFingerprint: 'fp-1' },
    async readSourceFingerprint() {
      this.calls.push('fingerprint')
      return this.fingerprint
    },
    async loadFresh() {
      this.calls.push('loadFresh')
      return null
    },
    async save(
      _sessionId: string,
      _snapshot: ChatContextRetrievalIndexSnapshot,
      options?: ChatContextRetrievalIndexSaveOptions
    ) {
      this.calls.push('save')
      this.savedFingerprints.push(options?.sourceFingerprint ?? null)
    },
  }
}

function createService(input: {
  payloadStore: RetrievalPayloadStorePort
  registry?: ContextGovernanceSessionRegistry
  indexStore?: ChatContextRetrievalIndexStore
}): ChatContextRetrievalService {
  return new ChatContextRetrievalService(
    input.payloadStore,
    createStateStore(),
    input.registry ?? new ContextGovernanceSessionRegistry(),
    input.indexStore ?? createIndexStore()
  )
}

function userMessage(text: string): ModelMessage {
  return { role: 'user', content: text }
}

describe('S3 · 超大 user 正文的端到端召回', () => {
  test('统一发送路径持久化全文、账本拿到 payloadRef，并向模型展示头尾', async () => {
    const fullText = `开头约束 ${'中'.repeat(60_000)} 结尾约束必须保留`
    const payloadStore = new InMemoryContextPayloadStore()
    const registry = new ContextGovernanceSessionRegistry({ config: { dashboard: false } })
    const compiler = new ProviderRequestCompiler(registry)

    const compiled = await compileProviderSendRequest(
      {
        sessionId: SessionId,
        rawHistoryMessages: [userMessage(fullText)],
        phase: 'stream',
        payloadStore,
        model: 'gpt-test',
        systemPrompt: 'system',
        contextWindow: 200_000,
      },
      compiler
    )

    const record = registry.peek(SessionId)!.ledger.list()[0]!
    assert.ok(record.payloadRef?.startsWith('ctx-user-payload:'))
    assert.equal(record.excerpt?.ref, record.payloadRef)
    const projected = String(compiled.providerMessages[0]?.content)
    assert.ok(projected.includes('开头约束'))
    assert.ok(projected.includes('结尾约束必须保留'))
    assert.ok(projected.includes(record.payloadRef!))

    const stored = (await payloadStore.listForSession(SessionId)).find(
      (candidate) => candidate.payloadRef === record.payloadRef
    )
    assert.equal(stored?.serializedResult, fullText)

    const service = createService({
      payloadStore: createPayloadStore({
        toolResults: stored
          ? {
              [stored.payloadRef]: {
                serializedResult: stored.serializedResult,
                displayResult: stored.serializedResult,
                toolCallId: stored.toolCallId,
                toolName: stored.toolName,
                payloadRef: stored.payloadRef,
                hash: stored.hash,
              },
            }
          : {},
      }),
      registry,
    })
    const recalled = await service.retrieveContextPayload({
      sessionId: SessionId,
      handleId: record.payloadRef!,
      maxChars: 100_000,
    })
    assert.equal(recalled.found, true)
    assert.ok(recalled.content?.includes('开头约束'))
    const recalledTail = await service.retrieveContextPayload({
      sessionId: SessionId,
      handleId: record.payloadRef!,
      offset: fullText.length - 10,
      maxChars: 100_000,
    })
    assert.ok(recalledTail.content?.includes('结尾约束必须保留'))
  })

  test('账本记录 id 形态的句柄能取回全文（U6/U10）', async () => {
    const fullText = `任务陈述开头 ${'长'.repeat(60_000)} 任务陈述结尾`
    const registry = new ContextGovernanceSessionRegistry()
    const session = registry.resolve(SessionId)!
    session.syncHistory({ messages: [userMessage(fullText)], at: 1 })

    const record = session.ledger.list()[0]!
    // 前提复现：安全阀发给模型的 ref 就是记录 id + refKind=context-handle。
    assert.equal(record.excerpt?.refKind, 'context-handle')
    assert.equal(record.excerpt?.ref, record.id)

    const service = createService({ payloadStore: createPayloadStore(), registry })
    const payload = await service.retrieveContextPayload({
      sessionId: SessionId,
      handleId: record.id,
      maxChars: 30_000,
    })

    assert.equal(payload.found, true)
    assert.equal(payload.kind, 'context-record')
    assert.ok(payload.content?.startsWith('任务陈述开头'))
    assert.equal(payload.metadata?.totalChars, fullText.length)
    assert.equal(payload.metadata?.nextOffset, 30_000)

    // 续读：offset 推到 nextOffset 必须拿到**不同**的一段，且能走到末尾。
    const tail = await service.retrieveContextPayload({
      sessionId: SessionId,
      handleId: record.id,
      offset: fullText.length - 10,
      maxChars: 30_000,
    })
    assert.equal(tail.content, fullText.slice(-10))
    assert.equal(tail.metadata?.nextOffset, null)
  })

  test('ctx-user-payload 句柄走内容寻址通道取回全文（U6）', async () => {
    const fullText = 'A'.repeat(120_000)
    const ref = `ctx-user-payload:${SessionId}:hash-1`
    const payloadStore = createPayloadStore({
      toolResults: {
        [ref]: {
          serializedResult: fullText,
          displayResult: fullText,
          toolCallId: `${SessionId}:user:0:hash-1`,
          toolName: '__context_user_text__',
          payloadRef: ref,
          hash: 'hash-1',
        },
      },
    })
    const service = createService({ payloadStore })

    const payload = await service.retrieveContextPayload({
      sessionId: SessionId,
      handleId: ref,
      maxChars: 10_000,
    })

    assert.equal(payload.found, true)
    assert.ok(payload.content?.includes('AAAA'))
    assert.equal(payload.metadata?.totalChars, fullText.length)
  })

  test('全保真层没了但账本还在时，tool: 句柄仍能取回原文（U6 兜底）', async () => {
    const toolText = 'R'.repeat(30_000)
    const registry = new ContextGovernanceSessionRegistry()
    const session = registry.resolve(SessionId)!
    session.syncHistory({
      messages: [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call_gone', toolName: 'shell', input: {} }] },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call_gone',
              toolName: 'shell',
              output: { type: 'text', value: toolText },
            },
          ],
        },
      ] as ModelMessage[],
      at: 1,
    })

    // payload 目录里没有这条 blob（被 GC / 从未落盘）。
    const service = createService({ payloadStore: createPayloadStore(), registry })
    const payload = await service.retrieveContextPayload({
      sessionId: SessionId,
      handleId: 'tool:call_gone',
      maxChars: 30_000,
    })

    assert.equal(payload.found, true)
    assert.ok(payload.content?.includes('RRRR'))
  })

  test('refKind 推断：ctx-user-payload 是 payload-ref、记录 id 是 context-handle（U6）', () => {
    assert.equal(inferRecallRefKind('ctx-user-payload:session-a:hash-1'), 'payload-ref')
    assert.equal(inferRecallRefKind('ctx-r000012'), 'context-handle')
    assert.equal(inferRecallRefKind('ctx-payload:session-a:hash-1'), 'payload-ref')
    assert.equal(inferRecallRefKind('call_abc'), 'tool-payload')
    assert.equal(inferRecallRefKind('call_abc:file:2'), 'evidence')
  })
})

describe('S3 · 非 jsonPath 正文分页', () => {
  test('offset 对整段 serializedResult 生效并回带 nextOffset（U31）', async () => {
    const body = Array.from({ length: 20_000 }, (_, index) => `line-${index}`).join('\n')
    const payloadStore = createPayloadStore({
      toolResults: {
        call_big: {
          serializedResult: body,
          displayResult: body,
          toolCallId: 'call_big',
          toolName: 'shell',
        },
      },
    })
    const service = createService({ payloadStore })

    const first = await service.retrieveContextPayload({
      sessionId: SessionId,
      handleId: 'tool:call_big',
      maxChars: 5_000,
    })
    const nextOffset = first.metadata?.nextOffset
    assert.equal(typeof nextOffset, 'number')

    const second = await service.retrieveContextPayload({
      sessionId: SessionId,
      handleId: 'tool:call_big',
      offset: nextOffset as number,
      maxChars: 5_000,
    })

    assert.notEqual(second.content, first.content)
    assert.ok(second.content?.includes(body.slice(nextOffset as number, (nextOffset as number) + 20)))
    assert.equal(second.metadata?.totalChars, body.length)

    // 越界不许静默回第一页——必须明确告知已到末尾。
    const beyond = await service.retrieveContextPayload({
      sessionId: SessionId,
      handleId: 'tool:call_big',
      offset: body.length + 10,
      maxChars: 5_000,
    })
    assert.equal(beyond.metadata?.returnedChars, 0)
    assert.match(beyond.warning ?? '', /越过正文末尾/u)
  })
})

describe('S3 · 索引新鲜度与缓存', () => {
  test('指纹在 build 之前采集，save 收到的是旧指纹（U7）', async () => {
    const indexStore = createIndexStore()
    const payloadStore = createPayloadStore()
    // 构建期间又落了一个新 blob：指纹随之变化，但快照里没有它。
    const originalLoad = payloadStore.loadSessionPayloads.bind(payloadStore)
    payloadStore.loadSessionPayloads = async (sessionId: string) => {
      const snapshot = await originalLoad(sessionId)
      indexStore.fingerprint = {
        stateMtimeMs: 2,
        payloadMtimeMs: 2,
        payloadFingerprint: 'fp-2',
      }
      return snapshot
    }
    const service = createService({ payloadStore, indexStore })

    await service.searchConversationHistory({ sessionId: SessionId, query: 'anything' })

    assert.equal(indexStore.calls[0], 'fingerprint')
    assert.ok(indexStore.calls.indexOf('save') > indexStore.calls.indexOf('fingerprint'))
    assert.deepEqual(indexStore.savedFingerprints[0], {
      stateMtimeMs: 1,
      payloadMtimeMs: 1,
      payloadFingerprint: 'fp-1',
    })
  })

  test('指纹不变时复用内存索引，指纹变了才重建（retrieval 优化2）', async () => {
    const indexStore = createIndexStore()
    const service = createService({ payloadStore: createPayloadStore(), indexStore })

    await service.searchConversationHistory({ sessionId: SessionId, query: 'a' })
    const afterFirst = indexStore.calls.filter((call) => call === 'loadFresh').length
    await service.searchConversationHistory({ sessionId: SessionId, query: 'b' })
    const afterSecond = indexStore.calls.filter((call) => call === 'loadFresh').length
    assert.equal(afterFirst, 1)
    assert.equal(afterSecond, 1)

    indexStore.fingerprint = { stateMtimeMs: 3, payloadMtimeMs: 3, payloadFingerprint: 'fp-3' }
    await service.searchConversationHistory({ sessionId: SessionId, query: 'c' })
    assert.equal(indexStore.calls.filter((call) => call === 'loadFresh').length, 2)
  })

  test('invalidateSession 之后不再供上一段对话的索引（v3 · R8）', async () => {
    // 缓存判据只有"源指纹一致"。会话被删后目录消失、指纹多半读不出来，于是**大多数**情况会自然
    // 退化成重建——但那是巧合不是保证：同一 sessionId 被复用、或目录被外部工具原样恢复到旧 mtime
    // 时，进程内会继续供应上一段对话的索引，而 LRU 槽位让它活很久。这里把"指纹原样不动"这一最坏
    // 形态钉住：治理侧已经认了"会话没了状态就该没"，检索侧必须有同一条失效通道。
    const indexStore = createIndexStore()
    const service = createService({ payloadStore: createPayloadStore(), indexStore })
    const loadFreshCount = (): number =>
      indexStore.calls.filter((call) => call === 'loadFresh').length

    await service.searchConversationHistory({ sessionId: SessionId, query: 'a' })
    await service.searchConversationHistory({ sessionId: SessionId, query: 'b' })
    assert.equal(loadFreshCount(), 1, '指纹不变时本就该命中内存快照')

    service.invalidateSession(SessionId)
    await service.searchConversationHistory({ sessionId: SessionId, query: 'c' })
    assert.equal(loadFreshCount(), 2)
  })
})
