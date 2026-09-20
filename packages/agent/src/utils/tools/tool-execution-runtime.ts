import { isArray, isEmpty, isPlainObject, isPresent, isString, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { ExecutionSpanStatus } from '../../types/agent.js'
import type { KernelToolFailureBatchEntry, ScheduledTool, ToolExecutionPolicyContext, ToolExecutionSettlement, ToolFailureResult, ToolResult } from '../../types/tools.js'

import { buildToolFailureResult } from './execution-policy-failures'
import { findHistoryPreviewPlaceholderArgumentPaths } from './history-preview-placeholder'

/**
 * 把工具执行期抛出的任意东西收敛成 `AppError`：字符串、原生 Error、已经是 AppError 的都能接。
 * 第二个参数是出事时那次调用的上下文，当前不参与判定，留着是为了以后按上下文区分错误分类时有个落点。
 */
export function buildExecutionAppError(
  error: unknown,
  _toolContext?: LooseOptional<ToolExecutionPolicyContext>
): AppError {
  return AppError.from(error)
}

/**
 * 开一条「中止后的收尾等待」：信号一旦中止，再宽限 `graceMs` 毫秒才判定为 aborted，
 * 好让工具自己有机会先把清理跑完、把真实结果交出来。返回的 promise 只会以 aborted 落定；
 * 正常结束的那一路由调用方竞速胜出，并且**必须**调 `cleanup` 摘掉监听与定时器，否则信号会一直被挂住。
 */
export function createToolAbortSettlement(
  abortSignal: AbortSignal,
  graceMs: number
): {
  promise: Promise<ToolExecutionSettlement>
  cleanup: () => void
} {
  const timers = new TimerScope({ name: 'ToolExecutor.abortSettlement' })
  let onAbort: Nullable<() => void> = null
  let cleaned = false
  const promise = new Promise<ToolExecutionSettlement>((resolve) => {
    const scheduleSettlement = (): void => {
      if (cleaned) return

      timers.after(
        graceMs,
        () => resolve({ status: 'aborted' }),
        {
          label: 'ToolExecutor.abortSettlement.grace',
        },
      )
    }

    if (abortSignal.aborted) {
      scheduleSettlement()
      return
    }

    onAbort = scheduleSettlement
    abortSignal.addEventListener('abort', onAbort, { once: true })
  })

  return {
    promise,
    cleanup: () => {
      cleaned = true
      if (onAbort) {
        abortSignal.removeEventListener('abort', onAbort)
      }
      timers.dispose()
    },
  }
}

/** 从一条工具结果派生 tool span 的结构化错误码：成功返回 null；失败优先取结构化结果里的 `error`，取不到兜 `'ERROR'`。 */
export function readToolSpanErrorCode(result: ToolResult): Nullable<string> {
  if (!result.error) return null
  const structured = isPlainObject(result.result) ? result.result : null
  return isString(structured?.error) ? structured.error : 'ERROR'
}

/** 描述供应商交来的工具参数到底是什么类型（`null` / `array` / typeof 结果），用在「参数不是对象」的回执里告诉模型它发了什么。 */
export function describeProviderToolArgsType(value: unknown): string {
  if (!isPresent(value)) return 'null'
  if (isArray(value)) return 'array'
  return typeof value
}

/**
 * 这条失败是不是「已经被闸拦下」的那类（取消、拦截、拒绝、成环闸、工具不可用）。
 * 成环判定要跳过它们：这些不是模型自己撞出来的新失败，拿去计数会把闸自己的输出当成空转证据。
 */
export function isLoopGuardBlockedResult(result: ToolResult): boolean {
  const record = isPlainObject(result.result) ? result.result : null
  const error = isString(record?.error) ? record.error : ''
  return [
    'tool_cancelled',
    'tool_blocked',
    'tool_denied',
    'tool_loop_guard',
    'tool_unavailable',
  ].includes(error)
}

/**
 * 收敛一条工具 span：没开 span（handle 为空）直接跳过，开了就按结果判 ok / aborted / error 并收尾。
 * 收尾后把 handle 摘掉，保证同一条 span 不会被终结两次；观测端口内部已隔离失败，这里不再兜。
 */
export function endToolSpan(tool: ScheduledTool, result: ToolResult): void {
  const handle = tool.spanHandle
  if (!handle) return
  tool.spanHandle = null
  const errorCode = readToolSpanErrorCode(result)
  const status: ExecutionSpanStatus = !result.error
    ? 'ok'
    : errorCode === 'tool_cancelled'
      ? 'aborted'
      : 'error'
  handle.end({ status, errorCode })
}

/**
 * 「复用请求本身有误」时的失败回执：按参数校验失败出结构化结果，并说明下一步怎么改。
 *
 * 原失败调用仍未被认领时（`reusableAttempt` 有值），把同一个 reuse 引用原样放回回执里，
 * 模型只需改 `changes` 再试；引用无效、已执行或已被认领时不带 inputReuse，只说明原因。
 * `reuseNote` 由调用方传入，与新失败回执共用同一句说明，免得两处漂移。
 */
export function buildInputReuseFailure(
  toolName: string,
  error: { message: string; context: Record<string, unknown>; reusableAttempt?: string },
  reuseNote: string,
): ToolFailureResult & { inputReuse?: { reuse: string; note: string } } {
  const failure = buildToolFailureResult('schema_validation_failed', error.message, toolName, {
    code: 'VALIDATION',
    details: error.context,
    nextActions: [error.reusableAttempt
      ? '原调用没有执行过：保持同一个 reuse，只修正回执指出的那一项 changes 后重试。'
      : '这次调用不能复用：按原因查看原回执或当前状态，再构造完整参数。'],
  })
  if (!error.reusableAttempt) return failure
  return { ...failure, inputReuse: { reuse: error.reusableAttempt, note: reuseNote } }
}

/** 历史压缩后的参数预览不能当源码重放：说清缺了什么、怎么找回原文，并在执行前拒绝这次调用。 */
export function buildHistoryPlaceholderArgsFailure(
  toolName: string,
  placeholderPaths: string[],
): { ok: false; reason: string; result: ToolFailureResult } {
  const shownPaths = placeholderPaths.slice(0, 10)
  const reason = `参数 ${shownPaths.join('、')} 是对话历史里的省略占位串（"[history preview omitted …]"），不是真实内容，工具未执行。历史中的旧调用只保留了参数预览，原文不在上下文里。`
  return {
    ok: false,
    reason,
    result: buildToolFailureResult(
      'history_placeholder_argument',
      reason,
      toolName,
      {
        code: 'VALIDATION',
        details: { placeholderPaths: shownPaths },
        nextActions: [
          '这些参数来自压缩后的历史预览，缺少可执行的完整内容；恢复真实内容后重新调用。',
          '需要旧内容时先重新读取目标文件或片段，以读到的原文为准构造参数。',
          '历史调用的 __historyInputRef 是宿主原文引用；参数不完整时报告缺口，不能直接重发历史投影。',
        ],
      },
    ),
  }
}

/**
 * 读取供应商交来的工具参数，判定这次调用能不能进执行队列。
 *
 * 缺席按空对象放行；是对象时还要挡两种「历史视图」参数——带 `__historyInput*` 元数据的，
 * 以及字段里躺着压缩预览占位串的，它们都不是完整可执行输入，放过去会产出损坏的副作用。
 * 不是对象时直接判失败，并在回执里告诉模型它实际发来的是什么类型、该怎么重建 args。
 */
export function readProviderToolArgs(
  toolName: string,
  args: unknown,
):
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string; result: ToolFailureResult } {
  if (!isPresent(args)) return { ok: true, args: {} }
  if (isPlainObject(args)) {
    const record = args as Record<string, unknown>
    if (['__historyInputOmissions', '__historyInputPreview', '__historyInputRef', '__historyInputRecall', '__toolReceivedFullInput'].some((key) => Object.hasOwn(record, key))) {
      const reason = '历史参数视图省略了原始字段，不能作为完整工具输入执行；工具未执行。'
      return {
        ok: false, reason,
        result: buildToolFailureResult('history_input_preview_argument', reason, toolName, {
          code: 'VALIDATION',
          details: { inputRef: optionalWhen(isString, record.__historyInputRef) },
          nextActions: ['基于真实原文构造符合当前 schema 的完整参数；缺失字段需要宿主补充，历史投影不能当作执行参数。'],
        }),
      }
    }
    const placeholderPaths = findHistoryPreviewPlaceholderArgumentPaths(record)
    return isEmpty(placeholderPaths)
      ? { ok: true, args: record }
      : buildHistoryPlaceholderArgsFailure(toolName, placeholderPaths)
  }

  const receivedType = describeProviderToolArgsType(args)
  const reason = `Tool arguments for "${toolName}" must be a JSON object; received ${receivedType}.`
  return {
    ok: false,
    reason,
    result: buildToolFailureResult(
      'schema_validation_failed',
      reason,
      toolName,
      {
        code: 'VALIDATION',
        details: {
          receivedType,
          schemaIssues: [{ path: '', message: reason }],
        },
        nextActions: [
          '重建 args：读取当前可见工具 schema，只传 schema.properties 声明的字段。',
          '不要把整段 JSON、数组或自然语言字符串作为工具参数；工具参数必须是 object。',
          '如果参数流像是截断或串行化错误，重新发起该工具调用。',
        ],
      },
    ),
  }
}

/**
 * 把本批结果折成成环闸要的失败清单：**必须整批都是失败**才算数，
 * 里面只要有一条成功、或有一条本来就是被闸拦下的结果，整批作废返回空数组——
 * 半批失败拿去计数会把正常推进误判成空转。
 */
export function toLoopGuardFailureBatch(
  results: readonly ToolResult[],
): KernelToolFailureBatchEntry[] {
  if (isEmpty(results)) return []

  const failures: KernelToolFailureBatchEntry[] = []
  for (const result of results) {
    if (!result.error || isLoopGuardBlockedResult(result)) return []
    failures.push({
      toolName: result.toolName,
      args: result.args,
      error: result.error,
    })
  }
  return failures
}
