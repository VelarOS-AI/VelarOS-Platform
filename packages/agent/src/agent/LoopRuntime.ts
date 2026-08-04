import type { ModelMessage } from 'ai'

import type {
  AgentDelegationContract,
  AgentModelInputModality,
  AgentRoleExpectedOutputKind,
  AgentRoleId,
  ToolAvailabilityScope,
  ToolCategoryId,
  ToolCategoryOverview,
  ToolDescriptor,
} from '@velaros-ai/agent/protocol'
import {
  isArray,
  isEmpty,
  isFunction,
  isObject,
  isPresent,
  isString,
  toNullable,
  truncate,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { AgentRuntimeCapabilityPorts } from '../capabilities'

import type { AgentRoleResolution } from './RoleTypes'

interface SubAgentOptionsLike {
  toolCategories?: ToolCategoryId[]
  allowedTools?: string[]
  identity?: string
  contextEpochScope?: LooseOptional<string>
  context?: string
  roleId?: AgentRoleId
  delegation?: AgentDelegationContract
  streamTextDeltas?: boolean
  turnCapDisabled?: boolean
  requestToolCategories?: (
    categories: ToolCategoryId[],
    reason: string,
    options?: { childRoleId?: AgentRoleId }
  ) => Promise<SubAgentToolCategoryRequestResult>
}

interface ResolveSubAgentDelegationArgs {
  task: string
  opts: SubAgentOptionsLike
  parentRoleId: AgentRoleId
}

interface ResolveSubAgentToolScopeArgs {
  delegation: AgentDelegationContract
  authorizedToolNames?: readonly string[]
  roleResolution: Pick<AgentRoleResolution, 'allowedTools' | 'enabledToolCategories' | 'label'>
  getToolNamesForCategories: (categories: ToolCategoryId[]) => string[]
  getAllowedSubAgentTools: (tools?: string[]) => string[]
  getToolCategoryId: (toolName: string) => Nullable<ToolCategoryId>
  blockedToolNames?: readonly string[]
  blockedCategoryIds?: readonly ToolCategoryId[]
}

interface SubAgentToolScope {
  allowedTools: string[]
  allowedCategories: ToolCategoryId[]
}

interface SubAgentContextBase {
  abortSignal: AbortSignal
  log: unknown
  role: {
    id: AgentRoleId
    label: string
    description: string
    nextAllowedRoles: AgentRoleId[]
  }
  /** enabled=本轮可执行，all=当前运行态可用全集，catalog=注册目录全集。 */
  listTools(scope?: ToolAvailabilityScope): ToolDescriptor[]
  /** enabled=本轮可执行，all=当前运行态可用全集，catalog=注册目录全集。 */
  listToolCategories(scope?: ToolAvailabilityScope): ToolCategoryOverview[]
  listCapabilityPages?: () => unknown[]
  getEnabledToolCategories(): ToolCategoryId[]
  getCurrentVisibleToolNames(): string[]
  setCurrentVisibleToolNames(toolNames: string[]): void
  getSupportedModelInputModalities(): readonly AgentModelInputModality[]
  setSupportedModelInputModalities(modalities: readonly AgentModelInputModality[]): void
  system?: unknown
  getCurrentVisibleToolSurfaceProfile?(toolName: string): unknown
  setCurrentVisibleToolSurfaceProfiles?(profiles: Record<string, unknown>): void
  codingSession: {
    enableToolCategories(categories: ToolCategoryId[], reason?: string): ToolCategoryId[]
    getEnabledToolCategories(): ToolCategoryId[]
    getEnabledPromptFeatures?: () => unknown[]
    hasToolCategoryAccess(category: ToolCategoryId): boolean
  }
  query(task: string, opts?: unknown): Promise<string>
  requestToolCategoryAccess?: (
    categories: ToolCategoryId[],
    reason: string
  ) => Promise<SubAgentToolCategoryRequestResult>
  capabilityPorts?: AgentRuntimeCapabilityPorts
}

interface SubAgentToolCategoryRequestResult {
  enabled: boolean
  approved: boolean
  autoApproved?: boolean
  reason?: string
  requestedCategories: ToolCategoryId[]
  enabledCategories: ToolCategoryId[]
  skippedCategories: ToolCategoryId[]
  message: string
}

interface CreateSubAgentContextArgs<TContext extends SubAgentContextBase> {
  parentCtx: TContext
  roleResolution: Pick<
    AgentRoleResolution,
    'id' | 'label' | 'description' | 'nextAllowedRoles' | 'allowedTools'
  >
  allowedTools: readonly string[]
  allowedCategories: readonly ToolCategoryId[]
  getAllowedSubAgentTools: (tools?: string[]) => string[]
  getToolNamesForCategories: (categories: ToolCategoryId[]) => string[]
  log: TContext['log']
  requestToolCategories?: SubAgentOptionsLike['requestToolCategories']
  blockedToolNames?: readonly string[]
  blockedCategoryIds?: readonly ToolCategoryId[]
}

interface ResolveSoloLoopToolsArgs {
  configuredTools?: readonly string[]
  roleAllowedTools: readonly string[]
  enabledToolNames: Iterable<string>
}

type BackgroundCommandSystemBoundary = {
  canStartBackgroundCommands: () => boolean
}

function createSubAgentSystemBoundary<TContext extends SubAgentContextBase>(
  parentCtx: TContext
): TContext['system'] {
  const system = parentCtx.system
  if (!system || !isObject(system)) return system

  const backgroundBoundary = system as Partial<BackgroundCommandSystemBoundary>
  if (!isFunction(backgroundBoundary.canStartBackgroundCommands)) return system

  const boundedSystem = Object.create(Object.getPrototypeOf(system)) as Record<string, unknown>
  Object.assign(boundedSystem, system)
  boundedSystem.canStartBackgroundCommands = () => false

  return boundedSystem
}

/** 无显式合约时，从 query 参数构造最小委派合约。 */
function resolveSubAgentDelegation(args: ResolveSubAgentDelegationArgs): AgentDelegationContract {
  if (args.opts.delegation) return args.opts.delegation

  const targetRoleId = args.opts.roleId ?? 'operator'
  return {
    title: truncate(args.task, 60),
    objective: args.task,
    targetRoleId,
    authorizedContext: args.opts.context?.trim(),
    authorizedToolCategories: args.opts.toolCategories ?? [],
    expectedOutput: resolveExpectedOutput(targetRoleId),
    canDelegateFurther: false,
    delegatedByRoleId: args.parentRoleId,
    identity: args.opts.identity?.trim() || undefined,
  }
}

/** 把委派合约渲染为子 Agent 的第一条 user 指令。 */
function buildSubAgentInstruction(contract: AgentDelegationContract): string {
  return [
    '这是一项由上游角色委派的固定子任务。',
    '你只能基于下方授权上下文和授权工具分类完成任务，不要自行扩展边界。',
    `目标角色：${contract.targetRoleId}`,
    `期望产出：${contract.expectedOutput}`,
    !isEmpty(contract.authorizedToolCategories)
      ? `授权工具分类：${contract.authorizedToolCategories.join(', ')}`
      : '授权工具分类：未额外收缩，使用该角色默认可用能力',
    contract.authorizedContext ? `授权上下文：\n${contract.authorizedContext}` : null,
    `任务：\n${contract.objective}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 根据委派合约和目标角色收窄子 Agent 的工具及类别边界。 */
function resolveSubAgentToolScope(args: ResolveSubAgentToolScopeArgs): SubAgentToolScope {
  const blockedToolNames = new Set(args.blockedToolNames ?? [])
  const blockedCategoryIds = new Set(args.blockedCategoryIds ?? [])
  const hasExplicitAuthorizedCategories = !isEmpty(args.delegation.authorizedToolCategories)
  const authorizedToolNames = [
    ...new Set(
      (args.authorizedToolNames ?? [])
        .map((toolName) => toolName.trim())
        .filter(Boolean)
    ),
  ]
  const hasExplicitAuthorizedTools = !isEmpty(authorizedToolNames)
  const authorizedToolCategories = args.delegation.authorizedToolCategories.filter(
    (categoryId) => !blockedCategoryIds.has(categoryId)
  )
  const baseAllowedTools = hasExplicitAuthorizedTools
    ? args.getAllowedSubAgentTools(authorizedToolNames)
    : hasExplicitAuthorizedCategories
      ? args.getAllowedSubAgentTools(args.getToolNamesForCategories(authorizedToolCategories))
      : args.getAllowedSubAgentTools([...args.roleResolution.allowedTools])

  const allowedTools = baseAllowedTools.filter((toolName) => {
    if (blockedToolNames.has(toolName)) return false
    const categoryId = args.getToolCategoryId(toolName)
    if (categoryId && blockedCategoryIds.has(categoryId)) return false
    if (hasExplicitAuthorizedTools) return true
    return (
      args.roleResolution.allowedTools.includes(toolName)
    )
  })
  if (!isEmpty(authorizedToolCategories) && isEmpty(allowedTools)) {
    throw new AppError(
      'VALIDATION',
      `目标角色 ${args.roleResolution.label} 当前拿不到请求的工具分类：${authorizedToolCategories.join(', ')}`
    )
  }

  const allowedCategories = hasExplicitAuthorizedTools
    ? [
        ...new Set(
          [
            ...authorizedToolCategories,
            ...allowedTools
              .map((toolName) => args.getToolCategoryId(toolName))
              .filter((categoryId): categoryId is ToolCategoryId => !!categoryId),
          ].filter((categoryId) => !blockedCategoryIds.has(categoryId))
        ),
      ]
    : args.roleResolution.enabledToolCategories.filter(
        (categoryId) =>
          !blockedCategoryIds.has(categoryId) &&
          allowedTools.some((toolName) => args.getToolCategoryId(toolName) === categoryId)
      )

  return { allowedTools, allowedCategories }
}

/**
 * 组装子 Agent 宿主上下文；继承父上下文，但替换角色、工具可见性和 query 边界。
 *
 * 隔离边界约定：
 * - 这里的展开**有意共享持久基底**（资源端口/服务/abortSignal 等），并显式覆盖
 *   角色、工具可见性与递归 query。
 * - 易变的 agent 运行态（如 codingSession 追踪器）应由调用方在进入子 loop 前
 *   先行隔离（见 AgentRunner.query 的 forkForSubAgent），不要依赖此处的浅展开来共享。
 *   新增任何「按子 Agent 应当独立」的可变字段时，需在 query 入口处显式处理，
 *   避免静默经由展开被父子共享。
 */
function createSubAgentContext<TContext extends SubAgentContextBase>(
  args: CreateSubAgentContextArgs<TContext>
): TContext {
  const blockedToolNames = new Set(args.blockedToolNames ?? [])
  const blockedCategoryIds = new Set(args.blockedCategoryIds ?? [])
  const allowedToolSet = new Set(
    args.allowedTools.filter((toolName) => !blockedToolNames.has(toolName))
  )
  const allowedCategorySet = new Set(args.allowedCategories)
  const roleToolSet = new Set(
    args
      .getAllowedSubAgentTools([...args.roleResolution.allowedTools])
      .filter((toolName) => !blockedToolNames.has(toolName))
  )
  let supportedModelInputModalities = [...args.parentCtx.getSupportedModelInputModalities()]
  const expandAllowedToolsForCategories = (categories: readonly ToolCategoryId[]): void => {
    const enabledCategories = categories.filter(
      (categoryId) => !blockedCategoryIds.has(categoryId)
    )
    const nextToolNames = args.getAllowedSubAgentTools(
      args.getToolNamesForCategories(enabledCategories)
    )
    nextToolNames.forEach((toolName) => {
      if (roleToolSet.has(toolName)) {
        allowedToolSet.add(toolName)
      }
    })
  }

  const requestToolCategoryAccess = async (
    categories: ToolCategoryId[],
    reason: string
  ): Promise<SubAgentToolCategoryRequestResult> => {
    const expandedCategories = [
      ...new Set(
        categories.filter((categoryId) => !!categoryId)
      ),
    ]
    const blockedCategories = expandedCategories.filter((categoryId) => blockedCategoryIds.has(categoryId))
    const requestedCategories = expandedCategories.filter(
      (categoryId) => !blockedCategoryIds.has(categoryId)
    )

    if (isEmpty(expandedCategories)) return {
        enabled: false,
        approved: false,
        reason,
        requestedCategories,
        enabledCategories: args.parentCtx.codingSession.getEnabledToolCategories(),
        skippedCategories: [],
        message: '没有请求任何工具分类。',
      }

    if (isEmpty(requestedCategories)) return {
        enabled: false,
        approved: false,
        reason,
        requestedCategories: expandedCategories,
        enabledCategories: args.parentCtx.codingSession.getEnabledToolCategories(),
        skippedCategories: expandedCategories,
        message: `子 Agent 不开放这些工具分类：${blockedCategories.join(', ')}。`,
      }

    if (!args.requestToolCategories) return {
        enabled: false,
        approved: false,
        reason,
        requestedCategories: expandedCategories,
        enabledCategories: args.parentCtx.codingSession.getEnabledToolCategories(),
        skippedCategories: expandedCategories,
        message: '父上下文未提供子 Agent 工具授权通道。',
      }

    const decision = await args.requestToolCategories(requestedCategories, reason, {
      childRoleId: args.roleResolution.id,
    })
    if (!decision.approved) return decision

    const approvedCategories = requestedCategories.filter(
      (categoryId) => !decision.skippedCategories.includes(categoryId)
    )
    if (!isEmpty(approvedCategories)) {
      approvedCategories.forEach((categoryId) => allowedCategorySet.add(categoryId))
      expandAllowedToolsForCategories(approvedCategories)
      args.parentCtx.codingSession.enableToolCategories(approvedCategories, reason)
    }

    return {
      ...decision,
      enabled: !isEmpty(approvedCategories),
      requestedCategories: expandedCategories,
      enabledCategories: args.parentCtx.codingSession.getEnabledToolCategories(),
      skippedCategories: [...blockedCategories, ...decision.skippedCategories],
    }
  }

  return {
    ...args.parentCtx,
    system: createSubAgentSystemBoundary(args.parentCtx),
    log: args.log,
    role: {
      id: args.roleResolution.id,
      label: args.roleResolution.label,
      description: args.roleResolution.description,
      nextAllowedRoles: [...args.roleResolution.nextAllowedRoles],
    },
    listTools: (scope = 'enabled') => {
      const visible = args.parentCtx.listTools(scope)
      return visible.filter((tool) =>
        scope === 'enabled' ? allowedToolSet.has(tool.name) : roleToolSet.has(tool.name)
      )
    },
    listToolCategories: (scope = 'enabled') => {
      const visible = args.parentCtx.listToolCategories(scope)
      return visible
        .map((category) => {
          const tools = category.tools.filter((tool) =>
            scope === 'enabled' ? allowedToolSet.has(tool.name) : roleToolSet.has(tool.name)
          )
          return {
            ...category,
            enabled:
              allowedCategorySet.has(category.category.id) &&
              args.parentCtx.codingSession.hasToolCategoryAccess(category.category.id),
            tools,
          }
        })
        .filter(
          (category) =>
            !blockedCategoryIds.has(category.category.id) && !isEmpty(category.tools)
        )
    },
    getEnabledToolCategories: () => [...allowedCategorySet],
    getCurrentVisibleToolNames: () => [...allowedToolSet],
    getSupportedModelInputModalities: () => [...supportedModelInputModalities],
    setSupportedModelInputModalities: (modalities) => {
      supportedModelInputModalities = [...new Set(modalities)]
    },
    listCapabilityPages: undefined,
    setCurrentVisibleToolNames: () => {
      // 子 Agent 的工具边界由 delegation scope 固定，不能在子上下文内扩大。
    },
    getCurrentVisibleToolSurfaceProfile: (toolName: string) =>
      toNullable(args.parentCtx.getCurrentVisibleToolSurfaceProfile?.(toolName)),
    setCurrentVisibleToolSurfaceProfiles: () => {
      // 子 Agent 的 surface 边界由父上下文实际暴露结果决定。
    },
    dispatchSubAgent: undefined,
    requestToolCategoryAccess,
    query: async () => {
      throw new AppError('VALIDATION', 'Sub-agent cannot spawn further agents')
    },
  }
}

/** Solo loop 每轮根据 profile 和当前启用类别计算模型实际可见工具。 */
function resolveSoloLoopTools(args: ResolveSoloLoopToolsArgs): string[] {
  const enabledToolNames = new Set(args.enabledToolNames)
  const profileAllowedTools = args.configuredTools
    ? args.configuredTools.filter((toolName) => args.roleAllowedTools.includes(toolName))
    : [...args.roleAllowedTools]

  return profileAllowedTools.filter((toolName) => enabledToolNames.has(toolName))
}

/** 从 assistant 消息里提取纯文本，用于 maxSteps 错误摘要。 */
function extractAssistantText(message?: ModelMessage): string {
  if (!message || message.role !== 'assistant') return ''

  if (isString(message.content)) return message.content

  if (!isArray(message.content)) return ''

  return message.content
    .filter((part): part is { type: 'text'; text: string } => {
      if (!isObject(part) || !isPresent(part)) return false
      const record = part as { type?: unknown; text?: unknown }
      return record.type === 'text' && isString(record.text)
    })
    .map((part) => part.text)
    .join(' ')
}

/** 按角色决定默认期望产出类型。 */
function resolveExpectedOutput(roleId: AgentRoleId): AgentRoleExpectedOutputKind {
  switch (roleId) {
    case 'coder':
      return 'implementation'
    case 'architect':
      return 'plan'
    case 'chat':
      return 'conversation'
    default:
      return 'task-result'
  }
}

export {
  buildSubAgentInstruction,
  createSubAgentContext,
  extractAssistantText,
  resolveSoloLoopTools,
  resolveSubAgentDelegation,
  resolveSubAgentToolScope,
}
export type {
  CreateSubAgentContextArgs,
  ResolveSoloLoopToolsArgs,
  ResolveSubAgentDelegationArgs,
  ResolveSubAgentToolScopeArgs,
  SubAgentContextBase,
  SubAgentOptionsLike,
  SubAgentToolScope,
}
