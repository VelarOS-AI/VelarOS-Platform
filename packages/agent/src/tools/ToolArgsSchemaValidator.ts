import {
  isArray,
  isEmpty,
  isNumber,
  isObject,
  isPlainObject,
  isPresent,
  isString,
} from '@velaros-ai/core'

import type {
  ToolValidationHintContext,
  ToolValidationHintProvider,
  ToolValidationIssueDetail,
} from '../capabilities'
import type { AppliedAdjustment } from '../tool-contract/ForgivingSchema'

interface ToolSchemaIssue {
  path: PropertyKey[]
  message: string
  expected?: unknown
  code?: unknown
  errors?: ToolSchemaIssue[][]
}

type ToolSchemaResult<TInput> =
  | {
      success: true
      data: TInput
    }
  | {
      success: false
      error: {
        issues: ToolSchemaIssue[]
      }
    }

type ToolSchema<TInput> = {
  safeParse(input: unknown): ToolSchemaResult<TInput>
}

type ToolSchemaIssueDetail = ToolValidationIssueDetail

export type ToolInputAdjustment = AppliedAdjustment

type ToolArgsValidationResult<TInput> =
  | {
      success: true
      data: TInput
      /** 真正交给工具执行、写入历史和去重账本的参数。 */
      args: Record<string, unknown>
      /** 模型最初提交的参数快照，仅用于诊断调整，不进入工具执行。 */
      requestedArgs: Record<string, unknown>
      normalized: boolean
      adjustments: ToolInputAdjustment[]
    }
  | {
      success: false
      error: { issues: ToolSchemaIssue[] }
      issues: ToolSchemaIssueDetail[]
    }

const DefaultToolArgsValidationHint =
  'If the argument JSON looks incomplete (cut off mid-field), the model stream may have been truncated and retrying may help; ' +
  'otherwise correct parameters to satisfy the schema. '

const MaxToolInputAdjustments = 50
const MaxToolInputAdjustmentDepth = 32
const MaxToolInputAdjustmentPathLength = 256

interface ToolInputAdjustmentCollector {
  adjustments: ToolInputAdjustment[]
  truncated: boolean
}

/**
 * 工具参数 schema 校验与轻量归一化。
 *
 * 负责把模型侧可能以字符串形式传入的 JSON/数字/boolean 按 schema issue 提示做有限次修正，
 * 并在失败时生成面向模型的 hint 与 nextActions。
 */
class ToolArgsSchemaValidator {
  private readonly maxNormalizationPasses = 5

  public validateWithNormalization<TInput>(
    schema: ToolSchema<TInput>,
    args?: Record<string, unknown>
  ): ToolArgsValidationResult<TInput> {
    const requestedArgs = this.cloneJsonLikeValue(args ?? {}) as Record<string, unknown>
    let current = this.cloneJsonLikeValue(args ?? {}) as Record<string, unknown>
    let lastResult = schema.safeParse(current)

    for (
      let pass = 0;
      pass < this.maxNormalizationPasses && !lastResult.success;
      pass += 1
    ) {
      const next = this.normalizeArgsFromSchemaIssues(current, lastResult.error.issues)
      if (!next.changed) {
        break
      }
      current = next.args
      lastResult = schema.safeParse(current)
    }

    if (lastResult.success) {
      const effectiveArgs = isPlainObject(lastResult.data)
        ? this.cloneJsonLikeValue(lastResult.data) as Record<string, unknown>
        : current
      const adjustments = this.describeAdjustments(requestedArgs, effectiveArgs)
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
      issues: this.formatIssues(lastResult.error.issues),
    }
  }

  /**
   * 比较模型输入与实际执行参数。只描述字段路径和调整类型，不复制字段值，避免诊断元数据泄密。
   */
  public describeAdjustments(
    requested: Record<string, unknown>,
    effective: Record<string, unknown>
  ): ToolInputAdjustment[] {
    const collector: ToolInputAdjustmentCollector = {
      adjustments: [],
      truncated: false,
    }
    this.collectAdjustments(requested, effective, '', 0, collector)
    if (collector.truncated) {
      const truncatedAdjustment: ToolInputAdjustment = {
        field: '<additional>',
        action: 'normalized',
        detail: 'additional schema adjustments were omitted from metadata',
      }
      if (collector.adjustments.length >= MaxToolInputAdjustments) {
        collector.adjustments[MaxToolInputAdjustments - 1] = truncatedAdjustment
      } else {
        collector.adjustments.push(truncatedAdjustment)
      }
    }
    return collector.adjustments
  }

