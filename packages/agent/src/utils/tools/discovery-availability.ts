
import type { ToolCategoryId, ToolOsState } from '../../types/agent.js'
import type { ToolCategoryUnavailableReason, ToolDiscoveryAvailability, ToolDiscoveryCategoryAvailabilityInput, ToolDiscoveryNextAction, ToolDiscoverySchemaState, ToolDiscoveryToolAvailabilityInput } from '../../types/tools.js'

const ToolDiscoveryAvailabilityValues = [
  'visible',
  'loadable',
  'requires_approval',
  'requires_user_action',
  'unavailable',
] as const satisfies readonly ToolDiscoveryAvailability[]

/**
 * 作用域策略拒掉某个工具类别时该对模型呈现成什么可用性——目前一律 `'unavailable'`：被策略拒的东西不给「可加载」的假希望。
 * 入参 reason 暂不参与判定（保留形参是为了将来按拒因分档，比如把「缺前置事实」降级成 requires_user_action 而不是彻底不可用）。
 */
function blockedCategoryAvailability(
  _reason: Nullable<ToolCategoryUnavailableReason>
): ToolDiscoveryAvailability {
  return 'unavailable'
}

/**
 * 某个工具类别是否允许模型自己换页装上——当前恒为真：内核不维护「只能预置、不准按需加载」的类别白名单。
 * 保留形参与这个判定点，是为了让上面两支 availability 解析不必因为将来加类别限制而改结构。
 */
function categoryIsLoadable(_categoryId: ToolCategoryId): boolean {
  return true
}

/**
 * 算一个能力（工具类别）页在 tool_map 里的可用性档位，按角色 → 作用域 → 已开启 → 运行时有货的顺序短路。
 * 角色不给用或作用域拒绝直接 `unavailable`；已开启即 `visible`；未开启但类别下一个运行时可用的工具都没有也判 `unavailable`（避免给模型一个换页后空手而归的页）；
 * 其余情况按是否需要人工批准给 `requires_approval` / `loadable`。
 */
function resolveCapabilityDiscoveryAvailability(
  input: ToolDiscoveryCategoryAvailabilityInput
): ToolDiscoveryAvailability {
  if (!input.categoryAllowed) return 'unavailable'
  if (!input.categoryAccessAllowed) return blockedCategoryAvailability(input.categoryUnavailableReason)
  if (input.categoryEnabled) return 'visible'
  if (!input.hasRuntimeAvailableTool) return 'unavailable'
  if (categoryIsLoadable(input.categoryId)) return input.requiresApproval ? 'requires_approval' : 'loadable'
  if (input.pluginBacked) return input.requiresApproval ? 'requires_approval' : 'loadable'
  return 'unavailable'
}

/**
 * 算单个工具页在 tool_map 里的可用性档位：角色不给用、系统开关关着、作用域拒绝，任一命中即 `unavailable`。
 * 已经暴露给模型的 → `visible`；否则必须 `runtimeAvailable` 才谈得上加载（宿主没实现的工具绝不显示成 loadable），
 * 再按是否需要人工批准落到 `requires_approval` / `loadable`，都不满足则 `unavailable`。
 */
function resolveToolDiscoveryAvailability(
  input: ToolDiscoveryToolAvailabilityInput
): ToolDiscoveryAvailability {
  if (!input.categoryAllowed || !input.systemEnabled) return 'unavailable'
  if (!input.categoryAccessAllowed) return blockedCategoryAvailability(input.categoryUnavailableReason)
  if (input.visible) return 'visible'
  if (input.categoryEnabled && input.runtimeAvailable) return 'loadable'
  if (categoryIsLoadable(input.categoryId) && input.runtimeAvailable) return input.requiresApproval ? 'requires_approval' : 'loadable'
  if (input.pluginBacked && input.runtimeAvailable) return input.requiresApproval ? 'requires_approval' : 'loadable'
  return 'unavailable'
}

/**
 * 工具页该标成「入参契约已知」还是「未知」——恒为 `'visible'`，与可用性档位无关（形参只为签名统一保留）。
 * 理由见函数体内注释：页背后的是已注册工具，契约在系统里一定存在，模型换页后的下一轮才拿到真 schema。
 */
function schemaStateForDiscoveryAvailability(
  availability: ToolDiscoveryAvailability
): ToolDiscoverySchemaState {
  void availability
  // 具体工具页描述已注册工具，故系统内部存在权威输入契约；
  // 主模型路径仍只看页摘要，真实 schema 在 page-in 后的下一轮暴露。
  return 'visible'
}

/**
 * 把可用性档位翻译成写给模型看的下一步动作：visible→`call_tool`、loadable→`replace_page`、
 * requires_approval→`request_approval`、requires_user_action→`request_user_action`、unavailable→`none`。
 * 穷举 switch 无 default，新增档位会在编译期报错，避免模型收到一个没有行动指引的页。
 */
function nextActionForDiscoveryAvailability(
  availability: ToolDiscoveryAvailability
): ToolDiscoveryNextAction {
  switch (availability) {
    case 'visible':
      return 'call_tool'
    case 'loadable':
      return 'replace_page'
    case 'requires_approval':
      return 'request_approval'
    case 'requires_user_action':
      return 'request_user_action'
    case 'unavailable':
      return 'none'
  }
}

/**
 * 把可用性档位压成对外展示的 `ToolOsState` 四态：visible→`resident`，loadable 与 requires_approval 合并为 `loadable`
 * （对 UI 而言都是「还没常驻但能拿到」，差别留在 nextAction 里），requires_user_action→`needs_setup`，unavailable→`unavailable`。
 */
function toolOsStateForDiscoveryAvailability(
  availability: ToolDiscoveryAvailability
): ToolOsState {
  switch (availability) {
    case 'visible':
      return 'resident'
    case 'loadable':
    case 'requires_approval':
      return 'loadable'
    case 'requires_user_action':
      return 'needs_setup'
    case 'unavailable':
      return 'unavailable'
  }
}

export {
  nextActionForDiscoveryAvailability,
  resolveCapabilityDiscoveryAvailability,
  resolveToolDiscoveryAvailability,
  schemaStateForDiscoveryAvailability,
  ToolDiscoveryAvailabilityValues,
  toolOsStateForDiscoveryAvailability,
}
