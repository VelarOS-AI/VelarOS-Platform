import { isArray, isBigInt, isEmpty, isFunction,isNonBlankString, isObject, isPlainObject, isString, optionalWhen } from '@velaros-ai/core'
import { type AppError } from '@velaros-ai/core/error'
import { readStringScalar } from '@velaros-ai/core/utils/unknownJsonRecord'

import type { ErrorCauseRecord, RuntimeToolIssue, ToolFailureBuildOptions,ToolFailureResult, ToolSpaceRecoveryGuide } from '../../types/tools.js'


/**
 * 沿 `cause` 链自外向内找第一个非空的 `reason` 字段并去掉首尾空白，找不到返回 null。
 * 领域包常把稳定机器码放在 reason 上，而包装成 AppError 后它只剩在 cause 链里；用 Set 记已访问对象，cause 成环也不会死循环。
 */
function extractNestedErrorReason(error: unknown): LooseOptional<string> {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && isObject(current) && !seen.has(current)) {
    seen.add(current)
    const record = current as ErrorCauseRecord
    if (isNonBlankString(record.reason)) return record.reason.trim()
    current = record.cause
  }
  return null
}

/**
 * 沿 `cause` 链自外向内找第一个是纯对象的 `details` 并原样返回（不做拷贝也不裁剪，裁剪交给 boundToolFailureDetails），找不到返回 null。
 * 取的是最外层那份：包装者比被包装者更贴近调用现场；同样用 Set 防 cause 成环。
 */
function extractNestedErrorDetails(error: unknown): LooseOptional<Record<string, unknown>> {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && isObject(current) && !seen.has(current)) {
    seen.add(current)
    const record = current as ErrorCauseRecord
    if (isPlainObject(record.details)) return record.details
    current = record.cause
  }
  return null
}

/**
 * 沿 `cause` 链自外向内找第一个非空的 `suggestedNextAction`（去首尾空白），找不到返回 null。
 * 这是领域包写给模型的「下一步该干什么」，会被提升成失败结果的 nextActions；同样用 Set 防 cause 成环。
 */
function extractNestedSuggestedNextAction(error: unknown): LooseOptional<string> {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && isObject(current) && !seen.has(current)) {
    seen.add(current)
    const record = current as ErrorCauseRecord
    if (isNonBlankString(record.suggestedNextAction)) return record.suggestedNextAction.trim()
    current = record.cause
  }
  return null
}

// cause 链上任意独立包（Project 等）都可能带回几十上百条 diagnostics 或超长字符串；
// 这里的数值是专为失败 details 选的——比 toolResultSerialization.ts 的模型工具结果档
// （maxArrayItems 400）严格得多，因为失败 details 会被直接持久化为工具结果的一部分，
// 裁掉的条目在当前边界内不可召回（截断发生在持久化之前，没有留存可续读的原始数据）；
// 只做体积/深度兜底，不追求语义完整。标记键特意不用 __truncatedItems——那是
// ContextRetrieval 工具（见 tool-library/builtin/ContextRetrieval.tool.ts）约定的
// 续读协议标记，模型看到它会尝试用 context:recall + jsonPath + nextOffset 续读；
// 这里没有 jsonPath/nextOffset，续读只会白费一个回合，必须用不同的键名避免模型误判。
const MaxDetailsArrayItems = 10
const MaxDetailsObjectKeys = 50
const MaxDetailsStringLength = 2_000
const MaxDetailsDepth = 6

/**
 * 递归把领域错误 details 裁成可安全 JSON 化的有界值：长字符串截到 MaxDetailsStringLength 并补省略号、BigInt 转 `123n` 形式、
 * 数组只留前 MaxDetailsArrayItems 项并追加 `__omittedItems` 计数、对象只留前 MaxDetailsObjectKeys 个键并写 `__truncatedKeys`/`__originalKeyCount`、
 * 超过 MaxDetailsDepth 换成占位串、循环引用换成 `[circular reference omitted]`。
 * 有 `toJSON` 的对象（Date/URL 等）先走 toJSON 再裁（toJSON 自己抛错则降级为不支持对象标记），非纯对象直接标记类名丢弃。
 * 裁掉的内容在这一层不可召回——截断发生在结果落盘之前，所以标记键刻意避开 `__truncatedItems`（那是 context:recall 的续读协议标记，模型看到会白跑一轮）。
 */
function boundDetailsValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (isString(value))
    return value.length > MaxDetailsStringLength
      ? `${value.slice(0, MaxDetailsStringLength)}…`
      : value

  // BigInt 是 JSON.stringify 会直接抛错的少数几种基础类型，其余基础类型（number/boolean/
  // function/symbol/undefined）JSON.stringify 只会静默丢弃，不需要在这里特殊处理。
  if (isBigInt(value)) return `${value.toString()}n`

  if (!isObject(value)) return value

  if (seen.has(value)) return '[circular reference omitted]'

  if (depth >= MaxDetailsDepth)
    return isArray(value)
      ? `[array omitted at depth limit: ${value.length} items]`
      : '[object omitted at depth limit]'

  seen.add(value)

  if (isArray(value)) {
    const items = value
      .slice(0, MaxDetailsArrayItems)
      .map((item) => boundDetailsValue(item, depth + 1, seen))
    if (value.length > MaxDetailsArrayItems) {
      items.push({
        __omittedItems: value.length - MaxDetailsArrayItems,
        originalLength: value.length,
      })
    }
    seen.delete(value)
    return items
  }

  // isPlainObject 把「非 null、非数组的 object」全部算作可用 Object.entries 遍历的记录，
  // Date/URL 这类没有自有可枚举属性、只靠 toJSON 表达状态的对象也会命中这条判断——按记录
  // 遍历会静默得到 {}，等于把值丢了。这里优先用其 toJSON（与 JSON.stringify 语义对齐）。
  const toJson = isFunction((value as { toJSON?: unknown }).toJSON)
    ? (value as { toJSON: () => unknown }).toJSON
    : null
  if (toJson) {
    seen.delete(value)
    try {
      return boundDetailsValue(toJson.call(value), depth, seen)
    } catch {
      // arch-guard:silent-catch-ok 领域对象的 toJSON 实现本身可能抛错；退化为不支持对象标记，
      // 不能让失败结果的构建被域对象内部问题打断。
      return `[omitted unsupported object: ${value.constructor?.name ?? 'unknown'}]`
    }
  }

  if (!isPlainObject(value)) {
    seen.delete(value)
    return `[omitted unsupported object: ${value.constructor?.name ?? 'unknown'}]`
  }

  const entries = Object.entries(value)
  const record: Record<string, unknown> = {}
  for (const [key, nestedValue] of entries.slice(0, MaxDetailsObjectKeys)) {
    record[key] = boundDetailsValue(nestedValue, depth + 1, seen)
  }
  if (entries.length > MaxDetailsObjectKeys) {
    record.__truncatedKeys = entries.length - MaxDetailsObjectKeys
    record.__originalKeyCount = entries.length
  }
  seen.delete(value)
  return record
}

/** 失败结果里的领域 details 有界投影：语义（reason/code/nextActions）不变，只裁体积。 */
function boundToolFailureDetails(details: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundDetailsValue(details, 0, new WeakSet())
  return isPlainObject(bounded) ? bounded : details
}

/**
 * 这条失败是不是「模型把工具调错了」而非「工具跑起来出了错」——只有 error 属于 schema_validation_failed、
 * tool_unavailable、tool_not_found、tool_call_invalid、tool_chain_invalid 这五种调用面故障时为真。
 * 为真才值得给模型补一段通用的自纠指引；执行期的业务失败不补，免得把噪声塞进上下文。
 */
function shouldAnnotateRuntimeToolIssue(result: ToolFailureResult): boolean {
  return [
    'schema_validation_failed',
    'tool_unavailable',
    'tool_not_found',
    'tool_call_invalid',
    'tool_chain_invalid',
  ].includes(result.error)
}

