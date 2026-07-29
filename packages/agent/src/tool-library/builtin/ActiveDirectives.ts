import { createHash } from 'node:crypto'

import { z } from 'zod'

import { isArray, isEmpty,isObject, isString, isTrue } from '@velaros-ai/core'
import type { ActiveContextArtifact } from '@velaros-ai/core/types'

const directiveTypeSchema = z.enum([
  'prohibition',
  'preference',
  'process',
  'requirement',
  'other',
])

type ActiveDirectiveType = z.infer<typeof directiveTypeSchema>

const ActiveDirectiveLimits = {
  maxActive: 8,
} as const

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
  return isObject(artifact.metadata) ? (artifact.metadata as ActiveDirectiveMetadata) : {}
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

  return createDirectiveArtifactId(
    requestedId ? `id:${requestedId}` : `title:${input.title}`
  )
}

function matchesDirectiveTitle(
  artifact: ActiveContextArtifact,
  title: Nullable<string>
): boolean {
  if (!title) return true

  return artifact.title.toLowerCase().includes(title.toLowerCase())
}

function readGoalConstraintReferences(
  artifact: ActiveContextArtifact,
  idSet: ReadonlySet<string>
): GoalConstraintReference[] {
  const metadata = artifact.metadata
  if (!isObject(metadata)) return []

  const metadataRecord = metadata as Record<string, unknown>
  const constraints = metadataRecord.constraints
  if (!isTrue(metadataRecord.goal) || !isArray(constraints)) return []

  return constraints.flatMap((constraint): GoalConstraintReference[] => {
    if (!isObject(constraint)) return []

    const constraintRecord = constraint as Record<string, unknown>
    const constraintId = constraintRecord.id
    if (!isString(constraintId)) return []
    if (!idSet.has(constraintId)) return []

    const title = constraintRecord.title
    return [{
      goalId: artifact.id,
      constraintId,
      title: isString(title) ? title : null,
    }]
  })
}

function buildNoArchiveDiagnostic(
  input: { ids?: string[] },
  artifacts: ActiveContextArtifact[]
) {
  const requestedIds = input.ids ?? []
  const idSet = new Set(requestedIds)
  const goalConstraintReferences = idSet.size > 0
    ? artifacts.flatMap((artifact) => readGoalConstraintReferences(artifact, idSet))
    : []

  if (!isEmpty(goalConstraintReferences)) return {
      reason: 'goal_constraint' as const,
      unmatchedIds: requestedIds,
      possibleGoalConstraintIds: goalConstraintReferences.map((reference) => reference.constraintId),
      goalConstraintReferences,
      message:
        '这些 id 匹配当前 goal.constraints，而不是 session-level active directive；archive_active_directive 只归档 metadata.directive=true 的 session directive。请用 update_goal 修改或移除目标 constraints。',
    }

  return {
    reason: 'no_matching_session_directive' as const,
    unmatchedIds: requestedIds,
    possibleGoalConstraintIds: [],
    goalConstraintReferences: [],
    message:
      '没有匹配到 active session directive；archive_active_directive 只处理 metadata.directive=true 的 session requirement。若要修改目标约束，请使用 update_goal。',
  }
}

export {
  ActiveDirectiveLimits,
  type ActiveDirectiveType,
  buildNoArchiveDiagnostic,
  createDirectiveArtifactId,
  directiveTypeSchema,
  getDirectiveType,
  isActiveDirectiveArtifact,
  matchesDirectiveTitle,
  resolveDirectiveArtifactId,
}
