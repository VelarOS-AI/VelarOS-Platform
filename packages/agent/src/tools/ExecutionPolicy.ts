// 域：工具执行的**策略与审批门**（安全门层，工具真正跑起来之前的最后一道判定）。
//
// **为什么门在这一层**：工具实体自己不做许可判定——判定要看会话、空间、角色、运行档与用户
// 授权状态，这些工具实体一概不该知道。把门收在这里，工具库才能保持「纯能力」，也才能保证
// **绕不过去**：Executor 的顺序契约把本门钉在 `tool-call:before` seam 之后、执行之前
// （见 `./Executor.ts` 导览的「顺序」不变量）。
//
// ## 判定链（每一环都可能终止执行）
//  1. **可用性**（空间/角色/运行档是否允许该工具出现）；
//  2. **能力域与作用域**（该工具要动的资源是否在本会话已授权范围内）；
//  3. **审批**（破坏性/越界操作要用户点头；自动批准只在显式声明的档发生并留通知）；
//  4. **参数与前置条件**。
//
// ## 关键不变量（改这些会破什么）
//  - **默认拒绝**：判定不出结论按拒绝（fail-closed）。任何「拿不到策略就放行」= 门变装饰。
//  - **拒绝要可读**：诊断必须让模型/用户知道**怎么补救**（缺哪个授权、该换哪个空间），
//    否则模型只会原样重试。
//  - **自动批准必须留痕**（`CapabilityAutoApprovalNotice`）：无痕迹的自动批准等于没有审批。
//  - **本门不认识 mod**：mod 贡献在装载期已被宿主收窄，到这里与内置工具同权。
import type {
  AgentModelInputModality,
  AgentRoleId,
  CapabilityAutoApprovalNotice,
  CapabilityScopeId,
  RunProfileSelectionId,
  ToolAvailabilityScope,
  ToolCapabilityEffectKind,
  ToolCapabilitySchema,
  ToolCategoryId,
  ToolConfirmationDecisionOptions,
  ToolPermission,
  ToolRole,
  ToolSurfaceProfileId,
} from '@velaros-ai/agent/protocol'
import { isPlainObject, optionalWhenLazy, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ScopedLog } from '@velaros-ai/core/logger'
import { logRuntime } from '@velaros-ai/core/logger'

import { getToolSurfaceFallbackChain } from '../agent/RuntimeProfiles'
import {
  type AgentRuntimeCapabilityPorts,
  resolveCapabilityCategoryDefinitions,
  resolveToolAliases,
  resolveToolValidationHintProviders,
} from '../capabilities'

import { decideToolCategoryAccess } from './access-policy'
import {
  buildExecutionFailureResult,
  buildToolFailureResult,
  type ToolFailureResult,
} from './ExecutionPolicyFailures'
import { buildToolSpaceRecoveryGuide } from './tool-space-recovery'
import {
  toolArgsSchemaValidator,
  type ToolArgsValidationResult,
  type ToolSchema,
} from './ToolArgsSchemaValidator'

type ToolVisibleSurfaceProfileId = ToolSurfaceProfileId | 'base'

interface ToolExecutionPolicySurface<TSurfaceInput = any, TBaseInput = any> {
  schema: ToolSchema<TSurfaceInput>
  normalize?: (input: TSurfaceInput, context: any) => TBaseInput
}

interface ToolExecutionPolicyTool<TInput = any> {
  schema: ToolSchema<TInput>
  surfaces?: Partial<Record<ToolSurfaceProfileId, ToolExecutionPolicySurface<any, TInput>>>
  permissions?: readonly ToolPermission[]
  capabilities?: ToolCapabilitySchema
  execute(input: TInput, context: ToolExecutionPolicyContext): Promise<unknown> | unknown
  isConcurrencySafe?: (input: Record<string, unknown>) => boolean
}

