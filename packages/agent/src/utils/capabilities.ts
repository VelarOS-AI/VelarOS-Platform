import type { AgentRuntimeCapabilityPorts,CapabilityContextCollector, CapabilityDelegationPolicy, CapabilityIntentClassifier, CapabilityScopePolicy, CapabilityValidationInterpreter, ToolAllocationMetadata, ToolResultMiddleware, ToolValidationHintProvider } from '../contract/requires.js'
import type { CapabilityScopeId, ToolCategoryDefinition, ToolCategoryId } from '../types/agent.js'
import type { CapabilityScopeCategoryDecision, CapabilityScopeResidency, CapabilityScopeRuntimeFacts, ToolAllocationDelegation, ToolAllocationPrerequisite } from '../types/capabilities.js'
import type { PromptSegmentDefinition } from '../types/guidance.js'

import { compareStableStrings } from './residency/determinism'

/**
 * 取子 Agent 的工具面禁令（只认顶层 `ports.delegationPolicy`，不收 extensions 的声明），两份名单各自去重。
 * 端口缺席时返回两个空数组：空名单 = 不额外禁，而不是"全禁"，更不是报错。
 */
export function resolveCapabilityDelegationPolicy(
  ports?: AgentRuntimeCapabilityPorts
): Required<CapabilityDelegationPolicy> {
  return {
    blockedToolNames: [...new Set(ports?.delegationPolicy?.blockedToolNames ?? [])],
    blockedCategoryIds: [...new Set(ports?.delegationPolicy?.blockedCategoryIds ?? [])],
  }
}

/**
 * 找出本次装配唯一生效的作用域策略：顶层 `scopePolicy` 给了就直接用它（extensions 里的不再看），
 * 否则从 extensions 里收。一个都没有返回 `undefined`（作用域语义缺席，下游一律按放行 / 默认处理）；
 * 收到两个及以上直接抛错——两份策略同时判类别会得出互相矛盾的工具面，宁可装配期炸掉也不让它带病跑。
 */
export function resolveCapabilityScopePolicy(
  ports?: LooseOptional<AgentRuntimeCapabilityPorts>
): CapabilityScopePolicy | undefined {
  if (ports?.scopePolicy) return ports.scopePolicy
  const policies = ports?.extensions
    ?.map((extension) => extension.scopePolicy)
    .filter((policy): policy is CapabilityScopePolicy => !!policy)
  if (!policies?.length) return undefined
  if (policies.length > 1)
    throw new Error('同一次装配只允许一份 capability 作用域策略生效：现在有多个扩展各带一份 scopePolicy，两份策略同时判类别会得出互相矛盾的工具面。请把它们合并，或在顶层 ports.scopePolicy 指定唯一一份。')
  return policies[0]
}

/**
 * 定出本次执行的作用域 id，三级回退：作用域策略的裁决 → `facts.scopeId`（去首尾空白）→ `'default'`。
 * 策略缺席（或没给出值）不算失败，只是把决定权交回事实声明；内核把这个 id 当不透明串，不解释任何作用域语义。
 */
export function resolveCapabilityScopeId(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  facts: CapabilityScopeRuntimeFacts
): CapabilityScopeId {
  return (
    resolveCapabilityScopePolicy(ports)?.resolveScopeId(facts) ??
    facts.scopeId?.trim() ??
    'default'
  )
}

/**
 * 问作用域策略"这个工具类别在当前作用域能不能开"。
 * 策略缺席时返回 `{ allowed: true }`：没人管 = 放行，不是默认拒绝；要拒必须由策略明确表态并带上 reasonCode/message 给模型看。
 */
export function decideCapabilityScopeCategory(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  categoryId: ToolCategoryId,
  facts: CapabilityScopeRuntimeFacts
): CapabilityScopeCategoryDecision {
  return (
    resolveCapabilityScopePolicy(ports)?.decideCategory(categoryId, facts) ?? {
      allowed: true,
    }
  )
}

/**
 * 把一批工具类别交给作用域策略扩成连带需要的类别（开 A 就必须同时开 B），再整体去重。
 * 策略缺席或没实现 `expandCategoryIds` 时按原样返回（仍然去重）；只扩一层，策略吐出什么就是什么，不拿结果再扩一轮。
 */
export function expandCapabilityCategoryIds(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  categoryIds: readonly ToolCategoryId[]
): ToolCategoryId[] {
  const expanded = resolveCapabilityScopePolicy(ports)?.expandCategoryIds?.(categoryIds)
  return [...new Set(expanded ?? categoryIds)]
}

/**
 * 取当前作用域的常驻工具声明（常驻 / 排除 / 受保护不许摘三份名单）。
 * 策略缺席或没实现 `getResidency` 时返回 `{}`：三份名单全缺席即"没有常驻集"，工具面完全交给分配器按需开，不是错。
 */
export function resolveCapabilityScopeResidency(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  facts: CapabilityScopeRuntimeFacts
): CapabilityScopeResidency {
  return resolveCapabilityScopePolicy(ports)?.getResidency?.(facts) ?? {}
}

