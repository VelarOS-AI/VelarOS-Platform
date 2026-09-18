/**
 * 验收测试与实现测试共用的假对象：一座假知识库（检索按页交回事先备好的文档，文档里带着引擎才有的多余字段，
 * 本单元要是把它们带给模型一眼就看得出来），经真的能力端口挂上 `velar:knowledge` 的三个操作；每次解析工作区、同步、检索都记下来。
 * 还有照生成的声明跑一段模型程序的代码面会话。放在 spec 下，因为验收测试依赖它们；实现测试也从这里取。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { CapabilityOperationContext } from '@velaros-ai/code-surface'
import { codeProgramChecker, createCapabilityPort, createCodeSurfaceSession, nodeSubprocessCodeRunner } from '@velaros-ai/code-surface'
import { AppError } from '@velaros-ai/core/error'

import type {
  KnowledgeIndexDiagnostics,
  KnowledgeOperationContext,
  KnowledgeSearchInput,
  KnowledgeSearchRecord,
  KnowledgeSearchRequest,
  KnowledgeSpacePort,
  KnowledgeSynced,
  KnowledgeSyncInput,
} from '../index'
import { knowledgeOperations } from '../index'

/** 空间自己的工作区。 */
export const WorkspaceRoot = '/repo'

/** 一份命中文档，外加引擎才有的几个字段（行身份、索引哈希、嵌入模型）：它们不许出现在交给模型的结果里。 */
export function record(id: string, patch: Partial<KnowledgeSearchRecord> = {}): KnowledgeSearchRecord {
  const engineOnly = { workspaceRoot: WorkspaceRoot, indexTextHash: 'hash-engine-only', embeddingModel: 'engine-only-model', chunkCount: 3 }
  return {
    id,
    path: `docs/${id}.md`,
    title: `标题 ${id}`,
    summary: `摘要 ${id}`,
    snippet: `片段 ${id}`,
    content: `正文 ${id}`,
    sourceKind: 'markdown',
    tags: ['guide'],
    score: 0.9,
    matchType: 'hybrid',
    indexStatus: 'ready',
    indexError: '',
    updatedAt: 1_760_000_000_000,
    ...patch,
    ...engineOnly,
  }
}

/** 一份同步结果，只有点名的字段有值。 */
export function synced(patch: Partial<KnowledgeSynced> = {}): KnowledgeSynced {
  return { workspaceRoot: WorkspaceRoot, scanned: 0, upserted: 0, reindexed: 0, reindexBlocked: 0, removed: 0, skipped: 0, forced: false, ...patch }
}

/** 一份引擎的诊断，带着模型面不要的向量库路径与索引运行时键。 */
export const Diagnostics = Object.freeze({
  workspaceSyncs: [{ workspaceRoot: WorkspaceRoot, lastSyncedAt: 1_760_000_000_000 }],
  totalDocuments: 12,
  pendingDocuments: 1,
  readyDocuments: 9,
  partialDocuments: 1,
  failedDocuments: 1,
  outdatedDocuments: 2,
  activeProfileIndexedDocuments: 8,
  activeProfileMissingDocuments: 4,
  preservedVectorIndexes: 0,
  embeddingProfileCount: 1,
  totalChunks: 40,
  fileIndex: { trackedFiles: 30, trackedBySourceKind: { markdown: 20, text: 0, json: 2, config: 3, code: 5 } },
  vectorStore: { path: '/data/lancedb', tableName: 'knowledge_chunks_v', rowCount: 36, dimensions: 1536, indices: [] },
  runtime: { provider: 'openai', model: 'text-embedding-3-small', indexRuntimeKey: 'knowledge-chunk-builder:v2' },
}) satisfies KnowledgeIndexDiagnostics

/**
 * 一座假知识库：检索按 pages 逐次交回；sync 给了就按它答同步（可以抛错）；defaultWorkspace 为 null 时空间没有默认工作区，
 * 调用又没给 workspaceRoot 就像真空间那样报 VALIDATION。
 */