/**
 * 给调用面故障的失败结果补两条通用自纠指引（先按实际错误改调用、只在真需要用户介入时才说阻塞），放在原有 nextActions 之前并整体去重。
 * 不属于调用面故障（见 shouldAnnotateRuntimeToolIssue）或结果已经带了 `runtimeToolIssue` 的原样返回；返回的是新对象，不改入参。
 */
function withRuntimeToolIssue(result: ToolFailureResult): ToolFailureResult {
  if (!shouldAnnotateRuntimeToolIssue(result) || result.runtimeToolIssue) return result

  return {
    ...result,
    nextActions: [...new Set([
      '先依据实际错误条件修正调用；可恢复的参数或定位问题直接继续，完整诊断保留在执行记录中。',
      '仅在需要用户权限、外部信息，或执行结果仍不确定且无法核实时说明阻塞；不要推测责任归属。',
      ...(result.nextActions ?? []),
    ])],
  }
}

/**
 * 把某个已经由下游构造好、塞在 `AppError.context.toolFailure` 里的失败结果重新读回强类型 `ToolFailureResult`。
 * 必须同时有非空 `error` 与 `reason` 才认（否则返回 null，让调用方回落到从 cause 链重建）；`toolName` 缺失时补 `'unknown'`，
 * code/details/nextActions/toolSpaceRecovery/runtimeToolIssue 按类型逐个挑，类型不对的字段直接丢，不会把脏数据带进模型上下文。
 */
function readEmbeddedToolFailure(value: unknown): Nullable<ToolFailureResult> {
  if (!isObject(value)) return null
  const record = value as Partial<ToolFailureResult>
  if (!isNonBlankString(record.error) || !isNonBlankString(record.reason)) return null
  const result: ToolFailureResult = {
    error: record.error.trim(),
    reason: record.reason.trim(),
    toolName: readStringScalar(record.toolName) ?? 'unknown',
  }
  const code = optionalWhen(isNonBlankString, record.code)?.trim()
  const details = optionalWhen(isObject, record.details) as Record<string, unknown> | undefined
  const nextActions = optionalWhen(isArray, record.nextActions)?.filter(isString)
  const toolSpaceRecovery = optionalWhen(isObject, record.toolSpaceRecovery) as
    | ToolSpaceRecoveryGuide
    | undefined
  const runtimeToolIssue = optionalWhen(isObject, record.runtimeToolIssue) as
    | RuntimeToolIssue
    | undefined
  if (code) {
    result.code = code
  }
  if (details) {
    result.details = details
  }
  if (nextActions) {
    result.nextActions = nextActions
  }
  if (toolSpaceRecovery) {
    result.toolSpaceRecovery = toolSpaceRecovery
  }
  if (runtimeToolIssue) {
    result.runtimeToolIssue = runtimeToolIssue
  }
  return result
}

/**
 * 组装一条要交给模型的工具失败结果：error/reason/toolName 必填，可选的 code/details/nextActions 只在有值时才写进去（不留空字段）。
 * 传了 `options.recovery` 时用恢复指引的 nextActions **覆盖** 传入的 nextActions，并把整份指引挂到 toolSpaceRecovery——
 * 工具压根拿不到时，"怎么把工具弄到手"优先于其他建议。最后统一过 withRuntimeToolIssue 补调用面自纠指引。
 */
function buildToolFailureResult(
  error: string,
  reason: string,
  toolName: string,
  options: ToolFailureBuildOptions = {}
): ToolFailureResult {
  const result: ToolFailureResult = {
    error,
    reason,
    toolName,
  }

  if (options.code) {
    result.code = options.code
  }
  if (options.details) {
    result.details = options.details
  }
  if (options.nextActions?.length) {
    result.nextActions = options.nextActions
  }
  if (options.recovery) {
    result.nextActions = options.recovery.nextActions
    result.toolSpaceRecovery = options.recovery
  }

  return withRuntimeToolIssue(result)
}

