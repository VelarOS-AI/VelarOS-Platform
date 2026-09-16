import { z } from 'zod'

import { isNumber, isPlainObject, isString, isUndefined, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ContextPayloadStore } from '../../contract/requires.js'
import type { AttemptInput, ToolAttemptOutcome, ToolInputReuse, ToolInputReuseContext } from '../../types/tools.js'

/** 复用信封里业务字段的描述后缀：provider 只看得到这一层，必须在这里说清两种调用各自的要求。 */
export const RequiredUnlessReuse = '新调用必填；用 reuse 复用失败调用时省略。'
/** attempt 原参数记录在 payload 存储里的 toolName 标记，读回时用它确认这条记录确实是参数快照。 */
export const InputToolName = '__tool_attempt_input__'
/** attempt 执行结论记录的 toolName 标记；没有它就说明那次调用还没结束，参数不可复用。 */
export const OutcomeToolName = '__tool_attempt_outcome__'
/** attempt 认领记录的 toolName 标记：存在即表示这次失败调用已经被某一次重试消费过。 */
export const ClaimToolName = '__tool_attempt_claim__'
/** changes 不许写入的字段名：这些键会改写原型链，落进恢复出来的参数副本就是一次原型污染。 */
export const ForbiddenInputChangeKeys: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
])

/** 复用信封的根 schema：带 reuse 时根上只能再有 changes，业务字段从被复用的那次调用恢复后重新校验。 */
export const ToolInputReuseSchema = z.strictObject({
  reuse: z.string().min(1).describe('原样复制失败回执 inputReuse.reuse（attempt:…）；带 reuse 时根上只能再有 changes，其余参数从该次调用恢复后重新校验。'),
  changes: z
    .array(
      z
        .strictObject({
          op: z.enum(['set', 'remove']),
          path: z
            .array(z.union([z.string(), z.number().int().nonnegative()]))
            .min(1)
            .max(32),
          value: z.unknown().optional(),
        })
        .superRefine((change, context) => {
          if ((change.op === 'set') !== Object.hasOwn(change, 'value'))
            context.addIssue({
              code: 'custom',
              path: ['value'],
              message: 'op 为 set 时必须给 value；op 为 remove 时只给 path，不要带 value。',
            })
        })
    )
    .min(1)
    .max(100)
    .describe('路径按数组给出，如 ["items", 0, "name"]；使用原参数的实际字段路径，其他参数原样保留。'),
}) satisfies z.ZodType<ToolInputReuse>

/** 复用信封里业务字段一律可省；原本必填的字段在描述里写明两种调用各自的要求，provider 只看得到这一层。 */
export function reusableInputField(field: z.ZodType): z.ZodType {
  let input = field
  while (
    input instanceof z.ZodOptional ||
    input instanceof z.ZodDefault ||
    input instanceof z.ZodPrefault
  )
    input = input.unwrap() as z.ZodType
  const meta = field.meta() ?? {}
  if (input !== field) return input.optional().meta(meta)
  const description = [meta.description, RequiredUnlessReuse].filter(isString).join(' ')
  return input.optional().meta({ ...meta, description })
}

/** 一次调用的参数快照归哪个作用域：项目工具按仓库根隔离，其余按资源 id；跨作用域的记录一律不许复用。 */
export function inputScope(context: ToolInputReuseContext): string | undefined {
  return context.project?.getRootPath() ?? context.resourceId
}

/** 归一化保存记录的参数契约版本号：缺省当 1 代，非法值直接判 VALIDATION，不拿坏记录去迁移。 */
export function contractVersion(value: Optional<number>): number {
  if (isUndefined(value)) return 1
  if (!Number.isSafeInteger(value) || value < 1)
    throw new AppError('VALIDATION', '保存的参数契约版本号不合法：它必须是不小于 1 的安全整数，当前这条记录已经坏了，不能拿它去复用参数。')
  return value
}

/** attempt 三类记录（参数 / 结论 / 认领）在 payload 存储里的哈希键，同一 callId 的三类互不覆盖。 */
export async function toolAttemptPayloadHash(
  callId: string,
  kind: 'input' | 'outcome' | 'claim'
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`tool-attempt-v1:${kind}:${callId}`)
  )
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 按 JSON 路径的写法描述参数位置，如 files[0].edits；空前缀即参数根。 */
export function describeParameterPath(segments: ReadonlyArray<string | number>): string {
  const text = segments.map((segment) => isNumber(segment) ? `[${segment}]` : `.${segment}`).join('')
  return text.startsWith('.') ? text.slice(1) : text || '参数根'
}

/**
 * 读取已证实未提交的失败调用所保存的完整参数（复用调用保存的是解析后的有效参数）。结果未定、仍在执行
 * 或已完成的调用返回 undefined：它们不能被复用，也就不需要为下一次决策展示原参数。
 */
export async function readReusableAttemptInput(
  store: ContextPayloadStore,
  sessionId: string,
  callId: string
): Promise<Optional<Record<string, unknown>>> {
  const [saved, settled] = await Promise.all([
    store.findByHash(sessionId, await toolAttemptPayloadHash(callId, 'input')),
    store.findByHash(sessionId, await toolAttemptPayloadHash(callId, 'outcome')),
  ])
  if (saved?.toolName !== InputToolName || settled?.toolName !== OutcomeToolName) return undefined
  const original = JSON.parse(saved.serializedResult) as AttemptInput
  const outcome = JSON.parse(settled.serializedResult) as { kind: string; outcome: ToolAttemptOutcome }
  if (original.kind !== 'tool-attempt-input' || outcome.kind !== 'tool-attempt-outcome' || outcome.outcome !== 'not-applied')
    return undefined
  return optionalWhen(isPlainObject, original.args)
}
