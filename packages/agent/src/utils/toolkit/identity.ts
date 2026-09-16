/** Canonical 工具身份：判定与断言在 `@velaros-ai/tool-contract`，这里按原名转发给 agent 自己与 `./tool-contract` 入口。 */

import { CanonicalToolIdPatternSource, toolIdentity } from '@velaros-ai/tool-contract'

/** canonical 工具 id 的正则：形如 `namespace:tool`，两段都以小写字母开头；模式源文本在工具契约的常量表里。 */
const CanonicalToolIdPattern = new RegExp(CanonicalToolIdPatternSource, 'u')

/**
 * 判断字符串是否是合法的 canonical 工具 id：形如 `namespace:tool`，两段都必须以小写字母开头，
 * 命名空间段只允许小写字母、数字、`.`、`-`，工具段只允许小写字母、数字、`_`、`-`。
 */
function isCanonicalToolId(value: string): boolean {
  return toolIdentity.isCanonical(value)
}

/** `isCanonicalToolId` 的断言版：不合法就抛出带原值和期望格式的 Error，合法则静默返回。 */
function assertCanonicalToolId(value: string): void {
  toolIdentity.assertCanonical(value)
}

export { assertCanonicalToolId, CanonicalToolIdPattern, isCanonicalToolId }
