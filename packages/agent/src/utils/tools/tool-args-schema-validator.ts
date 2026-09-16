import {
  isArray,
  isEmpty,
  isNumber,
  isObject,
  isPlainObject,
  isPresent,
  isString,
} from '@velaros-ai/core'

import type { ToolValidationHintProvider } from '../../contract/requires.js'
import type { ToolValidationHintContext } from '../../types/capabilities.js'
import type { ToolArgsValidationResult, ToolInputAdjustment, ToolInputAdjustmentCollector,ToolSchema, ToolSchemaIssue, ToolSchemaIssueDetail } from '../../types/tools.js'
import { AgentTuning } from '../tuning'

const DefaultToolArgsValidationHint =
  '参数 JSON 看起来不完整（在某个字段中间断掉）时，多半是模型输出流被截断了，重试一次可能就好；' +
  '否则请按 schema 改正参数。'




/** 按 schema 校验工具入参；模型常见的字符串化 JSON、数字与布尔按 issue 提示有限次归一后再校验。 */
export function validateWithNormalization<TInput>(schema: ToolSchema<TInput>, args?: Record<string, unknown>): ToolArgsValidationResult<TInput> {
    const requestedArgs = cloneJsonLikeValue(args ?? {}) as Record<string, unknown>
    let current = cloneJsonLikeValue(args ?? {}) as Record<string, unknown>
    let lastResult = schema.safeParse(current)

    for (
      let pass = 0;
      pass < AgentTuning.tools.maxArgsNormalizationPasses && !lastResult.success;
      pass += 1
    ) {
      const next = normalizeArgsFromSchemaIssues(current, lastResult.error.issues)
      if (!next.changed) {
        break
      }
      current = next.args
      lastResult = schema.safeParse(current)
    }

    if (lastResult.success) {
      const effectiveArgs = isPlainObject(lastResult.data)
        ? cloneJsonLikeValue(lastResult.data) as Record<string, unknown>
        : current
      const adjustments = describeAdjustments(requestedArgs, effectiveArgs)
      return {
        success: true,
        data: lastResult.data,
        args: effectiveArgs,
        requestedArgs,
        normalized: !isEmpty(adjustments),
        adjustments,
      }
    }

    return {
      success: false,
      error: lastResult.error,
      issues: formatIssues(lastResult.error.issues, current),
    }
  }

/**
   * 比较模型输入与实际执行参数。只描述字段路径和调整类型，不复制字段值，避免诊断元数据泄密。
   */
export function describeAdjustments(requested: Record<string, unknown>, effective: Record<string, unknown>): ToolInputAdjustment[] {
    const collector: ToolInputAdjustmentCollector = {
      adjustments: [],
      truncated: false,
    }
    collectAdjustments(requested, effective, '', 0, collector)
    if (collector.truncated) {
      const truncatedAdjustment: ToolInputAdjustment = {
        field: '<additional>',
        action: 'normalized',
        detail: '还有别的 schema 调整没写进元数据',
      }
      if (collector.adjustments.length >= AgentTuning.tools.maxInputAdjustments) {
        collector.adjustments[AgentTuning.tools.maxInputAdjustments - 1] = truncatedAdjustment
      } else {
        collector.adjustments.push(truncatedAdjustment)
      }
    }
    return collector.adjustments
  }

