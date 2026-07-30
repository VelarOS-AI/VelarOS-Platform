/**
 * Workspace kernel tools。
 *
 * 这里把 @velaros-ai/workspace 内核能力包装成 VelaTool，替代旧的 CodingEditTools /
 * CodingAdvancedEditTools / FuzzyPatchTools / CodeSymbolTools，统一走内核事务模型。
 *
 * 内核事务编辑流程：
 *   1. 准备编辑 —— 暂存操作、生成 diff，不写盘
 *   2. 校验 ——（可选）对事务暂存内容运行校验器
 *   3. 应用编辑 —— 通过 revision 与锁检查后写入
 *   4. 一步提交 —— 准备、校验，通过后应用
 *   5. 回滚 —— 撤销已应用的事务
 *
 * 本模块面向模型的工具描述和 schema `.describe()` 文案统一使用中文。
 */

import { isArray, isEmpty,isNonBlankString, optionalWhen, toOptional } from '@velaros-ai/core'
import { asRecord } from '@velaros-ai/core/utils/unknownJsonRecord'

import { executeCommitEditWithGating } from './commitGating'
import {
  applyWorkspaceToolDescriptionDetail,
  buildWorkspaceFileTree,
  combineWorkspaceDiffResults,
  resolveWorkspaceSearchExcludes,
  type WorkspaceCommitEditInput,
  WorkspaceCommitEditSchema,
  WorkspaceReadCapability,
  WorkspaceToolDescriptionDetail,
  WorkspaceTransactionCommitCapability,
  WorkspaceTransactionInspectCapability,
  WorkspaceTransactionRollbackCapability,
  wsTool,
} from './KernelToolShared'
import { codingToolHelper } from './Tool'
import { attachSystemToolSuggestion } from './ToolRequirements'
import {
  workspaceAgentDiffSchema,
  workspaceAgentListFilesSchema,
  workspaceAgentReadSchema,
  workspaceAgentRollbackSchema,
  workspaceAgentSearchSchema,
  workspaceAgentStatSchema,
  workspaceAgentSymbolsSchema,
} from './workspaceAgentExtensions'
import { defineWorkspaceAgentTool } from './workspaceAgentToolAdapter'
import { executeAgentWorkspaceRead } from './WorkspaceCapabilityPort'
import {
  buildRedundantWorkspaceReadNotice,
  checkAndRecordWorkspaceRead,
} from './WorkspaceReadLedger'
import { defineWorkspaceVelaTool, type WorkspaceToolRunContext } from './workspaceToolMiddleware'

// ---------------------------------------------------------------------------
// Read / inspect tools
// ---------------------------------------------------------------------------

/**
 * 对 ws_read 结果做重复回读去重：同一 run 内重复读同一文件同一版本的同一段内容时，
 * 抽掉重发的 content、换成一句"别再重复回读"的硬提示（保留 snapshot 元信息）。
 * 读到新版本(编辑后)或新范围(先读头现读尾)照常放行——只拦纯重复。
 */
function dedupeRepeatedWorkspaceReads(
  result: unknown,
  sessionKey: object,
  requestedRange?: { startLine?: number; endLine?: number }
): unknown {
  const record = asRecord(result)
  const files = record?.files
  if (!record || !isArray(files)) return result

  const dedupedFiles = files.map((file) => {
    const fileRecord = asRecord(file)
    const snapshot = asRecord(fileRecord?.snapshot)
    const path = snapshot?.path
    const revision = snapshot?.revision
    // 只对真的返回了正文的读做去重；不存在/目录/二进制/无 content 的直接放过。
    if (
      !fileRecord ||
      !isNonBlankString(path) ||
      !isNonBlankString(revision) ||
      !('content' in fileRecord)
    ) return file
    const servedRange = (asRecord(fileRecord.range) ?? requestedRange) as
      | { startLine?: number; endLine?: number }
      | undefined
    const decision = checkAndRecordWorkspaceRead(sessionKey, path, revision, servedRange)
    if (!decision.redundant) return file

    const { content: _dropped, ...rest } = fileRecord
    return {
      ...rest,
      redundantRead: true,
      notice: buildRedundantWorkspaceReadNotice(path, revision, decision.priorReads),
    }
  })

  return { ...record, files: dedupedFiles }
}