interface ToolExecutionPolicyRegistry {
  get(toolName: string): LooseOptional<ToolExecutionPolicyTool<any>>
  getRegistrationSignature?: (toolName: string) => LooseOptional<string>
  /**
   * 从 turn 快照背后的可变注册表读取当前签名。
   * getRegistrationSignature 保留 provider 曝光时的冻结值；此方法在执行前检测替换/卸载。
   */
  getCurrentRegistrationSignature?: (toolName: string) => LooseOptional<string>
  listAvailable(
    toolContext: unknown,
    allowList?: string[],
    scope?: ToolAvailabilityScope
  ): Array<{ name: string }>
  getDescriptor(
    toolName: string
  ): LooseOptional<{
    categoryId?: ToolCategoryId
    capabilities?: ToolCapabilitySchema
    role?: ToolRole
    outputInline?: boolean
    requiredModelInputModalities?: readonly AgentModelInputModality[]
  }>
}

interface ToolExecutionPolicyCodingSession {
  recordToolResult(toolName: string, output: unknown): void
  recordToolCallResult?: (toolName: string, args: Record<string, unknown>, output: unknown) => void
  recordInvisibleToolCall?: (toolName: string) => void
  getRedundantToolCallMessage: (
    toolName: string,
    args: Record<string, unknown>
  ) => LooseOptional<string>
  consumePendingAutoApprovalNotice: (
    categoryId: ToolCategoryId
  ) => LooseOptional<CapabilityAutoApprovalNotice>
  hasSessionToolCategoryApproval: (categoryId: ToolCategoryId) => boolean
  grantSessionToolCategoryApproval?: (categoryId: ToolCategoryId) => unknown
  getToolSurfaceProfile: () => ToolSurfaceProfileId
  setToolSurfaceProfile: (profile: ToolSurfaceProfileId, reason?: string) => ToolSurfaceProfileId
  getRunProfile: () => RunProfileSelectionId
  setRunProfile: (profile: RunProfileSelectionId, reason?: string) => RunProfileSelectionId
  /** 会话声明/切换后的当前能力作用域；可选——缺失时回退运行态推断。 */
  getActiveCapabilityScope?: () => CapabilityScopeId
}

interface ToolExecutionPolicyExecution {
  awaitConfirmationDecision(
    message: string,
    abortSignal: AbortSignal,
    options?: ToolConfirmationDecisionOptions
  ): Promise<{
    approved: boolean
    message?: LooseOptional<string>
  }>
}

interface ToolExecutionPolicyContext {
  /** Original model call identity for host approval and durable tool execution. */
  toolCallId?: string
  abortSignal: AbortSignal
  log: ScopedLog
  planningMode?: boolean
  codingSession: ToolExecutionPolicyCodingSession
  /** Concrete capability behavior is supplied by the composition root. */
  capabilityPorts?: AgentRuntimeCapabilityPorts
  role: { id: AgentRoleId }
  getCurrentVisibleToolSurfaceProfile: (
    toolName: string
  ) => LooseOptional<ToolVisibleSurfaceProfileId>
  getCurrentVisibleToolNames?: () => string[]
  resolveCurrentVisibleCanonicalToolName?: (providerToolName: string) => LooseOptional<string>
  getCurrentVisibleToolRegistrationSignature?: (toolName: string) => LooseOptional<string>
  execution: LooseOptional<ToolExecutionPolicyExecution>
  emitProgress?: (chunk: string) => void
  updateMetadata?: (payload: { title?: string; metadata?: Record<string, unknown> }) => void
}

type AnyVelaTool = ToolExecutionPolicyTool<any>

interface ToolExecutionRequest {
  /** 模型生成的 tool call id。 */
  toolCallId: string
  /** 工具名。 */
  toolName: string
  /** 模型生成的工具参数。 */
  args?: Record<string, unknown>
  /** 本轮基础 ToolContext。 */
  baseContext: ToolExecutionPolicyContext
  /** 当前工具独立的取消信号。 */
  abortSignal: AbortSignal
  /** 当前 tool call 的进度回调，由 ToolExecutor 按 toolCallId 绑定。 */
  emitProgress?: (chunk: string) => void
  /** 当前 tool call 的结构化展示元数据回调，由 ToolExecutor 按 toolCallId 绑定。 */
  updateMetadata?: (payload: { title?: string; metadata?: Record<string, unknown> }) => void
  /** Registry 可用性过滤范围；普通调用只允许 enabled，反射代理可请求 all 以覆盖 loadable 工具。 */
  availabilityScope?: ToolAvailabilityScope
}