/** 把校验 issue 折成给模型看的清单：路径、期望类型与实际值。 */
export function formatIssues(issues: ToolSchemaIssue[], input?: unknown): ToolSchemaIssueDetail[] {
    const formatted: ToolSchemaIssueDetail[] = []
    const seen = new Set<string>()
    let visited = 0
    const push = (path: PropertyKey[], message: string, alternatives: number[]): void => {
      const field = issuePathKey(path)
      const key = JSON.stringify([field, message])
      if (seen.has(key)) return
      seen.add(key)
      formatted.push({
        path: field,
        message: !isEmpty(alternatives) ? `Union option ${alternatives.join('.')}: ${message}` : message,
      })
    }
    const append = (
      nestedIssues: ToolSchemaIssue[],
      parentPath: PropertyKey[] = [],
      alternatives: number[] = []
    ): void => {
      for (const issue of nestedIssues) {
        if (formatted.length >= 3 || visited >= 50) return
        visited += 1
        const path = [...parentPath, ...issue.path]
        if (issue.code === 'invalid_union' && issue.errors?.length && alternatives.length < 8) {
          // Zod 的 union 分支路径相对外层 issue。只展开输入实际对应的分支；仍并列的分支保留编号，
          // 避免提示模型同时满足互斥选项。
          const relevant = relevantUnionBranches(issue.errors, valueAtPath(input, path))
          if (relevant.merged) {
            push([...path, ...relevant.merged.path], relevant.merged.message, alternatives)
            continue
          }
          for (const { index, issues: branch } of relevant.branches) {
            if (formatted.length >= 3 || visited >= 50) return
            append(branch, path, relevant.branches.length > 1 ? [...alternatives, index + 1] : alternatives)
          }
          continue
        }
        push(path, issue.message, alternatives)
      }
    }
    append(issues)
    return formatted
  }

/**
   * 选出与输入相符的 union 分支：输入里确有值、有分支对它报 invalid_value、也有分支对它毫无异议的字段就是
   * 判别字段（如 op），报错的分支直接淘汰；缺失字段同样报 invalid_value，所以必须看输入里是否真有这个值。
   * 所有分支都拒绝同一个判别值时合并成一句「可选值」；剩余分支取问题最少的；都只差同一处类型时合并成一句。
   */
function relevantUnionBranches(branches: ToolSchemaIssue[][], value: unknown): { branches: Array<{ index: number; issues: ToolSchemaIssue[] }>; merged?: { path: PropertyKey[]; message: string } } {
    let candidates = branches.map((issues, index) => ({ index, issues }))
    const rejections = (issues: ToolSchemaIssue[], key: PropertyKey) =>
      issues.filter((issue) => issue.code === 'invalid_value' && issue.path.length === 1 && issue.path[0] === key)
    const touches = (issues: ToolSchemaIssue[], key: PropertyKey) =>
      issues.some((issue) => issue.path[0] === key || (issue.code === 'unrecognized_keys' && isEmpty(issue.path) && isArray(issue.keys) && issue.keys.includes(key)))
    const keys = new Set(branches.flat()
      .filter((issue) => issue.code === 'invalid_value' && issue.path.length === 1)
      .map((issue) => issue.path[0]!)
      .filter((key) => isPlainObject(value) && isPresent(value[key as string])))
    for (const key of keys) {
      if (candidates.every(({ issues }) => !isEmpty(rejections(issues, key)))) {
        const allowed = [...new Set(candidates.flatMap(({ issues }) => rejections(issues, key).flatMap((issue) => isArray(issue.values) ? issue.values : [])))]
        return { branches: [], merged: { path: [key], message: `选项不合法：只能填 ${allowed.map((option) => JSON.stringify(option)).join('|')} 之一` } }
      }
      const accepting = candidates.filter(({ issues }) => !touches(issues, key))
      if (!isEmpty(accepting)) candidates = candidates.filter(({ issues }) => isEmpty(rejections(issues, key)))
    }
    const weight = (issues: ToolSchemaIssue[]) =>
      issues.reduce((total, issue) => total + (issue.code === 'unrecognized_keys' && isArray(issue.keys) ? issue.keys.length : 1), 0)
    const fewest = Math.min(...candidates.map(({ issues }) => weight(issues)))
    const selected = candidates.filter(({ issues }) => weight(issues) === fewest)
    const only = selected.map(({ issues }) => issues[0])
    if (selected.length > 1 && selected.every(({ issues }) => issues.length === 1) &&
      only.every((issue) => issue?.code === 'invalid_type' && isString(issue.expected) && JSON.stringify(issue.path) === JSON.stringify(only[0]!.path))) {
      const received = /received (\S+)$/u.exec(only[0]!.message)?.[1]
      const expected = [...new Set(only.map((issue) => String(issue!.expected)))].join(' | ')
      return { branches: [], merged: { path: only[0]!.path, message: `输入类型不对：应为 ${expected}${received ? `，实际收到 ${received}` : ''}` } }
    }
    return { branches: selected }
  }