/** 统一的工作区读取工具：path 支持单个文件或文件数组。 */
const workspaceRead = defineWorkspaceAgentTool(
  wsTool.read,
  {
    descriptionPatch: (spec) => ({
      notes: [
        '工作区文件正文读取入口；系统路径或工作区外文本使用 read。',
        ...spec.descriptionSpec.notes,
      ],
    }),
    schema: workspaceAgentReadSchema,
    permissions: ['fs:read'],
    capabilities: WorkspaceReadCapability,
    isConcurrencySafe: () => true,
    middleware: {
      action: wsTool.read,
      directory: true,
      revisionMismatchHints: true,
      normalizeErrors: { extra: (input) => ({ path: toOptional(input.path) }) },
    },
    execute: async ({ input, ctx, kernel }) => {
      const result = await executeAgentWorkspaceRead(
        kernel,
        {
          path: input.path,
          range: input.range,
          maxBytes: input.maxBytes,
          maxChars: input.maxChars,
          allowUnbounded: input.allowUnbounded,
          baseRevisions: input.baseRevisions,
          trust: input.trust,
        },
        { rootPath: ctx.workspace.getRootPath() }
      )
      return dedupeRepeatedWorkspaceReads(result, ctx.codingSession, input.range)
    },
  }
)

/** ws_file_stat */
const workspaceFileStat = defineWorkspaceAgentTool(
  wsTool.stat,
  {
    schema: workspaceAgentStatSchema,
    permissions: ['fs:read'],
    capabilities: WorkspaceReadCapability,
    isConcurrencySafe: () => true,
    middleware: {
      action: wsTool.stat,
      directory: true,
      normalizeErrors: { extra: (input) => ({ path: input.path }) },
    },
    execute: async ({ input, kernel }) => kernel.stat({ path: input.path }),
  }
)

/** ws_search — 唯一正文搜索工具。 */
const workspaceSearch = defineWorkspaceAgentTool(
  wsTool.search,
  {
    descriptionPatch: (spec) => ({
      notes: [
        '工作区正文搜索入口；系统路径文本搜索使用 grep；按文件名、目录名或 glob 发现路径时使用路径发现工具。',
        ...spec.descriptionSpec.notes,
      ],
    }),
    schema: workspaceAgentSearchSchema,
    permissions: ['fs:read'],
    capabilities: WorkspaceReadCapability,
    isConcurrencySafe: () => true,
    middleware: {
      action: wsTool.search,
      directory: true,
      discoveryPreflight: (input) => input,
    },
    execute: async ({ input, ctx, kernel }) => {
      const extGlobs = (input.extensions ?? []).map((ext) => `**/*.${ext.replace(/^\./, '')}`)
      const include = [...(input.glob ? [input.glob] : []), ...extGlobs]
      const exclude = resolveWorkspaceSearchExcludes(input.excludePresets, input.exclude)
      const result = await kernel.search({
        query: input.query,
        regex: input.regex,
        maxResults: input.maxResults,
        include: optionalWhen(!isEmpty(include), include),
        exclude,
        excludeGitignored: input.excludeGitignored,
        root: input.path,
        caseSensitive: input.caseSensitive,
      })
      const decorated = attachSystemToolSuggestion(result, ctx)
      return decorated.truncated
        ? {
            ...decorated,
            hint: '结果已截断（触达条数上限）；请收窄 glob/path/extensions 或增大 maxResults，优先缩小范围再分页手工搜。',
          }
        : decorated
    },
  }
)

