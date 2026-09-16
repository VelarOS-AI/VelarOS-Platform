import { isEmpty } from '@velaros-ai/core'

import type { AgentRuntimeCapabilityPorts, ToolAllocationMetadata } from '../../contract/requires.js'
import type { ToolCategoryId, ToolDescriptor } from '../../types/agent.js'
import type { SessionToolAllocatorPlan, ToolAllocatorAdvisorState, ToolAllocatorCategory, ToolAllocatorDeniedRequest, ToolAllocatorFuseState, ToolAllocatorOperation, ToolAllocatorRequest } from '../../types/tools.js'
import { resolveToolAllocationMetadata } from '../../utils/capabilities'
import { buildAllocationMessage, buildRequestSignature, buildRuntimeToolIndex, createDeniedRequest, dedupeDeniedRequests, uniqueStrings, uniqueToolCategoryIds } from '../../utils/tools/session-tool-allocator'
import { AgentTuning } from '../../utils/tuning'

/** 一次发放判定的全部入参：本轮申请了什么、运行态有什么、会话允许什么，三者在这里汇合。 */
interface SessionToolAllocatorPlanInput<TTool extends { name: string } = ToolDescriptor> {
  /** 本轮的回合序号，由调用方按会话自增；只用于调用方对账与排障，判定本身不看它。 */
  turn: number
  /** 触发这轮申请的用户原话；留给判定链做语义线索用，当前发放规则不读它。 */
  latestUserText: string
  /** 本轮模型提出的能力申请（意图 + 操作 + 目标）；一条申请可能牵出多个类别，逐条按顺序判。 */
  requests: readonly ToolAllocatorRequest[]
  /** 运行态**真的注册了**的类别与其工具；类别在这里没有工具就按 `not_implemented` 拒，不是按角色拒。 */
  runtimeToolCategories: ReadonlyArray<ToolAllocatorCategory<TTool>>
  /** 完整目录（含当前运行态没装载的），留给上层做「有但没装」的提示；发放判定不用它。 */
  catalogToolCategories?: ReadonlyArray<ToolAllocatorCategory<TTool>>
  /** 会话里已经打开过的类别；已打开的类别再申请不会重复记入发放清单。 */
  enabledToolCategoryIds: readonly ToolCategoryId[]
  /** 当前角色/运行档允许的类别白名单；不在其中直接按 `role_blocked` 拒。 */
  allowedToolCategoryIds: readonly ToolCategoryId[]
  /** 已经满足的前置条件 id（如已登录、已连接某连接器）；缺哪个就按该前置声明的代码与文案拒。 */
  satisfiedPrerequisiteIds?: readonly string[]
}

/** 构造参数：决定这份分配器用哪套发放元数据、哪些工具恒定驻留、重复申请几次熔断。 */
interface SessionToolAllocatorOptions {
  /** 宿主注入的能力端口；不传 `allocation` 时从它解析出发放元数据（操作→类别、前置条件、委派等）。 */
  capabilityPorts?: AgentRuntimeCapabilityPorts
  /** 直接给定发放元数据，优先于 `capabilityPorts` 解析结果；测试与特殊装配用它绕过端口。 */
  allocation?: ToolAllocationMetadata
  /** 基础驻留工具名单，覆盖元数据里的同名字段；发放时先按它打底，但只留运行态真有的那些。 */
  baselineToolNames?: readonly string[]
  /** 同一条申请连续几次仍未满足就熔断，最小 1，缺省 3；熔断后本轮只剩基础驻留工具。 */
  unresolvedRequestFuseThreshold?: number
}

/**
 * 会话级工具发放器：把模型的能力申请判成「发哪些类别、哪些工具，拒了哪些、为什么」。
 *
 * 按会话持有一份（模块底部还有一份进程内共享实例给无会话装配用），唯一的跨轮状态是
 * 未解决申请的计数——同一条申请反复被拒到阈值就熔断，本轮退回基础驻留工具。
 * 判定一律 fail-closed：角色不许、运行态没注册、前置没满足都出结构化拒绝项，不静默放行。
 */
