import { z } from 'zod'

import { isArray, isEmpty, isNumber, isObject, isPlainObject, isString, isUndefined, Log, optionalWhen } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ContextPayloadStore } from '../../agent/context/ContextPayloadStore'
import { createContextPayloadRef } from '../../agent/context/ContextPayloadStore'
import type { ToolInputReuseMigrationRequest } from '../../tool-contract/types'

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
              message: 'set requires value; remove takes only path',
            })
        })
    )
    .min(1)
    .max(100)
    .describe('路径按数组给出，如 ["items", 0, "name"]；使用原参数的实际字段路径，其他参数原样保留。'),
})
/** 失败回执 inputReuse.note：执行器给新失败和「复用请求本身有误」两处回执共用同一句说明。 */
export const ToolInputReuseNote =
  'Retry the same tool with reuse and changes only. Each change uses op set/remove and the actual saved field path as an array; set also requires the corrected value. Unchanged fields are restored and revalidated.'
const RequiredUnlessReuse = '新调用必填；用 reuse 复用失败调用时省略。'
const reusableSchemas = new WeakSet<object>()
/** 复用信封里业务字段一律可省；原本必填的字段在描述里写明两种调用各自的要求，provider 只看得到这一层。 */
function reusableInputField(field: z.ZodType): z.ZodType {
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
export function withToolInputReuse<T extends z.ZodType>(schema: T) {
  if (!(schema instanceof z.ZodObject)) throw new Error('Reusable input requires an object schema')
  // Provider 工具 schema 保持 object 根节点（不接受根级 anyOf）；根对象严格，未知字段在这一层就报出，
  // 业务字段的必填与互斥约束由同一套原始 schema 在运行时验证。
  const fields = Object.fromEntries(
    Object.entries(schema.shape).map(([name, field]) => [
      name,
      reusableInputField(field as z.ZodType),
    ])
  )
  // 先构建复用信封，避免只提供复用参数时提前执行业务约束。
  // 新调用和恢复后的调用都会通过原始 schema；带额外约束的对象
  // 不能直接调用 partial，复制约束也会在参数恢复前错误校验。
  const wrapped = z.strictObject({
    ...fields,
    reuse: ToolInputReuseSchema.shape.reuse.optional(),
    changes: ToolInputReuseSchema.shape.changes.optional(),
  })
    .superRefine((input, context) => {
      const parsed = Object.hasOwn(input, 'reuse')
        ? ToolInputReuseSchema.safeParse(input)
        : schema.safeParse(input)
      if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue })
    })
    .transform((input) => (Object.hasOwn(input, 'reuse') ? input : schema.parse(input)))
  reusableSchemas.add(wrapped)
  return wrapped
}
export function supportsToolInputReuse(schema: object): boolean {
  return reusableSchemas.has(schema)
}

export type ToolInputReuse = z.infer<typeof ToolInputReuseSchema>
export type ToolAttemptOutcome = 'not-applied' | 'completed' | 'unknown'
export interface ToolInputReuseContext {
  sessionId?: string
  resourceId?: string
  contextPayloadStore?: ContextPayloadStore
  project?: { getRootPath(): string }
}
interface AttemptInput {
  kind: 'tool-attempt-input'
  version: 1
  contractVersion?: number
  toolName: string
  scope?: string
  args: Record<string, unknown>
}
export interface ToolInputReuseOptions {
  inputContractVersion?: number
  inputReuseSourceTools?: readonly string[]
  migrateReusedInput?: (
    request: ToolInputReuseMigrationRequest
  ) => Promise<Record<string, unknown>> | Record<string, unknown>
}

function inputScope(context: ToolInputReuseContext): string | undefined {
  return context.project?.getRootPath() ?? context.resourceId
}
function contractVersion(value: Optional<number>): number {
  if (isUndefined(value)) return 1
  if (!Number.isSafeInteger(value) || value < 1)
    throw new AppError('VALIDATION', 'Invalid saved input contract version')
  return value
}
const InputToolName = '__tool_attempt_input__'
const OutcomeToolName = '__tool_attempt_outcome__'
const ForbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])

