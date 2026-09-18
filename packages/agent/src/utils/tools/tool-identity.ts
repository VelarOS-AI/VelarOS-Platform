/**
 * 模型工具的双重身份。
 *
 * VelarOS 内部只认 canonical id（`namespace:tool`）；provider 只接收它允许的传输名。
 * 传输名是一次请求的编译产物，不得写回注册表、权限策略或持久历史。
 */


import { CanonicalToolIdPatternSource } from '../../contract/constants.js'
import type { ToolTransportNamePlan, ToolTransportProjection } from '../../types/tools.js'

const ProviderToolNamePattern = /^[a-zA-Z0-9_-]{1,64}$/

/** canonical 工具 id 的正则，由合同里的源文本编出来，模型、清单、传输三方只有这一个出处。 */
const CanonicalToolIdPattern = new RegExp(CanonicalToolIdPatternSource, 'u')

/**
 * 判断字符串是否是合法的 canonical 工具 id：形如 `namespace:tool`，两段都必须以小写字母开头，
 * 命名空间段只允许小写字母、数字、`.`、`-`，工具段只允许小写字母、数字、`_`、`-`。
 */
function isCanonicalToolId(value: string): boolean {
  return CanonicalToolIdPattern.test(value)
}

/** `isCanonicalToolId` 的断言版：不合法就抛出带原值和期望格式的 Error，合法则静默返回。 */
function assertCanonicalToolId(value: string): void {
  if (!isCanonicalToolId(value))
    throw new Error(
      `canonical 工具 id "${value}" 不合法：应写成 namespace:tool，两段都以小写字母开头，命名空间段只能用小写字母、数字、点和短横线，工具段只能用小写字母、数字、下划线和短横线。`
    )
}

/**
 * 对 canonical 工具 id 算一个稳定的短指纹（FNV-1a 32 位，转 36 进制并左补零到 7 位）。
 * 只求同一个 id 在任何进程、任何轮次都得到同一串——传输名碰撞时靠它消歧，名字必须跨请求稳定，否则历史里的旧工具名就解码不回来。
 * 不是密码学哈希，也不承诺全局无碰撞（碰撞由调用方显式检测并抛错）。
 */
function stableToolNameHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0')
}

/**
 * 把 `namespace:tool` 形式的 canonical id 编译成一个候选 provider 传输名：两段各自把非 `[a-zA-Z0-9_-]` 字符换成下划线、
 * 折叠连续下划线并去首尾下划线，再用 `__` 连接（某段被净化成空时分别兜底为 `tool` / `call`）。
 * 净化结果超过 64 字符上限就截断并接上 canonical 指纹，保证长名字也能稳定落在 provider 的字符集与长度限制内。
 * 只保证「合法且稳定」，不保证唯一——净化后撞名由 createToolTransportNamePlan 负责消歧。
 */
function providerToolNameCandidate(canonicalId: string): string {
  const separatorIndex = canonicalId.indexOf(':')
  const namespace = canonicalId
    .slice(0, separatorIndex)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  const tool = canonicalId
    .slice(separatorIndex + 1)
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  const readable = `${namespace || 'tool'}__${tool || 'call'}`
  if (readable.length > 0 && readable.length <= 64) return readable

  const hash = stableToolNameHash(canonicalId)
  const prefix = readable.slice(0, Math.max(1, 64 - hash.length - 2)) || 'tool'
  return `${prefix}__${hash}`
}

/**
 * 为一个 provider 请求生成稳定、无冲突的工具名映射。
 *
 * Canonical id 编译成可读的 `namespace__tool`。任何净化碰撞都追加 canonical hash，
 * 因此外部 mod 也不能通过相似字符覆盖另一项。
 */
function createToolTransportNamePlan(canonicalIds: readonly string[]): ToolTransportNamePlan {
  const canonicalToProvider: Record<string, string> = {}
  const providerToCanonical: Record<string, string> = {}

  for (const canonicalId of [...new Set(canonicalIds)]) {
    assertCanonicalToolId(canonicalId)
    let providerName = providerToolNameCandidate(canonicalId)
    const occupiedBy = providerToCanonical[providerName]
    if (occupiedBy && occupiedBy !== canonicalId) {
      const hash = stableToolNameHash(canonicalId)
      providerName = `${providerName.slice(0, 64 - hash.length - 2)}__${hash}`
    }
    const finalOccupiedBy = providerToCanonical[providerName]
    if (finalOccupiedBy && finalOccupiedBy !== canonicalId)
      throw new Error(
        `provider 传输名撞车："${canonicalId}" 与 "${finalOccupiedBy}" 都会编译成 "${providerName}"；加指纹消歧后仍然撞上，请改掉其中一个工具的 canonical id。`
      )

    canonicalToProvider[canonicalId] = providerName
    providerToCanonical[providerName] = canonicalId
  }

  return Object.freeze({
    canonicalToProvider: Object.freeze(canonicalToProvider),
    providerToCanonical: Object.freeze(providerToCanonical),
  })
}

/**
 * 补全仅存在于历史中的 canonical 工具名传输别名。
 *
 * 动态工具空间只会把当前可见工具放进 provider tools，但历史里仍可能保留已经 page-out 的
 * tool-call/result。它们不是本轮可调用能力，却仍属于 provider 输入结构，名字同样必须满足供应方
 * 的字符集。这里只补请求历史的序列化别名；调用响应的 advertised 映射仍由可见工具快照单独维护，
 * 不能借此把历史工具重新开放出来。
 */