interface ToolExecutionPrepared {
  /** Registry 中实际执行的 canonical 工具名。 */
  toolName: string
  /** 通过 Registry 找到的工具定义。 */
  tool: AnyVelaTool
  /** 模型发出调用时激活的工具表面；为空则使用主 schema。 */
  selectedSurface?: LooseOptional<ToolExecutionPolicySurface<any, any>>
  /** 为当前工具覆写过 log/abortSignal 的上下文。 */
  toolContext: ToolExecutionPolicyContext
}

type ToolExecutionDecision =
  | {
      allowed: true
      prepared: ToolExecutionPrepared
    }
  | {
      allowed: false
      error: string
      /** 若模型工具名已修复为 canonical 名，这里用于失败结果继续使用同一个名字。 */
      toolName?: string
    }

interface ToolExecutionSuccessInput {
  toolName: string
  args: Record<string, unknown>
  output: unknown
  toolContext: ToolExecutionPolicyContext
}

interface ToolExecutionFailureInput {
  toolName: string
  error: AppError
  isConcurrencySafe: boolean
}

/**
 * 工具执行策略。
 *
 * ToolExecutor 负责排队和并发；本类负责单个工具“能不能执行、怎样执行”：
 * - 查工具是否存在。
 * - 做上下文可见性/权限过滤。
 * - 检测重复工具调用。
 * - 执行 zod 参数校验。
 * - 处理会话级工具类别授权。
 * - 记录 coding session 状态和 sibling cancel 策略。
 */
class ToolExecutionPolicy {
  /** 会话级类别审批的扩展点；默认不再使用粗类别审批，避免低风险能力反复阻塞。 */
  private readonly sessionApprovalToolCategories = new Set<ToolCategoryId>()
  private readonly log = logRuntime.tag('ToolExecutionPolicy')

  constructor(private readonly toolRegistry: ToolExecutionPolicyRegistry) {}

  /**
   * 修复 provider 偶发的工具名大小写漂移，并接住旧会话残留的历史工具名。
   *
   * 部分模型会把 `bash` 这类已注入工具名输出成 `Bash`。这里只在原名不存在、
   * lower-case 名称确实存在时修复，避免把两个真实不同名的工具错误合并。
   */
  public resolveCanonicalToolName(
    toolName: string,
    capabilityPorts?: AgentRuntimeCapabilityPorts,
    context?: Pick<ToolExecutionPolicyContext, 'resolveCurrentVisibleCanonicalToolName'>
  ): string {
    if (this.toolRegistry.get(toolName)) return toolName

    const transportedName = context?.resolveCurrentVisibleCanonicalToolName?.(toolName)
    if (transportedName && this.toolRegistry.get(transportedName)) return transportedName

    const lowerName = toolName.toLowerCase()
    if (lowerName !== toolName && this.toolRegistry.get(lowerName)) return lowerName

    const aliasedName = resolveToolAliases(capabilityPorts)[lowerName]
    if (aliasedName && this.toolRegistry.get(aliasedName)) return aliasedName

    return toolName
  }

  private resolveToolSurface(
    tool: AnyVelaTool,
    context: ToolExecutionPolicyContext,
    toolName: string
  ): LooseOptional<ToolExecutionPolicySurface<any, any>> {
    const visibleSurfaceProfile = context.getCurrentVisibleToolSurfaceProfile(toolName)
    if (visibleSurfaceProfile === 'base') return null
    if (visibleSurfaceProfile) return tool.surfaces![visibleSurfaceProfile]!

    const activeProfile = context.codingSession.getToolSurfaceProfile()
    for (const profileId of getToolSurfaceFallbackChain(activeProfile)) {
      const surface = tool.surfaces?.[profileId]
      if (surface) return surface
    }

    return null
  }

