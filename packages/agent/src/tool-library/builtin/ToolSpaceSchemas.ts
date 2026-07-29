import { z } from 'zod'

import { isEmpty,isNotUndefined } from '@velaros-ai/core'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import {
  ToolDiscoveryAvailabilityValues,
} from '../../tools'

export const ToolDiscoveryKindValues = ['tool', 'capability', 'plugin'] as const
const ToolFindQueryAllowedCharacters =
  /^[\p{Script=Han}A-Za-z0-9\s_\-./\\:：,，。;；|()[\]{}"'`+*#@!?=&%<>$~]+$/u
const ToolFindQueryHasSearchLanguage = /[\p{Script=Han}A-Za-z]/u

const toolDiscoveryCategorySchema = z.string().trim().min(1).max(120)
const toolDiscoveryDomainSchema = z.string().trim().min(1).max(120)
const ToolOsStateValues = [
  'resident',
  'loadable',
  'needs_setup',
  'unavailable',
] as const
const toolDiscoveryToolOsStateSchema = z.enum(ToolOsStateValues)

export const toolAvailabilitySchema = z.enum(ToolDiscoveryAvailabilityValues)
export const toolDiscoveryKindSchema = z.enum(ToolDiscoveryKindValues)

function isChineseOrEnglishToolSearchQuery(query: string): boolean {
  return ToolFindQueryHasSearchLanguage.test(query) && ToolFindQueryAllowedCharacters.test(query)
}

// 宽容:tool-space 各 op schema 用 .strip()(而非 .strict())——模型常把某个 op 的合法过滤 key
// (如 read op 里带 find/map 才认的 toolOsStates)带到别的 op 上,strict 会硬报 Unrecognized key
// 让模型循环重试。strip 静默丢弃不属于本 op 的 key,按有效参数执行(模型核心意图仍达成)。
const toolSpaceBaseSchema = z.object({
  op: z.enum(['find', 'page', 'map', 'read', 'replace']).describe(
    parameterDescription({
      description: 'ContextOS 工具空间操作。',
      values: [
        'find：按意图查找工具页。',
        'page：分页读取工具页表。',
        'map：按工具类别结构化展开系统工具地图、完整 toolNames 索引、状态和激活方法。',
        'read：读取指定工具页元数据。',
        'replace：换入/换出工具页，影响后续 AI SDK 暴露的 tools。',
      ],
    })
  ),
})

export const toolSpaceFindSchema = toolSpaceBaseSchema.extend({
  op: z.literal('find'),
  query: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .refine(isChineseOrEnglishToolSearchQuery, {
      message: 'tool_find query 只允许使用中文或英文搜索词；数字和工具名常用符号可以作为辅助内容。',
    })
    .describe(
      parameterDescription({
        description: '要搜索的工具意图、能力名、工具名或任务短语；只接受中文或英文搜索词。',
        usage: ['例如 read document、capture page、生成表格、计划、timeoutMs 1000。'],
      })
    ),
  kind: z
    .enum(['tool', 'capability', 'plugin', 'all'])
    .default('all')
    .describe(parameterDescription({ description: '搜索目标类型。' })),
  categoryIds: z
    .array(toolDiscoveryCategorySchema)
    .max(8)
    .default([])
    .describe(
      parameterDescription({
        description: '只搜索这些工具分类或能力分类；父子分类展开规则由能力描述符提供。',
      })
    ),
  domainIds: z
    .array(toolDiscoveryDomainSchema)
    .max(8)
    .default([])
    .describe(
      parameterDescription({
        description:
          '按 ToolOS v2 能力域过滤；domain 只是产品分类，不是权限边界。',
      })
    ),
  toolOsStates: z
    .array(toolDiscoveryToolOsStateSchema)
    .max(4)
    .default([])
    .describe(
      parameterDescription({
        description:
          '按工具页运行态 toolOsState 过滤：resident/loadable/needs_setup/unavailable。',
      })
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(12)
    .describe(parameterDescription({ description: '最多返回多少张工具页卡片。' })),
  cursor: z
    .string()
    .regex(/^\d+$/)
    .nullable()
    .optional()
    .describe(
      parameterDescription({
        description: '搜索结果游标；第一页省略，后续使用上一次返回的 nextCursor。',
      })
    ),
}).strip()
export const toolSpaceFindMethodSchema = toolSpaceFindSchema.omit({ op: true }).strip()

export const toolSpacePageSchema = toolSpaceBaseSchema.extend({
  op: z.literal('page'),
  kind: z
    .enum(['tool', 'capability', 'plugin', 'all'])
    .default('all')
    .describe(parameterDescription({ description: '分页读取的页类型。' })),
  categoryIds: z
    .array(toolDiscoveryCategorySchema)
    .max(8)
    .default([])
    .describe(
      parameterDescription({
        description: '只读取这些分类里的工具页；父子分类展开规则由能力描述符提供。',
      })
    ),
  domainIds: z
    .array(toolDiscoveryDomainSchema)
    .max(8)
    .default([])
    .describe(parameterDescription({ description: '按 ToolOS v2 能力域过滤工具页。' })),
  toolOsStates: z
    .array(toolDiscoveryToolOsStateSchema)
    .max(4)
    .default([])
    .describe(parameterDescription({ description: '按工具页运行态 toolOsState 过滤工具页。' })),
  limit: z
    .number()
    .int()
    .min(1)
    .max(80)
    .default(24)
    .describe(parameterDescription({ description: '本页最多返回多少张工具页。' })),
  cursor: z
    .string()
    .regex(/^\d+$/)
    .nullable()
    .optional()
    .describe(parameterDescription({ description: '上一页返回的 nextCursor；第一页省略。' })),
}).strip()
export const toolSpacePageMethodSchema = toolSpacePageSchema.omit({ op: true }).strip()

export const toolSpaceMapSchema = toolSpaceBaseSchema.extend({
  op: z.literal('map'),
  kind: z
    .enum(['tool', 'capability', 'plugin', 'all'])
    .default('all')
    .describe(parameterDescription({ description: '地图中包含的页类型。' })),
  categoryIds: z
    .array(toolDiscoveryCategorySchema)
    .max(8)
    .default([])
    .describe(
      parameterDescription({
        description: '只展开这些分类里的工具页；空数组表示当前能力地图。',
      })
    ),
  domainIds: z
    .array(toolDiscoveryDomainSchema)
    .max(8)
    .default([])
    .describe(
      parameterDescription({
        description:
          '按 ToolOS v2 能力域展开工具地图；domain 只是产品分类，不是权限边界。',
      })
    ),
  toolOsStates: z
    .array(toolDiscoveryToolOsStateSchema)
    .max(4)
    .default([])
    .describe(parameterDescription({ description: '按工具页运行态 toolOsState 过滤工具地图。' })),
  categoryLimit: z
    .number()
    .int()
    .min(1)
    .max(12)
    .default(12)
    .describe(
      parameterDescription({
        description:
          '本页最多返回多少个分类；默认 12 一次返回全部分类（每类附完整 toolNames 索引），无需翻页。需要精简时再调小，配 nextCursor 翻页。',
      })
    ),
  cursor: z
    .string()
    .regex(/^\d+$/)
    .nullable()
    .optional()
    .describe(parameterDescription({ description: '上一页返回的 nextCursor；第一页省略。' })),
  maxToolsPerCategory: z
    .number()
    .int()
    .min(1)
    .max(120)
    .default(8)
    .describe(
      parameterDescription({
        description:
          '每个分类最多展开多少个工具页，避免一次返回过大；map 会按 category_row_budget 动态降低实际值，并在返回 filters.parameterAdjusted/parameterAdjustments 中说明。',
      })
    ),
}).strip()
export const toolSpaceMapMethodSchema = toolSpaceMapSchema.omit({ op: true }).strip()

export const toolSpaceReadSchema = toolSpaceBaseSchema.extend({
  op: z.literal('read'),
  ids: z
    .array(z.string().trim().min(1).max(180))
    .min(1)
    .max(12)
    .describe(
      parameterDescription({
        description: '要读取正文的技能页 id：skill:<skill_id>，例如 skill:global:coding-style。',
        notes: [
          'tool_read 只读技能（及未来其他可读资源），不读工具页 schema——需要工具能力用 tool_map 发现、tool_replace 换入。',
        ],
      })
    ),
  detail: z
    .enum(['brief', 'full'])
    .default('brief')
    .describe(
      parameterDescription({
        description: '详情级别。full 时技能页额外返回按需读取说明。',
      })
    ),
}).strip()
export const toolSpaceReadMethodSchema = toolSpaceReadSchema.omit({ op: true }).strip()

const toolSpaceMapQueryMethodSchema = toolSpaceMapMethodSchema
  .extend({ op: z.literal('map').optional() })
  .strip()
const toolSpaceFindQueryMethodSchema = toolSpaceFindMethodSchema
  .extend({ op: z.literal('find') })
  .strip()
const toolSpacePageQueryMethodSchema = toolSpacePageMethodSchema
  .extend({ op: z.literal('page') })
  .strip()
const toolSpaceReadQueryMethodSchema = toolSpaceReadMethodSchema
  .extend({ op: z.literal('read') })
  .strip()

const toolSpaceQueryOperationSchema = z
  .enum(['map', 'find', 'page', 'read'])
  .optional()
  .describe(
    parameterDescription({
      description:
        '查询模式；省略时等同 map。find 按意图搜索，page 分页列页，read 读取指定技能正文（skill:<id>）。',
    })
  )

const toolSpaceQueryMethodObjectSchema = z.object({
  op: toolSpaceQueryOperationSchema,
  query: z
    .string()
    .trim()
    .min(2)
    .max(240)
    .refine((value) => ToolFindQueryHasSearchLanguage.test(value), {
      message: 'tool_find query 必须包含中文或英文搜索词。',
    })
    .refine((value) => ToolFindQueryAllowedCharacters.test(value), {
      message: 'tool_find query 只允许使用中文或英文搜索词；数字和工具名常用符号可以作为辅助内容。',
    })
    .optional()
    .describe(parameterDescription({ description: 'find 模式下要搜索的工具意图、能力名、工具名或任务短语。' })),
  ids: z
    .array(z.string().trim().min(1).max(180))
    .min(1)
    .max(12)
    .optional()
    .describe(parameterDescription({ description: 'read 模式下要读取正文的技能页 id：skill:<skill_id>。' })),
  detail: z
    .enum(['brief', 'full'])
    .optional()
    .describe(parameterDescription({ description: 'read 模式详情级别。' })),
  kind: z
    .enum(['tool', 'capability', 'plugin', 'all'])
    .optional()
    .describe(parameterDescription({ description: 'map/find/page 模式下的页类型过滤。' })),
  categoryIds: z
    .array(toolDiscoveryCategorySchema)
    .max(8)
    .optional()
    .describe(parameterDescription({ description: '按工具分类或能力分类过滤；展开规则由能力描述符提供。' })),
  domainIds: z
    .array(toolDiscoveryDomainSchema)
    .max(8)
    .optional()
    .describe(parameterDescription({ description: '按 ToolOS v2 能力域过滤。' })),
  toolOsStates: z
    .array(toolDiscoveryToolOsStateSchema)
    .max(4)
    .optional()
    .describe(parameterDescription({ description: '按工具页运行态过滤。' })),
  limit: z
    .number()
    .int()
    .min(1)
    .max(80)
    .optional()
    .describe(parameterDescription({ description: 'find/page 模式最多返回多少张工具页。' })),
  cursor: z
    .string()
    .regex(/^\d+$/)
    .nullable()
    .optional()
    .describe(parameterDescription({ description: '上一页返回的 nextCursor；第一页省略。' })),
  categoryLimit: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe(parameterDescription({ description: 'map 模式本页最多返回多少个分类。' })),
  maxToolsPerCategory: z
    .number()
    .int()
    .min(1)
    .max(120)
    .optional()
    .describe(
      parameterDescription({
        description:
          'map/batch 模式每个分类最多展开多少个工具页；map 可能按 category_row_budget 动态降低实际值，并通过 parameterAdjusted/parameterAdjustments 返回调整详情。',
      })
    ),
}).strip()

function stripUndefinedFields(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (isNotUndefined(value)) result[key] = value
  }
  return result
}

function parseToolSpaceQueryByOp(input: z.output<typeof toolSpaceQueryMethodObjectSchema>) {
  // 省略 op 但带了 query → 模型意图就是按短语搜索，按 find 解析。否则默认 map（按分类展开）。
  // 不这样推断的话，tool_map({query}) 会落到严格的 map schema 上被 "Unrecognized key: query" 拒绝，
  // 模型只能白白多花一轮改 op，是高频可观测的失败模式。
  const op = input.op ?? (isNotUndefined(input.query) ? 'find' : 'map')
  const normalized = stripUndefinedFields({ ...input, op })
  switch (op) {
    case 'find':
      return toolSpaceFindQueryMethodSchema.safeParse(normalized)
    case 'page':
      return toolSpacePageQueryMethodSchema.safeParse(normalized)
    case 'read':
      return toolSpaceReadQueryMethodSchema.safeParse(normalized)
    case 'map':
      return toolSpaceMapQueryMethodSchema.safeParse(normalized)
  }
}

export const toolSpaceQueryMethodSchema = toolSpaceQueryMethodObjectSchema.superRefine(
  (input, ctx) => {
    const exactParseResult = parseToolSpaceQueryByOp(input)
    if (exactParseResult.success) return

    for (const issue of exactParseResult.error.issues) {
      ctx.addIssue({
        code: 'custom',
        message: issue.message,
        path: issue.path,
      })
    }
  }
)

export function parseToolSpaceQueryMethodInput(input: unknown): z.output<typeof toolSpaceSchema> {
  const parsed = toolSpaceQueryMethodSchema.parse(input)
  const exactParseResult = parseToolSpaceQueryByOp(parsed)
  if (!exactParseResult.success) throw exactParseResult.error

  const op = 'op' in exactParseResult.data && exactParseResult.data.op
    ? exactParseResult.data.op
    : 'map'
  return toolSpaceSchema.parse({ ...exactParseResult.data, op })
}

export const toolSpaceReplaceSchema = toolSpaceBaseSchema.extend({
  op: z.literal('replace'),
  pageIn: z
    .array(z.string().trim().min(1).max(180))
    .max(8)
    .default([])
    .describe(
      parameterDescription({
        description:
          '要换入的工具页 id。工具页会在后续轮次真实出现在 AI SDK tools 中；插件页会静默启用对应能力。',
      })
    ),
  pageOut: z
    .array(z.string().trim().min(1).max(180))
    .max(8)
    .default([])
    .describe(parameterDescription({ description: '要降低驻留优先级或卸载的工具页 id。' })),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe(parameterDescription({ description: '为什么需要这次工具页替换。' })),
}).strip()
export const toolSpaceReplaceMethodSchema = toolSpaceReplaceSchema
  .omit({ op: true })
  .strip()
  .superRefine((value, issueCtx) => {
    if (!isEmpty(value.pageIn) || !isEmpty(value.pageOut)) return

    issueCtx.addIssue({
      code: 'custom',
      message: 'replace 至少需要 pageIn 或 pageOut 一个目标。',
      path: ['pageIn'],
    })
  })

const toolBatchSchema = z.object({
  action: z
    .enum(['plan', 'discover', 'import', 'replace', 'remove'])
    .describe(parameterDescription({ description: '批量工具管理动作。' })),
  queries: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(240)
        .refine(isChineseOrEnglishToolSearchQuery, {
          message:
            'tool_batch queries 只允许使用中文或英文搜索词；数字和工具名常用符号可以作为辅助内容。',
        })
    )
    .max(6)
    .default([])
    .describe(parameterDescription({ description: '批量搜索的任务意图、工具名或能力名。' })),
  categoryIds: z
    .array(toolDiscoveryCategorySchema)
    .max(8)
    .default([])
    .describe(parameterDescription({ description: '要批量发现、导入或移除的工具分类。' })),
  domainIds: z
    .array(toolDiscoveryDomainSchema)
    .max(8)
    .default([])
    .describe(
      parameterDescription({
        description:
          '要批量发现、导入或移除的 ToolOS v2 能力域；domain 不是权限边界，会展开为现有工具分类。',
      })
    ),
  toolOsStates: z
    .array(toolDiscoveryToolOsStateSchema)
    .max(4)
    .default([])
    .describe(
      parameterDescription({
        description:
          '要批量匹配的工具页运行态 toolOsState；常用于一次性发现 loadable 或 needs_setup 页。',
      })
    ),
  pageIds: z
    .array(z.string().trim().min(1).max(180))
    .max(20)
    .default([])
    .describe(parameterDescription({ description: '要批量导入、替换或移除的工具页 id。' })),
  pageIn: z
    .array(z.string().trim().min(1).max(180))
    .max(20)
    .default([])
    .describe(parameterDescription({ description: '显式换入的工具页 id。' })),
  pageOut: z
    .array(z.string().trim().min(1).max(180))
    .max(20)
    .default([])
    .describe(parameterDescription({ description: '显式换出的工具页 id。' })),
  kinds: z
    .array(toolDiscoveryKindSchema)
    .max(3)
    .default(['tool', 'capability', 'plugin'])
    .describe(parameterDescription({ description: '批量匹配的页类型。' })),
  maxMatchesPerQuery: z
    .number()
    .int()
    .min(1)
    .max(12)
    .default(4)
    .describe(parameterDescription({ description: '每个 query 最多导入或返回多少个候选页。' })),
  maxToolsPerCategory: z
    .number()
    .int()
    .min(1)
    .max(40)
    .default(12)
    .describe(
      parameterDescription({
        description:
          '每个分类最多返回多少个工具页；map 路径可能按 category_row_budget 动态降低实际值，并通过 parameterAdjusted/parameterAdjustments 返回调整详情。',
      })
    ),
  dryRun: z
    .boolean()
    .default(false)
    .describe(parameterDescription({ description: '为 true 时只计划，不改变会话工具状态。' })),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(240)
    .describe(parameterDescription({ description: '为什么需要这次批量工具管理。' })),
}).strip()

