import { isBoolean, optionalWhen, toNullable, toOptional } from '@velaros-ai/core'

import type { SubAgentSessionRecord, TeamModelRouteCategory, ThinkingDepth, ToolCategoryId } from '../../types/agent.js'
import type { ResolvedSubAgentTypeConfig, SubAgentDispatchRequest, TeamModelRouteResult } from '../../types/delegation.js'

import { dedupeToolCategories, normalizeResumeIdentityString, sameStringSet } from './dispatcher'

/**
 * 续跑时把线程首次派发用的参数补回这次请求里：本次没写的字段一律沿用线程存下来的那份。
 *
 * 续跑的提示词通常只写追加任务，类型 / 工具面 / 模型这些都指望「和上次一样」；不补回来，
 * 身份校验会当场判定不一致而拒绝续跑。自定义 agent 优先还原它的 id（存下来的 subagent_type 只是它的 base）。
 */
export function buildResumeDispatchRequest(
  request: SubAgentDispatchRequest,
  session: SubAgentSessionRecord
): SubAgentDispatchRequest {
  const storedRequest = session.request
  const storedToolCategories = storedRequest.tool_categories
    ? [...storedRequest.tool_categories]
    : undefined
  const storedReadonly = optionalWhen(isBoolean, storedRequest.readonly)
  return {
    ...request,
    input: {
      ...request.input,
      // 自定义 agent 会话续跑时优先还原 custom id（stored subagent_type 只是它的 base）。
      subagentType:
        request.input.subagentType ??
        toOptional(storedRequest.custom_agent_id) ??
        storedRequest.subagent_type,
      toolScope: request.input.toolScope ?? storedRequest.tool_scope ?? 'type_default',
      toolCategories: request.input.toolCategories ?? storedToolCategories,
      readonly: isBoolean(request.input.readonly) ? request.input.readonly : storedReadonly,
      model: request.input.model ?? toOptional(storedRequest.model),
      effort: request.input.effort ?? toOptional(storedRequest.effort),
      routeCategory: request.input.routeCategory ?? toOptional(storedRequest.route_category),
    },
  }
}

/**
 * 只读派发要用的类型配置：把资源写租约范围抹成 null。
 *
 * 只读的 worker 本来就不写，占着写租约只会白白挡住别的 worker。非只读时原样返回。
 */
export function resolveEffectiveSubAgentTypeConfig(
  base: ResolvedSubAgentTypeConfig,
  readonlyMode: boolean
): ResolvedSubAgentTypeConfig {
  if (!readonlyMode) return base
  return { ...base, resourceLeaseScope: null }
}

/** 派发时展示与记账用的类型键：自定义 agent 用它自己的 id，内置类型用类型名。熔断账本与状态事件都按它认「同一类」。 */
export function resolveSubAgentTypeKey(typeConfig: ResolvedSubAgentTypeConfig): string {
  return typeConfig.customAgentId ?? typeConfig.subagentType
}

/** 这次派发按哪个模型路由类别走：请求里写了就听请求的，没写用类型配置的缺省。续跑身份校验也比对它。 */
export function resolveSubAgentRouteCategory(
  request: SubAgentDispatchRequest,
  typeConfig: ResolvedSubAgentTypeConfig
): TeamModelRouteCategory {
  return request.input.routeCategory ?? typeConfig.routeCategory
}

/**
 * 把派发面指定的模型覆盖进路由的运行期覆盖字段。
 *
 * 覆盖值空白（没指定、或只写了空格）时原样返回路由，保持继承主模型的行为。
 */
export function applySubAgentModelOverride(
  route: TeamModelRouteResult,
  modelOverride: LooseOptional<string>
): TeamModelRouteResult {
  const normalized = modelOverride?.trim()
  if (!normalized) return route
  return {
    ...route,
    runtimeOverride: {
      ...route.runtimeOverride,
      model: normalized,
    },
  }
}

/**
 * 把派发面指定的 reasoning effort 覆盖进路由的 `runtimeOverride.thinkingDepth`。
 *
 * 该字段供执行环建 provider 与拼系统提示词用。缺省（null/undefined）时原样返回，
 * 保留模型路由已填的会话 effort——不覆盖就是继承。
 */
export function applySubAgentEffortOverride(
  route: TeamModelRouteResult,
  effortOverride: LooseOptional<ThinkingDepth>
): TeamModelRouteResult {
  if (!effortOverride) return route
  return {
    ...route,
    runtimeOverride: {
      ...route.runtimeOverride,
      thinkingDepth: effortOverride,
    },
  }
}