  private validateAndNormalizeToolInput(input: {
    tool: AnyVelaTool
    selectedSurface?: LooseOptional<ToolExecutionPolicySurface<any, any>>
    args?: Record<string, unknown>
    toolContext: ToolExecutionPolicyContext
  }): ToolArgsValidationResult<any> {
    const selectedSurface = input.selectedSurface
    if (!selectedSurface) return toolArgsSchemaValidator.validateWithNormalization(input.tool.schema, input.args)

    const surfaceResult = toolArgsSchemaValidator.validateWithNormalization(
      selectedSurface.schema,
      input.args
    )
    if (!surfaceResult.success) return surfaceResult

    const normalizedInput = selectedSurface.normalize
      ? selectedSurface.normalize(surfaceResult.data, input.toolContext)
      : surfaceResult.data
    const baseArgs = isPlainObject(normalizedInput) ? normalizedInput : {}
    const baseResult = toolArgsSchemaValidator.validateWithNormalization(input.tool.schema, baseArgs)
    if (!baseResult.success) return baseResult

    return {
      ...baseResult,
      normalized: true,
    }
  }

  /** 只做无副作用的当前可见性检查，供 ToolExecutor 在排队前快速落地不可用工具。 */
  public prepareUnavailableExecution(
    request: ToolExecutionRequest
  ): LooseOptional<Extract<ToolExecutionDecision, { allowed: false }>> {
    const toolName = this.resolveCanonicalToolName(request.toolName)
    const canonicalNamePatch = toolName === request.toolName ? {} : { toolName }
    const advertisedRegistrationSignature =
      request.baseContext.getCurrentVisibleToolRegistrationSignature?.(toolName)
    if (advertisedRegistrationSignature) {
      const currentRegistrationSignature =
        toNullable(
          (
            this.toolRegistry.getCurrentRegistrationSignature ??
            this.toolRegistry.getRegistrationSignature
          )?.call(this.toolRegistry, toolName)
        )
      if (currentRegistrationSignature !== advertisedRegistrationSignature)
        return {
          allowed: false,
          error: `Stale tool call: ${toolName}`,
          ...canonicalNamePatch,
        }
    }

    const tool = this.toolRegistry.get(toolName)
    if (!tool) {
      request.baseContext.codingSession.recordInvisibleToolCall?.(request.toolName)
      return {
        allowed: false,
        error: `No such tool: ${request.toolName}`,
        ...canonicalNamePatch,
      }
    }

    const toolContext = this.createToolContext(
      request.baseContext,
      request.toolCallId,
      toolName,
      request.abortSignal,
      request.emitProgress,
      request.updateMetadata
    )
    const available = this.toolRegistry.listAvailable(
      toolContext,
      [toolName],
      request.availabilityScope ?? 'enabled'
    )
    if (!available.some((entry) => entry.name === toolName)) {
      toolContext.codingSession.recordInvisibleToolCall?.(toolName)
      return {
        allowed: false,
        error: `Tool is not available in the current context: ${toolName}`,
        ...canonicalNamePatch,
      }
    }

    return null
  }