export function knowledgeDesk(options: {
  pages?: KnowledgeSearchRecord[][]
  sync?: () => Promise<KnowledgeSynced>
  defaultWorkspace?: Nullable<string>
} = {}) {
  const pages = [...(options.pages ?? [])]
  const searches: Array<{ query: string; options: KnowledgeSearchRequest }> = []
  const syncs: Array<{ workspaceRoot: string; options?: { force?: boolean } }> = []
  const resolved: Array<Optional<string>> = []
  let diagnosticsCalls = 0
  const defaultWorkspace = options.defaultWorkspace === undefined ? WorkspaceRoot : options.defaultWorkspace
  const port: KnowledgeSpacePort = {
    resolveWorkspace: (requested) => {
      resolved.push(requested)
      const root = requested ?? defaultWorkspace
      if (!root) throw new AppError('VALIDATION', '这个空间没有默认工作区，请给 workspaceRoot。')
      return root
    },
    getDiagnostics: async () => {
      diagnosticsCalls += 1
      return structuredClone(Diagnostics)
    },
    ensureWorkspaceSynced: async (workspaceRoot, syncOptions) => {
      syncs.push({ workspaceRoot, options: syncOptions })
      return options.sync ? options.sync() : synced({ workspaceRoot, forced: syncOptions?.force === true })
    },
    searchKnowledge: async (query, searchOptions) => {
      searches.push({ query, options: searchOptions })
      return pages.shift() ?? []
    },
  }
  const context: KnowledgeOperationContext = { abortSignal: new AbortController().signal, knowledge: port }
  /** 代码面宿主给每次调用装的上下文：同一个端口，取消信号跟着这次调用。 */
  const hostContext = (call: CapabilityOperationContext): KnowledgeOperationContext => ({ abortSignal: call.signal ?? new AbortController().signal, knowledge: port })
  const capabilities = createCapabilityPort({
    knowledge: {
      search: (input, call) => knowledgeOperations.search(input as KnowledgeSearchInput, hostContext(call)),
      sync: (input, call) => knowledgeOperations.sync(input as KnowledgeSyncInput, hostContext(call)),
      diagnostics: (_input, call) => knowledgeOperations.diagnostics(hostContext(call)),
    },
  })
  /** 像模型的程序那样调一次：成功交回返回值，失败抛带 code 的错误（程序看得到的就这两样）。入参与返回值都过一遍 JSON。 */
  const call = async (operation: string, input?: unknown): Promise<any> => {
    const outcome = await capabilities.invoke({ namespace: 'knowledge', operation, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)) })
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code })
    return outcome.value === undefined ? undefined : JSON.parse(JSON.stringify(outcome.value))
  }
  return { port, context, capabilities, call, searches, syncs, resolved, diagnosticsCalls: () => diagnosticsCalls }
}

/** 等一个调用失败，交出它的码与说明。 */
export async function failureOf(call: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = error as { code?: string; message?: string }
    return { code: failure.code ?? AppError.from(error).code, message: failure.message ?? String(error) }
  }
  throw new Error('应当失败，却成功了')
}

// ── 代码面 ──────────────────────────────────────────────────────

/** 模型这一轮读到的 `velar:knowledge` 声明：就是提交进仓的那份生成物，程序照着它过 typecheck。 */
export const KnowledgeDeclarations = readFileSync(fileURLToPath(new URL('../../../../baselines/code-surface/knowledge.d.ts', import.meta.url)), 'utf8')

/** 这一轮授给程序的模块：只有 `knowledge` 一个命名空间。 */
const Granted = [{ namespace: 'knowledge', declarations: KnowledgeDeclarations }]

/** 只照生成的声明做 typecheck、不执行：交回诊断，过了就是空的。 */
export function checkModelProgram(source: string) {
  const checked = codeProgramChecker.check({ source, granted: Granted })
  return checked.ok ? [] : checked.diagnostics
}

/** 让一段真程序照生成的声明过 typecheck，再在隔离里跑完：交出程序的结果。 */
export async function runModelProgram(desk: ReturnType<typeof knowledgeDesk>, source: string, timeoutMs = 20_000) {
  const session = createCodeSurfaceSession({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner, capabilities: desk.capabilities })
  const outcome = await session.submit({ program: { source }, granted: Granted, timeoutMs })
  if (!outcome.checked) {
    const why = 'needsModules' in outcome ? `要先补模块 ${outcome.needsModules.join(', ')}` : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过 typecheck：${why}`)
  }
  return outcome.result
}
