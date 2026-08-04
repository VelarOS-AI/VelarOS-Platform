import { createHash } from 'node:crypto'

import { z } from 'zod'

import type {
  ActiveContextArchiveFilter,
  ActiveContextArtifact,
  ActiveContextArtifactKind,
  ActiveContextArtifactStatus,
  ActiveContextListOptions,
  ActiveContextUpsertInput,
  ActiveDirectiveArchiveInput,
  ActiveDirectiveType,
  ActiveDirectiveUpsertInput,
} from '@velaros-ai/agent/protocol'
import { isArray, isEmpty, isPlainObject, isString, isTrue } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

const directiveTypeSchema = z.enum(['prohibition', 'preference', 'process', 'requirement', 'other'])

const ActiveDirectiveLimits = {
  maxActive: 8,
} as const

interface ActiveDirectiveContext {
  listActiveContextArtifacts(options?: ActiveContextListOptions): Promise<ActiveContextArtifact[]>
  upsertActiveContextArtifact(input: ActiveContextUpsertInput): Promise<ActiveContextArtifact>
  archiveActiveContextArtifacts(
    filter: ActiveContextArchiveFilter
  ): Promise<ActiveContextArtifact[]>
}

interface ActiveDirectiveArchiveResult {
  archivedIds: string[]
  archivedCount: number
  directives: ActiveContextArtifact[]
  diagnostic?: ReturnType<typeof buildNoArchiveDiagnostic>
}

interface ActiveDirectiveMetadata {
  directive?: unknown
  directiveType?: unknown
}

interface GoalConstraintReference {
  goalId: string
  constraintId: string
  title: Nullable<string>
}

function getDirectiveMetadata(artifact: ActiveContextArtifact): ActiveDirectiveMetadata {
  return isPlainObject(artifact.metadata) ? artifact.metadata : {}
}

function isActiveDirectiveArtifact(artifact: ActiveContextArtifact): boolean {
  return artifact.kind === 'requirement' && isTrue(getDirectiveMetadata(artifact).directive)
}

function getDirectiveType(artifact: ActiveContextArtifact): Nullable<ActiveDirectiveType> {
  const raw = getDirectiveMetadata(artifact).directiveType
  const parsed = directiveTypeSchema.safeParse(raw)

  return parsed.success ? parsed.data : null
}

function normalizeDirectiveIdentity(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ')
}

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

function matchesDirectiveTitle(artifact: ActiveContextArtifact, title: Nullable<string>): boolean {
  if (!title) return true

  return artifact.title.toLowerCase().includes(title.toLowerCase())
}

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

function buildNoArchiveDiagnostic(input: { ids?: string[] }, artifacts: ActiveContextArtifact[]) {
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
      `Active directive id conflicts with non-directive active context: ${id}`
    )
  }

  const activeDirectives = artifacts.filter(
    (artifact) => artifact.status === 'active' && isActiveDirectiveArtifact(artifact)
  )
  if (existing?.status !== 'active' && activeDirectives.length >= ActiveDirectiveLimits.maxActive) {
    throw new AppError(
      'VALIDATION',
      `Context protection area already contains ${ActiveDirectiveLimits.maxActive} active directives. Archive or merge one before adding another.`
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

export {
  type ActiveDirectiveArchiveResult,
  type ActiveDirectiveContext,
  ActiveDirectiveLimits,
  type ActiveDirectiveType,
  archiveActiveDirectives,
  buildNoArchiveDiagnostic,
  createDirectiveArtifactId,
  directiveTypeSchema,
  getDirectiveType,
  isActiveDirectiveArtifact,
  listActiveDirectives,
  matchesDirectiveTitle,
  resolveDirectiveArtifactId,
  upsertActiveDirective,
}