  /** 准备执行工具；返回 allowed=false 时 ToolExecutor 会把 error 作为 tool result。 */
  public prepareExecution(request: ToolExecutionRequest): ToolExecutionDecision {
    const toolName = this.resolveCanonicalToolName(request.toolName)
    const canonicalNamePatch = toolName === request.toolName ? {} : { toolName }
    const advertisedRegistrationSignature =
      request.baseContext.getCurrentVisibleToolRegistrationSignature?.(toolName)
    if (advertisedRegistrationSignature) {
      const currentRegistrationSignature =
        toNullable(
          (
            this.toolRegistry.getCurrentRegistrationSignature ??
            this.toolRegistry.getRegistrationSignature
          )?.call(this.toolRegistry, toolName)
        )
      if (currentRegistrationSignature !== advertisedRegistrationSignature)
        return {
          allowed: false,
          error: `Stale tool call: ${toolName}`,
          ...canonicalNamePatch,
        }
    }
    const tool = this.toolRegistry.get(toolName)
    if (!tool) {
      request.baseContext.codingSession.recordInvisibleToolCall?.(request.toolName)
      return {
        allowed: false,
        error: `No such tool: ${request.toolName}`,
      }
    }

    const toolContext = this.createToolContext(
      request.baseContext,
      request.toolCallId,
      toolName,
      request.abortSignal,
      request.emitProgress,
      request.updateMetadata
    )
    const selectedSurface = this.resolveToolSurface(tool, toolContext, toolName)
    const requestArgs = request.args ?? {}
    // 某些工具调用可被 CodingSessionTracker 判定为重复，直接返回提示给模型。
    const redundantToolCallMessage = toolContext.codingSession.getRedundantToolCallMessage(
      toolName,
      requestArgs
    )
    if (redundantToolCallMessage) {
      // 拦截事件落 log，便于线下排障：当模型卡在"反复同参重试"或"重复加载能力"时，
      // 在 ToolExecutionPolicy 这条 tag 下能直接搜到所有被拦截的调用、message 前缀和
      // toolName。message 截短到 200 字符以免日志膨胀。
      this.log.info('redundant tool call intercepted', {
        toolName,
        toolCallId: request.toolCallId,
        message: redundantToolCallMessage.slice(0, 200),
      })
      return {
        allowed: false,
        error: redundantToolCallMessage,
        ...canonicalNamePatch,
      }
    }

    // 再走一遍 Registry 可见性过滤，覆盖权限、系统禁用、角色 allowList、isAvailable。
    // 反射代理会对 loadable 目标传入 all；普通直接调用仍固定为 enabled。
    const available = this.toolRegistry.listAvailable(
      toolContext,
      [toolName],
      request.availabilityScope ?? 'enabled'
    )
    if (!available.some((entry) => entry.name === toolName)) {
      toolContext.codingSession.recordInvisibleToolCall?.(toolName)
      return {
        allowed: false,
        error: `Tool is not available in the current context: ${toolName}`,
        ...canonicalNamePatch,
      }
    }

    const normalizedForPolicy = this.validateAndNormalizeToolInput({
      tool,
      selectedSurface,
      args: request.args,
      toolContext,
    })
    if (
      request.args &&
      !selectedSurface &&
      normalizedForPolicy.success &&
      normalizedForPolicy.normalized
    ) {
      toolArgsSchemaValidator.replaceRecordContents(request.args, normalizedForPolicy.args)
    }

    const planningModeDecision = this.evaluatePlanningModeToolPolicy(toolContext)
    if (!planningModeDecision.allowed) return {
        allowed: false,
        error: planningModeDecision.reason,
        ...canonicalNamePatch,
      }

    return {
      allowed: true,
      prepared: {
        toolName,
        tool,
        selectedSurface,
        toolContext,
      },
    }
  }

  /** 执行已经准备好的工具定义。 */
  public async executePrepared(
    prepared: ToolExecutionPrepared,
    args: LooseOptional<Record<string, unknown>>,
    toolName: string
  ): Promise<unknown> {
    if (prepared.toolContext.abortSignal.aborted) {
      throw new AppError('EXECUTION_ABORTED', 'Tool execution cancelled before start')
    }
    // 在执行前用工具自身的 zod schema 校验参数完整性。
    // 当 LLM 流式传输中途被截断时，@ai-sdk 会将不完整的 JSON 解析为
    // 部分对象（例如 blocks 变成空数组），导致工具静默产出损坏的文件。
    // 在这里拦截为 VALIDATION，并把 schema issues 放进结构化工具失败结果。
    const parseResult = this.validateAndNormalizeToolInput({
      tool: prepared.tool,
      selectedSurface: prepared.selectedSurface,
      args: toOptional(args),
      toolContext: prepared.toolContext,
    })
    if (!parseResult.success) {
      const issueDetails = parseResult.issues
      const issues = issueDetails.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      const validationHintProviders = resolveToolValidationHintProviders(
        prepared.toolContext.capabilityPorts
      )
      const hint = toolArgsSchemaValidator.describeValidationHint(
        toolName,
        issues,
        validationHintProviders
      )
      throw new AppError(
        'VALIDATION',
        `Tool arguments validation failed for "${toolName}". ${hint}Schema errors: ${issues}`,
        parseResult.error,
        {
          schemaIssues: issueDetails,
          toolFailure: buildToolFailureResult(
            'schema_validation_failed',
            `参数结构不符合 ${toolName} 的 schema：${issues}`,
            toolName,
            {
              code: 'VALIDATION',
              details: { schemaIssues: issueDetails },
              nextActions: toolArgsSchemaValidator.buildValidationNextActions(
                toolName,
                issueDetails,
                validationHintProviders
              ),
            }
          ),
        }
      )
    }
    if (args && parseResult.normalized) {
      toolArgsSchemaValidator.replaceRecordContents(args, parseResult.args)
    }

    // 是否需要人工确认完全由注入的审批端口和风险策略裁决；执行器不解释能力领域。
    const approvalSkipped = await this.ensureSessionToolApproval({
      toolName,
      toolContext: prepared.toolContext,
    })
    // Approval is asynchronous; cancellation during that wait must prevent the side effect.
    if (prepared.toolContext.abortSignal.aborted) {
      throw new AppError('EXECUTION_ABORTED', 'Tool execution cancelled before start')
    }
    if (approvalSkipped) {
      // 用户拒绝授权时不执行工具，但返回结构化“已跳过”结果给模型。
      this.recordSuccess({
        toolName,
        args: parseResult.args,
        output: approvalSkipped,
        toolContext: prepared.toolContext,
      })
      return approvalSkipped
    }

    const output = await prepared.tool.execute(parseResult.data, prepared.toolContext)
    this.recordSuccess({
      toolName,
      args: parseResult.args,
      output,
      toolContext: prepared.toolContext,
    })
    return output
  }

