// 域：Agent 模型面工具——定义、分组与挂载都在这一个文件里。
//
// 人读代码的第一站。每个工具的说明、参数、权限、能力声明都写在它自己的定义里；execute 只写
// 简单的一两步，真正的实现交给 `impl/builtin/` 的执行类，这里一行委托过去。
// 说明与 schema 里的上限一律引 `contract/constants.ts` 的常量表，改一处模型看到的跟着变。
//
// 文件末尾是分组与内置 mod：官方的工具库、提示词段与执行模式不是特权硬编码，而是第一个
// bundled mod 消费者，与外部 mod 走同一条 validate → resolve → activate 管线；清单由既有单源
// 派生（`Object.keys(collection)` / `createBuiltInPromptSegments()` / `listExecutionModes()`），
// 不另立一份名单，所以不可能与实现漂移。
import { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'

import { AgentIdentity, AgentToolLimits, AgentToolNames } from '../contract/constants.js'
import type { ActiveDirectiveType, AgentModManifest, ToolCapabilitySchema } from '../types/agent.js'
import type {
  AgentWorkflowToolCollection,
  BuiltinAgentModOptions,
  BuiltinAgentModPackage,
  DispatchAgentInput,
  GoalConstraint,
  GoalStep,
  ReadBackgroundJobOutputInput,
  RunAgentWorkflowInput,
  UpdatePlanInput,
  VelaTool,
  WaitBackgroundJobsInput,
} from '../types/builtin.js'
import type { AgentModBindings } from '../types/mods.js'
import { readBackgroundJobOutputSchema, waitBackgroundJobsSchema } from '../utils/builtin/background-jobs'
import { toExecutionModeContribution, toPromptSegmentContribution, toToolContribution } from '../utils/builtin/builtin-mod'
import { defineVelaTool } from '../utils/builtin/define-agent-tool'
import { archiveActiveDirectives, directiveTypeSchema, listActiveDirectives, upsertActiveDirective } from '../utils/builtin/directives'
import { buildSubAgentDispatchRequest, dispatchAgentSchema } from '../utils/builtin/dispatch-schemas'
import { goalConstraintSchema, goalStatusSchema, goalStepSchema } from '../utils/builtin/goal-schemas'
import { planLifecycleSchema, planStatusSchema, planStepRefSchema } from '../utils/builtin/plans'
import {
  parseToolSpaceQueryMethodInput,
  runToolSpace,
  toolSpaceQueryMethodSchema,
  toolSpaceReadMethodSchema,
  toolSpaceReplaceMethodSchema,
  toolSpaceSchema,
} from '../utils/builtin/tool-space-run'
import { agentWorkflowSchema } from '../utils/builtin/workflow-schemas'
import { createBuiltInPromptSegments } from '../utils/guidance/catalog'
import { listExecutionModes } from '../utils/runner/execution-mode-registry'
import { createManualApprovalOptions } from '../utils/toolkit/approval'
import { renderParameterDescription as parameterDescription } from '../utils/toolkit/tool-description'
import { AgentModManifestSchemaVersion } from '../utils/wire/mods'

import type { AgentModHostAssemblerApi } from './assembly/AgentModHostAssembler'
import { AgentModHostAssembler } from './assembly/AgentModHostAssembler'
import { backgroundJobOperations } from './builtin/BackgroundJobOperations'
import { goalOperations } from './builtin/GoalOperations'
import { planOperations } from './builtin/PlanOperations'

// ── 能力声明 ────────────────────────────────────────────────────────────────
// 每个工具挂一份能力声明：读什么、写什么、能不能并发、为什么。宿主的作用域策略按它裁决。

/** Agent 自有 session 上下文读取，不触碰宿主文件或外部资源。 */
export const AgentContextReadCapability: ToolCapabilitySchema = {
  effectKind: 'read',
  readScopes: ['agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent session context read',
}

/** Active directive 等 session 上下文状态更新。 */
export const AgentContextWriteCapability: ToolCapabilitySchema = {
  effectKind: 'write',
  readScopes: ['agent-session-context'],
  writeScopes: ['agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent session context update',
}

/** 兼容事实便签写入；记录保存在会话工具结果中，可并发合并。 */
export const AgentContextSignalCapability: ToolCapabilitySchema = {
  effectKind: 'write',
  readScopes: ['agent-session-context'],
  writeScopes: ['agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent session facts record',
}

/** 当前 session 的 goal / plan 状态读取。 */
export const AgentPlanningReadCapability: ToolCapabilitySchema = {
  effectKind: 'read',
  readScopes: ['agent-session-planning'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent session planning read',
}

/** 当前 session 的 goal / plan 状态更新；并发写可能丢失进度。 */
export const AgentPlanningWriteCapability: ToolCapabilitySchema = {
  effectKind: 'write',
  readScopes: ['agent-session-planning'],
  writeScopes: ['agent-session-planning'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent session planning update',
}

/** 单次子 Agent 派发；调度器负责有界并发。 */
export const AgentDispatchCapability: ToolCapabilitySchema = {
  effectKind: 'execute',
  readScopes: ['agent-session-context', 'agent-tool-space'],
  writeScopes: ['agent-subagents', 'agent-background-jobs'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'sub-agent dispatch execution',
}

/** 多节点 Workflow 会统一编排、归约并更新一组子 Agent 执行。 */
export const AgentWorkflowCapability: ToolCapabilitySchema = {
  effectKind: 'execute',
  readScopes: ['agent-session-context', 'agent-tool-space'],
  writeScopes: ['agent-subagents', 'agent-background-jobs'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'multi-agent workflow execution',
}

/** 当前 session 后台 job 状态与输出读取。 */
export const AgentBackgroundJobReadCapability: ToolCapabilitySchema = {
  effectKind: 'read',
  readScopes: ['agent-background-jobs'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent background job read',
}

/** 中断当前 session 的后台 Agent 执行。 */
export const AgentBackgroundJobCancelCapability: ToolCapabilitySchema = {
  effectKind: 'execute',
  readScopes: ['agent-background-jobs'],
  writeScopes: ['agent-background-jobs', 'agent-subagents'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent background job cancellation',
}

/** 向用户展示确认或会话交接决策，并等待宿主交互结果。 */
export const AgentUserInteractionCapability: ToolCapabilitySchema = {
  effectKind: 'external',
  writeScopes: ['user-interaction', 'agent-session-context'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent user interaction request',
}

/** 工具页目录只读查询。 */
export const ToolingReadCapability: ToolCapabilitySchema = {
  effectKind: 'read',
  readScopes: ['agent-tool-space'],
  canReadArbitrarySource: false,
  concurrency: 'safe',
  reason: 'agent tool-space discovery',
}

/** 工具页驻留状态更新。 */
export const ToolingWriteCapability: ToolCapabilitySchema = {
  effectKind: 'write',
  readScopes: ['agent-tool-space'],
  writeScopes: ['agent-tool-space'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'agent tool-space residency update',
}

/** 向用户要一次明确确认，等待宿主交互结果。 */
export const UserConfirmationCapability: ToolCapabilitySchema = {
  effectKind: 'external',
  writeScopes: ['user-interaction'],
  canReadArbitrarySource: false,
  concurrency: 'unsafe',
  reason: 'explicit user confirmation request',
}

// ── 工具发现（tooling:map / tooling:read / tooling:replace）──────────────────

export const toolSpaceMap: VelaTool<z.input<typeof toolSpaceQueryMethodSchema>> = defineVelaTool<z.input<typeof toolSpaceQueryMethodSchema>>({
  name: AgentToolNames.toolingMap,
  role: 'control',
  category: 'agent-control',
  // 工具地图就是模型当下要读的内容：禁止 page-out 成 payload 引用，否则模型还得
  // 分页召回，白白多花轮次（见 debug：tooling:map→卸载→recall）。
  outputInline: true,
  summary: '查找当前任务需要的工具及可用状态；已在当前工具列表中提供完整参数的工具可直接调用。',
  suitable: [
    '需要按任务短语搜索工具页，或分页读取工具页状态。',
    '需要查看系统所有工具/能力的状态清单和完整工具名索引。',
    '需要知道某一类能力如何激活，而不是逐个猜工具。',
    '工具找不到或被拦截后，按工具名或任务短语查询原因与下一步。',
  ],
  forbidden: [
    '不要用它执行目标工具；它只返回工具地图和激活路径。',
    '任务已经明确要读文件、生成文档、创建表格等具体动作时，不要先拉取全局或整类地图；直接 op="find" 搜任务短语。',
  ],
  protocol: [
    '具体任务优先 op="find"：query 用用户目标短语，一次返回可换入的具体工具页。',
    '默认或 op="map"：按分类分页；page.nextCursor 非空时继续调用 tooling:map(cursor: nextCursor)。',
    'op="find"：按 query 搜索工具页；op="page"：平铺分页。读技能正文是另一个工具 tooling:read，这里没有 read 这个取值。',
    'map 下每个 category 返回完整 toolNames；详细状态页仍按 maxToolsPerCategory 展开。',
    '每个 category 头部包含 capability 页，可用 tooling:replace 一类激活。',
    '每个 tool 页包含 toolOsState 与 activation：resident 可直接调用，loadable 按 activation.method 换入，needs_setup 先处理 dependencies。',
  ],
  usage: [
    '按意图搜索时传 op="find" 和 query；只有查全局或分类清单时才省略 op。用 categoryIds/toolOsStates 缩小范围；判断下一步优先读 toolOsState。',
    'domainIds 的合法取值见返回的 filters.validDomainIds；拼错值会进入 filters.unknownDomainIds，且不会扩大成全量结果。',
  ],
  examples: [
    { op: 'find', query: 'read document' },
    { kind: 'all', toolOsStates: ['loadable'] },
    { kind: 'tool', toolOsStates: ['loadable'] },
  ],
  notes: [
    '这是首选查询入口：具体任务先精确 find；全局诊断再看结构化状态清单、依赖关系和一类激活路径。',
    '只列出当前产品作用域允许的工具；具体作用域隔离与恢复动作由注入的 CapabilityScopePolicy 声明。',
  ],
  schema: toolSpaceQueryMethodSchema,
  permissions: [],
  capabilities: ToolingReadCapability,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => runToolSpace(ctx, parseToolSpaceQueryMethodInput(input)),
})

export const toolSpaceRead: VelaTool<z.input<typeof toolSpaceReadMethodSchema>> = defineVelaTool<z.input<typeof toolSpaceReadMethodSchema>>({
  name: AgentToolNames.toolingRead,
  role: 'control',
  category: 'agent-control',
  // 同 tooling:map：技能正文是模型当下要读的内容，禁止 page-out。
  outputInline: true,
  summary: '读取当前角色可见的技能正文（skill:<id>）；技能索引见任务提示词。',
  suitable: ['任务确实需要某个技能的规范/步骤时，按 id 读取其正文再据以执行。'],
  forbidden: [
    '不读工具能力：需要某个工具时用 tooling:map 发现、tooling:replace 换入，让真实工具 schema 在下一轮暴露；不要用 tooling:read 读工具页。',
    '不要猜技能正文或不存在的 id；读取前只把索引当目录。',
  ],
  protocol: ['detail="full" 时技能页额外返回按需读取说明；默认 brief 即技能正文。'],
  usage: ['传 skill:<id>（来自任务提示词里「# 命中 Skill」那一段列出的 id）。'],
  examples: [{ ids: ['skill:global:coding-style'], detail: 'full' }],
  notes: [
    '内置技能和用户显式选择的技能直接读取；只有未选择的外部技能首次读取时弹确认卡，用户拒绝后不要重试。',
  ],
  schema: toolSpaceReadMethodSchema,
  permissions: [],
  capabilities: ToolingReadCapability,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) =>
    runToolSpace(ctx, toolSpaceSchema.parse({ op: 'read', ...toolSpaceReadMethodSchema.parse(input) })),
})

export const toolSpaceReplace: VelaTool<z.input<typeof toolSpaceReplaceMethodSchema>> = defineVelaTool<z.input<typeof toolSpaceReplaceMethodSchema>>({
  name: AgentToolNames.toolingReplace,
  role: 'control',
  category: 'agent-control',
  summary: '将发现的工具换入后续回合，或换出暂时不用的工具；返回实际处理结果与下一步。',
  suitable: [
    '需要一类激活 capability:*。',
    '需要把 loadable 工具换入可见工具空间供连续调用。',
    '需要 page-out 不再使用的工具页。',
  ],
  forbidden: ['不要用它执行目标工具；replace 后下一轮再调用真实工具。'],
  protocol: [
    'pageIn 可传 tool:* 或 capability:*；capability:* 表示一类激活。',
    '能力前置条件缺失时会返回 requiresUserActionDetails；按每条的 activation.dependencies 与 nextAction 处理，不要猜测能力自有资源。',
    'requiresUserActionDetails / requiresApprovalDetails 会说明阻塞原因，整体的下一步看回执的 nextTurnHint。',
  ],
  usage: [
    '从 tooling:map 结果复制精确页 id，传 pageIn/pageOut 和 reason；例子中的页也须以当前目录为准。',
  ],
  examples: [
    { pageIn: ['tool:job:read_output'], reason: '需要召回历史工具输出' },
    { pageOut: ['tool:job:read_output'], reason: '本阶段召回已完成' },
  ],
  notes: ['replace 只调整工具页驻留/能力状态；实际工具调用发生在下一轮真实工具 schema 暴露之后。'],
  schema: toolSpaceReplaceMethodSchema,
  permissions: [],
  capabilities: ToolingWriteCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) =>
    runToolSpace(ctx, toolSpaceSchema.parse({ op: 'replace', ...toolSpaceReplaceMethodSchema.parse(input) })),
})

// ── 长期指令（directive:list / directive:upsert / directive:archive）────────

export const listActiveDirectivesTool: VelaTool<Record<string, never>> = defineVelaTool<Record<string, never>>({
  name: AgentToolNames.directiveList,
  role: 'inspect',
  category: 'context',
  summary: '列出当前 session 上下文保护区中仍然生效的用户长期指令。',
  suitable: ['需要确认本 session 已固定且不能被历史压缩丢失的禁令、偏好、流程或需求约束。'],
  forbidden: ['不要把普通保留上下文或跨 session 偏好当成 active directive。'],
  usage: ['无需参数；只返回 metadata.directive=true 的 session 约束。'],
  examples: [{}],
  notes: ['用于取消或更新约束前的检查。'],
  schema: z.object({}),
  permissions: [],
  capabilities: AgentContextReadCapability,
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => {
    const directives = await listActiveDirectives(ctx.activeContext)
    return { directives, count: directives.length }
  },
})

export const upsertActiveDirectiveTool: VelaTool<{
  id?: string
  title: string
  content: string
  directiveType: ActiveDirectiveType
  sourceMessageId?: string
}> = defineVelaTool<{
  id?: string
  title: string
  content: string
  directiveType: ActiveDirectiveType
  sourceMessageId?: string
}>({
  name: AgentToolNames.directiveUpsert,
  role: 'control',
  category: 'context',
  summary: '把用户明确要求后续轮次持续遵守的重要指令写入当前 session 上下文保护区。',
  suitable: ['用户明确要求记住、始终遵守、后续都遵守，或给出禁止、权限、范围、流程等持续性边界。'],
  forbidden: ['不要因普通抱怨、一次性偏好、不确定表达或仅属于当前目标的临时条件自动写入。'],
  usage: ['只创建 session 级 directive；与当前目标一起结束的条件应放 goal.constraints。'],
  examples: [
    {
      title: '禁止自动重建索引',
      content: '不要自动批量重建索引。',
      directiveType: 'prohibition',
    },
  ],
  notes: [
    `最多同时保护 ${AgentToolLimits.directives.maxActive} 条；用户取消后用 directive:archive 归档。`,
  ],
  schema: z.object({
    id: z
      .string()
      .min(1)
      .max(AgentToolLimits.directives.identifierChars)
      .optional()
      .describe(
        parameterDescription({
          description: '可选稳定 ID；更新同一约束时复用。',
        })
      ),
    title: z
      .string()
      .min(1)
      .max(AgentToolLimits.directives.titleChars)
      .describe(
        parameterDescription({
          description: '约束标题，简短描述用户固定的规则。',
        })
      ),
    content: z
      .string()
      .min(1)
      .max(AgentToolLimits.directives.contentChars)
      .describe(
        parameterDescription({
          description: '后续轮次必须遵守的具体约束内容。',
        })
      ),
    directiveType: directiveTypeSchema.describe(
      parameterDescription({
        description: '约束类型。',
        values: [
          'prohibition：禁令或不允许做的事。',
          'preference：用户偏好。',
          'process：执行流程要求。',
          'requirement：结果或行为需求。',
          'other：无法归类但用户明确要求固定。',
        ],
      })
    ),
    sourceMessageId: z
      .string()
      .min(1)
      .max(AgentToolLimits.directives.identifierChars)
      .optional()
      .describe(
        parameterDescription({
          description: '触发该约束的用户消息 ID；没有时省略。',
        })
      ),
  }),
  permissions: [],
  capabilities: AgentContextWriteCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    const directive = await upsertActiveDirective(ctx.activeContext, input)
    return { directive, updated: true }
  },
})

export const archiveActiveDirective: VelaTool<{
  ids?: string[]
  title?: string
  directiveType?: ActiveDirectiveType
}> = defineVelaTool<{
  ids?: string[]
  title?: string
  directiveType?: ActiveDirectiveType
}>({
  name: AgentToolNames.directiveArchive,
  role: 'control',
  category: 'context',
  summary: '取消当前 session 上下文保护区中一个或多个已固定的长期指令。',
  suitable: ['用户明确说取消限制、不需要禁令、以后可以、刚才那条不要固定。'],
  forbidden: ['不要归档普通 active context；只处理 metadata.directive=true 的条目。'],
  usage: ['三个筛选条件至少给一个：ids 精确归档，title 按标题包含匹配，directiveType 按类型整批归档。'],
  examples: [{ title: '禁止自动重建索引' }, { directiveType: 'prohibition' }],
  notes: ['只归档 session 级长期指令；当前目标里的约束用 goal:update 的 constraints 改。'],
  schema: z
    .object({
      ids: z
        .array(z.string().min(1).max(AgentToolLimits.directives.identifierChars))
        .min(1)
        .max(AgentToolLimits.directives.maxArchiveIds)
        .optional()
        .describe(
          parameterDescription({
            description: '要归档的 directive id 列表。',
          })
        ),
      title: z
        .string()
        .min(1)
        .max(AgentToolLimits.directives.titleChars)
        .optional()
        .describe(
          parameterDescription({
            description: '按标题包含匹配要取消的约束。',
          })
        ),
      directiveType: directiveTypeSchema.optional().describe(
        parameterDescription({
          description: '按约束类型匹配。',
        })
      ),
    })
    .refine((input) => !!input.ids?.length || !!input.title || !!input.directiveType, {
      message: '至少传 ids、title 或 directiveType 之一。',
    }),
  permissions: [],
  capabilities: AgentContextWriteCapability,
  isConcurrencySafe: () => false,
  execute: (input, ctx) => archiveActiveDirectives(ctx.activeContext, input),
})

export const createGoal: VelaTool<{
  objective: string
  token_budget?: number
  steps?: GoalStep[]
  constraints?: GoalConstraint[]
}> = defineVelaTool<{
  objective: string
  token_budget?: number
  steps?: GoalStep[]
  constraints?: GoalConstraint[]
}>({
  name: AgentToolNames.goalCreate,
  role: 'control',
  category: 'planning',
  summary: '为需要长时间持续工作的任务创建当前 session 活动目标。',
  suitable: [
    '模型判断任务需要长时间持续工作时，应自主创建活动目标。',
    '目标模式刚开始且尚未存在活动目标。',
  ],
  forbidden: [
    '不要为短小、可立即完成的任务创建目标；用户明确要求不用目标模式时不得自主启用。',
    '不要在已有活动目标时重复创建；改目标内容或完成/阻塞状态请用 goal:update。重复调用只会返回并保留当前目标。',
  ],
  usage: [
    '预计任务会长时间运行、跨多轮推进或等待后台工作时，可主动创建目标；普通任务不要创建。',
    'objective 写清本次要达成的结果；token_budget 只有用户明确给预算时才传。',
    '目标生命周期步骤写入 steps；如果用户同时要求可见 plan/计划，另行调用 plan:update 维护 execution plan；需要持续遵守的用户约束写入 constraints。',
  ],
  examples: [
    {
      objective: '修复保存失败并跑验证',
      steps: [{ step: '定位保存失败路径', status: 'in_progress' }],
    },
  ],
  notes: ['同一 session 同时只允许一个活动目标；重复创建是幂等读取，不会覆盖当前目标。'],
  schema: z.object({
    objective: z.string().trim().min(1).max(AgentToolLimits.planning.objectiveChars).describe(
      parameterDescription({
        description: '本次目标模式要达成的具体目标。',
      })
    ),
    token_budget: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        parameterDescription({
          description: '可选 token 预算；只有用户明确要求预算时设置。',
        })
      ),
    steps: z
      .array(goalStepSchema)
      .min(1)
      .max(AgentToolLimits.planning.maxSteps)
      .optional()
      .describe(
        parameterDescription({
          description: '目标拆解出的完整生命周期步骤列表；不替代 plan:update 的可见 execution plan。',
        })
      ),
    constraints: z
      .array(goalConstraintSchema)
      .min(1)
      .max(AgentToolLimits.planning.maxConstraints)
      .optional()
      .describe(
        parameterDescription({
          description: '仅在当前目标边界内持续遵守的完整约束列表；跨目标长期有效的用户指令使用 active directive。',
        })
      ),
  }),
  permissions: [],
  capabilities: AgentPlanningWriteCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => goalOperations.create(input, ctx),
})

export const updateGoal: VelaTool<{
  status?: 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled'
  objective?: string
  steps?: GoalStep[]
  complete_step?: string | number
  constraints?: GoalConstraint[]
}> = defineVelaTool<{
  status?: 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled'
  objective?: string
  steps?: GoalStep[]
  complete_step?: string | number
  constraints?: GoalConstraint[]
}>({
  name: AgentToolNames.goalUpdate,
  role: 'control',
  category: 'planning',
  summary: '更新当前 session 的目标，支持暂停、恢复、完成、受阻或取消。',
  suitable: [
    '需要同步目标、步骤或约束状态。',
    '需要暂停或恢复目标。',
    '目标已实际完成、用户取消目标，或模型确认存在无法继续推进的真实阻碍。',
  ],
  forbidden: [
    '不要用它创建目标。',
    '不要仅因为任务困难、耗时、结果不确定或希望获得澄清就草率标记 blocked。',
    '不要在用户仍要求继续推进时把目标标记 cancelled。',
  ],
  usage: [
    '维护步骤最省心:传完整 steps 列表(每步带 status),这一项就能同步全部步骤;想改哪步就改它的 status，传 [] 清空步骤。',
    'constraints 传完整列表；传 [] 清空当前目标约束，省略则保留。',
    '完成某步的简写:传 complete_step(1-based 序号或精确标题,别自造 id);host 标记 completed 并推进下一个 pending。steps 与 complete_step 可一起传。',
    'status=complete 宣布目标完成:未收尾的 pending/in_progress 步骤会被自动标完成,不用逐个 complete_step。',
    'status=blocked 宣布目标受阻:模型确认缺少必要授权、用户输入或外部状态等真实阻碍导致无法继续推进时,可以自行调用,不需要等待多轮审计。',
    'status=paused 暂停目标并结束本次推进；后续得到继续指令时用 status=active 恢复。',
    'status=cancelled 只用于用户取消、目标被明确替换或已确认不再需要继续的情况。',
    '所有字段都不传则视为读取当前目标、不报错。',
  ],
  examples: [
    { steps: [{ step: '跑验证', status: 'in_progress' }] },
    { complete_step: 1 },
    { steps: [], constraints: [] },
    { status: 'paused' },
    { status: 'active' },
    { status: 'complete' },
    { status: 'blocked' },
    { status: 'cancelled' },
  ],
  notes: ['返回里的 steps 字段给出每步 ref(序号)+标题+状态,下次引用照它传。目标进入终态后,目标模式收尾门才允许本次执行完成。'],
  schema: z
    .object({
      status: goalStatusSchema
        .optional()
        .describe(
          parameterDescription({
            description: '目标生命周期状态；不传时仅更新目标内容字段。',
            values: [
              'active：恢复暂停的目标并继续推进。',
              'paused：暂停目标并结束本次推进，保留后续恢复入口。',
              'complete：目标已经真正完成。',
              'blocked：模型确认存在无法继续推进的真实阻碍。',
              'cancelled：用户取消、目标被替换或明确不再需要继续。',
            ],
          })
        ),
      objective: z.string().trim().min(1).max(AgentToolLimits.planning.objectiveChars).optional().describe(
        parameterDescription({
          description: '可选的新目标描述；省略则保留当前目标。',
        })
      ),
      steps: z
        .array(goalStepSchema)
        .max(AgentToolLimits.planning.maxSteps)
        .optional()
        .describe(
          parameterDescription({
            description: '目标拆解出的完整生命周期步骤列表；传 [] 清空，省略则保留。不替代 plan:update 的可见 execution plan。',
          })
        ),
      complete_step: z
        .union([z.string().trim().min(1).max(AgentToolLimits.planning.stepTitleChars), z.number().int().positive().max(AgentToolLimits.planning.maxSteps)])
        .optional()
        .describe(
          parameterDescription({
            description: '可选:完成一个目标步骤;用 1-based 序号或精确标题引用。',
            notes: [
              '步骤通常没有 id,优先用序号;不要自造 id。',
              '可以和 steps 一起传:先按 steps 重建、再完成引用的步骤。',
            ],
          })
        ),
      constraints: z
        .array(goalConstraintSchema)
        .max(AgentToolLimits.planning.maxConstraints)
        .optional()
        .describe(
          parameterDescription({
            description: '仅在当前目标边界内持续遵守的完整约束列表；传 [] 清空，省略则保留。跨目标长期有效的用户指令使用 active directive。',
          })
        ),
    }),
  permissions: [],
  capabilities: AgentPlanningWriteCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => goalOperations.update(input, ctx),
})

// ── 计划（plan:update / plan:get）────────────────────────────────────────────

/** 更新当前 execution 的可见计划。 */
export const updatePlan: VelaTool<UpdatePlanInput> = defineVelaTool<UpdatePlanInput>({
  name: AgentToolNames.planUpdate,
  role: 'control',
  category: 'planning',
  summary: '更新当前 execution 的可见执行计划。',
  suitable: [
    '任务复杂、需要多个具体步骤时，应由模型自主创建计划。',
    '需要同步现有计划进度。',
    '需要暂停、恢复、完成或归档当前计划。',
  ],
  forbidden: ['不要为简单单步任务创建计划；用户明确要求不用计划时不得自主启用。'],
  usage: [
    '创建或更新计划后，继续推进用户已授权的任务。用户明确选择计划模式或要求先出方案再确认时，按该要求等待确认。',
    '维护计划最省心的方式:直接传完整 plan 列表(每步带 status:pending/in_progress/completed),这一项就能建立并同步整个计划,想改哪步就改它的 status。',
    '完成某步的简写:传 complete_step(1-based 序号或精确标题;步骤没有 id,别自造 "step-1"),host 标记 completed 并自动推进下一个 pending。',
    'lifecycle 省略时保留已有生命周期；首次建计划会自动推导，active 计划全部步骤终态时自动 completed。',
    'lifecycle=paused 暂停计划并结束本次推进；后续用 lifecycle=active 恢复。',
    'lifecycle=completed 表示计划已执行完成；lifecycle=archived 表示用户改变目标或废弃旧方案。',
    'plan 和 complete_step 可以一起传(先按 plan 重建、再完成引用步骤);两个都不传则视为读取当前计划、不报错。',
  ],
  examples: [
    { plan: [{ step: "实现", status: "in_progress" }, { step: "验证", status: "pending" }] },
    { complete_step: 1 },
    { complete_step: ['实现', '验证'] },
    { lifecycle: 'paused' },
    { lifecycle: 'active' },
    { lifecycle: 'completed' },
  ],
  notes: [
    '返回里的 steps 字段给出每步 ref(序号)+标题+状态，下次引用照它传。建立计划、更新进度可以与用户已授权的执行工具同批发出。',
  ],
  schema: z
    .object({
      explanation: z.string().min(1).max(AgentToolLimits.planning.explanationChars).optional().describe(
        parameterDescription({
          description: '本次计划变化的简短说明。',
        })
      ),
      lifecycle: planLifecycleSchema
        .optional()
        .describe(
          parameterDescription({
            description: '计划生命周期；省略则保留已有状态。',
            values: [
              'active：计划仍在执行。',
              'paused：计划已暂停，可在后续恢复。',
              'completed：当前任务已完成。',
              'archived：用户改变目标或废弃旧方案。',
            ],
          })
        ),
      plan: z
        .array(
          z.object({
            id: z.string().min(1).max(AgentToolLimits.planning.stepIdChars).optional().describe(
              parameterDescription({
                description: '稳定步骤 ID。',
                notes: ['已有步骤可复用。'],
              })
            ),
            step: z.string().min(1).max(AgentToolLimits.planning.stepTitleChars).describe(
              parameterDescription({
                description: '步骤标题。',
              })
            ),
            objective: z.string().min(1).max(AgentToolLimits.planning.stepObjectiveChars).optional().describe(
              parameterDescription({
                description: '可选的步骤目标。',
              })
            ),
            status: planStatusSchema.describe(
              parameterDescription({
                description: '步骤状态。',
                values: [
                  'pending：尚未开始。',
                  'in_progress：正在执行。',
                  'completed：已完成。',
                  'failed：执行失败。',
                  'skipped：已跳过。',
                ],
              })
            ),
          })
        )
        .min(1)
        .max(AgentToolLimits.planning.maxSteps)
        .optional()
        .describe(
          parameterDescription({
            description: '完整的当前计划列表。',
            notes: ['按执行顺序排列。'],
          })
        ),
      complete_step: z
        // 空数组不再硬拒(模型会传 [] 表示"这次没有要完成的"),execute 侧按未传处理(no-op)。
        .union([planStepRefSchema, z.array(planStepRefSchema).max(AgentToolLimits.planning.maxSteps)])
        .optional()
        .describe(
          parameterDescription({
            description: '要标记完成的一个或多个步骤:用 1-based 序号或精确标题引用。',
            notes: [
              '步骤通常没有 id,优先用序号(1、2、3…);不要自造 id。',
              '可以和 plan 一起传:先按 plan 重建列表,再完成引用的步骤。',
              '传空数组等价不传(无步骤要完成)。',
            ],
          })
        ),
    }),
  permissions: [],
  capabilities: AgentPlanningWriteCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => planOperations.update(input, ctx),
})

// ── 子 Agent（agent:dispatch / agent:run_workflow）───────────────────────────

export const dispatchAgent: VelaTool<DispatchAgentInput> = defineVelaTool<DispatchAgentInput>({
  name: AgentToolNames.agentDispatch,
  role: 'control',
  category: 'agent-control',
  summary: '在当前执行作用域中派发独立 sub-agent。',
  suitable: [
    '仅复杂任务：并行探索多目录/方案，或单条子任务本身就需很多步。',
    '并行处理可独立完成、无需实时共享中间状态的子任务。',
  ],
  forbidden: [
    '默认不派：简单/单步任务（读文件、跑命令）自己直接做，更快。',
    '工具调不出时用 tooling:map/tooling:replace 换入自用，别拿子 Agent 绕过。',
    '不派彼此实时同步的串行任务；子 Agent 不能再派子 Agent。',
    '不要用子 Agent 绕过宿主的能力、权限或作用域边界。',
  ],
  usage: [
    '新派时 prompt 必须自洽：子 Agent 看不到你的会话历史，目标/已知事实/范围边界/成功标准/输出长度都要写进去；续跑只写追加的任务。',
    '同一轮可多次调用 agent:dispatch 实现并行；系统会自动限制并发数。',
    'mode=sync（默认）阻塞到完成并内联返回结果——不要再调 job:wait，也不要因为没立刻拿到就重派。',
    'mode=async 立即返回一个可等待的 job：本轮可以直接结束，作业收尾时系统会叫醒你；回合中途要定点等某个作业才用 job:wait，想先看进展用 job:read_output。',
    'subagent_type 选择本轮提示目录中的精确 id；新建省略使用宿主默认类型，续跑省略继承原线程。tool_scope 用 type_default、inherit 或 custom（custom 时填 tool_categories）。',
    '优先复用：同一工作线上的追问、补做、纠偏、修复后复验，用 thread_id 续跑已派的子 Agent（它保留着读过的上下文，不必重读）；复验就续跑原验证者。',
    '需要独立上下文才新派：独立复核/第二意见（不让产出者复核自己的产出）、原线程跑偏或上下文过大、换了作用域或无关新任务。',
    '请人复核时必给 readonly=true；需要机器可读结果时给 output_schema，结果落在 structured_output。',
    'agent_name 必须是英文代号名，不要带数字，例如 Atlas、Forge、Scout、Beacon。',
  ],
  examples: [
    // 同步只读探索（默认 mode:sync，返回后再继续）
    {
      agent_name: 'Scout',
      readonly: true,
      tool_scope: 'type_default',
      description: '摸清登录模块',
      prompt: '读 src/auth，把登录流程、关键文件和风险点各讲一遍。',
    },
    // 异步后台任务：mode:async，父 Agent 先继续，之后用 job:wait/job:read_output 收束
    {
      agent_name: 'Reviewer',
      readonly: true,
      tool_scope: 'type_default',
      mode: 'async',
      description: '复核工具函数的测试覆盖',
      prompt: '读 src/util.js 和它的测试，指出漏掉的边界情况，每条都给准确的文件位置。',
    },
    // 修复后复验：续跑原来的验证者，它还记得失败现场
    {
      thread_id: 'subagent:verifier-thread',
      prompt: '已经修好 src/auth/login.ts 的空值判断，重跑一遍登录相关的测试。',
    },
    { thread_id: 'subagent:running-thread', interrupt: true },
  ],
  notes: [
    '子 Agent 在独立上下文中运行；回传为 summary 文本 + 结构化 `<subagent-result>` 块（含 thread_id、status、resumable、artifacts）。',
    '失败、中断或 wind_down 也返回结构化结果；resumable=true 可带 thread_id 续跑，否则新派或自行接手。线程只保留有限时间，过期续跑会明确报错。',
  ],
  usageSkillId: 'sub-agent-orchestration',
  schema: dispatchAgentSchema,
  permissions: [],
  capabilities: AgentDispatchCapability,
  isAvailable: (ctx) => !!ctx.dispatchSubAgent,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => {
    if (!ctx.dispatchSubAgent) throw new AppError('VALIDATION', '子 Agent 派发当前不可用。')
    return ctx.dispatchSubAgent(buildSubAgentDispatchRequest(input))
  },
})

export const runAgentWorkflow: VelaTool<RunAgentWorkflowInput> = defineVelaTool({
  name: AgentToolNames.agentRunWorkflow,
  role: 'control',
  category: 'agent-control',
  summary: '用声明式、有界控制流编排多个一级子 Agent，并在代码侧收敛结构化结果。',
  suitable: [
    '复杂任务需要固定 fan-out、无栅栏流水线、有界多轮收敛或多数票时。',
    '需要多个独立 reviewer 先按 JSON Schema 返回，再由代码侧 filter/dedupe/投票时。',
  ],
  forbidden: [
    '简单或单步任务不要建 Workflow；直接做或派一个子 Agent 更快。',
    '不得把 operation 当通用脚本；没有 fs、网络、process、require/import 或任意代码执行能力。',
    '是否可调用由产品委派策略决定；Workflow 不能派孙 Agent。',
    '不要用 Workflow 绕过 Project 权限、工具分类或写租约。',
  ],
  usage: [
    'steps 按数组顺序执行；归约类 step 的 source.step_id 只能引用更早的 step。',
    'subagent_type 从本轮目录选精确 id；省略使用宿主默认类型。',
    'operation 六选一：parallel / pipeline / repeat 派 Agent，filter / dedupe / majority_vote 是纯归约。',
    '每个 Agent call 必须提供 output_schema；最终只接受符合 schema 的 JSON，修复失败会作为该节点失败。',
    '多数票缺 quorum、平票或未达 threshold 时返回 inconclusive，不会默认判通过。',
    '步数/并发/Agent 数/轮数超限不报错、直接钳制；真实上限以结果里的 effective_limits 为准。',
  ],
  examples: [
    {
      name: '独立复核投票',
      max_concurrency: 3,
      max_agents: 3,
      steps: [
        {
          id: 'reviews',
          operation: 'parallel',
          calls: ['Atlas', 'Beacon'].map((agent_name, index) => ({
            id: `review-${index + 1}`,
            agent_name,
            prompt: '独立检查当前这次项目改动，给出结论；不要改任何文件。',
            readonly: true,
            output_schema: {
              type: 'object',
              properties: { verdict: { type: 'string', enum: ['approve', 'reject'] } },
              required: ['verdict'],
              additionalProperties: false,
            },
          })),
        },
        {
          id: 'decision',
          operation: 'majority_vote',
          source: { step_id: 'reviews' },
          vote_path: ['structured_output', 'verdict'],
          quorum: 2,
        },
      ],
    },
  ],
  notes: [
    '结果回显 effective_limits、agent_count、每步状态和最终 output。',
    '所有节点都经 SubAgentDispatcher，与手工派发走同一条执行路（并发、熔断、沙箱、取消、模型路由）。',
  ],
  usageSkillId: 'workflow-authoring',
  schema: agentWorkflowSchema,
  permissions: [],
  capabilities: AgentWorkflowCapability,
  isAvailable: (ctx) => !!ctx.runAgentWorkflow,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    if (!ctx.runAgentWorkflow) throw new AppError('VALIDATION', '多 Agent Workflow 当前不可用。')
    return ctx.runAgentWorkflow(input)
  },
})

// ── 后台作业（job:read_output / job:wait / job:cancel）───────────────────────

export const readBackgroundJobOutput: VelaTool<ReadBackgroundJobOutputInput> = defineVelaTool<ReadBackgroundJobOutputInput>({
  name: AgentToolNames.jobReadOutput,
  role: 'control',
  category: 'agent-control',
  summary: '读取当前会话内核后台 job 的新增或完整输出。',
  suitable: [
    'agent:dispatch 已启动可等待子 Agent job，后续需要查看其结果或错误输出。',
    '后台 job 通知提示任务完成、失败或可能停滞，需要检查输出后再继续。',
    '需要非阻塞地轮询后台任务输出，而不是 sleep 或重复派发同一任务。',
  ],
  forbidden: [
    '不要用它读 shell 命令的输出；后台命令在程序里用 velaros:shell 的 listTasks 看。',
    '不要在没有 job_id 时猜测；先从 agent:dispatch 返回或后台通知中取得 job id。',
  ],
  usage: [
    '默认 mode=incremental，只返回新增输出并推进游标；需要完整缓存时用 mode=snapshot。',
    'filter 是正则表达式，只保留匹配行；正则无效会被忽略（返回全量输出并说明原因），不会报错。',
    '「没有新增输出」＝本次真的没有新增；「新增 N 行，但一行都没命中 filter」＝有新增但一行没命中，此时用 mode=snapshot 或去掉 filter 复读。两者都不代表 job 不存在。',
  ],
  examples: [
    {
      job_id: 'subagent:abc:background:123',
      mode: 'incremental',
      filter: 'error|failed|summary',
    },
  ],
  notes: [
    '该工具只访问当前会话拥有的内核后台 job；跨会话或不存在的 job 会返回 not found。',
    '它不等待任务完成；需要等待外部条件（端口/HTTP/文件）时在程序里用 velaros:shell 的 run 轮询（如 curl/test -f 循环）。',
  ],
  schema: readBackgroundJobOutputSchema,
  permissions: [],
  capabilities: AgentBackgroundJobReadCapability,
  isAvailable: (ctx) => !!ctx.readBackgroundJobOutput,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => backgroundJobOperations.readOutput(input, ctx),
})

export const waitBackgroundJobs: VelaTool<WaitBackgroundJobsInput> = defineVelaTool<WaitBackgroundJobsInput>({
  name: AgentToolNames.jobWait,
  role: 'control',
  category: 'agent-control',
  summary: '等待当前会话内核后台 job 完成并返回结果。',
  suitable: [
    'agent:dispatch 已启动一个或多个可等待子 Agent job，需要在继续决策前收束它们的结果。',
    '后台 job 仍在运行，但下一步依赖其最终输出，应该等待而不是手动轮询。',
    '需要一次性等待当前会话内所有已运行后台 job，可省略 job_ids。',
  ],
  forbidden: [
    '不要用它等待普通命令；后台命令在程序里用 velaros:shell 的 listTasks 看。',
    '不要把 thread_id 当 job_id；job_id 来自 agent:dispatch 返回或后台通知。',
  ],
  usage: [
    '提供 job_ids 时只等待当前会话拥有且匹配的 job；跨会话或不存在的 id 会被忽略。',
    '省略 job_ids 时等待调用瞬间当前会话内仍在运行的所有后台 job。',
    'timeout_ms 到期时返回当前状态和当前可读输出；返回 running 表示仍未完成。',
    'filter 是正则表达式，只保留匹配行；正则无效会被忽略（返回全量输出并说明原因），不会报错。',
  ],
  examples: [
    {
      job_ids: ['subagent:abc:background:123'],
      timeout_ms: 30_000,
      filter: 'summary|error|failed',
    },
  ],
  notes: [
    '该工具只访问当前会话拥有的内核后台 job；不读取其他会话任务。',
    '它和 job:read_output 使用同一个输出源，artifact-backed 输出可完整读取。',
  ],
  schema: waitBackgroundJobsSchema,
  permissions: [],
  capabilities: AgentBackgroundJobReadCapability,
  isAvailable: (ctx) => !!ctx.waitBackgroundJobs,
  isConcurrencySafe: () => true,
  execute: async (input, ctx) => backgroundJobOperations.wait(input, ctx),
})

// ── 交互（interaction:confirm）───────────────────────────────────────────────

export const requestConfirmationTool: VelaTool<{ message: string }> = defineVelaTool<{ message: string }>({
  name: AgentToolNames.interactionConfirm,
  role: 'execute',
  category: 'interaction',
  summary: '向用户请求一次明确确认。',
  suitable: ['执行高风险、长期运行或需要人工授权的动作前。'],
  forbidden: ['不要用于普通说明或不需要用户决策的信息提示。'],
  usage: ['传 message 描述待确认动作；工具会暂停当前 execution。'],
  examples: [{ message: '即将运行会改写文件的命令，确认继续吗？' }],
  notes: [
    '用户批准后继续，拒绝时终止本次 execution。',
    // notes 是静态数组，渲染时拿不到宿主声明，所以这里一律不点名工具：
    // 「请求用户动作的工具」叫什么由宿主声明，工具页的 activation 会在需要时点名它。
    '它只做一次「是/否」确认：要用户填表单、或要一次给出多个可选动作，都不要拿它硬凑，改用工具页里标着请求用户动作的那个工具。',
  ],
  schema: z.object({
    message: z.string().min(1).describe(
      parameterDescription({
        description: '需要用户确认的内容。',
        usage: ['说明即将执行的动作、原因和影响范围。'],
      })
    ),
  }),
  permissions: [],
  capabilities: UserConfirmationCapability,
  isConcurrencySafe: () => false,
  execute: async ({ message }, ctx) => {
    await ctx.approval.awaitConfirmation(message, ctx.abortSignal, createManualApprovalOptions())
    return { approved: true }
  },
})

// ── 分组 ────────────────────────────────────────────────────────────────────
// 宿主按组挂载；组名即按域分的工具集合，改组等于改宿主看到的工具面。

export const categoriesTools: {
  'tooling:map': typeof toolSpaceMap
  'tooling:read': typeof toolSpaceRead
  'tooling:replace': typeof toolSpaceReplace
} = {
  [AgentToolNames.toolingMap]: toolSpaceMap,
  [AgentToolNames.toolingRead]: toolSpaceRead,
  [AgentToolNames.toolingReplace]: toolSpaceReplace,
}

export const activeDirectiveTools: {
  'directive:list': typeof listActiveDirectivesTool
  'directive:upsert': typeof upsertActiveDirectiveTool
  'directive:archive': typeof archiveActiveDirective
} = {
  [AgentToolNames.directiveList]: listActiveDirectivesTool,
  [AgentToolNames.directiveUpsert]: upsertActiveDirectiveTool,
  [AgentToolNames.directiveArchive]: archiveActiveDirective,
}

export const goalTools: {
  'goal:create': typeof createGoal
  'goal:update': typeof updateGoal
} = {
  [AgentToolNames.goalCreate]: createGoal,
  [AgentToolNames.goalUpdate]: updateGoal,
}

export const plansTools: { 'plan:update': typeof updatePlan } = {
  [AgentToolNames.planUpdate]: updatePlan,
}

export const dispatchAgentTools: { 'agent:dispatch': typeof dispatchAgent } = {
  [AgentToolNames.agentDispatch]: dispatchAgent,
}

export const agentWorkflowTools: AgentWorkflowToolCollection = {
  [AgentToolNames.agentRunWorkflow]: runAgentWorkflow,
}

export const backgroundJobTools: {
  'job:read_output': VelaTool<ReadBackgroundJobOutputInput>
  'job:wait': VelaTool<WaitBackgroundJobsInput>
} = {
  [AgentToolNames.jobReadOutput]: readBackgroundJobOutput,
  [AgentToolNames.jobWait]: waitBackgroundJobs,
}

export const confirmationTools: {
  'interaction:confirm': typeof requestConfirmationTool
} = {
  [AgentToolNames.interactionConfirm]: requestConfirmationTool,
}

// ── 挂载：随包官方 mod ──────────────────────────────────────────────────────

/** 随包官方 Agent mod 的稳定 id（恒加载，永不孤儿）；值在 AgentIdentity.builtinModId。 */
export const BuiltinAgentModId: string = AgentIdentity.builtinModId

/** 内置工具库单源：新增内置工具集合只在此追加，manifest 自动跟随。 */
export const BuiltinAgentModToolCollections: ReadonlyArray<Readonly<
  Record<string, VelaTool<any>>
>> = [
  activeDirectiveTools,
  { ...agentWorkflowTools },
  backgroundJobTools,
  categoriesTools,
  confirmationTools,
  dispatchAgentTools,
  goalTools,
  plansTools,
]


/**
 * 构造随包官方 Agent mod。
 *
 * 恒加载（trust=bundled-official），三轴贡献：内置工具库 / 内置提示词段 / 官方执行模式。
 * 技能轴刻意缺席——Agent Runtime 自身不带内置技能定义（技能由宿主的文件式供应方注入），
 * 声明空轴只会制造零消费者的假贡献。
 */
export function createBuiltinAgentModDefinition(
  options: BuiltinAgentModOptions = {}
): BuiltinAgentModPackage {
  const tools = agentTools
  const promptSegments = createBuiltInPromptSegments(options.promptOptions)
  const executionModes = listExecutionModes()

  const manifest: AgentModManifest = {
    id: BuiltinAgentModId,
    version: options.version ?? '1.0.0',
    publisher: 'VelarOS',
    displayName: 'VelarOS Agent 内置轴',
    description:
      'Agent Runtime 随包提供的内置工具库、提示词段与官方执行模式，经领域 Loader 恒加载。',
    manifestSchemaVersion: AgentModManifestSchemaVersion,
    engines: { velaros: '*', agent: '*' },
    trust: 'bundled-official',
    contributes: {
      tools: Object.entries(tools).map(([name, tool]) => toToolContribution(name, tool)),
      promptSegments: promptSegments.map(toPromptSegmentContribution),
      executionModes: executionModes.map(toExecutionModeContribution),
    },
  }

  const bindings: AgentModBindings = {
    tools,
    promptSegments: Object.fromEntries(
      promptSegments.map((definition) => [definition.id, definition])
    ),
    executionModes: Object.fromEntries(
      executionModes.map((descriptor) => [descriptor.id, descriptor])
    ),
  }

  return {
    source: 'bundled',
    origin: BuiltinAgentModId,
    manifest,
    bindings,
  }
}

/**
 * 本包全部内置工具按名索引的单源：宿主要挂工具、要查某个工具的定义，一律从这里取。
 *
 * 分组仍在 `BuiltinAgentModToolCollections` 里，那是给内置 mod 拼清单用的，不再出包。
 */
export const agentTools: Readonly<Record<string, VelaTool<any>>> = Object.freeze(
  BuiltinAgentModToolCollections.reduce<Record<string, VelaTool<any>>>((tools, collection) => {
    for (const [name, tool] of Object.entries(collection)) {
      // 重复工具名在这里即抛，不留到 Loader 才发现。
      if (name in tools) throw new Error(`内置工具名重复：${name}（内置集合之间必须互斥）。`)
      tools[name] = tool
    }
    return tools
  }, {})
)

/**
 * 宿主装配 mod 用的组装器：内置 mod 由本文件提供，pack 由宿主给。
 *
 * 装配器自己不认识任何具体工具，随包官方 mod 从这里注入——工具面（本文件）在分层的最上层，
 * 装配层在它之下，依赖方向只能是这一个方向。
 */
export const agentModHost: AgentModHostAssemblerApi = new AgentModHostAssembler(() => [
  createBuiltinAgentModDefinition(),
])
