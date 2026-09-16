
import type { ToolCategoryId } from '../../types/agent.js'
import type { ToolSpaceRecoveryGuide } from '../../types/tools.js'

/**
 * 模型调了一个当前拿不到的工具时，给它拼一份「怎么把这个工具弄到手」的恢复指引（随失败结果一起进模型上下文）。
 * 四条固定动作按 tooling:map 定位 → 满足 activation.dependencies → 按 visible/loadable 分支调用或换页 → requires_approval/requires_user_action 的处理排；
 * 给了 `categoryId` 才会带上 `capability:<id>` 这一层（否则 capabilityId 为 null，指引退化成只针对单个工具页）；
 * 给了 `unavailableReason` 再追加一条原因说明，明确告诉模型别再原样重试同一个被隔离的工具。
 */
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