/** ws_list_files — list directory entries or discover paths by name/glob/extension. */
const workspaceListFiles = defineWorkspaceAgentTool(wsTool.listFiles, {
    descriptionPatch: {
      usage: [
        '用 path、recursive、maxDepth、limit 和 include/exclude 控制范围；limit 是 Agent 工具层必填返回上限；深度字段是 maxDepth 不是 depth。',
        '深度字段只能写 maxDepth，不是 depth；使用 query、glob 或 extensions 时必须同时传 maxDepth。',
      ],
      examples: [
        { path: 'src', include: ['**/*.test.ts'], recursive: true, maxDepth: 4, limit: 50 },
      ],
      notes: ['按文件名、目录名或 glob 发现路径时使用路径发现工具，而不是正文搜索。'],
    },
    schema: workspaceAgentListFilesSchema,
    permissions: ['fs:read'],
    capabilities: WorkspaceReadCapability,
    isConcurrencySafe: () => true,
    middleware: {
      action: wsTool.listFiles,
      directory: true,
      discoveryPreflight: (input) => ({
        ...input,
        recursive:
          input.recursive ||
          !!(input.query?.trim() || input.glob?.trim() || input.extensions?.length),
      }),
    },
    execute: async ({ input, ctx }) => {
      const hasFilters = !!(input.query?.trim() || input.glob?.trim() || input.extensions?.length)
      const exclude = resolveWorkspaceSearchExcludes(input.excludePresets, input.exclude)
      const view = input.view ?? 'flat'

      if (hasFilters) {
        // 显式列字段而不是「rest 剩余展开 + 一串 void 消变量」：这是工具入参 → 端口契约的
        // 跨边界映射，按 §3.7 应当可审计；rest 形态还会把将来新增的 schema 字段悄悄漏给端口。
        // limit ×8 是发现模式的过采样窗口，端口内过滤后再由下面的 limitResults 裁到 limit。
        const entries = await ctx.workspace.findFiles({
          path: input.path,
          query: input.query,
          glob: input.glob,
          extensions: input.extensions,
          include: input.include,
          excludeGitignored: input.excludeGitignored,
          entryTypes: input.entryTypes,
          pathMatchMode: input.pathMatchMode,
          exclude,
          limit: input.limit * 8,
          maxDepth: input.maxDepth ?? 12,
        })
        const mapped = entries.map((entry) => ({ path: entry.path, type: entry.type }))
        const { results, truncated } = codingToolHelper.limitResults(mapped, input.limit)
        return {
          rootPath: ctx.workspace.getRootPath(),
          mode: 'find' as const,
          view,
          count: results.length,
          truncated,
          ...(view === 'tree'
            ? { tree: buildWorkspaceFileTree(results, input.path) }
            : { entries: results }),
        }
      }

      const entriesWithSentinel = await ctx.workspace.listFiles({
        path: input.path,
        include: input.include,
        exclude,
        excludeGitignored: input.excludeGitignored,
        recursive: input.recursive,
        maxDepth: input.maxDepth,
        limit: input.limit + 1,
      })
      const truncated = entriesWithSentinel.length > input.limit
      const slice = truncated ? entriesWithSentinel.slice(0, input.limit) : entriesWithSentinel
      return {
        rootPath: ctx.workspace.getRootPath(),
        mode: 'list' as const,
        view,
        count: slice.length,
        truncated,
        ...(view === 'tree'
          ? { tree: buildWorkspaceFileTree(slice, input.path) }
          : { entries: slice.map((entry) => ({ path: entry.path, type: entry.type })) }),
      }
    },
  })

/** ws_symbols */
const workspaceSymbols = defineWorkspaceAgentTool(
  wsTool.symbols,
  {
    schema: workspaceAgentSymbolsSchema,
    permissions: ['fs:read'],
    capabilities: WorkspaceReadCapability,
    isConcurrencySafe: () => true,
    middleware: {
      action: wsTool.symbols,
      normalizeErrors: { extra: (input) => ({ path: input.path }) },
    },
    execute: async ({ input, kernel }) => kernel.listSymbols(input.path),
  }
)