/** 按 issue 路径取出入参里对应位置的值。 */
function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
    let cursor = input
    for (const segment of path) {
      if (!isObject(cursor)) return undefined
      cursor = (cursor as Record<PropertyKey, unknown>)[segment]
    }
    return cursor
  }

/** 给一次校验失败挑一句面向模型的提示；能力包给了更贴切的提示就用它的。 */
export function describeValidationHint(toolName: string, issues: string, providers: readonly ToolValidationHintProvider[] = []): string {
    const recovery = resolveRecovery(providers, {
      toolName,
      issues,
      pageId: `tool:${toolName}`,
      issueDetails: [],
    })
    return recovery.hint ?? DefaultToolArgsValidationHint
  }

/** 给一次校验失败列出模型下一步能做的动作。 */
export function buildValidationNextActions(toolName: string, issueDetails: readonly ToolSchemaIssueDetail[] = [], providers: readonly ToolValidationHintProvider[] = []): string[] {
    const pageId = `tool:${toolName}`
    const issues = issueDetails.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    const recoveryContext: ToolValidationHintContext = {
      toolName,
      issues,
      pageId,
      issueDetails,
    }
    const actions = [
      `按本轮真实 schema 中当前操作对应的分支修正所指出字段；不要根据工具名或相似工具猜参数。`,
      `失败回执带 inputReuse 时用 reuse + changes 修正字段并保留其余有效参数；没有复用入口时再构造完整调用。`,
      `如果目标工具未暴露真实 schema，请通过宿主提供的能力发现接口加载 ${pageId} 后再调用。`,
    ]

    const recovery = resolveRecovery(providers, recoveryContext)
    if (recovery.nextActions) actions.unshift(...recovery.nextActions)

    return actions
  }

/** 判定这次校验失败该按哪种恢复路径处理。 */
function resolveRecovery(providers: readonly ToolValidationHintProvider[], context: ToolValidationHintContext): { hint?: string; nextActions?: readonly string[] } {
    for (const provider of providers) {
      const recovery = provider.getRecovery(context)
      if (recovery) return recovery
    }
    return {}
  }

/** 原地把一个记录对象的内容整体换成另一份（`__proto__` 等键按普通自有属性写）。 */
export function replaceRecordContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const key of Object.keys(target)) {
      delete target[key]
    }
    Object.defineProperties(target, Object.getOwnPropertyDescriptors(source))
  }

/** 把 issue 路径折成可比较的字符串键。 */
function issuePathKey(path: readonly PropertyKey[]): string {
    return path.map(String).join('.')
  }

/** 从一条 issue 里读出它期望的类型名。 */
function readIssueExpected(issue: {
    message: string
    expected?: unknown
    code?: unknown
  }): Nullable<string> {
    if (isString(issue.expected)) return issue.expected.toLowerCase()

    const message = issue.message.toLowerCase()
    if (message.includes('expected array')) return 'array'
    if (message.includes('expected object')) return 'object'
    if (message.includes('expected number')) return 'number'
    if (message.includes('expected boolean')) return 'boolean'
    return null
  }

/** 按路径读一个嵌套值；路径断在中途返回 undefined。 */
function readPathValue(root: unknown, path: readonly PropertyKey[]): unknown {
    let current = root
    for (const segment of path) {
      if (!isObject(current) && !isArray(current)) return undefined
      current = (current as Record<PropertyKey, unknown>)[segment]
    }
    return current
  }

/** 按路径写一个嵌套值；路径断在中途返回 false。 */
function writePathValue(root: unknown, path: readonly PropertyKey[], value: unknown): boolean {
    if (isEmpty(path)) return false

    let current = root
    for (const segment of path.slice(0, -1)) {
      if (!isObject(current) && !isArray(current)) return false
      current = (current as Record<PropertyKey, unknown>)[segment]
    }

    if (!isObject(current) && !isArray(current)) return false
    const lastSegment = path[path.length - 1]
    if (!isPresent(lastSegment)) return false
    ;(current as Record<PropertyKey, unknown>)[lastSegment] = value
    return true
  }

