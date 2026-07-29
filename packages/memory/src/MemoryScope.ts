/**
 * Memory owns its serialized scope identity. Hosts decide which product
 * context maps to which scope and pass the resolved value through adapters.
 */
export type MemoryScopeId = string

export const GLOBAL_MEMORY_SCOPE = 'global'
export const SYSTEM_MEMORY_SCOPE = 'system'

export function scopeTypeForScopeId(
  scopeId: LooseOptional<string>
): 'global' | 'workspace' | 'site' | 'system' {
  const normalized = scopeId?.trim() ?? ''
  if (normalized.startsWith('project:')) return 'workspace'
  if (normalized.startsWith('site:')) return 'site'
  if (normalized === SYSTEM_MEMORY_SCOPE) return 'system'
  return 'global'
}

export function buildProjectMemoryScope(
  root: LooseOptional<string>
): MemoryScopeId {
  const normalized = root?.trim()
  return normalized ? `project:${normalized}` : SYSTEM_MEMORY_SCOPE
}

export function buildSiteMemoryScope(
  origin: LooseOptional<string>
): MemoryScopeId {
  const normalized = origin?.trim()
  return normalized ? `site:${normalized}` : SYSTEM_MEMORY_SCOPE
}
