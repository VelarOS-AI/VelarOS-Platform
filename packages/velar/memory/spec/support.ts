/**
 * 验收测试与实现测试共用的夹具：
 * - 真的文件档记忆库（纯内存文件端口，不碰磁盘）与它的空间端口——记忆域的规则在真后端上验；
 * - 一个记账的假存储口——模型面的核对与投影只看交给端口的是什么、交回的是什么；
 * - 经真的能力端口挂上 `velar:memory` 四个操作的空间，以及照生成的声明跑一段模型程序的代码面会话。
 * 放在 spec 下，因为验收测试依赖它们；实现测试也从这里取。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { CapabilityOperationContext } from '@velaros-ai/code-surface'
import { codeProgramChecker, createCapabilityPort, createCodeSurfaceSession, nodeSubprocessCodeRunner } from '@velaros-ai/code-surface'
import { AppError } from '@velaros-ai/core/error'

import type {
  MemoryBackendVerb,
  MemoryEvidenceInput,
  MemoryFilesIo,
  MemoryFilesScopeRoot,
  MemoryIdInput,
  MemoryOperationContext,
  MemoryRecallItem,
  MemoryRecallOptions,
  MemorySaveInput,
  MemorySearchInput,
  MemorySpacePort,
  MemoryStoreBackend,
} from '../index.js'
import { createMemoryFilesBackend, memoryOperations } from '../index.js'

/** 项目空间的作用域与记忆目录。 */
export const ProjectRoot: MemoryFilesScopeRoot = { scopeType: 'workspace', scopeId: 'project:/repo', directory: '/repo/.velaros/memory' }

/** 系统空间的作用域与记忆目录。 */
export const SystemRoot: MemoryFilesScopeRoot = { scopeType: 'system', scopeId: 'system', directory: '/userData/memory' }

