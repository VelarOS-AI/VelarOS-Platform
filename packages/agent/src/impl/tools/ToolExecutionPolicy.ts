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
//  3. **参数与前置条件**（先拒绝无效输入，避免为无法执行的调用请求授权）；
//  4. **审批**（破坏性/越界操作要用户点头；自动批准只在显式声明的档发生并留通知）。
//
// ## 关键不变量（改这些会破什么）
//  - **默认拒绝**：判定不出结论按拒绝（fail-closed）。任何「拿不到策略就放行」= 门变装饰。
//  - **拒绝要可读**：诊断必须让模型/用户知道**怎么补救**（缺哪个授权、该换哪个空间），
//    否则模型只会原样重试。
//  - **自动批准必须留痕**（`CapabilityAutoApprovalNotice`）：无痕迹的自动批准等于没有审批。
//  - **本门不认识 mod**：mod 贡献在装载期已被宿主收窄，到这里与内置工具同权。
import {
  isPlainObject,
  isPresent,
  optionalWhenLazy,
  toNullable,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { logRuntime } from '@velaros-ai/core/logger'

import type { AgentRuntimeCapabilityPorts } from '../../contract/requires.js'
import type { ToolConfirmationDecisionOptions } from '../../types/agent'
import type {CapabilityAutoApprovalNotice, ToolCapabilityEffectKind, ToolCategoryId, ToolRole } from '../../types/agent.js'
import type { ToolInputReuseContract } from '../../types/toolkit.js'
import type { ToolExecutionDecision, ToolExecutionFailureInput, ToolExecutionFailureKind, ToolExecutionPolicyContext, ToolExecutionPolicyRegistry, ToolExecutionPrepared, ToolExecutionRequest, ToolExecutionSuccessInput, ToolFailureResult } from '../../types/tools.js'
import { resolveCapabilityCategoryDefinitions, resolveToolAliases, resolveToolValidationHintProviders } from '../../utils/capabilities'
import { createApprovalOperationKey } from '../../utils/toolkit/task-approval'
import { decideToolCategoryAccess } from '../../utils/tools/access-policy'
import { buildExecutionFailureResult, buildToolFailureResult } from '../../utils/tools/execution-policy-failures'
import { createToolContext, evaluatePlanningModeToolPolicy, formatSessionToolApprovalMessage, resolveToolSurface, validateAndNormalizeToolInput } from '../../utils/tools/execution-policy-preparation'
import { toolArgsSchemaValidator } from '../../utils/tools/tool-args-schema-validator'
import { buildToolSpaceRecoveryGuide } from '../../utils/tools/tool-space-recovery'

import { supportsToolInputReuse } from './ToolInputReuseStore'

/**
 * 工具执行的策略与审批门：单个工具「能不能执行、怎样执行、失败了怎么说」全在这里判。
 *
 * 由 `ToolExecutor` 持有一份（每条执行链一份），唯一依赖是构造时注入的工具注册表；
 * 本会话已授权的工具类别记在实例里，跨调用复用。判定一律 fail-closed——查不到工具、
 * 拿不到可见性结论、审批没点头都按拒绝收敛，并且拒绝一定带可读的补救说明。
 */
interface ToolExecutionPolicyApi {
  /**
   * 把模型报的工具名还原成注册表里的真名：原名存在就原样返回，否则依次试本轮投递的别名、
   * 全小写名、能力端口登记的别名表；都不中就把原名退回去，由调用方按「没有这个工具」处理。
   */
  resolveCanonicalToolName(
    toolName: string,
    capabilityPorts?: AgentRuntimeCapabilityPorts,
    context?: Pick<ToolExecutionPolicyContext, 'resolveCurrentVisibleCanonicalToolName'>
  ): string
  /**
   * 排队之前的快速体检：只查「这次调用是不是已经废了」——注册签名过期、工具不存在、当前上下文不可见。
   * 命中任意一条就返回现成的拒绝判决（`allowed: false`），让执行器立刻落地不必进队；都没命中返回 null。
   * 无副作用，可随时调。
   */
  prepareUnavailableExecution(
    request: ToolExecutionRequest
  ): LooseOptional<Extract<ToolExecutionDecision, { allowed: false }>>
  /**
   * 完整准备一次执行：还原真名 → 查注册签名与可见性 → 选表面 → 校验并归一化参数 → 查重复调用 → 计划模式判定。
   * 全过时返回 `allowed: true` 与准备件（工具、表面、真正会执行的参数、上下文），供执行器排队后直接开跑；
   * 任一环不过返回 `allowed: false` 与给模型看的 error，执行器把它当作工具结果写回历史。
   * 有副作用：归一化后的参数会原地写回 `request.args`（仅 base 表面），并通过 `updateMetadata` 回显调整项。
   */
  prepareExecution(request: ToolExecutionRequest): ToolExecutionDecision
  /**
   * 拿到执行槽之后的轻量复检，关的是「排队期间世界变了」这个窗口：注册签名漂移、工具被卸载、
   * 已经不可见、或这次调用在排队期间变成了重复调用。有问题时返回那条拒绝判决（含拒绝原因与失败归类），
   * 没问题返回 null。绝不重跑 schema 或表面归一化，只认 prepare 时算好的 `effectiveArgs`。
   */
  revalidatePreparedExecution(
    prepared: ToolExecutionPrepared,
    effectiveArgs: Record<string, unknown>
  ): LooseOptional<Extract<ToolExecutionDecision, { allowed: false }>>
  /**
   * 真正执行已准备好的工具：先补一次参数校验（流被截断时 provider 会交上残缺 JSON，这里拦成 VALIDATION），
   * 再过会话级类别审批，最后带着收窄过的审批/执行端口调工具本体，成功后把结果记进会话去重账。
   * 用户拒绝授权时不执行，返回结构化的「已跳过」结果；开始前或审批途中被取消一律抛 `EXECUTION_ABORTED`。
   */
  executePrepared(
    prepared: ToolExecutionPrepared,
    args: LooseOptional<Record<string, unknown>>,
    toolName: string
  ): Promise<unknown>
  /**
   * 取走该工具类别待发的自动批准通知（整会话只发一次）。由执行器在收敛结果时调，
   * 通知走 emitNotice 推给界面而不嵌进工具结果；没有待发通知或工具没有类别时返回 null。
   */
  consumePendingAutoApprovalNotice(
    toolName: string,
    toolContext: ToolExecutionPolicyContext
  ): LooseOptional<CapabilityAutoApprovalNotice>
  /** 记一次成功或「已跳过」的结果，让会话更新提醒与重复调用判定；执行成功路径与拒绝授权路径都会调。 */
  recordSuccess(input: ToolExecutionSuccessInput): void
  /** 这个工具的 schema 支不支持「复用上次调用参数」（`inputReuse`）；工具不存在时按不支持处理。 */
  supportsInputReuse(toolName: string): boolean
  /** 取这个工具的参数复用契约（契约版本、可复用的来源工具、迁移函数）；工具不存在时三项都是 undefined。 */
  inputReuseContract(toolName: string): ToolInputReuseContract<any>
  /**
   * 这次失败要不要连带取消同轮其他工具。只有终止类错误才取消——普通的参数或逻辑错误只报给模型，
   * 不该因为一个文件没找到就杀掉整批编辑。
   */
  shouldAbortSiblings(input: ToolExecutionFailureInput): boolean
  /** 这个错误是不是「整条执行链该停」的那种（用户中止、结果收敛失败），而不是交给模型自己修的普通工具错误。 */
  isTerminalExecutionError(error: AppError): boolean
  /**
   * 把准入失败（不存在、类别不可用、被拦下）变成模型和界面都读得懂的结构化结果：
   * 按 `failureKind` 选 `tool_not_found` / `tool_unavailable` / `tool_blocked`，并附上该换哪个空间、缺哪个授权的补救指引。
   * 归类只认判定现场给的 `failureKind`（不给按 `tool_blocked`），绝不从 `reason` 文案回猜——文案改一个字就会让归类漂移。
   */
  buildBlockedFailureResult(
    toolName: string,
    reason: string,
    toolContext: ToolExecutionPolicyContext,
    failureKind?: ToolExecutionFailureKind
  ): ToolFailureResult
  /** 把执行期抛出的异常变成结构化工具结果，避免失败路径在历史里显示成 null。 */
  buildExecutionFailureResult(toolName: string, error: AppError): ToolFailureResult
  /** 查工具所属类别 id，供执行开始事件带给界面；工具或 descriptor 不在时返回空。 */
  getToolCategoryId(toolName: string): LooseOptional<ToolCategoryId>
  /** 查工具 owner 声明的副作用类型（读/写/外部动作），供执行观测与评测判定；没声明时返回空。 */
  getToolEffectKind(toolName: string): LooseOptional<ToolCapabilityEffectKind>
  /** 这个工具是否声明了 `outputInline`：声明了的输出禁止句柄化，必须原样内联给模型。 */
  isToolOutputInline(toolName: string): boolean
  /** 查工具角色（如 `control`），执行器据此判定嵌套/包装调用有没有触到控制类工具。 */
  getToolRole(toolName: string): LooseOptional<ToolRole>
  /**
   * 问工具自己「带这份参数能不能与别人并行」。工具没声明判定函数时返回 `fallback`（缺省 false）；
   * 参数不是对象、或判定函数自己抛错，一律按不安全处理并留一条 warn 日志——失败方向必须是串行。
   */
  resolveConcurrencySafe(toolName: string, input: unknown, fallback?: boolean): boolean
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
class ToolExecutionPolicy implements ToolExecutionPolicyApi {
  /** 会话级类别审批的扩展点；默认不再使用粗类别审批，避免低风险能力反复阻塞。 */
  private readonly sessionApprovalToolCategories = new Set<ToolCategoryId>()
  private readonly log = logRuntime.tag('ToolExecutionPolicy')

  constructor(private readonly toolRegistry: ToolExecutionPolicyRegistry) {}

  private readCurrentRegistrationSignature(toolName: string): LooseOptional<string> {
    return toNullable(
      (
        this.toolRegistry.getCurrentRegistrationSignature ??
        this.toolRegistry.getRegistrationSignature
      )?.call(this.toolRegistry, toolName)
    )
  }

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

  /** 只做无副作用的当前可见性检查，供 ToolExecutor 在排队前快速落地不可用工具。 */
  public prepareUnavailableExecution(
    request: ToolExecutionRequest
  ): LooseOptional<Extract<ToolExecutionDecision, { allowed: false }>> {
    const toolName = this.resolveCanonicalToolName(request.toolName)
    const canonicalNamePatch = toolName === request.toolName ? {} : { toolName }
    const advertisedRegistrationSignature =
      request.baseContext.getCurrentVisibleToolRegistrationSignature?.(toolName)
    if (advertisedRegistrationSignature) {
      const currentRegistrationSignature = this.readCurrentRegistrationSignature(toolName)
      if (currentRegistrationSignature !== advertisedRegistrationSignature)
        return {
          allowed: false,
          error: `工具调用已过期：${toolName} 的注册状态在这次调用排队期间变了，请按当前工具清单重新发起调用。`,
          ...canonicalNamePatch,
        }
    }

    const tool = this.toolRegistry.get(toolName)
    if (!tool) {
      request.baseContext.codingSession.recordInvisibleToolCall?.(request.toolName)
      return {
        allowed: false,
        error: `没有名为 ${request.toolName} 的工具：请在当前工具清单里确认名字，或先把它所属的能力页调进来再调用。`,
        ...canonicalNamePatch,
      }
    }

    const toolContext = createToolContext(
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
        error: `工具 ${toolName} 在当前上下文里不可用：它没有通过本轮的可见性过滤（权限、能力作用域、角色白名单或工具自身的可用性判定），请先满足其中不足的那一项。`,
        failureKind: 'tool_unavailable',
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
    const currentRegistrationSignature = this.readCurrentRegistrationSignature(toolName)
    if (advertisedRegistrationSignature) {
      if (currentRegistrationSignature !== advertisedRegistrationSignature)
        return {
          allowed: false,
          error: `工具调用已过期：${toolName} 的注册状态在这次调用排队期间变了，请按当前工具清单重新发起调用。`,
          ...canonicalNamePatch,
        }
    }
    const tool = this.toolRegistry.get(toolName)
    if (!tool) {
      request.baseContext.codingSession.recordInvisibleToolCall?.(request.toolName)
      return {
        allowed: false,
        error: `没有名为 ${request.toolName} 的工具：请在当前工具清单里确认名字，或先把它所属的能力页调进来再调用。`,
      }
    }

    const toolContext = createToolContext(
      request.baseContext,
      request.toolCallId,
      toolName,
      request.abortSignal,
      request.emitProgress,
      request.updateMetadata
    )
    const selectedSurface = resolveToolSurface(tool, toolContext, toolName)
    const requestArgs = request.args ?? {}

    // 走一遍 Registry 可见性过滤，覆盖权限、系统禁用、角色 allowList、isAvailable。
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
        error: `工具 ${toolName} 在当前上下文里不可用：它没有通过本轮的可见性过滤（权限、能力作用域、角色白名单或工具自身的可用性判定），请先满足其中不足的那一项。`,
        failureKind: 'tool_unavailable',
        ...canonicalNamePatch,
      }
    }

    const normalizedForPolicy = validateAndNormalizeToolInput({
      tool,
      selectedSurface,
      args: request.args,
      toolContext,
    })
    const effectiveArgs = normalizedForPolicy.success
      ? normalizedForPolicy.args
      : requestArgs
    if (
      request.args &&
      normalizedForPolicy.success &&
      normalizedForPolicy.normalized
    ) {
      // base surface 的 provider 输入与执行输入同形，可原地收敛，令历史、去重和审批看到实际参数。
      // profile surface 可能有意使用另一套参数形状，只回显调整，不把 base 参数写回 provider 历史。
      if (!selectedSurface) {
        toolArgsSchemaValidator.replaceRecordContents(request.args, normalizedForPolicy.args)
      }
      request.updateMetadata?.({
        metadata: {
          inputAdjusted: true,
          inputAdjustments: normalizedForPolicy.adjustments,
        },
      })
    }

    // 去重必须看 schema/default/surface normalize 后真正会执行的参数，避免同义输入绕过。
    const redundantToolCallMessage = toolContext.codingSession.getRedundantToolCallMessage(
      toolName,
      effectiveArgs
    )
    if (redundantToolCallMessage) {
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

    const planningModeDecision = evaluatePlanningModeToolPolicy(toolContext)
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
        effectiveArgs,
        validationResult: normalizedForPolicy,
        registrationSignature: toNullable(
          advertisedRegistrationSignature ?? currentRegistrationSignature
        ),
        toolContext,
      },
    }
  }

  /**
   * 实际执行槽授予后的轻量复检。只读取 prepare 缓存的 effectiveArgs，绝不再次运行
   * schema 或 surface normalize；用来关闭排队期间注册表、可用性和 session 去重状态变化的窗口。
   */
  public revalidatePreparedExecution(
    prepared: ToolExecutionPrepared,
    effectiveArgs: Record<string, unknown>
  ): LooseOptional<Extract<ToolExecutionDecision, { allowed: false }>> {
    const toolName = prepared.toolName
    const currentRegistrationSignature = this.readCurrentRegistrationSignature(toolName)
    if (
      (
        isPresent(prepared.registrationSignature) ||
        isPresent(currentRegistrationSignature)
      ) &&
      currentRegistrationSignature !== prepared.registrationSignature
    ) return { allowed: false, error: `工具调用已过期：${toolName} 的注册状态在这次调用排队期间变了，请按当前工具清单重新发起调用。` }

    const currentTool = this.toolRegistry.get(toolName)
    if (!currentTool) {
      prepared.toolContext.codingSession.recordInvisibleToolCall?.(toolName)
      return { allowed: false, error: `没有名为 ${toolName} 的工具：请在当前工具清单里确认名字，或先把它所属的能力页调进来再调用。` }
    }
    if (
      !isPresent(prepared.registrationSignature) &&
      !isPresent(currentRegistrationSignature) &&
      currentTool !== prepared.tool
    ) return { allowed: false, error: `工具调用已过期：${toolName} 的注册状态在这次调用排队期间变了，请按当前工具清单重新发起调用。` }

    const available = this.toolRegistry.listAvailable(
      prepared.toolContext,
      [toolName],
      'enabled'
    )
    if (!available.some((entry) => entry.name === toolName)) {
      prepared.toolContext.codingSession.recordInvisibleToolCall?.(toolName)
      return {
        allowed: false,
        error: `工具 ${toolName} 在当前上下文里不可用：它没有通过本轮的可见性过滤（权限、能力作用域、角色白名单或工具自身的可用性判定），请先满足其中不足的那一项。`,
        failureKind: 'tool_unavailable',
      }
    }

    const redundantToolCallMessage =
      prepared.toolContext.codingSession.getRedundantToolCallMessage(toolName, effectiveArgs)
    if (!redundantToolCallMessage) return null

    this.log.info('redundant tool call intercepted after queue admission', {
      toolName,
      toolCallId: prepared.toolContext.toolCallId,
      message: redundantToolCallMessage.slice(0, 200),
    })
    return { allowed: false, error: redundantToolCallMessage }
  }

  /** 执行已经准备好的工具定义。 */
  public async executePrepared(
    prepared: ToolExecutionPrepared,
    args: LooseOptional<Record<string, unknown>>,
    toolName: string
  ): Promise<unknown> {
    if (prepared.toolContext.abortSignal.aborted) {
      throw new AppError(
        'EXECUTION_ABORTED',
        `工具 ${toolName} 还没开始执行就被取消：拿到执行槽时本轮已经中止（用户停止或上层取消），工具本体没跑，没有产生任何副作用。`
      )
    }
    // 在执行前用工具自身的 zod schema 校验参数完整性。
    // 当 LLM 流式传输中途被截断时，@ai-sdk 会将不完整的 JSON 解析为
    // 部分对象（例如 blocks 变成空数组），导致工具静默产出损坏的文件。
    // 在这里拦截为 VALIDATION，并把 schema issues 放进结构化工具失败结果。
    const parseResult = prepared.validationResult ?? validateAndNormalizeToolInput({
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
        `工具 ${toolName} 的参数没通过 schema 校验，本次调用未执行。${hint}schema 报错：${issues}`,
        parseResult.error,
        {
          schemaIssues: issueDetails,
          toolFailure: buildToolFailureResult(
            'schema_validation_failed',
            `参数结构不符合 ${toolName} 的 schema：${issues}`,
            toolName,
            {
              code: 'VALIDATION',
              details: { schemaIssues: issueDetails, executionOutcome: 'not-applied' },
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
    // 是否需要人工确认完全由注入的审批端口和风险策略裁决；执行器不解释能力领域。
    const approvalSkipped = await this.ensureSessionToolApproval({
      toolName,
      toolContext: prepared.toolContext,
    })
    // 审批是异步的：等待期间被取消就不能再产生副作用。
    if (prepared.toolContext.abortSignal.aborted) {
      throw new AppError(
        'EXECUTION_ABORTED',
        `工具 ${toolName} 在等待授权期间被取消：授权流程还没走完本轮就已中止，工具本体没跑，没有产生任何副作用。`
      )
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

    const context = prepared.toolContext
    let operation: ToolConfirmationDecisionOptions['operation']
    const scopedOptions = (options?: ToolConfirmationDecisionOptions): ToolConfirmationDecisionOptions => {
      if (!options?.operation) operation ??= {
        key: createApprovalOperationKey(`tool:${toolName}`, parseResult.args),
        label: toolName,
      }
      return {
        ...options,
        operation: options?.operation ?? operation,
        requester: options?.requester ?? { agentId: context.role.id },
      }
    }
    // 属性描述符里不能出现 undefined：上下文没有的审批/执行端口就不定义，继续沿原型读到缺席。
    const executionContext: ToolExecutionPolicyContext = Object.create(context)
    if (context.approval) {
      Object.defineProperty(executionContext, 'approval', {
        value: {
          awaitConfirmation: (message: string, signal?: AbortSignal, options?: ToolConfirmationDecisionOptions) =>
            context.approval!.awaitConfirmation(message, signal, scopedOptions(options)),
          awaitConfirmationDecision: (message: string, signal?: AbortSignal, options?: ToolConfirmationDecisionOptions) =>
            context.approval!.awaitConfirmationDecision(message, signal, scopedOptions(options)),
        },
      })
    }
    if (context.execution) {
      const execution = {
        ...context.execution,
        awaitConfirmationDecision: (message: string, signal: AbortSignal, options?: ToolConfirmationDecisionOptions) =>
          context.execution!.awaitConfirmationDecision(message, signal, scopedOptions(options)),
      }
      if (context.execution.awaitConfirmation) {
        execution.awaitConfirmation = (message: string, signal?: AbortSignal, options?: ToolConfirmationDecisionOptions) =>
          context.execution!.awaitConfirmation!(message, signal, scopedOptions(options))
      }
      Object.defineProperty(executionContext, 'execution', { value: execution })
    }
    const output = await prepared.tool.execute(parseResult.data, executionContext)
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
   * - EXECUTION_ABORTED 等终止类错误 → 无条件 abort，不管并发安全性。
   * - 普通 VALIDATION / NOT_FOUND / 工具逻辑错误 → 只报错给模型，不取消其他不相关文件的编辑。
   *   （之前的逻辑是 !isConcurrencySafe 就 abort，导致一个文件找不到目标就杀掉整批编辑。）
   */
  public supportsInputReuse(toolName: string): boolean {
    const tool = this.toolRegistry.get(this.resolveCanonicalToolName(toolName))
    return !!tool && supportsToolInputReuse(tool.schema)
  }

  public inputReuseContract(toolName: string): ToolInputReuseContract<any> {
    const tool = this.toolRegistry.get(this.resolveCanonicalToolName(toolName))
    return {
      inputContractVersion: tool?.inputContractVersion,
      inputReuseSourceTools: tool?.inputReuseSourceTools,
      migrateReusedInput: tool?.migrateReusedInput,
    }
  }

  public shouldAbortSiblings(input: ToolExecutionFailureInput): boolean {
    // terminal 错误：整个 session 应停止；普通编辑/校验错误不再级联取消兄弟工具。
    return this.isTerminalExecutionError(input.error)
  }

  /** 这些错误表示执行应整体终止，而不是只作为普通工具错误交给模型修复。 */
  public isTerminalExecutionError(error: AppError): boolean {
    return error.code === 'EXECUTION_ABORTED'
      || error.code === 'TOOL_RESULT_FINALIZATION_FAILED'
  }

  /**
   * 把准入失败变成模型和 UI 都能读懂的结构化工具结果。
   *
   * 归类只认判定现场传来的 `failureKind`（不给按 `tool_blocked`）。这里曾经用正则嗅 `reason`
   * 文案来判「是不是不可用」，那等于把失败码绑死在一句话的措辞上——润色或翻译一次文案，
   * `tool_unavailable` 就会静默退化成 `tool_blocked`，界面的补救指引跟着变错。
   */
  public buildBlockedFailureResult(
    toolName: string,
    reason: string,
    toolContext: ToolExecutionPolicyContext,
    failureKind?: ToolExecutionFailureKind
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
          access.message ?? `当前能力范围里用不了 ${categoryLabel}。`
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

    return buildToolFailureResult(failureKind ?? 'tool_blocked', reason, canonicalToolName, {
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
  public resolveConcurrencySafe(
    toolName: string,
    input: unknown,
    fallback = false,
  ): boolean {
    const canonicalToolName = this.resolveCanonicalToolName(toolName)
    const definition = this.toolRegistry.get(canonicalToolName)
    if (!definition?.isConcurrencySafe) return fallback
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
      formatSessionToolApprovalMessage({
        toolName: input.toolName,
        categoryId,
        categoryLabel,
      }),
      input.toolContext.abortSignal,
      {
        riskScope: `tool-category:${categoryId}`,
        rememberRiskScope: true,
        operation: {
          key: `tool-category:${categoryId}`,
          label: categoryLabel,
          target: categoryLabel,
        },
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

}

export { ToolExecutionPolicy }
export type { ToolExecutionPolicyApi, ToolFailureResult }