/**
 * 把各能力扩展与顶层声明的工具别名合成一张表（旧名 / 别名 → 现名）。
 * 冲突按写入次序解决：extensions 按装配顺序依次覆盖，顶层 `toolAliases` 最后写所以永远赢。
 * 全部缺席返回空表 = 不做任何改名；模型用旧名或改过的名字调工具时靠这张表纠回 canonical 名。
 */
export function resolveToolAliases(
  ports?: AgentRuntimeCapabilityPorts
): Readonly<Record<string, string>> {
  return Object.assign(
    {},
    ...(ports?.extensions?.map((extension) => extension.toolAliases ?? {}) ?? []),
    ports?.toolAliases ?? {}
  )
}

/**
 * 汇总各能力扩展 descriptor 里声明的工具类别目录——类别语义归产品包所有，内核自己不内置任何类别。
 * 按扩展装配顺序逐个写入；同一 id 出现两次且定义**内容不一致**（`JSON.stringify` 逐字比对，键序敏感）直接抛错，
 * 不静默取后者：类别 id 是整个工具面的公共命名空间，两份不同定义会让同一 id 在不同调用点表现不一，必须在装配期就炸出来。
 * 一字不差的重复声明放行。没有扩展时返回空表。
 */
export function resolveCapabilityCategoryDefinitions(
  ports?: AgentRuntimeCapabilityPorts
): Readonly<Record<ToolCategoryId, ToolCategoryDefinition>> {
  const definitions: Record<ToolCategoryId, ToolCategoryDefinition> = {}
  for (const extension of ports?.extensions ?? []) {
    for (const category of extension.descriptor.categories ?? []) {
      const existing = definitions[category.id]
      if (existing && JSON.stringify(existing) !== JSON.stringify(category)) {
        throw new Error(`注入的工具类别定义冲突：${category.id} 被两个扩展声明成了不同内容。类别 id 是整个工具面的公共命名空间，同一个 id 只能有一份定义，请让两处完全一致或改用不同 id。`)
      }
      definitions[category.id] = category
    }
  }
  return definitions
}

/**
 * 各类端口清单共用的排序器：priority 小的在前（省略按 0），并列时按 id 的 UTF-16 码元序兜底。
 * 不用 `localeCompare`——它随 ICU 数据与 locale 变化，同一份装配在两台机器上会排出不同顺序；
 * 而提示词段的排序结果直接就是 prompt 的字节顺序，一漂移就打掉整条前缀缓存。
 */
function byPriority<T extends { priority?: number; id: string }>(left: T, right: T): number {
  return (left.priority ?? 0) - (right.priority ?? 0) || compareStableStrings(left.id, right.id)
}

/**
 * 汇总工具回执的后处理链：extensions 贡献的先铺平、顶层 `resultMiddlewares` 接在后面，整体再按 `byPriority` 重排。
 * 排序结果即执行次序，链上每一环看到的是前一环改过的回执。
 * 都缺席时返回空数组 = 回执原样送进模型面，不做任何后处理。
 */
export function resolveToolResultMiddlewares(
  ports?: AgentRuntimeCapabilityPorts
): Array<ToolResultMiddleware<any>> {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.resultMiddlewares ?? []) ?? []),
    ...(ports?.resultMiddlewares ?? []),
  ].sort(byPriority)
}

/**
 * 汇总"参数校验失败该怎么改"的补救指引供应方，合并与排序规则同 `resolveToolResultMiddlewares`。
 * 调用方按这个顺序逐个问，取第一个给得出建议的，所以 priority 实际决定谁的话被模型看见。
 * 返回空数组时模型只拿到原始校验错误，没有改法提示——这是降级，不是失败。
 */
export function resolveToolValidationHintProviders(
  ports?: AgentRuntimeCapabilityPorts
): ToolValidationHintProvider[] {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.validationHintProviders ?? []) ?? []),
    ...(ports?.validationHintProviders ?? []),
  ].sort(byPriority)
}

/**
 * 汇总验证结论解释器（把某类工具的回执翻成"这次验证过没过、证据是什么"），合并与排序规则同上。
 * 返回空数组 = 没人能解释验证回执，编码会话判不出验证真假，只能一律按"未验证"对待。
 */
export function resolveCapabilityValidationInterpreters(
  ports?: AgentRuntimeCapabilityPorts
): CapabilityValidationInterpreter[] {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.validationInterpreters ?? []) ?? []),
    ...(ports?.validationInterpreters ?? []),
  ].sort(byPriority)
}

/**
 * 按当前运行快照产出各能力方要注入的提示词段：先把 extensions 与顶层的贡献者合并排序，再依次收段并铺平成一条序列。
 * 这条序列的顺序就是提示词的字节顺序，所以排序必须确定性（priority + id 码元序），贡献者也必须是纯函数、不在里面做 IO。
 * 快照形状对内核刻意不透明，由各贡献者自己认领字段；没有贡献者时返回空数组 = 不注入任何段落。
 */