/**
 * 这次派发给子 Agent 开哪些工具类别，由请求里的 `tool_scope` 决定。
 *
 * `inherit` 抄父 Agent 此刻已启用的；`custom` 用请求点名的那些；其余（含缺省 `type_default`）用类型配置自带的。
 * 三条路都会去重，交给下游的一定是干净清单。
 */
export function resolveInitialSubAgentToolCategories(
  request: SubAgentDispatchRequest,
  typeConfig: ResolvedSubAgentTypeConfig
): ToolCategoryId[] {
  switch (request.input.toolScope ?? 'type_default') {
    case 'inherit':
      return dedupeToolCategories(request.parentCtx.codingSession.getEnabledToolCategories())
    case 'custom':
      return dedupeToolCategories(request.input.toolCategories ?? [])
    case 'type_default':
    default:
      return dedupeToolCategories([...typeConfig.toolCategories])
  }
}

/**
 * 逐项比对续跑请求与线程首次派发时的身份；不一致就返回给父 Agent 看的拒绝文案，全一致返回 null。
 *
 * 续跑 = 复用一段既有对话历史，任何一项（父会话 / 资源 / 类型 / 自定义 agent / readonly / tool_scope /
 * 工具分类 / model / route_category）对不上，都意味着这段历史是在另一套前提下产生的，接着跑会让模型带着
 * 错误前提干活——那类错误既不报错也不好查，所以宁可拒绝并要求新派。
 * **刻意不比对执行**：线程本来就要跨执行续跑，同一父会话下一轮换个 executionId 是常态。
 */
export function validateSubAgentResumeIdentity(
  request: SubAgentDispatchRequest,
  threadId: string,
  session: SubAgentSessionRecord,
  typeConfig: ResolvedSubAgentTypeConfig,
  readonlyMode: boolean,
  toolCategories: readonly ToolCategoryId[]
): Nullable<string> {
  const reject = (reason: string): string =>
    `不能续跑子智能体 ${threadId}：${reason}。请新派发一个子 Agent。`

  if (session.parent_session_id !== request.parentCtx.sessionId) return reject(
      `threadId 属于 parent session "${session.parent_session_id}"，当前 parent session 是 "${request.parentCtx.sessionId}"`
    )

  const storedResource = normalizeResumeIdentityString(session.resource_id)
  const currentResource = normalizeResumeIdentityString(request.parentCtx.resourceId)
  if (storedResource !== currentResource) return reject(
      `threadId 是在资源 "${storedResource || '（无）'}" 上派发的，当前资源是 "${currentResource || '（无）'}"`
    )

  if (session.subagent_type !== typeConfig.subagentType) return reject(
      `threadId 属于 sub-agent type "${session.subagent_type}"，当前请求是 "${typeConfig.subagentType}"`
    )

  const storedCustomAgentId = toNullable(session.request.custom_agent_id)
  const currentCustomAgentId = toNullable(typeConfig.customAgentId)
  if (storedCustomAgentId !== currentCustomAgentId) return reject(
      `threadId 属于自定义 agent "${storedCustomAgentId ?? '（无）'}"，当前请求是 "${currentCustomAgentId ?? '（无）'}"`
    )

  const storedRequest = session.request
  const storedReadonly = isBoolean(storedRequest.readonly)
    ? storedRequest.readonly
    : typeConfig.readonlyDefault
  if (storedReadonly !== readonlyMode) return reject(
      `threadId 的 readonly=${storedReadonly}，当前请求 readonly=${readonlyMode}`
    )

  const storedToolScope = storedRequest.tool_scope ?? 'type_default'
  const currentToolScope = request.input.toolScope ?? 'type_default'
  if (storedToolScope !== currentToolScope) return reject(
      `threadId 使用 tool_scope "${storedToolScope}"，当前请求是 "${currentToolScope}"`
    )

  const storedToolCategories = storedRequest.tool_categories ?? []
  if (!sameStringSet(storedToolCategories, toolCategories)) return reject(
      `threadId 使用工具分类 "${storedToolCategories.join(', ')}"，当前请求是 "${toolCategories.join(', ')}"`
    )

  const storedModel = normalizeResumeIdentityString(storedRequest.model)
  const currentModel = normalizeResumeIdentityString(request.input.model)
  if (storedModel !== currentModel) return reject(
      `threadId 使用 model "${storedModel || 'default'}"，当前请求是 "${currentModel || 'default'}"`
    )

  const storedRouteCategory = storedRequest.route_category ?? typeConfig.routeCategory
  const currentRouteCategory = resolveSubAgentRouteCategory(request, typeConfig)
  if (storedRouteCategory !== currentRouteCategory) return reject(
      `threadId 使用 route_category "${storedRouteCategory}"，当前请求是 "${currentRouteCategory}"`
    )

  return null
}