function completeToolTransportNameAliases(
  existingAliases: Readonly<Record<string, string>>,
  historicalToolNames: readonly string[]
): Readonly<Record<string, string>> {
  const completed = { ...existingAliases }
  const occupiedByProviderName = new Map<string, string>()

  for (const [canonicalId, providerName] of Object.entries(completed)) {
    const occupiedBy = occupiedByProviderName.get(providerName)
    if (occupiedBy && occupiedBy !== canonicalId)
      throw new Error(
        `provider 传输名撞车："${canonicalId}" 与 "${occupiedBy}" 都会编译成 "${providerName}"；加指纹消歧后仍然撞上，请改掉其中一个工具的 canonical id。`
      )
    occupiedByProviderName.set(providerName, canonicalId)
  }

  const missingCanonicalIds = [...new Set(historicalToolNames)]
    .filter(
      (toolName) =>
        !completed[toolName] &&
        !ProviderToolNamePattern.test(toolName) &&
        isCanonicalToolId(toolName)
    )
    .sort()

  for (const canonicalId of missingCanonicalIds) {
    let providerName = providerToolNameCandidate(canonicalId)
    const occupiedBy = occupiedByProviderName.get(providerName)
    if (occupiedBy && occupiedBy !== canonicalId) {
      const hash = stableToolNameHash(canonicalId)
      providerName = `${providerName.slice(0, 64 - hash.length - 2)}__${hash}`
    }
    const finalOccupiedBy = occupiedByProviderName.get(providerName)
    if (finalOccupiedBy && finalOccupiedBy !== canonicalId)
      throw new Error(
        `provider 传输名撞车："${canonicalId}" 与 "${finalOccupiedBy}" 都会编译成 "${providerName}"；加指纹消歧后仍然撞上，请改掉其中一个工具的 canonical id。`
      )

    completed[canonicalId] = providerName
    occupiedByProviderName.set(providerName, canonicalId)
  }

  return Object.freeze(completed)
}

/**
 * 从完整注册目录编译稳定传输身份，再投影出本次请求实际可见的工具。
 *
 * 不能只从可见工具编译：两个 canonical id 净化后发生碰撞时，工具驻留状态的变化会让
 * 同一工具在不同请求里改名，进而破坏历史解码、工具续租和未驻留调用的 fail-closed 判定。
 */
function createToolTransportProjection(
  registeredCanonicalIds: readonly string[],
  visibleCanonicalIds: readonly string[]
): ToolTransportProjection {
  const plan = createToolTransportNamePlan(registeredCanonicalIds)
  const visibleCanonicalToProvider: Record<string, string> = {}
  for (const canonicalId of visibleCanonicalIds) {
    const providerName = plan.canonicalToProvider[canonicalId]
    if (!providerName)
      throw new Error(
        `可见工具 ${canonicalId} 不在已登记的传输名方案里：传输名只从完整注册目录编译，这个工具没登记过，请先把它注册进工具注册表再让它可见。`
      )
    visibleCanonicalToProvider[canonicalId] = providerName
  }

  return Object.freeze({
    plan,
    visibleCanonicalToProvider: Object.freeze(visibleCanonicalToProvider),
  })
}

const ToolIdentityTokenCharacters = 'a-zA-Z0-9._:-'
const ProviderToolIdentityTokenCharacters = 'a-zA-Z0-9_-'

/**
 * 转义字符串里的正则元字符（`. * + ? ^ $ { } ( ) | [ ] \`），让它能安全地嵌进 RegExp 字面量当纯文本匹配。
 * 工具 id 里的 `.` 之类字符若不转义会退化成通配，替换就会误伤别的工具名。
 */
function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 把模型可见文本里的 canonical 工具引用编译成当前请求的 provider 别名。
 *
 * 只替换完整 identity token，避免 `project:read` 误伤 `project:read_more`；映射只活在
 * provider 请求边界，不得写回提示词定义、注册表或持久历史。
 */
function rewriteCanonicalToolReferences(
  text: string,
  aliases: Readonly<Record<string, string>>
): string {
  return rewriteToolReferences(text, aliases, ToolIdentityTokenCharacters)
}

/** 把 provider 可见别名还原为持久历史和用户界面使用的 canonical id。 */
function rewriteProviderToolReferences(
  text: string,
  providerToCanonical: Readonly<Record<string, string>>
): string {
  return rewriteToolReferences(text, providerToCanonical, ProviderToolIdentityTokenCharacters)
}

/**
 * 在文本里按替换表改写工具引用，两个方向（canonical→provider、provider→canonical）共用这一支，
 * 差别只在 `tokenCharacters`——它定义什么字符算 identity token 的一部分。
 * 只替换完整 token：匹配要求左边界是行首或非 token 字符、右边界是行尾或非 token 字符，所以 `project:read` 不会误伤 `project:read_more`。
 * 源与目标相同的条目跳过；其余按源串长度降序（同长按字典序）替换，长名先替，避免短名先替把长名劈开。
 */
function rewriteToolReferences(
  text: string,
  replacements: Readonly<Record<string, string>>,
  tokenCharacters: string
): string {
  let rewritten = text
  const entries = Object.entries(replacements)
    .filter(([source, target]) => source !== target)
    .sort(([left], [right]) => right.length - left.length || left.localeCompare(right))

  for (const [source, target] of entries) {
    const pattern = new RegExp(
      `(^|[^${tokenCharacters}])${escapeRegularExpression(source)}(?=$|[^${tokenCharacters}])`,
      'gu'
    )
    rewritten = rewritten.replace(pattern, (_match, prefix: string) => `${prefix}${target}`)
  }
  return rewritten
}

export {
  assertCanonicalToolId,
  completeToolTransportNameAliases,
  createToolTransportNamePlan,
  createToolTransportProjection,
  escapeRegularExpression,
  isCanonicalToolId,
  ProviderToolIdentityTokenCharacters,
  ProviderToolNamePattern,
  rewriteCanonicalToolReferences,
  rewriteProviderToolReferences,
}
