import { z } from 'zod'

import { first,toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { MemoryReadCapability, MemoryWriteCapability } from '../../Capabilities'
import type { MemoryEvidenceCategory, MemoryRecallItem } from '../../memory-tree'
import { GLOBAL_MEMORY_SCOPE, scopeTypeForScopeId } from '../../MemoryScope'
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
  userConfirmed?: boolean
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
    snapshotVersion: item.snapshotVersion,
    retrievalReason: item.retrievalReason,
    path: item.path.map((node) => ({ type: node.nodeType, title: node.title })),
    evidenceIds: item.evidenceIds,
  }
}

const saveMemory = defineMemoryTool<SaveMemoryInput>({
  name: 'save_memory',
  role: 'memory',
  category: 'memory',
  summary: '把一条可追溯证据交给记忆树，而不是直接改写长期结论。',
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
    '工具只提交 Evidence；Concept、Episode、Claim、Relation 与树版本由 MemoryDream 统一生成。',
    '来源、会话、工作区和认识状态会被保留，禁止绕过证据层直接写结论。',
  ],
  usage: ['传 kind、title、content；用户刚刚明确确认时设置 userConfirmed=true。'],
  examples: [
    {
      kind: 'preference',
      title: '回复风格',
      content: '用户偏好简洁中文回答，先给结论。',
      userConfirmed: true,
    },
    {
      kind: 'task',
      title: '重构记忆系统',
      content: '第一版只实现后端统一记忆内核，Canvas 可视化后置。',
      workspaceRoot: '/workspace/VelarOS',
    },
  ],
  notes: ['同一来源重复提交会按 provenance 幂等；重复主题由 MemoryDream 归并。'],
  schema: z.object({
    kind: memoryCategorySchema.describe(
      parameterDescription({ description: '证据类别。' })
    ),
    title: z.string().min(1).max(240).describe(
      parameterDescription({ description: '这条证据的简短主题。' })
    ),
    content: z.string().min(1).max(24_000).describe(
      parameterDescription({ description: '需要进入记忆生长管线的证据内容。' })
    ),
    summary: z.string().max(1_000).optional().describe(
      parameterDescription({ description: '可选的人类可读摘要。' })
    ),
    source: z.string().max(240).optional().describe(
      parameterDescription({ description: '可选来源说明。' })
    ),
    tags: z.array(z.string().max(80)).max(24).optional().describe(
      parameterDescription({ description: '可选标签，只作为证据元数据。' })
    ),
    workspaceRoot: z.string().optional().describe(
      parameterDescription({ description: '可选工作区根；默认从当前项目空间派生。' })
    ),
    taskKey: z.string().max(240).optional().describe(
      parameterDescription({ description: '可选任务稳定键。' })
    ),
    userConfirmed: z.boolean().optional().describe(
      parameterDescription({ description: '内容是否由用户本轮明确陈述或确认。' })
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
    const result = await ctx.memory.captureEvidence({
      // 工具内容的作者是模型，不是用户：信任级封顶在 agent_derived，绝不由模型自报的
      // userConfirmed 铸造 user_stated/user_correction。真实用户确认经聊天消息采集独立进入
      // user_stated 证据；此处放行自报会给 prompt injection 一条伪造「用户已确认」的提权通道。
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
        // 模型自报的「用户确认」仅作提示保留，不参与信任级铸造。
        agentAssertedUserConfirmation: input.userConfirmed ?? false,
        sessionLineage: toNullable(ctx.sessionLineage),
      },
    })
    const diagnostics = await ctx.memory.getDiagnostics()
    return {
      accepted: true,
      inserted: result.inserted,
      evidenceId: result.evidence.id,
      ingestSequence: result.evidence.ingestSequence,
      treeVersion: diagnostics.treeVersion,
      message: '证据已进入统一记忆生长管线；长期结论由 MemoryDream 整理后生成。',
    }
  },
})

const searchMemories = defineMemoryTool<SearchMemoriesInput>({
  name: 'search_memories',
  role: 'memory',
  category: 'memory',
  summary: '沿当前记忆树路径召回带来源的 Claim。',
  suitable: ['回答依赖用户历史、项目连续性、任务演化、偏好或既有结论。'],
  forbidden: ['不要把召回结果当成无来源的绝对事实；注意 confidence 与 evidenceIds。'],
  protocol: [
    '返回 Claim、Concept 与当前树路径。',
    '普通召回只返回 active 记忆；deep=true 才包含 dormant 记忆。',
  ],
  usage: ['search 模式传 query；browse/profile 可以省略 query。'],
  notes: ['结果绑定当前树版本；需要核对来源时继续调用 get_memory。'],
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
      snapshotVersion: first(memories)?.snapshotVersion ?? 0,
      count: memories.length,
      memories: memories.map(compactRecall),
    }
  },
})

const getMemory = defineMemoryTool<GetMemoryInput>({
  name: 'get_memory',
  role: 'memory',
  category: 'memory',
  summary: '按 Claim id 读取记忆结论、树路径和 Evidence 来源。',
  suitable: ['search_memories 返回候选后，需要检查完整值和 provenance。'],
  forbidden: ['不要用它搜索未知记忆。'],
  usage: ['传 search_memories 返回的 id。'],
  notes: ['id 是 Claim id。'],
  examples: [{ id: 'claim_abcd' }],
  schema: z.object({ id: z.string().min(1) }),
  permissions: ['memory:read'],
  capabilities: MemoryReadCapability,
  isConcurrencySafe: () => true,
  execute: async ({ id }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const memory = await ctx.memory.getClaim(id)
    if (!memory) throw new AppError('NOT_FOUND', `记忆主张不存在：${id}`)
    return { memory }
  },
})

const forgetMemory = defineMemoryTool<ForgetMemoryInput>({
  name: 'archive_memory',
  role: 'memory',
  category: 'memory',
  summary: '让一条 Claim 沉睡并退出普通召回，保留 Evidence 供深层回忆。',
  suitable: ['用户明确表示某个结论过时、暂时不希望它继续影响日常回答。'],
  forbidden: ['不要把自然遗忘描述为物理删除。'],
  usage: ['传 Claim id；reason 只写入本次工具结果，不另建秘密日志。'],
  notes: ['这是权重和生命周期变化，不执行物理删除。'],
  examples: [{ id: 'claim_abcd', reason: '该偏好只适用于旧项目' }],
  schema: z.object({
    id: z.string().min(1),
    reason: z.string().max(500).optional(),
  }),
  permissions: ['memory:write'],
  capabilities: MemoryWriteCapability,
  isConcurrencySafe: () => false,
  execute: async ({ id, reason }, ctx) => {
    ctx.abortSignal.throwIfAborted()
    const result = await ctx.memory.forgetClaim(id)
    return {
      forgotten: true,
      physicalDelete: false,
      reason: toNullable(reason),
      ...result,
      message: '该 Claim 已进入沉睡并退出普通召回；Evidence 仍可在深层回忆中被重新发现。',
    }
  },
})

const memoryTools = {
  save_memory: saveMemory,
  search_memories: searchMemories,
  get_memory: getMemory,
  archive_memory: forgetMemory,
}

export { memoryTools }