// ws_prepare_edit / ws_amend_edit / ws_apply_edit（两步预备→提交仪式）已移除：
// 它们的真实价值（准备事务、原子多文件改）已被常驻的 ws_edit 一步聚合入口完整覆盖，
// 模型无需再手动走多轮事务协议。底层 kernel 方法（kernel.prepareEdit/amendEdit/applyEdit）
// 与门控机器（executeCommitEditWithGating / wsTool.commitEdit 名字常量）保留，供 ws_edit 内部复用。

const workspaceEditAggregate = defineWorkspaceVelaTool<WorkspaceCommitEditInput>({
  name: wsTool.edit,
  category: 'workspace-edit',
  role: 'edit',
  summary: '一步完成工作区编辑：准备事务、校验并按策略应用。',
  suitable: [
    '需要直接完成常规工作区文本编辑，不需要先把事务 diff 暂停给模型二次确认。',
    '需要减少准备事务再提交事务的多轮协议开销。',
  ],
  forbidden: [
    `不要用它执行 shell 命令；工作区命令使用 ${wsTool.runCommand}。`,
  ],
  protocol: [
    '一步内完成事务准备、授权、校验和 apply gating；写文件用它即可。',
    '默认 autoApply=true、autoFix=true、split=auto；需要更保守时显式传对应字段。',
    '高风险或大 diff 仍可能返回 preflight/split 结果，按返回提示继续处理。',
  ],
  usage: [
    '传 operations；可选 checks、autoApply、autoFix、split、cwd、confirmRisk。',
    `应用后想撤销改动用 ${wsTool.rollback}（传返回的 transactionId）。`,
  ],
  examples: [
    {
      operations: [
        {
          operation: {
            type: 'create_file',
            path: 'package.json',
            content: '{\n  "name": "demo"\n}\n',
          },
        },
      ],
      autoApply: true,
    },
    {
      operations: [
        {
          operation: {
            type: 'replace_text',
            path: 'src/app.ts',
            oldText: 'return false',
            newText: 'return true',
          },
        },
      ],
      autoApply: true,
    },
    {
      // 往文件末尾追加（不要为了追加而整文件重写）。
      operations: [
        {
          operation: {
            type: 'append_text',
            path: 'src/index.js',
            text: '\nmodule.exports = { greet };\n',
          },
        },
      ],
      autoApply: true,
    },
    {
      // 在某个锚点前/后插入（position: "before" | "after"）。
      operations: [
        {
          operation: {
            type: 'insert_text_at_anchor',
            path: 'src/routes.ts',
            anchorText: '// routes',
            position: 'after',
            text: "\nrouter.get('/health', health)",
          },
        },
      ],
      autoApply: true,
    },
    {
      // 删除文件 / 重命名（移动）文件。
      operations: [
        { operation: { type: 'delete_file', path: 'src/old.ts' } },
        { operation: { type: 'rename_file', from: 'src/a.ts', to: 'src/b.ts' } },
      ],
      autoApply: true,
    },
    {
      // 一次调用里多个操作，按顺序应用（同一事务）。
      operations: [
        {
          operation: {
            type: 'create_file',
            path: 'src/util.js',
            content: 'export const noop = () => {}\n',
          },
        },
        {
          operation: {
            type: 'append_text',
            path: 'src/index.js',
            text: "\nexport * from './util.js'\n",
          },
        },
      ],
      autoApply: true,
    },
  ],
  notes: [
    '这是给模型的单步聚合入口；底层事务协议仍由 workspace kernel 执行。',
    '每个编辑都是 { operation: { type, ... } } 形状——注意 operation 这层包裹，不要在顶层直接传 path/content。',
    '按需选 operation 类型，别用整文件重写替代局部改：新建=create_file(path+content)、局部改=replace_text(path+oldText+newText)、追加=append_text(path+text)、锚点插入=insert_text_at_anchor(path+anchorText+position+text)、开头插入=prepend_text、删片段=delete_text、删文件=delete_file(path)、改名/移动=rename_file(from+to)、按符号替换=replace_symbol。',
    '需要一次原子地改多个文件时，把多个 operation（可跨不同 path）放进同一次 ws_edit 的 operations 数组即可——它们在同一个事务里按顺序应用、一起成功或一起失败，不需要任何单独的批处理工具。',
  ],
  schema: WorkspaceCommitEditSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: WorkspaceTransactionCommitCapability,
  isConcurrencySafe: () => false,
  middleware: {
    action: wsTool.edit,
    mutation: { operation: 'single-step workspace edit' },
    editPreflight: (input) => ({
      confirmRisk: input.confirmRisk,
      operations: input.operations,
    }),
    directory: true,
  },
  execute: async ({ input, ctx, kernel }: WorkspaceToolRunContext<WorkspaceCommitEditInput>) => {
    const shouldAutoApply = input.autoApply ?? true
    const shouldAutoFix = input.autoFix ?? true
    const splitMode = input.split ?? 'auto'
    return executeCommitEditWithGating({
      kernel,
      ctx,
      input,
      shouldAutoApply,
      shouldAutoFix,
      splitMode,
    })
  },
})