async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
async function key(callId: string, kind: 'input' | 'outcome' | 'claim'): Promise<string> {
  return hash(`tool-attempt-v1:${kind}:${callId}`)
}
async function put(
  context: ToolInputReuseContext,
  callId: string,
  kind: 'input' | 'outcome' | 'claim',
  value: unknown
): Promise<void> {
  if (!context.sessionId || !context.contextPayloadStore) return
  const digest = await key(callId, kind)
  const serializedResult = JSON.stringify(value)
  const stored = await context.contextPayloadStore.put({
    sessionId: context.sessionId,
    hash: digest,
    payloadRef: createContextPayloadRef(context.sessionId, digest),
    toolCallId: `attempt:${callId}`,
    toolName:
      kind === 'input'
        ? InputToolName
        : kind === 'outcome'
          ? OutcomeToolName
          : '__tool_attempt_claim__',
    serializedResult,
    chars: serializedResult.length,
    createdAt: Date.now(),
  })
  if (stored.serializedResult !== serializedResult)
    throw new Error('Tool attempt identity conflict')
}
export async function saveToolAttemptInput(
  context: ToolInputReuseContext,
  callId: string,
  toolName: string,
  args: Record<string, unknown>,
  inputContractVersion?: number
): Promise<boolean> {
  if (!context.sessionId || !context.contextPayloadStore) return false
  await put(context, callId, 'input', {
    kind: 'tool-attempt-input',
    version: 1,
    toolName,
    scope: inputScope(context),
    contractVersion: contractVersion(inputContractVersion),
    args,
  } satisfies AttemptInput)
  return true
}
export async function saveToolAttemptOutcome(
  context: ToolInputReuseContext,
  callId: string,
  outcome: ToolAttemptOutcome,
  metrics?: { requestedChars: number; effectiveChars: number; reused: boolean }
): Promise<void> {
  await put(context, callId, 'outcome', { kind: 'tool-attempt-outcome', outcome, metrics })
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
    store.findByHash(sessionId, await key(callId, 'input')),
    store.findByHash(sessionId, await key(callId, 'outcome')),
  ])
  if (saved?.toolName !== InputToolName || settled?.toolName !== OutcomeToolName) return undefined
  const original = JSON.parse(saved.serializedResult) as AttemptInput
  const outcome = JSON.parse(settled.serializedResult) as { kind: string; outcome: ToolAttemptOutcome }
  if (original.kind !== 'tool-attempt-input' || outcome.kind !== 'tool-attempt-outcome' || outcome.outcome !== 'not-applied')
    return undefined
  return optionalWhen(isPlainObject, original.args)
}

/**
 * 复用请求无法还原成可执行参数。reusableAttempt 表示原失败调用仍未被认领：执行器把它原样放回回执的
 * inputReuse，模型改好 changes 即可再复用；引用无效、已执行或已被认领时不带它，只说明原因。
 */
export class ToolInputReuseError extends AppError {
  constructor(message: string, details: Record<string, unknown>, readonly reusableAttempt?: string) {
    super('VALIDATION', message, undefined, details)
    this.name = 'ToolInputReuseError'
  }
}

type ToolInputChange = ToolInputReuse['changes'][number]

/** 按 JSON 路径的写法描述参数位置，如 files[0].edits；空前缀即参数根。 */
function describeParameterPath(segments: ReadonlyArray<string | number>): string {
  const text = segments.map((segment) => isNumber(segment) ? `[${segment}]` : `.${segment}`).join('')
  return text.startsWith('.') ? text.slice(1) : text || '参数根'
}

/** changes 某一段走不通：指出第几项、哪一段、那一层实际有什么；原调用仍可复用。 */
function changePathError(
  reuse: string,
  change: ToolInputChange,
  changeIndex: number,
  segmentIndex: number,
  problem: string,
  availableKeys?: string[]
): ToolInputReuseError {
  const details: Record<string, unknown> = { reuse, changeIndex, path: change.path, segmentIndex }
  if (availableKeys) details.availableKeys = availableKeys
  return new ToolInputReuseError(`changes[${changeIndex}].path ${problem}`, details, reuse)
}