  /**
   * 消费当前工具类别对应的 capability auto-approval notice（整会话只产生一次）。
   * 由 ToolExecutor.finalizeResult 调用，结果通过 emitNotice 推给 renderer，不再嵌入工具结果。
   */
  public consumePendingAutoApprovalNotice(
    toolName: string,
    toolContext: ToolExecutionPolicyContext
  ): LooseOptional<CapabilityAutoApprovalNotice> {
    const descriptor = this.toolRegistry.getDescriptor(toolName)
    const categoryId = descriptor?.categoryId
    if (!categoryId) return null
    return toolContext.codingSession.consumePendingAutoApprovalNotice(categoryId)
  }

  /** 记录成功/跳过结果，让 coding session 更新后续提醒和去重状态。 */
  public recordSuccess(input: ToolExecutionSuccessInput): void {
    input.toolContext.codingSession.recordToolResult(input.toolName, input.output)
    input.toolContext.codingSession.recordToolCallResult?.(input.toolName, input.args, input.output)
  }

  /**
   * 决定是否取消其他正在运行的 sibling 工具。
   *
   * 规则：
   * - EXECUTION_ABORTED / EXECUTION_DENIED 等终止类错误 → 无条件 abort，不管并发安全性。
   * - 普通 VALIDATION / NOT_FOUND / 工具逻辑错误 → 只报错给模型，不取消其他不相关文件的编辑。
   *   （之前的逻辑是 !isConcurrencySafe 就 abort，导致一个文件找不到目标就杀掉整批编辑。）
   */
  public shouldAbortSiblings(input: ToolExecutionFailureInput): boolean {
    // terminal 错误：整个 session 应停止；普通编辑/校验错误不再级联取消兄弟工具。
    return this.isTerminalExecutionError(input.error)
  }

  /** 这些错误表示执行应整体终止，而不是只作为普通工具错误交给模型修复。 */
  public isTerminalExecutionError(error: AppError): boolean {
    return error.code === 'EXECUTION_ABORTED' || error.code === 'EXECUTION_DENIED'
  }

  /** 把准入失败变成模型和 UI 都能读懂的结构化工具结果。 */
  public buildBlockedFailureResult(
    toolName: string,
    reason: string,
    toolContext: ToolExecutionPolicyContext
  ): ToolFailureResult {
    const canonicalToolName = this.resolveCanonicalToolName(toolName)
    const tool = this.toolRegistry.get(canonicalToolName)
    if (!tool) return buildToolFailureResult('tool_not_found', reason, canonicalToolName, {
        recovery: buildToolSpaceRecoveryGuide({ toolName: canonicalToolName }),
      })

    const categoryId = this.toolRegistry.getDescriptor(canonicalToolName)?.categoryId
    if (categoryId) {
      const access = decideToolCategoryAccess(categoryId, {
        roleId: toolContext.role.id,
        activeCapabilityScope: toolContext.codingSession.getActiveCapabilityScope?.(),
        capabilityPorts: toolContext.capabilityPorts,
      })
      if (!access.allowed) {
        const categoryLabel =
          resolveCapabilityCategoryDefinitions(toolContext.capabilityPorts)[categoryId]?.label ??
          categoryId
        const unavailableReason =
          access.message ?? `${categoryLabel} is unavailable in the active capability scope.`
        return buildToolFailureResult('tool_unavailable', unavailableReason, canonicalToolName, {
          details: {
            categoryId,
            unavailableReason: access.reason,
          },
          recovery: buildToolSpaceRecoveryGuide({
            toolName: canonicalToolName,
            categoryId,
            unavailableReason: access.reason,
          }),
        })
      }
    }

    if (/not available|不可使用|不可用/i.test(reason)) return buildToolFailureResult('tool_unavailable', reason, canonicalToolName, {
        details: optionalWhenLazy(categoryId, () => ({ categoryId })),
        recovery: buildToolSpaceRecoveryGuide({ toolName: canonicalToolName, categoryId }),
      })

    return buildToolFailureResult('tool_blocked', reason, canonicalToolName, {
      details: optionalWhenLazy(categoryId, () => ({ categoryId })),
      recovery: buildToolSpaceRecoveryGuide({ toolName: canonicalToolName, categoryId }),
    })
  }

