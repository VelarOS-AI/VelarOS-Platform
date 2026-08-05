import { z } from 'zod'

import { renderParameterDescription as parameterDescription } from '@velaros-ai/agent/tool-contract'
import { isEmpty, isNumber, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { MemoryReadCapability, MemoryWriteCapability } from '../../Capabilities'
import type { MemoryEvidenceCategory, MemoryRecallItem } from '../../memory-tree'
import {
  GLOBAL_MEMORY_SCOPE,
  isMemoryVisibleInScope,
  scopeTypeForScopeId,
} from '../../MemoryScope'
import { defineMemoryTool, type MemoryToolContext } from '../../Types'

const memoryCategorySchema = z.enum([
  'conversation',
  'fact',
  'preference',
  'feedback',
  'procedure',
  'project',
  'task',
  'goal',
  'interest',
  'entity',
  'artifact',
  // 旧调用兼容只存在于工具输入边界，进入内核前立即归一化。
  'session',
  'user',
  'reference',
])

type MemoryToolCategory = z.infer<typeof memoryCategorySchema>

export interface SaveMemoryInput extends Record<string, unknown> {
  kind: MemoryToolCategory
  title: string
  content: string
  summary?: string
  source?: string
  tags?: string[]
  workspaceRoot?: string
  taskKey?: string
  privacyClass?: 'standard' | 'personal' | 'sensitive'
}

export interface SearchMemoriesInput extends Record<string, unknown> {
  query?: string
  mode?: 'search' | 'browse' | 'profile'
  limit?: number
  workspaceRoot?: string
  deep?: boolean
  categories?: MemoryToolCategory[]
}

export interface GetMemoryInput extends Record<string, unknown> {
  id: string
}

export interface ForgetMemoryInput extends Record<string, unknown> {
  id: string
  reason?: string
}

function normalizeCategory(category: MemoryToolCategory): MemoryEvidenceCategory {
  if (category === 'session') return 'conversation'
  if (category === 'user') return 'preference'
  if (category === 'reference') return 'artifact'
  return category
}

function inferWorkspaceRoot(input: SaveMemoryInput | SearchMemoriesInput, ctx: MemoryToolContext): string {
  const explicit = input.workspaceRoot?.trim()
  if (explicit) return explicit
  const scope = ctx.memoryScope?.trim() ?? ''
  return scope.startsWith('project:') ? scope.slice('project:'.length) : ''
}

function compactRecall(item: MemoryRecallItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    conceptType: item.conceptType,
    predicate: item.predicate,
    scopeType: item.scopeType,
    scopeId: item.scopeId,
    confidence: item.confidence,
    activation: item.activation,
    retrievalReason: item.retrievalReason,
    sources: item.evidenceIds,
    // 树路径只有树档有；文件档如实返回空数组，投影成缺席而不是一串空节点。
    ...(!isEmpty(item.path)
      ? { path: item.path.map((node) => ({ type: node.nodeType, title: node.title })) }
      : {}),
  }
}

// @arch-guard:suspend code-style/require-chinese-comments 理由：本块为中文说明，反引号内技术标识符密度触发启发式误报。
/**
 * 跨作用域读门 —— **全仓唯一一处**。
 *
 * 召回本身已按当前空间收敛（`memory:search` 传 scopeId）；`memory:get` 收的是模型手里的一个
 * id，没有这道门就等于「拿到任何 id 都能跨项目/跨站点读全文」。global 作用域的记忆按设计
 * 处处可读，`global` 记忆管理面（memoryScope = global）则代表「全部」，两者都放行。
 *
 * 判据本身住 `isMemoryVisibleInScope`（两轴单源），这里只把工具面的入参喂进去：读门与后端
 * 过滤必须是同一条真值表，否则「search 看不见但 get 读得到」就是一个可利用的越界口。
 * `memory:get` 只有会话身份轴（模型给的是 id，不是根），因此不传 workspaceRoot。
 */
function isMemoryReadableInScope(
  item: MemoryRecallItem,
  memoryScope: LooseOptional<string>,
): boolean {
  return isMemoryVisibleInScope(item, { scopeId: memoryScope })
}