function applyInputChange(args: Record<string, unknown>, change: ToolInputChange, changeIndex: number, reuse: string): void {
  let cursor: unknown = args
  for (const [index, segment] of change.path.entries()) {
    const parent = describeParameterPath(change.path.slice(0, index))
    const fail = (problem: string, availableKeys?: string[]) =>
      changePathError(reuse, change, changeIndex, index, problem, availableKeys)
    if (isString(segment) && ForbiddenKeys.has(segment)) throw fail(`不能使用字段名 "${segment}"。`)
    if (!isObject(cursor)) throw fail(`在 ${parent} 处已经不是对象或数组，无法继续进入 ${JSON.stringify(segment)}。`)
    if (isArray(cursor) && (!isNumber(segment) || segment >= cursor.length))
      throw fail(`的 ${parent} 是长度 ${cursor.length} 的数组，这一段必须是 0–${cursor.length - 1} 的下标（收到 ${JSON.stringify(segment)}）。`)
    if (!isArray(cursor) && !isString(segment)) throw fail(`的 ${parent} 是对象，这一段必须是字段名（收到 ${segment}）。`)
    const target = cursor as Record<string | number, unknown>
    const last = index === change.path.length - 1
    if ((!last || change.op === 'remove') && !Object.hasOwn(target, segment)) {
      const keys = Object.keys(target)
      throw fail(`的 ${parent} 没有 ${JSON.stringify(segment)}；原参数这一层现有：${keys.join('、') || '（空）'}。`, keys)
    }
    if (!last) cursor = target[segment]
    else if (change.op === 'set')
      Object.defineProperty(target, segment, {
        value: structuredClone(change.value),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    else if (isArray(cursor)) cursor.splice(segment as number, 1)
    else delete target[segment]
  }
}

/** 只复用已证实未提交的失败调用；来源只读，修改副本重新经过当前策略与 schema。 */
export async function resolveToolInputReuse(
  context: ToolInputReuseContext,
  toolName: string,
  input: Record<string, unknown>,
  consumerCallId?: string,
  options: ToolInputReuseOptions = {}
): Promise<Record<string, unknown>> {
  if (!Object.hasOwn(input, 'reuse')) return input
  const reuse = input.reuse
  if (!isString(reuse) || !reuse.startsWith('attempt:'))
    throw new ToolInputReuseError('reuse 必须原样复制失败回执 inputReuse.reuse 的值（attempt:…）。', { reuse: String(reuse) })
  if (!context.sessionId || !context.contextPayloadStore)
    throw new AppError('UNAVAILABLE', 'Saved tool input is unavailable')
  const callId = reuse.slice('attempt:'.length)
  const [saved, settled, claimed] = await Promise.all([
    context.contextPayloadStore.findByHash(context.sessionId, await key(callId, 'input')),
    context.contextPayloadStore.findByHash(context.sessionId, await key(callId, 'outcome')),
    context.contextPayloadStore.findByHash(context.sessionId, await key(callId, 'claim')),
  ])
  if (
    !saved ||
    saved.toolName !== InputToolName ||
    !settled ||
    settled.toolName !== OutcomeToolName
  )
    throw new ToolInputReuseError(`${reuse} 没有可复用的参数记录，或那次调用仍在执行；先查看它的结果再决定。`, { reuse })
  const original = JSON.parse(saved.serializedResult) as AttemptInput
  const outcome = JSON.parse(settled.serializedResult) as {
    kind: string
    outcome: ToolAttemptOutcome
  }
  if (
    original.kind !== 'tool-attempt-input' ||
    original.version !== 1 ||
    (original.toolName !== toolName && !options.inputReuseSourceTools?.includes(original.toolName)) ||
    original.scope !== inputScope(context)
  )
    throw new AppError('PERMISSION', isUndefined(original.scope) && !isUndefined(inputScope(context))
      ? 'Legacy saved input has no verified resource scope; restore it only in its original trusted context'
      : 'Saved input belongs to a different tool or resource scope')
  if (outcome.kind !== 'tool-attempt-outcome' || outcome.outcome !== 'not-applied')
    throw new ToolInputReuseError(`${reuse} 那次调用可能已经生效，不能复用；先查看它的回执和当前状态，再发新的调用。`, { reuse, outcome: outcome.outcome })
  if (claimed)
    throw new ToolInputReuseError(`${reuse} 已经被复用过一次；那次重试若也失败且回执带 inputReuse，请改用它的引用。`, {
      reuse, retry: JSON.parse(claimed.serializedResult).consumerCallId,
    })
  // 到这里原调用确定仍可复用：之后的每种错误都把同一个 reuse 放回回执，模型只需修正 changes。
  const request = ToolInputReuseSchema.safeParse(input)
  if (!request.success) {
    const extra = request.error.issues.find((issue): issue is z.core.$ZodIssueUnrecognizedKeys => issue.code === 'unrecognized_keys' && isEmpty(issue.path))
    const schemaIssues = request.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }))
    throw new ToolInputReuseError(extra
      ? `带 reuse 时根上只能有 reuse 与 changes，多了 ${extra.keys.join('、')}。要修正原参数就把改动写进 changes；要发全新参数就去掉 reuse。`
      : `reuse 请求格式不对：${schemaIssues.map((issue) => `${issue.path || '参数根'}: ${issue.message}`).join('；')}`,
    { reuse, schemaIssues }, reuse)
  }
  let args = structuredClone(original.args)
  for (const [changeIndex, change] of request.data.changes.entries()) applyInputChange(args, change, changeIndex, reuse)
  if (Object.hasOwn(args, 'reuse'))
    throw new ToolInputReuseError('changes 不能在参数里写入 reuse；复用只能有一层。', { reuse }, reuse)
  const sourceContractVersion = contractVersion(original.contractVersion)
  const targetContractVersion = contractVersion(options.inputContractVersion)
  if (sourceContractVersion !== targetContractVersion || original.toolName !== toolName) {
    if (!options.migrateReusedInput)
      throw new AppError('VALIDATION', `Saved input uses contract ${sourceContractVersion}; this tool uses contract ${targetContractVersion} and has no compatible migration`)
    // 迁移失败时还未执行工具，因此保留原调用的继续修补能力。
    // 来源信息只在记录、作用域和执行结果校验通过后传给迁移回调。
    args = await options.migrateReusedInput({
      input: args, sourceContractVersion, targetContractVersion,
      sourceToolName: original.toolName, sourceCallId: callId, toolCallId: consumerCallId,
    })
    if (!isPlainObject(args) || Object.hasOwn(args, 'reuse'))
      throw new AppError('VALIDATION', 'Saved input migration must return executable input fields')
  }
  if (consumerCallId) await claimAttempt(context, callId, consumerCallId)
  return args
}