/** 浅层复制一个 JSON 形状的值，避免归一化改到调用方的对象。 */
function cloneJsonLikeValue(value: unknown): unknown {
    if (isArray(value)) return value.map((item) => cloneJsonLikeValue(item))
    if (isPlainObject(value)) return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, cloneJsonLikeValue(item)])
      )
    return value
  }

/** 比较两个 JSON 形状的值是否等价（限定深度，防环）。 */
function jsonLikeEquals(left: unknown, right: unknown, depth: number): boolean {
    if (Object.is(left, right)) return true
    if (depth >= AgentTuning.tools.maxInputAdjustmentDepth) return false
    if (isArray(left) && isArray(right)) return left.length === right.length && left.every((item, index) =>
        jsonLikeEquals(item, right[index], depth + 1)
      )
    if (isPlainObject(left) && isPlainObject(right)) {
      const leftKeys = Object.keys(left)
      const rightKeys = Object.keys(right)
      return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
        Object.hasOwn(right, key) && jsonLikeEquals(left[key], right[key], depth + 1)
      )
    }
    return false
  }

/** 对比请求入参与实际生效入参，列出被系统改过的字段。 */
function collectAdjustments(requested: unknown, effective: unknown, path: string, depth: number, collector: ToolInputAdjustmentCollector): void {
    if (collector.truncated) return
    if (collector.adjustments.length >= AgentTuning.tools.maxInputAdjustments) {
      collector.truncated = true
      return
    }
    if (jsonLikeEquals(requested, effective, depth)) return
    if (depth >= AgentTuning.tools.maxInputAdjustmentDepth) {
      collector.truncated = true
      return
    }

    if (isPlainObject(requested) && isPlainObject(effective)) {
      const keys = new Set([...Object.keys(requested), ...Object.keys(effective)])
      for (const key of [...keys].sort()) {
        if (collector.adjustments.length >= AgentTuning.tools.maxInputAdjustments) {
          collector.truncated = true
          return
        }
        const nestedPath = path ? `${path}.${key}` : key
        const requestedHasKey = Object.hasOwn(requested, key)
        const effectiveHasKey = Object.hasOwn(effective, key)
        if (!requestedHasKey) {
          collector.adjustments.push({
            field: limitAdjustmentPath(nestedPath),
            action: 'defaulted',
            detail: 'schema 补上了没填的字段',
          })
          continue
        }
        if (!effectiveHasKey) {
          collector.adjustments.push({
            field: limitAdjustmentPath(nestedPath),
            action: 'ignored',
            detail: 'schema 去掉了一个不支持的字段',
          })
          continue
        }
        collectAdjustments(
          requested[key],
          effective[key],
          nestedPath,
          depth + 1,
          collector
        )
      }
      return
    }

    if (isArray(requested) && isArray(effective) && requested.length === effective.length) {
      for (const [index, item] of requested.entries()) {
        collectAdjustments(
          item,
          effective[index],
          `${path}[${index}]`,
          depth + 1,
          collector
        )
        if (collector.truncated) break
      }
      return
    }

    const coerced = isString(requested) && !isString(effective)
    const clamped = isNumber(requested) && isNumber(effective)
    let action: ToolInputAdjustment['action'] = 'normalized'
    let detail = 'schema 在执行前改写了模型给的值'
    if (coerced) {
      action = 'coerced'
      detail = 'schema 把模型给的值转成了声明的类型'
    } else if (clamped) {
      action = 'clamped'
      detail = 'schema 在执行前把模型给的值夹到了范围内或做了取整'
    }
    collector.adjustments.push({
      field: limitAdjustmentPath(path || '<root>'),
      action,
      detail,
    })
  }

