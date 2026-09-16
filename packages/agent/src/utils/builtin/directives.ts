// 域：会话级长期指令（`directive:*` 三个工具）的纯逻辑：身份归并、匹配、上限判定与读写编排。
//
// 这里只认「活动上下文条目」这个接口，不认宿主：所有函数都收调用方传进来的 `ActiveDirectiveContext`。
import { createHash } from 'node:crypto'

import { z } from 'zod'

import { isArray, isEmpty, isPlainObject, isString, isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { AgentToolLimits } from '../../contract/constants.js'
import type { ActiveContextArtifact, ActiveContextArtifactKind, ActiveContextArtifactStatus, ActiveDirectiveArchiveInput, ActiveDirectiveType, ActiveDirectiveUpsertInput } from '../../types/agent.js'
import type { ActiveDirectiveArchiveDiagnostic, ActiveDirectiveArchiveResult, ActiveDirectiveContext, ActiveDirectiveMetadata, GoalConstraintReference } from '../../types/builtin.js'


export const directiveTypeSchema: z.ZodType<ActiveDirectiveType> = z.enum([
  'prohibition',
  'preference',
  'process',
  'requirement',
  'other',
])

/** 长期指令的条数上限；值在 AgentToolLimits.directives.maxActive，模型在工具说明里看得到。 */
export const ActiveDirectiveLimits: { readonly maxActive: number } = Object.freeze({
  maxActive: AgentToolLimits.directives.maxActive,
})

/** 读一条活动上下文条目的指令元数据；不是对象就当空表。 */
function getDirectiveMetadata(artifact: ActiveContextArtifact): ActiveDirectiveMetadata {
  return isPlainObject(artifact.metadata) ? artifact.metadata : {}
}

/** 判断一条活动上下文条目是不是长期指令（kind=requirement 且 metadata.directive 为真）。 */
function isActiveDirectiveArtifact(artifact: ActiveContextArtifact): boolean {
  return artifact.kind === 'requirement' && isTrue(getDirectiveMetadata(artifact).directive)
}

/** 读一条指令的类型；元数据里的值不合法时返回 null。 */
function getDirectiveType(artifact: ActiveContextArtifact): Nullable<ActiveDirectiveType> {
  const raw = getDirectiveMetadata(artifact).directiveType
  const parsed = directiveTypeSchema.safeParse(raw)

  return parsed.success ? parsed.data : null
}

/** 把指令标题归一成可比较的身份串：NFKC、去首尾空白、折叠空格、转小写。 */
function normalizeDirectiveIdentity(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ')
}

/** 由归一化后的身份串派生稳定的 artifact id。 */
function createDirectiveArtifactId(value: string): string {
  const digest = createHash('sha256')
    .update(normalizeDirectiveIdentity(value))
    .digest('hex')
    .slice(0, 24)

  return `active-directive:${digest}`
}

/**
 * 指令 id 归并：**调用方传的 id 不会被原样当作 artifact id**（这是最容易踩的一点）。
 *
 * 三段判定，顺序即优先级：
 *  1. 传了 id 且**确实存在**这条 artifact → 就用它（更新既有指令）；
 *  2. 没传 id → 按归一化标题找既有同名指令（活跃优先、其次最近更新）→ 复用其 id。
 *     这一段是幂等的关键：模型重述同一条指令时不该长出第二份。
 *  3. 都不命中 → 由 `id:<传入值>` 或 `title:<标题>` 派生**哈希 id**。
 * 第 3 段决定了"传一个没见过的 id"得到的是该 id 的哈希而非该 id 本身——好处是同一个陌生 id
 * 反复调用稳定收敛到同一条 artifact，坏处是调用方不能假设自己能指定字面 id。
 * 标题归一（NFKC + 折叠空白 + 小写）让全角/半角、多空格的同一句话归到一条。
 */
function resolveDirectiveArtifactId(
  input: { id?: string; title: string },
  artifacts: ActiveContextArtifact[]
): string {
  const requestedId = input.id?.trim()
  if (requestedId && artifacts.some((artifact) => artifact.id === requestedId)) return requestedId

  if (!requestedId) {
    const normalizedTitle = normalizeDirectiveIdentity(input.title)
    const existingByTitle = artifacts
      .filter(
        (artifact) =>
          isActiveDirectiveArtifact(artifact) &&
          normalizeDirectiveIdentity(artifact.title) === normalizedTitle
      )
      .sort((left, right) => {
        if (left.status === 'active' && right.status !== 'active') return -1
        if (left.status !== 'active' && right.status === 'active') return 1
        return right.updatedAt - left.updatedAt
      })[0]
    if (existingByTitle) return existingByTitle.id
  }

  return createDirectiveArtifactId(requestedId ? `id:${requestedId}` : `title:${input.title}`)
}

/** 按标题子串匹配一条指令；没给标题时一律算命中。 */
function matchesDirectiveTitle(artifact: ActiveContextArtifact, title: Nullable<string>): boolean {
  if (!title) return true

  return artifact.title.toLowerCase().includes(title.toLowerCase())
}

/** 从一条目标条目里找出与给定 id 集合相交的约束引用，用来解释「这些 id 是目标约束不是指令」。 */
function readGoalConstraintReferences(
  artifact: ActiveContextArtifact,
  idSet: ReadonlySet<string>
): GoalConstraintReference[] {
  const metadata = artifact.metadata
  if (!isPlainObject(metadata)) return []

  const constraints = metadata.constraints
  if (!isTrue(metadata.goal) || !isArray(constraints)) return []

  return constraints.flatMap((constraint): GoalConstraintReference[] => {
    if (!isPlainObject(constraint)) return []

    const constraintId = constraint.id
    if (!isString(constraintId)) return []
    if (!idSet.has(constraintId)) return []

    const title = constraint.title
    return [
      {
        goalId: artifact.id,
        constraintId,
        title: isString(title) ? title : null,
      },
    ]
  })
}

/** 归档一条都没命中时，说清楚是撞上了目标约束还是本来就没有这条 session 指令。 */
function buildNoArchiveDiagnostic(
  input: { ids?: string[] },
  artifacts: ActiveContextArtifact[]
): ActiveDirectiveArchiveDiagnostic {
  const requestedIds = input.ids ?? []
  const idSet = new Set(requestedIds)
  const goalConstraintReferences =
    idSet.size > 0
      ? artifacts.flatMap((artifact) => readGoalConstraintReferences(artifact, idSet))
      : []

  if (!isEmpty(goalConstraintReferences))
    return {
      reason: 'goal_constraint' as const,
      unmatchedIds: requestedIds,
      possibleGoalConstraintIds: goalConstraintReferences.map(
        (reference) => reference.constraintId
      ),
      goalConstraintReferences,
      message:
        '这些 id 匹配当前 goal.constraints，而不是 session-level active directive；directive:archive 只归档 metadata.directive=true 的 session directive。请用 goal:update 修改或移除目标 constraints。',
    }

  return {
    reason: 'no_matching_session_directive' as const,
    unmatchedIds: requestedIds,
    possibleGoalConstraintIds: [],
    goalConstraintReferences: [],
    message:
      '没有匹配到 active session directive；directive:archive 只处理 metadata.directive=true 的 session requirement。若要修改目标约束，请使用 goal:update。',
  }
}

/** 列出当前会话里仍然生效的长期指令。 */
async function listActiveDirectives(
  context: ActiveDirectiveContext,
  status: ActiveContextArtifactStatus | 'all' = 'active'
): Promise<ActiveContextArtifact[]> {
  const artifacts = await context.listActiveContextArtifacts({
    status,
    kinds: ['requirement'] satisfies ActiveContextArtifactKind[],
  })
  return artifacts.filter(isActiveDirectiveArtifact)
}

/** 写入或更新一条长期指令；撞上非指令条目或超出条数上限时抛错。 */
async function upsertActiveDirective(
  context: ActiveDirectiveContext,
  input: ActiveDirectiveUpsertInput
): Promise<ActiveContextArtifact> {
  const artifacts = await context.listActiveContextArtifacts({
    status: 'all',
  })
  const id = resolveDirectiveArtifactId(input, artifacts)
  const existing = artifacts.find((artifact) => artifact.id === id)
  if (existing && !isActiveDirectiveArtifact(existing)) {
    throw new AppError(
      'VALIDATION',
      `活动指令 id ${id} 与一条非指令的活动上下文撞车：这个 id 上已经存在别的活动上下文条目（例如决策记录），指令不能顶掉它。换一个 id，或者先把那条已有条目归档。`
    )
  }

  const activeDirectives = artifacts.filter(
    (artifact) => artifact.status === 'active' && isActiveDirectiveArtifact(artifact)
  )
  if (existing?.status !== 'active' && activeDirectives.length >= ActiveDirectiveLimits.maxActive) {
    throw new AppError(
      'VALIDATION',
      `上下文保护区里已经有 ${ActiveDirectiveLimits.maxActive} 条活动指令，到达上限，加不进新的。先归档或合并掉其中一条，再添加。`
    )
  }

  return context.upsertActiveContextArtifact({
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
}

/** 按 id、标题或类型归档长期指令；一条都没命中时带上诊断说明。 */
async function archiveActiveDirectives(
  context: ActiveDirectiveContext,
  input: ActiveDirectiveArchiveInput
): Promise<ActiveDirectiveArchiveResult> {
  const idSet = new Set(input.ids ?? [])
  const title = input.title?.trim() || null
  const artifacts = await context.listActiveContextArtifacts({
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

  if (isEmpty(matchingIds))
    return {
      archivedIds: [],
      archivedCount: 0,
      directives: [],
      diagnostic: buildNoArchiveDiagnostic(input, artifacts),
    }

  const directives = await context.archiveActiveContextArtifacts({
    ids: matchingIds,
  })
  return {
    archivedIds: matchingIds,
    archivedCount: matchingIds.length,
    directives,
  }
}

export { archiveActiveDirectives, buildNoArchiveDiagnostic, createDirectiveArtifactId, getDirectiveType, isActiveDirectiveArtifact, listActiveDirectives, matchesDirectiveTitle, resolveDirectiveArtifactId, upsertActiveDirective }