/**
 * 把执行期抛出的 `AppError` 翻译成给模型看的 `ToolFailureResult`。
 * 优先直接取 `context.toolFailure` 里已成型的失败结果；否则沿 cause 链（外加 `context.projectError` 这个跨 IPC 往返后仍在的镜像）
 * 捞 reason/details/suggestedNextAction，`code === 'UNKNOWN'` 时把领域 reason 提升成有效 code。
 * 有效 code 决定对外的 error 分类：EXECUTION_ABORTED→`tool_cancelled`、UNAVAILABLE→`tool_unavailable`、
 * EXECUTION_DENIED/PERMISSION_DENIED/PERMISSION→`tool_denied`、TOOL_RESULT_FINALIZATION_FAILED→同名，其余归 `tool_execution_failed`。
 * details 先单独做有界投影再追加 reason/code（顺序不能反，否则领域字段一多就把这两个关键字段挤出键数上限），全空时干脆不带 details。
 */
function buildExecutionFailureResult(toolName: string, error: AppError): ToolFailureResult {
  const embeddedFailure = readEmbeddedToolFailure(error.context.toolFailure)
  if (embeddedFailure) return withRuntimeToolIssue(embeddedFailure)

  // 跨 Kernel/IPC 边界一趟 AppError.toJSON → fromJSON 往返会丢掉 cause（context 不丢），
  // 这时 cause 链上什么都读不到；镜像进 context 的领域错误对象（例如
  // packages/project/src/kernel-module.ts 的 projectCapabilityError 写入的
  // context.projectError）就是这种情况下唯一还在的诊断来源，作回退读取。
  const projectErrorMirror = error.context.projectError
  const nestedReason =
    extractNestedErrorReason(error) ?? extractNestedErrorReason(projectErrorMirror)
  const nestedDetails =
    extractNestedErrorDetails(error) ?? extractNestedErrorDetails(projectErrorMirror)
  const nestedSuggestedNextAction =
    extractNestedSuggestedNextAction(error) ??
    extractNestedSuggestedNextAction(projectErrorMirror)
  // 独立领域包可能用 reason 承载稳定机器码。AppError.from 会保留 cause，但不会把领域 reason
  // 冒充 Core code；Agent 边界在 UNKNOWN 时显式提升，避免真正原因只躺在 details 里。
  const effectiveCode = error.code === 'UNKNOWN' && nestedReason ? nestedReason : error.code
  // 先对领域 details 单独做有界投影，reason/code 之后再追加——顶层键数截断（
  // MaxDetailsObjectKeys）只应该丢领域自己的字段，不能连着一起把 reason/code 也挤
  // 出前 50 个键（评审 minor：领域 details 顶层键不少于 49 个时会先丢 reason/code，
  // 而 details.reason 往往是唯一还能看到领域原因的地方）。
  const boundedNestedDetails = nestedDetails ? boundToolFailureDetails(nestedDetails) : {}
  const boundedDetails: Record<string, unknown> = { ...boundedNestedDetails }
  if (error.context.executionOutcome === 'not-applied') boundedDetails.executionOutcome = 'not-applied'
  if (nestedReason) {
    boundedDetails.reason = nestedReason
  }
  if (effectiveCode) {
    boundedDetails.code = effectiveCode
  }

  return buildToolFailureResult(
    effectiveCode === 'EXECUTION_ABORTED'
      ? 'tool_cancelled'
      : effectiveCode === 'UNAVAILABLE'
        ? 'tool_unavailable'
      : effectiveCode === 'EXECUTION_DENIED' || effectiveCode === 'PERMISSION_DENIED' || effectiveCode === 'PERMISSION'
        ? 'tool_denied'
        : effectiveCode === 'TOOL_RESULT_FINALIZATION_FAILED'
          ? 'tool_result_finalization_failed'
        : 'tool_execution_failed',
    error.message,
    toolName,
    {
      code: effectiveCode,
      details: optionalWhen(!isEmpty(Object.keys(boundedDetails)), boundedDetails),
      nextActions: nestedSuggestedNextAction ? [nestedSuggestedNextAction] : undefined,
    }
  )
}

export {
  buildExecutionFailureResult,
  buildToolFailureResult,
  extractNestedErrorDetails,
  extractNestedErrorReason,
}