  public formatIssues(
    issues: ToolSchemaIssue[]
  ): ToolSchemaIssueDetail[] {
    const formatted: ToolSchemaIssueDetail[] = []
    const seen = new Set<string>()
    let visited = 0
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
          // Zod 的 union 分支路径相对外层 issue；分支条件必须保留，避免提示模型同时满足互斥选项。
          for (const [index, branch] of issue.errors.entries()) {
            if (formatted.length >= 3 || visited >= 50) return
            append(branch, path, [...alternatives, index + 1])
          }
          continue
        }
        const field = this.issuePathKey(path)
        const key = JSON.stringify([field, issue.message])
        if (seen.has(key)) continue
        seen.add(key)
        formatted.push({
          path: field,
          message: !isEmpty(alternatives)
            ? `Union option ${alternatives.join('.')}: ${issue.message}`
            : issue.message,
        })
      }
    }
    append(issues)
    return formatted
  }

  public describeValidationHint(
    toolName: string,
    issues: string,
    providers: readonly ToolValidationHintProvider[] = []
  ): string {
    const recovery = this.resolveRecovery(providers, {
      toolName,
      issues,
      pageId: `tool:${toolName}`,
      issueDetails: [],
    })
    return recovery.hint ?? DefaultToolArgsValidationHint
  }

  public buildValidationNextActions(
    toolName: string,
    issueDetails: readonly ToolSchemaIssueDetail[] = [],
    providers: readonly ToolValidationHintProvider[] = []
  ): string[] {
    const pageId = `tool:${toolName}`
    const issues = issueDetails.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    const recoveryContext: ToolValidationHintContext = {
      toolName,
      issues,
      pageId,
      issueDetails,
    }
    const actions = [
      `不要根据工具名或相似工具猜字段；visible 工具按本轮真实 schema 重建 args。`,
      `删除当前 schema.properties 未声明的字段，再按 required/properties 重建 args。`,
      `如果目标工具未暴露真实 schema，请通过宿主提供的能力发现接口加载 ${pageId} 后再调用。`,
    ]

    const recovery = this.resolveRecovery(providers, recoveryContext)
    if (recovery.nextActions) actions.unshift(...recovery.nextActions)

    return actions
  }

  private resolveRecovery(
    providers: readonly ToolValidationHintProvider[],
    context: ToolValidationHintContext
  ): { hint?: string; nextActions?: readonly string[] } {
    for (const provider of providers) {
      const recovery = provider.getRecovery(context)
      if (recovery) return recovery
    }
    return {}
  }

  public replaceRecordContents(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): void {
    for (const key of Object.keys(target)) {
      delete target[key]
    }
    Object.defineProperties(target, Object.getOwnPropertyDescriptors(source))
  }

  private issuePathKey(path: readonly PropertyKey[]): string {
    return path.map(String).join('.')
  }

  private readIssueExpected(issue: {
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

  private readPathValue(root: unknown, path: readonly PropertyKey[]): unknown {
    let current = root
    for (const segment of path) {
      if (!isObject(current) && !isArray(current)) return undefined
      current = (current as Record<PropertyKey, unknown>)[segment]
    }
    return current
  }

  private writePathValue(root: unknown, path: readonly PropertyKey[], value: unknown): boolean {
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

  private cloneJsonLikeValue(value: unknown): unknown {
    if (isArray(value)) return value.map((item) => this.cloneJsonLikeValue(item))
    if (isPlainObject(value)) return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.cloneJsonLikeValue(item)])
      )
    return value
  }

  private jsonLikeEquals(left: unknown, right: unknown, depth: number): boolean {
    if (Object.is(left, right)) return true
    if (depth >= MaxToolInputAdjustmentDepth) return false
    if (isArray(left) && isArray(right)) return left.length === right.length && left.every((item, index) =>
        this.jsonLikeEquals(item, right[index], depth + 1)
      )
    if (isPlainObject(left) && isPlainObject(right)) {
      const leftKeys = Object.keys(left)
      const rightKeys = Object.keys(right)
      return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
        Object.hasOwn(right, key) && this.jsonLikeEquals(left[key], right[key], depth + 1)
      )
    }
    return false
  }

  private collectAdjustments(
    requested: unknown,
    effective: unknown,
    path: string,
    depth: number,
    collector: ToolInputAdjustmentCollector
  ): void {
    if (collector.truncated) return
    if (collector.adjustments.length >= MaxToolInputAdjustments) {
      collector.truncated = true
      return
    }
    if (this.jsonLikeEquals(requested, effective, depth)) return
    if (depth >= MaxToolInputAdjustmentDepth) {
      collector.truncated = true
      return
    }

    if (isPlainObject(requested) && isPlainObject(effective)) {
      const keys = new Set([...Object.keys(requested), ...Object.keys(effective)])
      for (const key of [...keys].sort()) {
        if (collector.adjustments.length >= MaxToolInputAdjustments) {
          collector.truncated = true
          return
        }
        const nestedPath = path ? `${path}.${key}` : key
        const requestedHasKey = Object.hasOwn(requested, key)
        const effectiveHasKey = Object.hasOwn(effective, key)
        if (!requestedHasKey) {
          collector.adjustments.push({
            field: this.limitAdjustmentPath(nestedPath),
            action: 'defaulted',
            detail: 'schema supplied the omitted field',
          })
          continue
        }
        if (!effectiveHasKey) {
          collector.adjustments.push({
            field: this.limitAdjustmentPath(nestedPath),
            action: 'ignored',
            detail: 'schema removed an unsupported field',
          })
          continue
        }
        this.collectAdjustments(
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
        this.collectAdjustments(
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
    let detail = 'schema transformed the model value before execution'
    if (coerced) {
      action = 'coerced'
      detail = 'schema converted the model value to its declared type'
    } else if (clamped) {
      action = 'clamped'
      detail = 'schema bounded or rounded the model value before execution'
    }
    collector.adjustments.push({
      field: this.limitAdjustmentPath(path || '<root>'),
      action,
      detail,
    })
  }

  private limitAdjustmentPath(path: string): string {
    if (path.length <= MaxToolInputAdjustmentPathLength) return path
    return `${path.slice(0, MaxToolInputAdjustmentPathLength - 3)}...`
  }

  private parseJsonString(value: string): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(value) }
    } catch {
      return { ok: false }
    }
  }

  private normalizeJsonEncodedStringForExpectedType(
    value: string,
    expected: Nullable<string>,
    depth = 0
  ): { changed: boolean; value: unknown } {
    if (depth >= 3) return { changed: false, value }

    const parsed = this.parseJsonString(value.trim())
    if (!parsed.ok || !isString(parsed.value)) return { changed: false, value }

    const nested = this.normalizeStringForExpectedType(parsed.value, expected, depth + 1)
    if (nested.changed) return nested

    return { changed: true, value: parsed.value }
  }

  private normalizeStringForExpectedType(
    value: string,
    expected: Nullable<string>,
    depth = 0
  ): { changed: boolean; value: unknown } {
    const trimmed = value.trim()
    if (isEmpty(trimmed)) return { changed: false, value }

    const jsonEncodedString = this.normalizeJsonEncodedStringForExpectedType(trimmed, expected, depth)
    if (jsonEncodedString.changed) return jsonEncodedString

    if (expected === 'array' || expected === 'object') {
      const parsed = this.parseJsonString(trimmed)
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
      const parsed = this.parseJsonString(trimmed)
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

  private normalizeArgsFromSchemaIssues(
    args: Record<string, unknown>,
    issues: ToolSchemaIssue[]
  ): { args: Record<string, unknown>; changed: boolean } {
    const next = this.cloneJsonLikeValue(args)
    if (!isPlainObject(next)) return { args, changed: false }

    let changed = false
    const seen = new Set<string>()
    for (const issue of issues) {
      const key = this.issuePathKey(issue.path)
      if (seen.has(key)) continue
      seen.add(key)

      const current = this.readPathValue(next, issue.path)
      if (!isString(current)) continue

      const normalized = this.normalizeStringForExpectedType(current, this.readIssueExpected(issue))
      if (!normalized.changed) continue

      changed = this.writePathValue(next, issue.path, normalized.value) || changed
    }

    return { args: next, changed }
  }

}

const toolArgsSchemaValidator = new ToolArgsSchemaValidator()

const validateToolArgsWithNormalization =
  toolArgsSchemaValidator.validateWithNormalization.bind(toolArgsSchemaValidator)
const formatToolSchemaIssues = toolArgsSchemaValidator.formatIssues.bind(toolArgsSchemaValidator)

export {
  formatToolSchemaIssues,
  ToolArgsSchemaValidator,
  toolArgsSchemaValidator,
  validateToolArgsWithNormalization,
}
export type { ToolArgsValidationResult, ToolSchema, ToolSchemaIssueDetail }