/** 纯内存的文件端口：只经公开的注入面，不碰磁盘；snapshot 交出写下的全部文件。 */
export function memoryIo(): MemoryFilesIo & { snapshot(): Record<string, string> } {
  const files = new Map<string, string>()
  return {
    join: (...segments) => segments.join('/'),
    ensureDirectory: () => {},
    listFiles: (directory) =>
      [...files.keys()]
        .filter((path) => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/'))
        .map((path) => path.slice(directory.length + 1)),
    readTextFile: (path) => files.get(path) ?? null,
    writeTextFile: (path, content) => {
      files.set(path, content)
    },
    deleteFile: (path) => {
      files.delete(path)
    },
    snapshot: () => Object.fromEntries([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
  }
}

/** 一个跑在文件权威层上的后端，外加它的文件快照。 */
export function filesBackend(roots: readonly MemoryFilesScopeRoot[] = [SystemRoot, ProjectRoot]) {
  const io = memoryIo()
  return { io, backend: createMemoryFilesBackend({ roots, io, now: () => 1_700_000_000_000 }) }
}

/** 把一个后端接成空间端口：宿主把它的记忆后端交进来就是这几行。 */
export function storePort(backend: MemoryStoreBackend): MemorySpacePort {
  return {
    describeBackend: () => ({ id: backend.descriptor.id, verbs: backend.descriptor.verbs }),
    captureEvidence: (input) => backend.capture(input),
    recall: (query, options) => backend.recall(query, options),
    getMemory: (memoryId) => backend.getItem(memoryId),
    getDiagnostics: () => {
      throw new Error('文件档没有整理管线，不读诊断')
    },
    archiveMemory: (memoryId) => backend.archive?.(memoryId) ?? { claimId: memoryId, affectedEvidenceIds: [], treeVersion: 0 },
  }
}

/** 一条召回条目，外加记忆库才有的内部字段（行身份、概念 id、显著度、快照版本）：它们不许出现在交给模型的结果里。 */
export function recallItem(id: string, patch: Partial<MemoryRecallItem> = {}): MemoryRecallItem {
  return {
    id,
    claimId: `claim:${id}`,
    conceptId: `concept:${id}`,
    conceptType: 'user',
    predicate: 'memory',
    title: `标题 ${id}`,
    summary: `摘要 ${id}`,
    value: `内容 ${id}`,
    scopeType: 'workspace',
    scopeId: ProjectRoot.scopeId,
    confidence: 1,
    salience: 0.4,
    activation: 1,
    updatedAt: 1_760_000_000_000,
    snapshotVersion: 7,
    retrievalReason: 'text',
    evidenceIds: [id],
    sourceTypes: ['agent_tool'],
    path: [],
    ...patch,
  }
}

/**
 * 一个记账的假存储口：召回按 pages 逐次交回，known 里的条目 get 读得到；verbs 与 treeVersion 决定写入回执的口径，
 * readOnly 为真时归档一条都归不到。交给端口的每次写、召回、读、归档都记下来。
 */
export function spyStore(options: {
  pages?: MemoryRecallItem[][]
  known?: MemoryRecallItem[]
  verbs?: MemoryBackendVerb[]
  treeVersion?: number
  readOnly?: boolean
} = {}) {
  const pages = [...(options.pages ?? [])]
  const known = new Map((options.known ?? []).map((item) => [item.id, item]))
  const captured: MemoryEvidenceInput[] = []
  const recalls: Array<{ query: string; options?: MemoryRecallOptions }> = []
  const reads: string[] = []
  const archives: string[] = []
  const port: MemorySpacePort = {
    describeBackend: () => ({ id: 'spy', verbs: options.verbs ?? ['capture', 'recall', 'inspect', 'archive'] }),
    captureEvidence: (input) => {
      captured.push(input)
      return { evidence: { id: `${ProjectRoot.scopeId}::entries/${captured.length}.md` } as never, inserted: true }
    },
    recall: (query, recallOptions) => {
      recalls.push({ query, options: recallOptions })
      return pages.shift() ?? []
    },
    getMemory: (id) => {
      reads.push(id)
      return known.get(id) ?? null
    },
    getDiagnostics: () => ({ treeVersion: options.treeVersion ?? 0 }) as never,
    archiveMemory: (id) => {
      archives.push(id)
      return { claimId: id, affectedEvidenceIds: options.readOnly ? [] : [id], treeVersion: 0 }
    },
  }
  return { port, captured, recalls, reads, archives }
}

/** 一个挂着 `velar:memory` 的空间：作用域与会话绑进每次调用的上下文，经真的能力端口调四个操作。 */
export function memorySpace(memory: MemorySpacePort, scope: string = ProjectRoot.scopeId) {
  const context: MemoryOperationContext = { abortSignal: new AbortController().signal, sessionId: 'session-acceptance', memoryScope: scope, memory }
  /** 代码面宿主给每次调用装的上下文：同一个端口与作用域，取消信号跟着这次调用。 */
  const hostContext = (call: CapabilityOperationContext): MemoryOperationContext => ({ ...context, abortSignal: call.signal ?? new AbortController().signal })
  const capabilities = createCapabilityPort({
    memory: {
      save: (input, call) => memoryOperations.save(input as MemorySaveInput, hostContext(call)),
      search: (input, call) => memoryOperations.search(input as MemorySearchInput, hostContext(call)),
      get: (input, call) => memoryOperations.get(input as MemoryIdInput, hostContext(call)),
      archive: (input, call) => memoryOperations.archive(input as MemoryIdInput, hostContext(call)),
    },
  })
  /** 像模型的程序那样调一次：成功交回返回值，失败抛带 code 的错误（程序看得到的就这两样）。入参与返回值都过一遍 JSON。 */
  const call = async (operation: string, input?: unknown): Promise<any> => {
    const outcome = await capabilities.invoke({ namespace: 'memory', operation, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)) })
    if (outcome.error) throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code })
    return outcome.value === undefined ? undefined : JSON.parse(JSON.stringify(outcome.value))
  }
  return { context, capabilities, call }
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

/** 模型这一轮读到的 `velar:memory` 声明：就是提交进仓的那份生成物，程序照着它过 typecheck。 */
export const MemoryDeclarations = readFileSync(fileURLToPath(new URL('../../../../baselines/code-surface/memory.d.ts', import.meta.url)), 'utf8')

/** 这一轮授给程序的模块：只有 `memory` 一个命名空间。 */
const Granted = [{ namespace: 'memory', declarations: MemoryDeclarations }]

/** 只照生成的声明做 typecheck、不执行：交回诊断，过了就是空的。 */
export function checkModelProgram(source: string) {
  const checked = codeProgramChecker.check({ source, granted: Granted })
  return checked.ok ? [] : checked.diagnostics
}

/** 让一段真程序照生成的声明过 typecheck，再在隔离里跑完：交出程序的结果。 */
export async function runModelProgram(space: ReturnType<typeof memorySpace>, source: string, timeoutMs = 20_000) {
  const session = createCodeSurfaceSession({ checker: codeProgramChecker, runner: nodeSubprocessCodeRunner, capabilities: space.capabilities })
  const outcome = await session.submit({ program: { source }, granted: Granted, timeoutMs })
  if (!outcome.checked) {
    const why = 'needsModules' in outcome ? `要先补模块 ${outcome.needsModules.join(', ')}` : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过 typecheck：${why}`)
  }
  return outcome.result
}