// ws_validate（对暂存事务跑校验器）已移除：分步事务入口取消后它无独立使用价值；
// kernel.validate 方法保留供内部/CLI 使用。

/**
 * ws_rollback
 *
 * 回滚已应用事务。语义上是“撤销”操作而非新增写入，因此当前实现选择不再调用
 * prepareWorkspaceMutation 弹出确认——但仍依赖 kernel 内部的事务状态校验，
 * 只有 status='applied' 的事务才能回滚成功。
 */
const workspaceRollback = defineWorkspaceAgentTool(wsTool.rollback, {
    schema: workspaceAgentRollbackSchema,
    permissions: ['fs:read', 'fs:write'],
    capabilities: WorkspaceTransactionRollbackCapability,
    isConcurrencySafe: () => false,
    middleware: {
      action: wsTool.rollback,
      normalizeErrors: { extra: (input) => ({ transactionId: input.transactionId }) },
    },
    execute: async ({ input, kernel }) => kernel.rollback(input),
  })

/** ws_diff */
const workspaceDiff = defineWorkspaceAgentTool(
  wsTool.diff,
  {
    schema: workspaceAgentDiffSchema,
    permissions: ['fs:read'],
    capabilities: WorkspaceTransactionInspectCapability,
    isConcurrencySafe: () => true,
    middleware: {
      action: wsTool.diff,
      normalizeErrors: {
        extra: (input) => ({ transactionId: toOptional(input.transactionId) }),
      },
    },
    execute: async ({ input, kernel }) => {
      if (input.sessionTransactionIds && !isEmpty(input.sessionTransactionIds)) {
        const results = await Promise.all(
          input.sessionTransactionIds.map((transactionId) => kernel.diff({ transactionId }))
        )
        return combineWorkspaceDiffResults(results)
      }
      return kernel.diff({ transactionId: input.transactionId })
    },
  }
)

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const rawWorkspaceKernelTools = {
  [wsTool.read]: workspaceRead,
  [wsTool.stat]: workspaceFileStat,
  [wsTool.search]: workspaceSearch,
  [wsTool.listFiles]: workspaceListFiles,
  [wsTool.symbols]: workspaceSymbols,
  [wsTool.edit]: workspaceEditAggregate,
  [wsTool.rollback]: workspaceRollback,
  [wsTool.diff]: workspaceDiff,
}

const workspaceKernelTools = applyWorkspaceToolDescriptionDetail(
  rawWorkspaceKernelTools,
  WorkspaceToolDescriptionDetail
)
export { workspaceKernelTools }
