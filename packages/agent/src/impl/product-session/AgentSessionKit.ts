// 产品会话的归档信封与权限规则：只做数据判定，不碰任何存储。
import type { AgentPermissionAction, AgentPermissionRequest, AgentPermissionRule, AgentSessionArchiveEnvelope, RequestAgentPermissionInput } from '../../types/product-session'
import { createAgentSessionArchiveEnvelope, parseAgentSessionArchiveEnvelope } from '../../utils/product-session/archive'
import { evaluateAgentPermissionRules, normalizeAgentPermissionRequest } from '../../utils/product-session/permissions'

/**
 * 产品 Session 的两件纯数据能力：归档信封的构造与解析、权限规则的归一与判定。
 *
 * 归档信封是跨版本可读的落盘格式，schema 版本在 `AgentProtocolVersions.sessionArchiveSchema`；
 * 权限规则按「最后一条命中的规则说了算」判定。无状态，进程内共用一份。
 */
export interface AgentSessionKitApi {
  /** 把一次会话导出折成归档信封。 */
  createArchiveEnvelope<TSession, TResource, TEvent>(input: {
  readonly productId: string
  readonly productSchemaVersion: number
  readonly exportedAt: string
  readonly sanitized: boolean
  readonly session: TSession
  readonly resources: readonly TResource[]
  readonly events: readonly TEvent[]
}): AgentSessionArchiveEnvelope<TSession, TResource, TEvent>
  /** 解析一份归档信封；版本或形状不对按错误码抛。 */
  parseArchiveEnvelope(input: unknown, options?: {
  readonly expectedProductId?: string
  readonly maximumResources?: number
  readonly maximumEvents?: number
}): AgentSessionArchiveEnvelope<unknown>
  /** 把一次权限请求归一成规则匹配用的形状。 */
  normalizePermissionRequest<TMode extends string>(input: RequestAgentPermissionInput<TMode>, options?: { nextId?: () => string; now?: () => number }): AgentPermissionRequest<TMode>
  /** 按规则表判一次权限请求；最后一条命中的规则说了算。 */
  evaluatePermissionRules<TMode extends string>(request: AgentPermissionRequest<TMode>, rules: readonly AgentPermissionRule[], defaultDecision: (request: AgentPermissionRequest<TMode>) => AgentPermissionAction): { readonly action: AgentPermissionAction; readonly source: 'built-in' | 'rule' }
}

/** 方法逐个转调 utils/product-session 里的纯函数；这里只负责把它们收成一件对外能力。 */
class AgentSessionKit implements AgentSessionKitApi {
  public createArchiveEnvelope<TSession, TResource, TEvent>(input: {
  readonly productId: string
  readonly productSchemaVersion: number
  readonly exportedAt: string
  readonly sanitized: boolean
  readonly session: TSession
  readonly resources: readonly TResource[]
  readonly events: readonly TEvent[]
}): AgentSessionArchiveEnvelope<TSession, TResource, TEvent> {
    return createAgentSessionArchiveEnvelope(input)
  }

  public parseArchiveEnvelope(input: unknown, options?: {
  readonly expectedProductId?: string
  readonly maximumResources?: number
  readonly maximumEvents?: number
}): AgentSessionArchiveEnvelope<unknown> {
    return parseAgentSessionArchiveEnvelope(input, options)
  }

  public normalizePermissionRequest<TMode extends string>(input: RequestAgentPermissionInput<TMode>, options?: { nextId?: () => string; now?: () => number }): AgentPermissionRequest<TMode> {
    return normalizeAgentPermissionRequest(input, options)
  }

  public evaluatePermissionRules<TMode extends string>(request: AgentPermissionRequest<TMode>, rules: readonly AgentPermissionRule[], defaultDecision: (request: AgentPermissionRequest<TMode>) => AgentPermissionAction): { readonly action: AgentPermissionAction; readonly source: 'built-in' | 'rule' } {
    return evaluateAgentPermissionRules(request, rules, defaultDecision)
  }
}

/** 产品会话的归档与权限判定面（无状态，进程内共用一份）。 */
export const agentSessionKit: AgentSessionKitApi = new AgentSessionKit()