interface SessionToolAllocatorApi {
  /**
   * 判一轮发放。逐条申请 → 展开成类别 → 依次过委派、角色、运行态注册、前置条件四道，
   * 全过的类别进发放清单，任一不过就记一条结构化拒绝；同一条申请连续被拒到阈值触发熔断。
   * 永远返回完整计划（含给模型看的 `message`），不抛错；熔断时 `grantedCategoryIds` 清空、
   * 工具名退回基础驻留清单。
   */
  plan<TTool extends { name: string } = ToolDescriptor>(
    input: SessionToolAllocatorPlanInput<TTool>
  ): Promise<SessionToolAllocatorPlan>
}

class SessionToolAllocator implements SessionToolAllocatorApi {
  private readonly baselineToolNames: readonly string[]
  private readonly metadata: ToolAllocationMetadata
  private readonly unresolvedRequestFuseThreshold: number
  private readonly unresolvedRequestCounts = new Map<string, number>()

  constructor(options: SessionToolAllocatorOptions = {}) {
    this.metadata = options.allocation ?? resolveToolAllocationMetadata(options.capabilityPorts)
    this.baselineToolNames =
      options.baselineToolNames ?? this.metadata.baselineToolNames ?? []
    this.unresolvedRequestFuseThreshold = Math.max(
      1,
      options.unresolvedRequestFuseThreshold ?? AgentTuning.tools.allocatorFailureBreakerThreshold
    )
  }

  public async plan<TTool extends { name: string } = ToolDescriptor>(
    input: SessionToolAllocatorPlanInput<TTool>
  ): Promise<SessionToolAllocatorPlan> {
    const runtimeIndex = buildRuntimeToolIndex(input.runtimeToolCategories)
    const runtimeCategoryMap = runtimeIndex.categoryMap
    const runtimeToolNames = runtimeIndex.toolNames
    const baselineToolNames = this.baselineToolNames.filter((toolName) =>
      runtimeToolNames.has(toolName)
    )
    const allowedCategoryIds = new Set(input.allowedToolCategoryIds)
    const enabledCategoryIds = new Set(input.enabledToolCategoryIds)
    const grantedCategoryIds: ToolCategoryId[] = []
    const deniedRequests: ToolAllocatorDeniedRequest[] = []
    let fuse: ToolAllocatorFuseState = { tripped: false }
    const advisorState: ToolAllocatorAdvisorState = { called: false }

    for (const request of input.requests) {
      const requestedCategories = this.resolveRequestedCategories(request)
      const requestDeniedBefore = deniedRequests.length

      for (const categoryId of requestedCategories) {
        const operation = this.resolveOperationForCategory(request, categoryId)
        const delegated = this.metadata.delegatedOperations?.[operation]
        if (delegated) {
          deniedRequests.push(
            createDeniedRequest({
              operation,
              categoryId,
              code: delegated.code ?? 'delegated',
              message: delegated.message,
            })
          )
          continue
        }
        const denial = this.resolveCategoryDenial({
          operation,
          categoryId,
          runtimeCategoryMap,
          allowedCategoryIds,
          satisfiedPrerequisiteIds: new Set(input.satisfiedPrerequisiteIds ?? []),
        })
        if (denial) {
          deniedRequests.push(denial)
          continue
        }
        if (!enabledCategoryIds.has(categoryId) || !grantedCategoryIds.includes(categoryId)) {
          grantedCategoryIds.push(categoryId)
        }
      }

      const requestProducedDenial = deniedRequests.length > requestDeniedBefore
      if (requestProducedDenial) {
        const signature = buildRequestSignature(request)
        const count = (this.unresolvedRequestCounts.get(signature) ?? 0) + 1
        this.unresolvedRequestCounts.set(signature, count)
        if (count >= this.unresolvedRequestFuseThreshold) {
          fuse = {
            tripped: true,
            message: `工具分配器已拦截重复申请：同一未解决能力连续 ${count} 次申请仍未满足，请停止重复申请并排查沟通或运行态前置条件。`,
          }
          deniedRequests.push(
            ...requestedCategories.map((categoryId) => ({
              operation: this.resolveOperationForCategory(request, categoryId),
              categoryId,
              code: 'request_fuse_tripped' as const,
              message: fuse.message ?? '工具申请熔断。',
            }))
          )
        }
        continue
      }

      if (isEmpty(requestedCategories)) continue

      this.unresolvedRequestCounts.delete(buildRequestSignature(request))
    }

    const uniqueDeniedRequests = dedupeDeniedRequests(deniedRequests)
    const grantedToolNameCandidates = [...baselineToolNames]
    for (const categoryId of grantedCategoryIds) {
      for (const tool of runtimeCategoryMap.get(categoryId) ?? []) {
        grantedToolNameCandidates.push(tool.name)
      }
    }
    const grantedToolNames = uniqueStrings(grantedToolNameCandidates)

    return {
      baselineToolNames,
      grantedCategoryIds: fuse.tripped ? [] : uniqueToolCategoryIds(grantedCategoryIds),
      grantedToolNames: fuse.tripped ? baselineToolNames : grantedToolNames,
      deniedRequests: uniqueDeniedRequests,
      fuse,
      advisor: advisorState,
      message: buildAllocationMessage({
        grantedCategoryIds,
        deniedRequests: uniqueDeniedRequests,
        fuse,
      }),
    }
  }

