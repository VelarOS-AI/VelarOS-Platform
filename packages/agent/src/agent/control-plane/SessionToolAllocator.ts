import { isEmpty } from '@velaros-ai/core'
import type { ToolCategoryId, ToolDescriptor } from '@velaros-ai/core/types'

import {
  type AgentRuntimeCapabilityPorts,
  resolveToolAllocationMetadata,
  type ToolAllocationMetadata,
} from '../../capabilities'

type ToolAllocatorOperation = string
interface ToolAllocatorRequest {
  intent: string
  operations: readonly ToolAllocatorOperation[]
  targets?: readonly string[]
  reason: string
}

interface ToolAllocatorCategory<TTool extends { name: string } = ToolDescriptor> {
  category: { id: ToolCategoryId } & Record<string, unknown>
  tools: readonly TTool[]
}

type ToolAllocatorDenialCode =
  | 'not_implemented'
  | 'role_blocked'
  | 'request_fuse_tripped'
  | 'prerequisite_missing'
  | 'delegated'
  | (string & {})

interface ToolAllocatorDeniedRequest {
  operation: ToolAllocatorOperation
  categoryId: ToolCategoryId
  code: ToolAllocatorDenialCode
  message: string
}

interface ToolAllocatorFuseState {
  tripped: boolean
  message?: string
}

interface ToolAllocatorAdvisorState {
  called: boolean
  message?: string
  error?: string
}

interface SessionToolAllocatorPlanInput<TTool extends { name: string } = ToolDescriptor> {
  turn: number
  latestUserText: string
  requests: readonly ToolAllocatorRequest[]
  runtimeToolCategories: ReadonlyArray<ToolAllocatorCategory<TTool>>
  catalogToolCategories?: ReadonlyArray<ToolAllocatorCategory<TTool>>
  enabledToolCategoryIds: readonly ToolCategoryId[]
  allowedToolCategoryIds: readonly ToolCategoryId[]
  satisfiedPrerequisiteIds?: readonly string[]
}

interface SessionToolAllocatorPlan {
  baselineToolNames: string[]
  grantedCategoryIds: ToolCategoryId[]
  grantedToolNames: string[]
  deniedRequests: ToolAllocatorDeniedRequest[]
  fuse: ToolAllocatorFuseState
  advisor: ToolAllocatorAdvisorState
  message: string
}

interface ToolAllocatorRuntimeIndex<TTool extends { name: string }> {
  categoryMap: Map<ToolCategoryId, TTool[]>
  toolNames: Set<string>
}

interface SessionToolAllocatorOptions {
  capabilityPorts?: AgentRuntimeCapabilityPorts
  allocation?: ToolAllocationMetadata
  baselineToolNames?: readonly string[]
  unresolvedRequestFuseThreshold?: number
}

function createDeniedRequest(input: {
  operation: ToolAllocatorOperation
  categoryId: ToolCategoryId
  code: ToolAllocatorDenialCode
  message: string
}): ToolAllocatorDeniedRequest {
  return {
    operation: input.operation,
    categoryId: input.categoryId,
    code: input.code,
    message: input.message,
  }
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

function uniqueToolCategoryIds(values: Iterable<ToolCategoryId>): ToolCategoryId[] {
  return [...new Set(values)]
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

class SessionToolAllocator {
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
      options.unresolvedRequestFuseThreshold ?? 3
    )
  }

  public async plan<TTool extends { name: string } = ToolDescriptor>(
    input: SessionToolAllocatorPlanInput<TTool>
  ): Promise<SessionToolAllocatorPlan> {
    const runtimeIndex = this.buildRuntimeToolIndex(input.runtimeToolCategories)
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
        const signature = this.buildRequestSignature(request)
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

      this.unresolvedRequestCounts.delete(this.buildRequestSignature(request))
    }

    const uniqueDeniedRequests = this.dedupeDeniedRequests(deniedRequests)
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
      message: this.buildMessage({
        grantedCategoryIds,
        deniedRequests: uniqueDeniedRequests,
        fuse,
      }),
    }
  }

  private buildRuntimeToolIndex<TTool extends { name: string }>(
    categories: ReadonlyArray<ToolAllocatorCategory<TTool>>
  ): ToolAllocatorRuntimeIndex<TTool> {
    const categoryMap = new Map<ToolCategoryId, TTool[]>()
    const toolNames = new Set<string>()

    for (const category of categories) {
      const visibleTools: TTool[] = []
      for (const tool of category.tools) {
        visibleTools.push(tool)
        toolNames.add(tool.name)
      }
      categoryMap.set(category.category.id, visibleTools)
    }

    return { categoryMap, toolNames }
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

  private dedupeDeniedRequests(
    deniedRequests: readonly ToolAllocatorDeniedRequest[]
  ): ToolAllocatorDeniedRequest[] {
    const seen = new Set<string>()
    const result: ToolAllocatorDeniedRequest[] = []
    for (const denied of deniedRequests) {
      const key = [
        denied.operation,
        denied.categoryId,
        denied.code,
        denied.message,
      ].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      result.push(denied)
    }
    return result
  }

  private buildRequestSignature(request: ToolAllocatorRequest): string {
    return [
      normalizeText(request.intent),
      request.operations.map((operation) => operation.trim()).sort().join(','),
      [...(request.targets ?? [])].map(normalizeText).sort().join(','),
    ].join('|')
  }

  private buildMessage(input: {
    grantedCategoryIds: readonly ToolCategoryId[]
    deniedRequests: readonly ToolAllocatorDeniedRequest[]
    fuse: ToolAllocatorFuseState
  }): string {
    if (input.fuse.tripped) return input.fuse.message ?? '工具申请已熔断。'
    const granted = uniqueToolCategoryIds(input.grantedCategoryIds)
    if (isEmpty(granted) && isEmpty(input.deniedRequests)) return '工具分配器保留基础驻留工具，本轮没有额外发放。'
    const parts: string[] = []
    if (!isEmpty(granted)) {
      parts.push(`已发放工具分类：${granted.join(', ')}。`)
    }
    if (!isEmpty(input.deniedRequests)) {
      parts.push(
        `未发放：${input.deniedRequests
          .map((item) => `${item.categoryId}/${item.code}${item.message ? `：${item.message}` : ''}`)
          .join(', ')}。`
      )
    }
    return parts.join(' ')
  }
}

const sessionToolAllocator = new SessionToolAllocator()

export {
  SessionToolAllocator,
  sessionToolAllocator,
}
export type {
  SessionToolAllocatorOptions,
  SessionToolAllocatorPlan,
  SessionToolAllocatorPlanInput,
  ToolAllocatorAdvisorState,
  ToolAllocatorDeniedRequest,
  ToolAllocatorOperation,
  ToolAllocatorRequest,
}
