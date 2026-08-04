import type { ToolCategoryId } from '@velaros-ai/agent/protocol'

interface ToolSpaceRecoveryGuide {
  query: string
  pageId: string
  capabilityId: Nullable<string>
  nextActions: string[]
}

function buildToolSpaceRecoveryGuide(input: {
  toolName: string
  categoryId?: LooseOptional<ToolCategoryId>
  unavailableReason?: LooseOptional<string>
}): ToolSpaceRecoveryGuide {
  const capabilityId = input.categoryId ? `capability:${input.categoryId}` : null
  const target = capabilityId
    ? `tool:${input.toolName} / ${capabilityId}`
    : `tool:${input.toolName}`
  const nextActions = [
    `先用 tooling:map(kind:"all") 查看系统工具地图和 guide.dependencyRules；或用 tooling:map(op:"find", query:"${input.toolName}") 定位目标工具状态和功能摘要。需要缩小范围时使用 domainIds/toolOsStates。`,
    `先满足 ${target} 的 activation.dependencies；具体前置条件与用户动作由能力页声明，不要猜测宿主资源或切换方式。`,
    `如果 ${target} 是 visible，直接调用真实工具；如果是 loadable，先 tooling:replace(pageIn:["tool:${input.toolName}"])，下一轮通过真实 schema 调用。`,
    `如果 ${target} 是 requires_approval，用 tooling:replace(pageIn:["${capabilityId ?? `tool:${input.toolName}`}"]) 做一类能力激活；如果是 requires_user_action，严格执行 activation.dependencies 与 nextActions。`,
  ]

  if (input.unavailableReason) {
    nextActions.push(
      `不可用原因：${input.unavailableReason}。该原因属于能力包；按工具页声明的恢复动作处理，不要重复调用被隔离工具。`
    )
  }

  return {
    query: input.toolName,
    pageId: `tool:${input.toolName}`,
    capabilityId,
    nextActions,
  }
}

export { buildToolSpaceRecoveryGuide }
export type { ToolSpaceRecoveryGuide }