  /** 把执行异常变成结构化工具结果，避免失败路径显示为 null。 */
  public buildExecutionFailureResult(toolName: string, error: AppError): ToolFailureResult {
    return buildExecutionFailureResult(toolName, error)
  }

  /** 获取工具所属类别 ID，供 emitToolStart 携带 categoryId 给前端。 */
  public getToolCategoryId(toolName: string): LooseOptional<ToolCategoryId> {
    const canonicalToolName = this.resolveCanonicalToolName(toolName)
    return this.toolRegistry.getDescriptor(canonicalToolName)?.categoryId
  }

  /** 获取工具 owner 声明的正式副作用类型，供执行观测与评测判定使用。 */
  public getToolEffectKind(toolName: string): LooseOptional<ToolCapabilityEffectKind> {
    const canonicalToolName = this.resolveCanonicalToolName(toolName)
    return this.toolRegistry.getDescriptor(canonicalToolName)?.capabilities?.effectKind
  }

  /** 工具是否声明 outputInline（输出禁止 page-out、始终内联）。 */
  public isToolOutputInline(toolName: string): boolean {
    const canonicalToolName = this.resolveCanonicalToolName(toolName)
    return !!this.toolRegistry.getDescriptor(canonicalToolName)?.outputInline
  }

  private evaluatePlanningModeToolPolicy(
    toolContext: ToolExecutionPolicyContext
  ): { allowed: boolean; reason: string } {
    if (!toolContext.planningMode) return {
        allowed: true,
        reason: 'planning mode is off',
      }

    return {
      allowed: true,
      reason: 'planning mode does not restrict tool execution',
    }
  }

  /**
   * 获取工具角色（如 `control`）。
   * 供 ToolExecutor 判定嵌套/包装调用（timed/chain/reflect）是否触达控制类工具——
   * 控制/编排类工具（agent:dispatch、plan:update、interaction:show_action_cards 等）不应被嵌套调用。
   */
  public getToolRole(toolName: string): LooseOptional<ToolRole> {
    const canonicalToolName = this.resolveCanonicalToolName(toolName)
    return this.toolRegistry.getDescriptor(canonicalToolName)?.role
  }

  /** 查询工具自己的并发安全声明；声明抛错时按不安全处理。 */
  public resolveConcurrencySafe(toolName: string, input: unknown): boolean {
    const canonicalToolName = this.resolveCanonicalToolName(toolName)
    const definition = this.toolRegistry.get(canonicalToolName)
    if (!definition?.isConcurrencySafe) return false
    if (!isPlainObject(input)) return false

    try {
      return definition.isConcurrencySafe(input as Record<string, unknown>)
    } catch (err) {
      // 工具自定义的并发安全判定函数抛错 → 仍然按不安全处理；但必须留下日志，
      // 否则 tool author 永远没办法知道 isConcurrencySafe 实现里挂了什么异常。
      logRuntime
        .tag('ToolExecutionPolicy')
        .warn('isConcurrencySafe threw, treating tool as unsafe', {
          toolName,
          error: err,
        })
      return false
    }
  }

