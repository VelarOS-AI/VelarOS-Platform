import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
  structureToolDescriptionsForCategory,
} from '@velaros-ai/agent/tool-contract'

import {
  MemoryEvidenceCategories,
  MemoryEvidenceCategoryAliases,
  MemoryEvidenceLimits,
  MemoryPrivacyClasses,
  MemorySearchModes,
  MemoryToolCategoryId,
  MemoryToolLimits,
  MemoryToolNames,
} from '../contract/constants'
import type { MemoryToolCollection } from '../contract/provides'
import type {
  ForgetMemoryInput,
  GetMemoryInput,
  SaveMemoryInput,
  SearchMemoriesInput,
} from '../types/tool'
import { defineMemoryTool } from '../utils/tool'

import { memoryToolOperations } from './MemoryToolOperations'

/** 只读记忆的能力声明：读记忆、可并发。 */
const MemoryReadCapability = {
  effectKind: 'read',
  readScopes: ['memory'],
  memoryAccess: 'read',
  concurrency: 'safe',
  reason: '读取长期记忆',
} as const

/** 写记忆的能力声明：读写记忆、不可并发。 */
const MemoryWriteCapability = {
  effectKind: 'write',
  readScopes: ['memory'],
  writeScopes: ['memory'],
  memoryAccess: 'write',
  concurrency: 'unsafe',
  reason: '写入长期记忆',
} as const

// 旧调用兼容只存在于工具输入边界，进入内核前立即归一化。
const memoryCategorySchema = z.enum([
  ...MemoryEvidenceCategories,
  ...(Object.keys(MemoryEvidenceCategoryAliases) as Array<keyof typeof MemoryEvidenceCategoryAliases>),
])

const saveMemory = defineMemoryTool<SaveMemoryInput>({
  name: MemoryToolNames.save,
  role: MemoryToolCategoryId,
  category: MemoryToolCategoryId,
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
    title: z.string().min(1).max(MemoryEvidenceLimits.titleChars).describe(
      parameterDescription({ description: '这条记忆的简短主题。' })
    ),
    content: z.string().min(1).max(MemoryEvidenceLimits.contentChars).describe(
      parameterDescription({ description: '要记住的内容正文。' })
    ),
    summary: z.string().max(MemoryToolLimits.summaryChars).optional().describe(
      parameterDescription({ description: '可选的人类可读摘要。' })
    ),
    source: z.string().max(MemoryToolLimits.sourceChars).optional().describe(
      parameterDescription({ description: '可选来源说明。' })
    ),
    tags: z.array(z.string().max(MemoryToolLimits.tagChars)).max(MemoryToolLimits.tagCount).optional().describe(
      parameterDescription({ description: '可选标签，只作为记忆元数据。' })
    ),
    workspaceRoot: z.string().optional().describe(
      parameterDescription({ description: '可选工作区根；默认从当前项目空间派生。' })
    ),
    taskKey: z.string().max(MemoryToolLimits.sourceChars).optional().describe(
      parameterDescription({ description: '可选任务稳定键。' })
    ),
    privacyClass: z.enum(MemoryPrivacyClasses).optional().describe(
      parameterDescription({ description: '可选隐私级；秘密信息无论级别都禁止写入。' })
    ),
  }),
  permissions: ['memory:write'],
  capabilities: MemoryWriteCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => memoryToolOperations.save(input, ctx),
})

const searchMemories = defineMemoryTool<SearchMemoriesInput>({
  name: MemoryToolNames.search,
  role: MemoryToolCategoryId,
  category: MemoryToolCategoryId,
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
      query: z.string().max(MemoryToolLimits.queryChars).optional(),
      mode: z.enum(MemorySearchModes).optional(),
      limit: z.number().int().min(1).max(MemoryToolLimits.recallItems).optional(),
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
  execute: async (input, ctx) => memoryToolOperations.search(input, ctx),
})

const getMemory = defineMemoryTool<GetMemoryInput>({
  name: MemoryToolNames.get,
  role: MemoryToolCategoryId,
  category: MemoryToolCategoryId,
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
  execute: async (input, ctx) => memoryToolOperations.get(input, ctx),
})

const forgetMemory = defineMemoryTool<ForgetMemoryInput>({
  name: MemoryToolNames.archive,
  role: MemoryToolCategoryId,
  category: MemoryToolCategoryId,
  summary: '归档一条记忆，让它退出日常召回。',
  suitable: ['用户明确表示某条记忆过时、暂时不希望它继续影响日常回答。'],
  forbidden: ['不要把归档描述成删除——内容一个字节都还在。'],
  usage: ['传 memory:search 返回的 id；reason 只写入本次工具结果，不另建秘密日志。'],
  notes: [
    '归档不是删除：内容仍在，deep=true 的深层召回仍能翻到。',
    '用户要求「彻底删掉」时如实说明当前只能归档，别承诺物理删除。',
    '只能归档当前空间可见的记忆（本空间 + 全局）；别的空间的 id 一律当作不存在。',
  ],
  examples: [{ id: 'project:/repo::entries/回复风格.md', reason: '该偏好只适用于旧项目' }],
  schema: z.object({
    id: z.string().min(1),
    reason: z.string().max(MemoryToolLimits.archiveReasonChars).optional(),
  }),
  permissions: ['memory:write'],
  capabilities: MemoryWriteCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => memoryToolOperations.archive(input, ctx),
})

/** 四个记忆工具连同分组与挂载：说明按类别渲染一次，宿主拿到的就是模型看到的字节。 */
const memoryTools: MemoryToolCollection = structureToolDescriptionsForCategory({
  [MemoryToolNames.save]: saveMemory,
  [MemoryToolNames.search]: searchMemories,
  [MemoryToolNames.get]: getMemory,
  [MemoryToolNames.archive]: forgetMemory,
}, MemoryToolCategoryId)

export { memoryTools }