export function resolveCapabilityPromptSegments(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  snapshot: unknown
): PromptSegmentDefinition[] {
  const contributors = [
    ...(ports?.extensions?.flatMap((extension) => extension.promptContributors ?? []) ?? []),
    ...(ports?.promptContributors ?? []),
  ].sort(byPriority)
  return contributors.flatMap((contributor) => [...contributor.getSegments(snapshot)])
}

/**
 * 汇总每轮的上下文采集器，合并与排序规则同上（这里的 priority 只钉死遍历次序，实际采集是并发的）。
 * 返回空数组 = 本轮工具上下文不额外补任何数据。
 */
export function resolveCapabilityContextCollectors(
  ports?: LooseOptional<AgentRuntimeCapabilityPorts>
): CapabilityContextCollector[] {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.contextCollectors ?? []) ?? []),
    ...(ports?.contextCollectors ?? []),
  ].sort(byPriority)
}

/**
 * 汇总意图分类器，合并与排序规则同上。Agent 只负责把各能力域报上来的通用信号收齐，不解释任何私有意图语义。
 * 返回空数组 = 这次执行识别不出任何意图信号，下游按"无信号"走，不是报错。
 */
export function resolveCapabilityIntentClassifiers(
  ports?: AgentRuntimeCapabilityPorts
): CapabilityIntentClassifier[] {
  return [
    ...(ports?.extensions?.flatMap((extension) => extension.intentClassifiers ?? []) ?? []),
    ...(ports?.intentClassifiers ?? []),
  ].sort(byPriority)
}

/**
 * 跑一遍全部上下文采集器，把各自结果按 `collector.id` 归档成一个对象交给工具上下文。
 * 全部采集器**并发**执行（`Promise.all`），任一个抛错整次采集就失败——所以采集器必须自己兜住可预期的失败，别把 IO 异常抛出来。
 * 同 id 的采集器会互相覆盖（后一个赢）；没有采集器时返回空对象。
 */
export async function collectCapabilityContext(
  ports: LooseOptional<AgentRuntimeCapabilityPorts>,
  messages: readonly unknown[],
  context?: Readonly<Record<string, unknown>>
): Promise<Readonly<Record<string, unknown>>> {
  const entries = await Promise.all(
    resolveCapabilityContextCollectors(ports).map(async (collector) => [
      collector.id,
      await collector.collect(messages, context),
    ] as const)
  )
  return Object.fromEntries(entries)
}

/**
 * 把各扩展与顶层声明的工具分配元数据合成一份，四个字段各按各的合并语义：
 * `baselineToolNames` 取并集（保底工具谁声明都算数）、`operationCategories` 按 operationId 取并集去重（要开的类别只多不少）、
 * `delegatedOperations` 后装配者整条覆盖（顶层排在最后，所以顶层的委派结论最终说了算）、
 * `prerequisites` 直接拼接不去重（每条独立判定，重复声明只是多判一次）。
 * 全部缺席时四项返回空容器 = 分配器不受任何声明约束，而不是无工具可开。
 */
export function resolveToolAllocationMetadata(
  ports?: AgentRuntimeCapabilityPorts
): ToolAllocationMetadata {
  const sources = [
    ...(ports?.extensions?.map((extension) => extension.allocation).filter(Boolean) ?? []),
    ports?.allocation,
  ].filter((source): source is ToolAllocationMetadata => !!source)

  const baselineToolNames = new Set<string>()
  const operationCategories: Record<string, ToolCategoryId[]> = {}
  const delegatedOperations: Record<string, ToolAllocationDelegation> = {}
  const prerequisites: ToolAllocationPrerequisite[] = []

  for (const source of sources) {
    source.baselineToolNames?.forEach((name) => baselineToolNames.add(name))
    for (const [operationId, categoryIds] of Object.entries(source.operationCategories ?? {})) {
      operationCategories[operationId] = [
        ...new Set([...(operationCategories[operationId] ?? []), ...categoryIds]),
      ]
    }
    Object.assign(delegatedOperations, source.delegatedOperations)
    prerequisites.push(...(source.prerequisites ?? []))
  }

  return {
    baselineToolNames: [...baselineToolNames],
    operationCategories,
    delegatedOperations,
    prerequisites,
  }
}

/**
 * 取宿主声明的「请求用户动作」角色由哪个工具承担：按装配顺序（扩展在前、顶层在最后）取**最后一个非空**声明，
 * 去首尾空白后返回；一处都没声明（或只声明了空白串）返回 null。
 *
 * 返回 null 是**正常状态**而不是配置缺失——不是每个宿主都有这样一个工具。读取方必须在 null 时仍给出
 * 完整可执行的指引，只是不点名任何工具；拿 null 当错误、或就地编一个工具名，都会把模型指向一个不存在的工具。
 */
export function resolveUserActionRequestToolName(
  ports?: LooseOptional<AgentRuntimeCapabilityPorts>
): Nullable<string> {
  const declarations = [
    ...(ports?.extensions?.map((extension) => extension.userActionRequestToolName) ?? []),
    ports?.userActionRequestToolName,
  ]
  let resolved: Nullable<string> = null
  for (const declaration of declarations) {
    const toolName = declaration?.trim()
    if (toolName) resolved = toolName
  }
  return resolved
}
