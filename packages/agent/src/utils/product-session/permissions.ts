import { randomUUID } from 'node:crypto'

import { isEmpty } from '@velaros-ai/core'

import type { AgentPermissionAction, AgentPermissionRequest, AgentPermissionRule, RequestAgentPermissionInput } from '../../types/product-session.js'

/**
 * 把外部递进来的授权请求规成一条冻结、字段齐全的 `AgentPermissionRequest`：
 * `permission`/`toolName`/`sessionId`/`projectRoot` 去空白后必须非空（缺一个就抛，免得记出一条认不出对象的审批记录）；
 * `id` 留空就现生成；`alwaysPatterns` 缺省与 `patterns` 同；`risk` 缺省按 `readOnly` 推——只读算 `low`，其余一律 `high`，
 * 即缺省往严判，宁可多问一次；`metadata` 另冻一份浅拷贝。`options.nextId` 与 `options.now` 可注入，测试用来消掉随机与时钟。
 */
export function normalizeAgentPermissionRequest<TMode extends string>(
  input: RequestAgentPermissionInput<TMode>,
  options: { nextId?: () => string; now?: () => number } = {}
): AgentPermissionRequest<TMode> {
  const permission = requireNonEmpty(input.permission, 'permission')
  const toolName = requireNonEmpty(input.toolName, 'toolName')
  const patterns = normalizeAgentPermissionPatterns(input.patterns)
  const alwaysPatterns = normalizeAgentPermissionPatterns(input.alwaysPatterns ?? patterns)
  return Object.freeze({
    id: input.id?.trim() || (options.nextId ?? randomUUID)(),
    sessionId: requireNonEmpty(input.sessionId, 'sessionId'),
    projectRoot: requireNonEmpty(input.projectRoot, 'projectRoot'),
    mode: input.mode,
    permission,
    toolName,
    patterns,
    alwaysPatterns,
    readOnly: input.readOnly,
    risk: input.risk ?? (input.readOnly ? 'low' : 'high'),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
    createdAt: (options.now ?? Date.now)(),
  })
}

/**
 * 对请求里的每个 pattern 各判一次，再按「最严者胜」合成一个判决：deny 压 ask，ask 压 allow——
 * 任一 pattern 落到 deny 就立刻整体 deny 并短路（剩下的 pattern 不必再看），任一为 ask 则整体 ask，全 allow 才 allow。
 * 某个 pattern 没有规则命中时回落到 `defaultDecision`：默认策略由产品注入，Platform 这层只负责规则与通配的确定性优先级。
 * 返回的 `source` 用于对用户说清「是谁拦的」；只有中途短路的那次 deny 精确标出来源，收尾那次只按「配过规则没有」标。
 */
export function evaluateAgentPermissionRules<TMode extends string>(
  request: AgentPermissionRequest<TMode>,
  rules: readonly AgentPermissionRule[],
  defaultDecision: (request: AgentPermissionRequest<TMode>) => AgentPermissionAction
): { readonly action: AgentPermissionAction; readonly source: 'built-in' | 'rule' } {
  let sawAsk = false
  for (const pattern of request.patterns) {
    const rule = findLastMatchingAgentPermissionRule(rules, request.permission, pattern)
    if (!rule) {
      const builtIn = defaultDecision(request)
      if (builtIn === 'deny') return { action: 'deny', source: 'built-in' }
      if (builtIn === 'ask') sawAsk = true
      continue
    }
    if (rule.action === 'deny') return { action: 'deny', source: 'rule' }
    if (rule.action === 'ask') sawAsk = true
  }
  return {
    action: sawAsk ? 'ask' : 'allow',
    source: rules.length > 0 ? 'rule' : 'built-in',
  }
}

/**
 * 从**后往前**找第一条 `permission` 与 `pattern` 双双通配命中的规则，都不命中返回 null。
 * 倒序是关键：规则表按写入先后排列，后加的必须压过先加的——用户刚点的「以后都允许」若被更早的旧规则盖住，
 * 他会看到自己刚做的选择当场失效。
 */
export function findLastMatchingAgentPermissionRule(
  rules: readonly AgentPermissionRule[],
  permission: string,
  pattern: string
): Nullable<AgentPermissionRule> {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!
    if (
      agentPermissionWildcardMatch(permission, rule.permission)
      && agentPermissionWildcardMatch(pattern, rule.pattern)
    ) return rule
  }
  return null
}

/**
 * 通配匹配：pattern 恰为 `*` 时无条件为真；否则按 `*` 切段、**对每段做正则转义**、再用 `.*` 接回并整串锚定（`^…$`）匹配。
 * 也就是除 `*` 外一切字符都按字面量处理——规则里写 `Bash(rm -rf /)`、`*.min.js` 这种带正则元字符的串
 * 不会被当成正则解释，既不会误命中一大片，也不会在编译时炸出无效正则。
 */
export function agentPermissionWildcardMatch(value: string, pattern: string): boolean {
  if (pattern === '*') return true
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'u').test(value)
}

/**
 * 把 pattern 列表规成一份冻结的、逐条去空白并去重的非空列表；缺席、全是空白、或去重后为空，统统回退成 `['*']`。
 * 注意这个回退的含义是「这次请求不限定具体对象」，不是「不匹配任何对象」——空列表若直接放行会让循环一次都不跑，
 * 判决直接落到 allow。
 */
export function normalizeAgentPermissionPatterns(
  patterns?: readonly string[]
): readonly string[] {
  const normalized = [...new Set((patterns ?? ['*']).map((pattern) => pattern.trim()).filter(Boolean))]
  return Object.freeze(!isEmpty(normalized) ? normalized : ['*'])
}

/** 取一个必填文本：去首尾空白后必须非空，否则抛 `授权请求的 ${field} 不能为空：…`；返回的是去过空白的值，调用方要用返回值而不是原值。 */
function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`授权请求的 ${field} 不能为空：去掉首尾空白后必须仍有内容，否则记出来的审批记录认不出对象。`)
  return normalized
}