const saveMemory = defineMemoryTool<SaveMemoryInput>({
  name: 'memory:save',
  role: 'memory',
  category: 'memory',
  summary: '写入一条带来源的长期记忆。',
  suitable: [
    '用户明确表达长期偏好、纠正、目标或稳定事实。',
    '任务、项目、方法或产物对未来会话仍有价值。',
  ],
  forbidden: [
    '不要保存密码、Token、Cookie、私钥或恢复码。',
    '不要把未经证据支持的推断伪装成用户事实。',
    '不要保存只对当前回合有用的临时步骤。',
  ],
  protocol: [
    '记忆按当前空间作用域落库；来源、会话与工作区随记忆一起保留。',
    '返回值里的 availability 说明这条记忆什么时候可被召回：immediate = 已可召回，'
      + 'consolidating = 由后台整理管线择时纳入。不要凭空承诺「稍后整理」。',
  ],
  usage: ['传 kind、title、content。'],
  examples: [
    {
      kind: 'preference',
      title: '回复风格',
      content: '用户偏好简洁中文回答，先给结论。',
    },
    {
      kind: 'task',
      title: '重构记忆系统',
      content: '第一版只实现后端统一记忆内核，Canvas 可视化后置。',
      workspaceRoot: '/workspace/VelarOS',
    },
  ],
  notes: [
    '同一来源重复提交按来源幂等，不会写出两条。',
    '本工具写下的内容作者是你，不是用户；真实的用户确认由聊天消息采集独立记录，'
      + '不要在这里声称「用户已确认」。',
  ],
  schema: z.object({
    kind: memoryCategorySchema.describe(
      parameterDescription({ description: '记忆类别。' })
    ),
    title: z.string().min(1).max(240).describe(
      parameterDescription({ description: '这条记忆的简短主题。' })
    ),
    content: z.string().min(1).max(24_000).describe(
      parameterDescription({ description: '要记住的内容正文。' })
    ),
    summary: z.string().max(1_000).optional().describe(
      parameterDescription({ description: '可选的人类可读摘要。' })
    ),
    source: z.string().max(240).optional().describe(
      parameterDescription({ description: '可选来源说明。' })
    ),
    tags: z.array(z.string().max(80)).max(24).optional().describe(
      parameterDescription({ description: '可选标签，只作为记忆元数据。' })
    ),
    workspaceRoot: z.string().optional().describe(
      parameterDescription({ description: '可选工作区根；默认从当前项目空间派生。' })
    ),
    taskKey: z.string().max(240).optional().describe(
      parameterDescription({ description: '可选任务稳定键。' })
    ),
    privacyClass: z.enum(['standard', 'personal', 'sensitive']).optional().describe(
      parameterDescription({ description: '可选隐私级；秘密信息无论级别都禁止写入。' })
    ),
  }),
  permissions: ['memory:write'],
  capabilities: MemoryWriteCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const workspaceRoot = inferWorkspaceRoot(input, ctx)
    const memoryScope = ctx.memoryScope?.trim()
    const backend = ctx.memory.describeBackend()
    const result = await ctx.memory.captureEvidence({
      // 工具内容的作者是模型，不是用户：信任级封顶在 agent_derived，绝不由模型自报的
      // 「用户已确认」铸造 user_stated/user_correction。真实用户确认经聊天消息采集独立进入
      // user_stated 证据；放行自报会给 prompt injection 一条伪造「用户已确认」的提权通道。
      // 2026-08-05：连同那个从没有读者的 userConfirmed 参数一起删掉——留在模型面上只会让
      // 每次调用多推理一个参数、并诱使模型在回答里承诺一件工具没做的事。
      sourceType: 'agent_tool',
      trustLevel: 'agent_derived',
      sessionId: ctx.sessionId,
      workspaceRoot,
      scopeType: memoryScope ? scopeTypeForScopeId(memoryScope) : undefined,
      scopeId: memoryScope,
      title: input.title,
      content: input.content,
      category: normalizeCategory(input.kind),
      privacyClass: input.privacyClass ?? (['preference', 'feedback', 'user'].includes(input.kind) ? 'personal' : 'standard'),
      metadata: {
        summary: input.summary ?? '',
        source: input.source ?? 'memory tool',
        tags: input.tags ?? [],
        taskKey: input.taskKey ?? '',
        sessionLineage: toNullable(ctx.sessionLineage),
      },
    })
    // 有整理管线的后端（树档）写入即入队、由 Dream 择时纳入；没有的后端写入即最终态。
    // 对模型只说这一件能兑现的事，treeVersion 这类某一档的 schema 只在该档在跑时才回。
    const consolidating = backend.verbs.includes('dream')
    const treeVersion = consolidating ? (await ctx.memory.getDiagnostics()).treeVersion : undefined
    return {
      accepted: true,
      inserted: result.inserted,
      memoryId: result.evidence.id,
      availability: consolidating ? 'consolidating' : 'immediate',
      message: consolidating
        ? '已记下；由后台整理管线择时纳入长期结论。'
        : '已记下，现在就能被召回。',
      // 条件展开而不是 `optionalWhen`：后者在不满足时回 undefined，键**仍然在**，于是
      // 「没有整理管线的后端不回 treeVersion」这句契约在 `in` 判定下是假的。
      // @arch-guard:suspend code-style/forbid-single-property-conditional-spread 理由：契约测试断言不支持档「'treeVersion' in result === false」（键完全缺席），optionalWhen 会留下 undefined 键。
      ...(isNumber(treeVersion) ? { treeVersion } : {}),
    }
  },
})