/** 把过长的调整路径截短，只留给模型看得懂的那一段。 */
function limitAdjustmentPath(path: string): string {
    if (path.length <= AgentTuning.tools.maxInputAdjustmentPathChars) return path
    return `${path.slice(0, AgentTuning.tools.maxInputAdjustmentPathChars - 3)}...`
  }

/** 尝试把一段文本解析成 JSON；失败时不抛错，返回 ok:false。 */
function parseJsonString(value: string): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(value) }
    } catch {
      return { ok: false }
    }
  }

/** 把被字符串化的 JSON 按期望类型还原成对象或数组。 */
function normalizeJsonEncodedStringForExpectedType(value: string, expected: Nullable<string>, depth = 0): { changed: boolean; value: unknown } {
    if (depth >= 3) return { changed: false, value }

    const parsed = parseJsonString(value.trim())
    if (!parsed.ok || !isString(parsed.value)) return { changed: false, value }

    const nested = normalizeStringForExpectedType(parsed.value, expected, depth + 1)
    if (nested.changed) return nested

    return { changed: true, value: parsed.value }
  }

/** 把字符串按期望类型转成数字、布尔或数组。 */
function normalizeStringForExpectedType(value: string, expected: Nullable<string>, depth = 0): { changed: boolean; value: unknown } {
    const trimmed = value.trim()
    if (isEmpty(trimmed)) return { changed: false, value }

    const jsonEncodedString = normalizeJsonEncodedStringForExpectedType(trimmed, expected, depth)
    if (jsonEncodedString.changed) return jsonEncodedString

    if (expected === 'array' || expected === 'object') {
      const parsed = parseJsonString(trimmed)
      if (!parsed.ok) return { changed: false, value }
      if (expected === 'array' && isArray(parsed.value)) return { changed: true, value: parsed.value }
      if (expected === 'object' && isPlainObject(parsed.value)) return { changed: true, value: parsed.value }
      return { changed: false, value }
    }

    if (expected === 'number' && /^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) {
      const number = Number(trimmed)
      return Number.isFinite(number) ? { changed: true, value: number } : { changed: false, value }
    }

    if (expected === 'boolean') {
      switch (trimmed) {
        case 'true': {
          return { changed: true, value: true }
        }
        case 'false': {
          return { changed: true, value: false }
        }
        default: {
          return { changed: false, value }
        }
      }
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = parseJsonString(trimmed)
      if (parsed.ok && (isPlainObject(parsed.value) || isArray(parsed.value))) return { changed: true, value: parsed.value }
    }

    // union 变体失败时 zod 只报 "Invalid input"、不带 expected 线索（真实事故：
    // 某些 capability 的布尔字段字符串化会被连续硬拒）。该路径已确定解析失败，
    // 对无歧义字面量做保守转换再重试；若目标其实要字符串，重试仍会失败并回落原始报错。
    if (!expected) {
      if (trimmed === 'true') return { changed: true, value: true }
      if (trimmed === 'false') return { changed: true, value: false }
      if (/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) {
        const number = Number(trimmed)
        if (Number.isFinite(number)) return { changed: true, value: number }
      }
    }

    return { changed: false, value }
  }

/** 按这一轮的 issue 清单对入参做一遍归一化，返回新入参与是否真的改过。 */
function normalizeArgsFromSchemaIssues(args: Record<string, unknown>, issues: ToolSchemaIssue[]): { args: Record<string, unknown>; changed: boolean } {
    const next = cloneJsonLikeValue(args)
    if (!isPlainObject(next)) return { args, changed: false }

    let changed = false
    const seen = new Set<string>()
    for (const issue of issues) {
      const key = issuePathKey(issue.path)
      if (seen.has(key)) continue
      seen.add(key)

      const current = readPathValue(next, issue.path)
      if (!isString(current)) continue

      const normalized = normalizeStringForExpectedType(current, readIssueExpected(issue))
      if (!normalized.changed) continue

      changed = writePathValue(next, issue.path, normalized.value) || changed
    }

    return { args: next, changed }
  }

export {
  formatIssues as formatToolSchemaIssues,
  validateWithNormalization as validateToolArgsWithNormalization,
}