  /** 对需要会话级批准的工具类别弹确认；批准后同类工具本会话不再重复问。 */
  private async ensureSessionToolApproval(input: {
    toolName: string
    toolContext: ToolExecutionPolicyContext
  }): Promise<LooseOptional<Record<string, unknown>>> {
    const descriptor = this.toolRegistry.getDescriptor(input.toolName)
    const categoryId = descriptor?.categoryId
    if (!categoryId || !this.sessionApprovalToolCategories.has(categoryId)) return null

    if (input.toolContext.codingSession.hasSessionToolCategoryApproval(categoryId)) return null

    const categoryLabel =
      resolveCapabilityCategoryDefinitions(input.toolContext.capabilityPorts)[categoryId]?.label ??
      categoryId
    const execution = input.toolContext.execution
    if (!execution) return {
        approved: false,
        skipped: true,
        changed: false,
        categoryId,
        toolName: input.toolName,
        message: `当前运行上下文不支持会话级工具类别授权，已跳过 ${categoryLabel} 工具。`,
      }

    // awaitConfirmationDecision 不会在拒绝时自动终止执行，模型可以拿到拒绝原因继续处理。
    const decision = await execution.awaitConfirmationDecision(
      this.formatSessionToolApprovalMessage({
        toolName: input.toolName,
        categoryId,
        categoryLabel,
      }),
      input.toolContext.abortSignal,
      {
        riskScope: `tool-category:${categoryId}`,
        rememberRiskScope: false,
        // 结构化信封与下面那段散文同一批产出：渲染层按 kind 画结构卡，散文只做兜底
        // （旧会话存档 / 不认识该 kind 的消费方）。改文案不会再让结构卡静默退化。
        detail: {
          kind: 'tool-category-authorization',
          categoryId,
          categoryLabel,
          toolName: input.toolName,
        },
      }
    )

    if (!decision.approved) return {
        approved: false,
        skipped: true,
        changed: false,
        categoryId,
        toolName: input.toolName,
        rejectionMessage: decision.message,
        message: decision.message?.trim()
          ? `用户拒绝授权 ${categoryLabel} 工具，并说明：${decision.message.trim()}`
          : `用户拒绝授权 ${categoryLabel} 工具。`,
      }

    input.toolContext.codingSession.grantSessionToolCategoryApproval?.(categoryId)
    return null
  }

  /** 生成会话级工具类别授权卡片文案。 */
  private formatSessionToolApprovalMessage(input: {
    toolName: string
    categoryId: ToolCategoryId
    categoryLabel: string
  }): string {
    return [
      '工具授权请求',
      `类型：${input.categoryLabel}`,
      `工具：${input.toolName}`,
      `授权范围：当前会话内的全部 ${input.categoryLabel} 工具`,
      '同意后，本会话内同类工具不再重复询问。',
      '拒绝时可以填写原因；留空时模型会自行决定追问、结束或跳过。',
    ].join('\n')
  }

  /** 为单个工具派生上下文：使用独立 abortSignal 和工具专属日志 tag。 */
  private createToolContext(
    baseContext: ToolExecutionPolicyContext,
    toolCallId: string,
    toolName: string,
    abortSignal: AbortSignal,
    emitProgress?: (chunk: string) => void,
    updateMetadata?: (payload: { title?: string; metadata?: Record<string, unknown> }) => void
  ): ToolExecutionPolicyContext {
    // Query contexts inherit host ports from a frozen parent. Preserve that prototype chain.
    return Object.create(baseContext, {
      toolCallId: { value: toolCallId, enumerable: true },
      abortSignal: { value: abortSignal, enumerable: true },
      log: { value: logRuntime.tag(`Tool:${toolName}`), enumerable: true },
      emitProgress: { value: emitProgress ?? baseContext.emitProgress, enumerable: true },
      updateMetadata: { value: updateMetadata ?? baseContext.updateMetadata, enumerable: true },
    })
  }

}

export { ToolExecutionPolicy }
export type {
  ToolExecutionDecision,
  ToolExecutionPolicyContext,
  ToolExecutionPolicyExecution,
  ToolExecutionPolicyRegistry,
  ToolExecutionPolicyTool,
  ToolExecutionPrepared,
  ToolFailureResult,
}
export type { ToolArgsValidationResult, ToolSchemaIssueDetail } from './ToolArgsSchemaValidator'
