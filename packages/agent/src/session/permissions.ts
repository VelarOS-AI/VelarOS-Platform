import { randomUUID } from 'node:crypto'

export type AgentPermissionReply = 'once' | 'session' | 'always' | 'reject'
export type AgentPermissionAction = 'allow' | 'deny' | 'ask'
export type AgentPermissionRisk = 'low' | 'high'

export interface AgentPermissionRule {
  readonly permission: string
  readonly pattern: string
  readonly action: AgentPermissionAction
}

export interface AgentPermissionRequest<TMode extends string = string> {
  readonly id: string
  readonly sessionId: string
  readonly projectRoot: string
  readonly mode: TMode
  readonly permission: string
  readonly toolName: string
  readonly patterns: readonly string[]
  readonly alwaysPatterns: readonly string[]
  readonly readOnly: boolean
  readonly risk: AgentPermissionRisk
  readonly metadata: Readonly<Record<string, unknown>>
  readonly createdAt: number
}

export interface RequestAgentPermissionInput<TMode extends string = string> {
  readonly id?: string
  readonly sessionId: string
  readonly projectRoot: string
  readonly mode: TMode
  readonly permission: string
  readonly toolName: string
  readonly patterns?: readonly string[]
  readonly alwaysPatterns?: readonly string[]
  readonly readOnly: boolean
  readonly risk?: AgentPermissionRisk
  readonly metadata?: Readonly<Record<string, unknown>>
}

export function normalizeAgentPermissionRequest<TMode extends string>(
  input: RequestAgentPermissionInput<TMode>,
  options: { nextId?: () => string; now?: () => number } = {}
): AgentPermissionRequest<TMode> {
  const permission = requireNonEmpty(input.permission, 'permission')
  const toolName = requireNonEmpty(input.toolName, 'toolName')
  const patterns = normalizeAgentPermissionPatterns(input.patterns)
  const alwaysPatterns = normalizeAgentPermissionPatterns(input.alwaysPatterns ?? patterns)
  return Object.freeze({
    id: input.id?.trim() || (options.nextId ?? randomUUID)(),
    sessionId: requireNonEmpty(input.sessionId, 'sessionId'),
    projectRoot: requireNonEmpty(input.projectRoot, 'projectRoot'),
    mode: input.mode,
    permission,
    toolName,
    patterns,
    alwaysPatterns,
    readOnly: input.readOnly,
    risk: input.risk ?? (input.readOnly ? 'low' : 'high'),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    createdAt: (options.now ?? Date.now)(),
  })
}

/**
 * deny dominates ask, ask dominates allow; product injects its own default policy while Platform owns
 * deterministic wildcard/rule precedence.
 */
export function evaluateAgentPermissionRules<TMode extends string>(
  request: AgentPermissionRequest<TMode>,
  rules: readonly AgentPermissionRule[],
  defaultDecision: (request: AgentPermissionRequest<TMode>) => AgentPermissionAction
): { readonly action: AgentPermissionAction; readonly source: 'built-in' | 'rule' } {
  let sawAsk = false
  for (const pattern of request.patterns) {
    const rule = findLastMatchingAgentPermissionRule(rules, request.permission, pattern)
    if (!rule) {
      const builtIn = defaultDecision(request)
      if (builtIn === 'deny') return { action: 'deny', source: 'built-in' }
      if (builtIn === 'ask') sawAsk = true
      continue
    }
    if (rule.action === 'deny') return { action: 'deny', source: 'rule' }
    if (rule.action === 'ask') sawAsk = true
  }
  return {
    action: sawAsk ? 'ask' : 'allow',
    source: rules.length > 0 ? 'rule' : 'built-in',
  }
}

export function findLastMatchingAgentPermissionRule(
  rules: readonly AgentPermissionRule[],
  permission: string,
  pattern: string
): AgentPermissionRule | null {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!
    if (
      agentPermissionWildcardMatch(permission, rule.permission)
      && agentPermissionWildcardMatch(pattern, rule.pattern)
    ) return rule
  }
  return null
}

export function agentPermissionWildcardMatch(value: string, pattern: string): boolean {
  if (pattern === '*') return true
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'u').test(value)
}

export function normalizeAgentPermissionPatterns(
  patterns: readonly string[] | undefined
): readonly string[] {
  const normalized = [...new Set((patterns ?? ['*']).map((pattern) => pattern.trim()).filter(Boolean))]
  return Object.freeze(normalized.length > 0 ? normalized : ['*'])
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} cannot be empty.`)
  return normalized
}