// 执行由宿主进程管理；多个运行器使用不同存储包装时仍需串行认领。
// 认领记录跨重启保存，异常或未知子调用必须先检查状态再决定后续动作。
const claims = new Map<string, Promise<void>>()
async function claimAttempt(
  context: ToolInputReuseContext,
  callId: string,
  consumerCallId: string
): Promise<void> {
  const identity = JSON.stringify([context.sessionId, context.project?.getRootPath(), callId])
  const previous = claims.get(identity) ?? Promise.resolve()
  const task = previous
    .catch((error) => { Log.tag('ToolInputReuse').debug('前次恢复声明失败，重新检查持久化状态', { error }) })
    .then(async () => {
      const existing = await context.contextPayloadStore!.findByHash(
        context.sessionId!,
        await key(callId, 'claim')
      )
      if (existing)
        throw new ToolInputReuseError(`attempt:${callId} 已经被复用过一次；那次重试若也失败且回执带 inputReuse，请改用它的引用。`, {
          reuse: `attempt:${callId}`, retry: JSON.parse(existing.serializedResult).consumerCallId,
        })
      await put(context, callId, 'claim', { kind: 'tool-attempt-claim', consumerCallId })
    })
  claims.set(identity, task)
  try {
    await task
  } finally {
    if (claims.get(identity) === task) claims.delete(identity)
  }
}