const searchMemories = defineMemoryTool<SearchMemoriesInput>({
  name: 'memory:search',
  role: 'memory',
  category: 'memory',
  summary: '召回当前空间可见的长期记忆。',
  suitable: ['回答依赖用户历史、项目连续性、任务演化、偏好或既有结论。'],
  forbidden: ['不要把召回结果当成无来源的绝对事实；注意 confidence 与 sources。'],
  protocol: [
    '召回按当前空间作用域收敛，外加全局记忆；不跨项目/跨站点翻找。',
    '普通召回只返回在用的记忆；deep=true 才把已归档的一并翻出来。',
  ],
  usage: ['search 模式传 query；browse/profile 可以省略 query。'],
  notes: ['需要核对某条的全文与来源时继续调用 memory:get。'],
  examples: [
    { query: '记忆系统重构', limit: 8 },
    { mode: 'profile', limit: 12 },
    { query: '之前暂停的任务', deep: true },
  ],
  schema: z
    .object({
      query: z.string().max(500).optional(),
      mode: z.enum(['search', 'browse', 'profile']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      workspaceRoot: z.string().optional(),
      deep: z.boolean().optional(),
      categories: z.array(memoryCategorySchema).optional(),
    })
    .superRefine((input, context) => {
      if ((input.mode ?? 'search') === 'search' && !input.query?.trim()) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['query'],
          message: 'search 模式必须提供 query。',
        })
      }
    }),
  permissions: ['memory:read'],
  capabilities: MemoryReadCapability,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const mode = input.mode ?? 'search'
    const workspaceRoot = inferWorkspaceRoot(input, ctx)
    const query = mode === 'profile' ? '' : input.query?.trim() ?? ''
    const categories =
      mode === 'profile'
        ? (['preference', 'feedback', 'interest'] as MemoryEvidenceCategory[])
        : input.categories?.map(normalizeCategory)
    // 按当前空间作用域收敛召回：browser/system 空间若不传 scopeId，recall 的 effectiveScope
    // 为空 = 无作用域过滤，会翻出所有项目/站点的 claim。global（记忆管理面）才代表「全部」。
    const memoryScope = ctx.memoryScope?.trim()
    const scopeId = memoryScope && memoryScope !== GLOBAL_MEMORY_SCOPE ? memoryScope : undefined
    const memories = await ctx.memory.recall(query, {
      limit: input.limit ?? (mode === 'browse' ? 20 : 10),
      workspaceRoot,
      scopeId,
      categories,
      includeDormant: input.deep,
      deep: input.deep,
    })
    return {
      mode,
      query,
      count: memories.length,
      memories: memories.map(compactRecall),
    }
  },
})

const getMemory = defineMemoryTool<GetMemoryInput>({
  name: 'memory:get',
  role: 'memory',
  category: 'memory',
  summary: '按 id 读取一条记忆的全文与来源。',
  suitable: ['memory:search 返回候选后，需要检查完整内容和来源。'],
  forbidden: ['不要用它搜索未知记忆。'],
  usage: ['传 memory:search 返回的 id。'],
  notes: ['只能读当前空间可见的记忆（本空间 + 全局）；别的空间的 id 一律当作不存在。'],
  examples: [{ id: 'project:/repo::entries/回复风格.md' }],
  schema: z.object({ id: z.string().min(1) }),
  permissions: ['memory:read'],
  capabilities: MemoryReadCapability,
  isConcurrencySafe: () => true,
  execute: async ({ id }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const memory = await ctx.memory.getMemory(id)
    // 越界与不存在回同一个 NOT_FOUND：分开回等于把「这条存在但不属于你」当成信息泄漏出去。
    if (!memory || !isMemoryReadableInScope(memory, ctx.memoryScope)) {
      throw new AppError('NOT_FOUND', `记忆不存在：${id}`)
    }
    return { memory }
  },
})

const forgetMemory = defineMemoryTool<ForgetMemoryInput>({
  name: 'memory:archive',
  role: 'memory',
  category: 'memory',
  summary: '归档一条记忆，让它退出日常召回。',
  suitable: ['用户明确表示某条记忆过时、暂时不希望它继续影响日常回答。'],
  forbidden: ['不要把归档描述成删除——内容一个字节都还在。'],
  usage: ['传 memory:search 返回的 id；reason 只写入本次工具结果，不另建秘密日志。'],
  notes: [
    '归档不是删除：内容仍在，deep=true 的深层召回仍能翻到。',
    '用户要求「彻底删掉」时如实说明当前只能归档，别承诺物理删除。',
  ],
  examples: [{ id: 'project:/repo::entries/回复风格.md', reason: '该偏好只适用于旧项目' }],
  schema: z.object({
    id: z.string().min(1),
    reason: z.string().max(500).optional(),
  }),
  permissions: ['memory:write'],
  capabilities: MemoryWriteCapability,
  isConcurrencySafe: () => false,
  execute: async ({ id, reason }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const result = await ctx.memory.archiveMemory(id)
    return {
      archived: true,
      physicalDelete: false,
      reason: toNullable(reason),
      ...result,
      message: '已归档：这条记忆退出日常召回，内容仍在，深层召回仍可翻到。',
    }
  },
})

const memoryTools = {
  'memory:save': saveMemory,
  'memory:search': searchMemories,
  'memory:get': getMemory,
  'memory:archive': forgetMemory,
}

export { memoryTools }
