import { z } from 'zod'

import { isString } from '@velaros-ai/core'
import {
  renderParameterDescription as parameterDescription,
  toolDescriptions,
} from '@velaros-ai/tool-contract'

import {
  MemoryEvidenceCategories,
  MemoryEvidenceLimits,
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
import { normalizeMemoryCategory } from '../utils/tools'
import { MemoryTuning } from '../utils/tuning'

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

/**
 * 类别的入参边界：**只宣传**正式类别，旧别名（`session` / `user` / `reference`）照收但不进 schema。
 *
 * `preprocess` 在校验之前把别名折成正式值，`io: 'input'` 的 JSON Schema 因此只列正式类别——
 * 模型不必在 `user` 与 `preference` 之间做一道无意义的选择题，老会话传旧值也不会被判错。
 */
const memoryCategorySchema = z.preprocess(
  (value) => (isString(value) ? normalizeMemoryCategory(value as never) : value),
  z.enum(MemoryEvidenceCategories),
)

/** 类别逐个是什么意思：`kind` 的字段说明照 `values` 的写法列出来。 */
const MemoryCategoryMeanings = [
  'fact 稳定事实',
  'preference 偏好',
  'feedback 对协作方式的反馈',
  'procedure 做法',
  'project 项目',
  'task 任务',
  'goal 目标',
  'interest 兴趣',
  'entity 人与事物',
  'artifact 产出物',
  'conversation 对话要点',
].join('、')

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
    },
  ],
  notes: [
    '同一空间里标题和正文都相同的内容再写一次，不会多出一条；措辞变了就是新的一条。',
    '本工具写下的内容作者是你，不是用户；真实的用户确认由聊天消息采集独立记录，'
      + '不要在这里声称「用户已确认」。',
  ],
  schema: z.object({
    kind: memoryCategorySchema.describe(
      parameterDescription({ description: `记忆类别：${MemoryCategoryMeanings}。` })
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
      parameterDescription({ description: '可选来源说明，只写进记忆文件给人看，不影响召回。' })
    ),
    tags: z.array(z.string().max(MemoryToolLimits.tagChars)).max(MemoryToolLimits.tagCount).optional().describe(
      parameterDescription({ description: '可选标签，只写进记忆文件给人看，不影响召回。' })
    ),
    taskKey: z.string().max(MemoryToolLimits.sourceChars).optional().describe(
      parameterDescription({ description: '可选任务稳定键。' })
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
    '只召回当前空间（当前项目、当前站点或系统空间）的记忆，别的空间的看不到。',
    '普通召回只返回在用的记忆；deep=true 才把已归档的一并翻出来。',
  ],
  usage: [
    '有明确话题就传 query；想看最近记了什么就不传 query；'
      + '只看用户画像就传 categories: ["preference","feedback","interest"]。',
  ],
  notes: ['需要核对某条的全文与来源时继续调用 memory:get。'],
  examples: [
    { query: '记忆系统重构', limit: 8 },
    { categories: ['preference', 'feedback', 'interest'], limit: 12 },
    { query: '之前暂停的任务', deep: true },
  ],
  schema: z.object({
    query: z.string().max(MemoryToolLimits.queryChars).optional().describe(
      parameterDescription({ description: '要找的话题，用用户原话或关键词；不传就是看最近记了什么。' })
    ),
    limit: z.number().int().min(1).max(MemoryToolLimits.recallItems).optional().describe(
      parameterDescription({
        description: `返回多少条，缺省 ${MemoryTuning.tools.searchDefaultLimit} 条`
          + `（不传 query 时 ${MemoryTuning.tools.browseDefaultLimit} 条），最多 ${MemoryToolLimits.recallItems} 条。`,
      })
    ),
    deep: z.boolean().optional().describe(
      parameterDescription({ description: '为真时连已归档的一起找，缺省只找在用的。' })
    ),
    categories: z.array(memoryCategorySchema).optional().describe(
      parameterDescription({ description: '只看这些类别，不传就是全部类别。' })
    ),
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
  notes: ['只能读当前空间的记忆；别的空间的 id 一律当作不存在。'],
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
  forbidden: [
    '不要说成删除：归档后内容还在，deep=true 仍能找到；用户要彻底删除时如实说明现在只能归档。',
  ],
  usage: ['传 memory:search 返回的 id。'],
  notes: [
    '回执的 archived 为 false 表示这个 id 不存在或不在当前空间，要如实告诉用户没有归档成。',
    '只能归档当前空间的记忆；别的空间的 id 一律当作不存在。',
  ],
  examples: [{ id: 'project:/repo::entries/回复风格.md' }],
  schema: z.object({ id: z.string().min(1) }),
  permissions: ['memory:write'],
  capabilities: MemoryWriteCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => memoryToolOperations.archive(input, ctx),
})

/** 四个记忆工具连同分组与挂载：说明按类别渲染一次，宿主拿到的就是模型看到的字节。 */
const memoryTools: MemoryToolCollection = toolDescriptions.forCategory({
  [MemoryToolNames.save]: saveMemory,
  [MemoryToolNames.search]: searchMemories,
  [MemoryToolNames.get]: getMemory,
  [MemoryToolNames.archive]: forgetMemory,
}, MemoryToolCategoryId)

export { memoryTools }
