/** Canonical model-tool identity shared by manifests, registries, and transports. */
const CanonicalToolIdPattern = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9_-]*$/

/**
 * 判断字符串是否是合法的 canonical 工具 id：形如 `namespace:tool`，两段都必须以小写字母开头，
 * 命名空间段只允许小写字母、数字、`.`、`-`，工具段只允许小写字母、数字、`_`、`-`。
 * 大写、空串、缺冒号、多段冒号一律为假——模型/清单/传输三方靠它对齐同一套工具身份。
 */
function isCanonicalToolId(value: string): boolean {
  return CanonicalToolIdPattern.test(value)
}

/**
 * `isCanonicalToolId` 的断言版：不合法就抛出带原值和期望格式的 Error，合法则静默返回。
 * 用在清单登记、注册表装配这类「早失败好过把坏 id 发给模型」的入口。
 */
function assertCanonicalToolId(value: string): void {
  if (!isCanonicalToolId(value))
    throw new Error(
      `canonical 工具 id "${value}" 不合法：应写成 namespace:tool，两段都以小写字母开头，命名空间段只能用小写字母、数字、点和短横线，工具段只能用小写字母、数字、下划线和短横线。`
    )
}

export { assertCanonicalToolId, CanonicalToolIdPattern, isCanonicalToolId }