  private resolveRequestedCategories(request: ToolAllocatorRequest): ToolCategoryId[] {
    return uniqueToolCategoryIds(
      request.operations.flatMap(
        (operation) => this.metadata.operationCategories?.[operation] ?? []
      )
    )
  }

  private resolveOperationForCategory(
    request: ToolAllocatorRequest,
    categoryId: ToolCategoryId
  ): ToolAllocatorOperation {
    return (
      request.operations.find((operation) =>
        this.metadata.operationCategories?.[operation]?.includes(categoryId)
      ) ??
      request.operations[0] ??
      'unknown'
    )
  }

  private resolveCategoryDenial<TTool extends { name: string }>(input: {
    operation: ToolAllocatorOperation
    categoryId: ToolCategoryId
    runtimeCategoryMap: ReadonlyMap<ToolCategoryId, readonly TTool[]>
    allowedCategoryIds: ReadonlySet<ToolCategoryId>
    satisfiedPrerequisiteIds: ReadonlySet<string>
  }): Nullable<ToolAllocatorDeniedRequest> {
    const roleBlocked = !input.allowedCategoryIds.has(input.categoryId)
    if (roleBlocked) return createDeniedRequest({
      operation: input.operation,
      categoryId: input.categoryId,
      code: 'role_blocked',
      message: `当前角色不允许 ${input.categoryId} 分类工具。`,
    })

    const tools = input.runtimeCategoryMap.get(input.categoryId) ?? []
    if (!tools.length) return createDeniedRequest({
      operation: input.operation,
      categoryId: input.categoryId,
      code: 'not_implemented',
      message: `当前运行态没有注册 ${input.categoryId} 分类工具。`,
    })

    const missingPrerequisite = this.metadata.prerequisites?.find(
      (prerequisite) =>
        prerequisite.categoryIds.includes(input.categoryId) &&
        !input.satisfiedPrerequisiteIds.has(prerequisite.id)
    )
    if (missingPrerequisite)
      return createDeniedRequest({
        operation: input.operation,
        categoryId: input.categoryId,
        code: missingPrerequisite.denialCode ?? 'prerequisite_missing',
        message: missingPrerequisite.message,
      })

    return null
  }

}

/** 无会话装配共用的那一份发放器；跨轮状态只有未解决申请的计数。 */
export const sessionToolAllocator: SessionToolAllocatorApi = new SessionToolAllocator()

export {
  SessionToolAllocator,
}
export type { SessionToolAllocatorApi, SessionToolAllocatorOptions, SessionToolAllocatorPlanInput }
