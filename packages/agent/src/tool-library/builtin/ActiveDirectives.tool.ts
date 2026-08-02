import { z } from 'zod'

import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { renderParameterDescription as parameterDescription } from '@velaros-ai/core/utils/ToolDescription'

import { defineVelaTool } from '../defineVelaTool'

import {
  ActiveDirectiveLimits,
  type ActiveDirectiveType,
  buildNoArchiveDiagnostic,
  directiveTypeSchema,
  getDirectiveType,
  isActiveDirectiveArtifact,
  matchesDirectiveTitle,
  resolveDirectiveArtifactId,
} from './ActiveDirectives'

const listActiveDirectives = defineVelaTool<Record<string, never>>({
  name: 'directive:list',
  role: 'inspect',
  category: 'general',
  summary: '列出当前 session 上下文保护区中仍然生效的用户长期指令。',
  suitable: ['需要确认本 session 已固定且不能被历史压缩丢失的禁令、偏好、流程或需求约束。'],
  forbidden: ['不要把普通保留上下文或跨 session 偏好当成 active directive。'],
  usage: ['无需参数；只返回 metadata.directive=true 的 session 约束。'],
  examples: [{}],
  notes: ['用于取消或更新约束前的检查。'],
  schema: z.object({}),
  permissions: [],
  isConcurrencySafe: () => true,
  execute: async (_input, ctx) => {
    const artifacts = await ctx.activeContext.listActiveContextArtifacts({
      status: 'active',
      kinds: ['requirement'],
    })
    const directives = artifacts.filter(isActiveDirectiveArtifact)

    return {
      directives,
      count: directives.length,
    }
  },
})

const upsertActiveDirective = defineVelaTool<{
  id?: string
  title: string
  content: string
  directiveType: ActiveDirectiveType
  sourceMessageId?: string
}>({
  name: 'directive:upsert',
  role: 'control',
  category: 'general',
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
    `最多同时保护 ${ActiveDirectiveLimits.maxActive} 条；用户取消后用 directive:archive 归档。`,
  ],
  schema: z.object({
    id: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        parameterDescription({
          description: '可选稳定 ID；更新同一约束时复用。',
        })
      ),
    title: z
      .string()
      .min(1)
      .max(160)
      .describe(
        parameterDescription({
          description: '约束标题，简短描述用户固定的规则。',
        })
      ),
    content: z
      .string()
      .min(1)
      .max(1000)
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
      .max(120)
      .optional()
      .describe(
        parameterDescription({
          description: '触发该约束的用户消息 ID；没有时省略。',
        })
      ),
  }),
  permissions: [],
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    const artifacts = await ctx.activeContext.listActiveContextArtifacts({
      status: 'all',
      kinds: ['requirement'],
    })
    const id = resolveDirectiveArtifactId(input, artifacts)
    const existing = artifacts.find((artifact) => artifact.id === id)
    if (existing && !isActiveDirectiveArtifact(existing)) {
      throw new AppError(
        'VALIDATION',
        `Active directive id conflicts with non-directive active context: ${id}`
      )
    }

    const activeDirectives = artifacts.filter(
      (artifact) => artifact.status === 'active' && isActiveDirectiveArtifact(artifact)
    )
    if (
      existing?.status !== 'active' &&
      activeDirectives.length >= ActiveDirectiveLimits.maxActive
    ) {
      throw new AppError(
        'VALIDATION',
        `Context protection area already contains ${ActiveDirectiveLimits.maxActive} active directives. Archive or merge one before adding another.`
      )
    }

    const directive = await ctx.activeContext.upsertActiveContextArtifact({
      id,
      kind: 'requirement',
      scope: 'session',
      status: 'active',
      title: input.title,
      content: input.content,
      sourceMessageId: input.sourceMessageId,
      metadata: {
        directive: true,
        directiveType: input.directiveType,
      },
    })

    return {
      directive,
      updated: true,
    }
  },
})

const archiveActiveDirective = defineVelaTool<{
  ids?: string[]
  title?: string
  directiveType?: ActiveDirectiveType
}>({
  name: 'directive:archive',
  role: 'control',
  category: 'general',
  summary: '取消当前 session 上下文保护区中一个或多个已固定的长期指令。',
  suitable: ['用户明确说取消限制、不需要禁令、以后可以、刚才那条不要固定。'],
  forbidden: ['不要归档普通 active context；只处理 metadata.directive=true 的条目。'],
  usage: ['session directive；goal.constraints 用 goal:update。'],
  examples: [{ title: '禁止自动重建索引' }, { directiveType: 'prohibition' }],
  notes: ['归档 session directive；goal.constraints 用 goal:update。'],
  schema: z
    .object({
      ids: z
        .array(z.string().min(1).max(120))
        .min(1)
        .max(20)
        .optional()
        .describe(
          parameterDescription({
            description: '要归档的 directive id 列表。',
          })
        ),
      title: z
        .string()
        .min(1)
        .max(160)
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
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => {
    const idSet = new Set(input.ids ?? [])
    const title = input.title?.trim() || null
    const artifacts = await ctx.activeContext.listActiveContextArtifacts({
      status: 'active',
      kinds: ['requirement'],
    })
    const matchingIds = artifacts
      .filter(isActiveDirectiveArtifact)
      .filter((artifact) => !idSet.size || idSet.has(artifact.id))
      .filter((artifact) => matchesDirectiveTitle(artifact, title))
      .filter(
        (artifact) => !input.directiveType || getDirectiveType(artifact) === input.directiveType
      )
      .map((artifact) => artifact.id)

    if (isEmpty(matchingIds)) return {
        archivedIds: [],
        archivedCount: 0,
        directives: [],
        diagnostic: buildNoArchiveDiagnostic(input, artifacts),
      }

    const directives = await ctx.activeContext.archiveActiveContextArtifacts({
      ids: matchingIds,
    })

    return {
      archivedIds: matchingIds,
      archivedCount: matchingIds.length,
      directives,
    }
  },
})

const activeDirectiveTools = {
  'directive:list': listActiveDirectives,
  'directive:upsert': upsertActiveDirective,
  'directive:archive': archiveActiveDirective,
}

export { activeDirectiveTools }