export const toolBatchMethodSchema = toolBatchSchema.superRefine((value, issueCtx) => {
  const targetCount =
    value.queries.length +
    value.categoryIds.length +
    value.domainIds.length +
    value.toolOsStates.length +
    value.pageIds.length +
    value.pageIn.length +
    value.pageOut.length
  if (targetCount > 0) return
  issueCtx.addIssue({
    code: 'custom',
    message:
      'tool_batch 至少需要 queries、categoryIds、domainIds、toolOsStates、pageIds、pageIn 或 pageOut 一个目标。',
    path: ['queries'],
  })
})

export const toolSpaceSchema = z.discriminatedUnion('op', [
  toolSpaceFindSchema,
  toolSpacePageSchema,
  toolSpaceMapSchema,
  toolSpaceReadSchema,
  toolSpaceReplaceSchema,
])

export type ToolSpaceInput = z.input<typeof toolSpaceSchema>
export type ToolSpaceFindInput = z.output<typeof toolSpaceFindSchema>
export type ToolSpacePageInput = z.output<typeof toolSpacePageSchema>
export type ToolSpaceMapInput = z.output<typeof toolSpaceMapSchema>
export type ToolSpaceReadInput = z.output<typeof toolSpaceReadSchema>
export type ToolSpaceReplaceInput = z.output<typeof toolSpaceReplaceSchema>
export type ToolBatchInput = z.output<typeof toolBatchMethodSchema>
export type ToolSpaceOperationInput = z.output<typeof toolSpaceSchema>
