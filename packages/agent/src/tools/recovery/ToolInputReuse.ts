import { z } from 'zod'

import { isArray, isNumber, isObject, isPlainObject, isString,isUndefined, Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ContextPayloadStore } from '../../agent/context/ContextPayloadStore'
import { createContextPayloadRef } from '../../agent/context/ContextPayloadStore'
import type { ToolInputReuseMigrationRequest } from '../../tool-contract/types'

export const ToolInputReuseSchema = z.strictObject({
  reuse: z.string().min(1).describe('失败回执中的参数引用；复用该次完整参数，只提交 changes。'),
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
const reusableSchemas = new WeakSet<object>()
function optionalInputField(field: z.ZodType): z.ZodType {
  let input = field
  while (
    input instanceof z.ZodOptional ||
    input instanceof z.ZodDefault ||
    input instanceof z.ZodPrefault
  )
    input = input.unwrap() as z.ZodType
  return input.optional().meta(field.meta() ?? {})
}
export function withToolInputReuse<T extends z.ZodType>(schema: T) {
  if (!(schema instanceof z.ZodObject)) throw new Error('Reusable input requires an object schema')
  // Provider 工具 schema 保持 object 根节点；required 分支由同一套原始 schema 在运行时验证。
  const fields = Object.fromEntries(
    Object.entries(schema.shape).map(([name, field]) => [
      name,
      optionalInputField(field as z.ZodType),
    ])
  )
  // 先构建复用信封，避免只提供复用参数时提前执行业务约束。
  // 新调用和恢复后的调用都会通过原始 schema；带额外约束的对象
  // 不能直接调用 partial，复制约束也会在参数恢复前错误校验。
  const wrapped = z.looseObject(fields)
    .extend({
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

/** 只复用已证实未提交的失败调用；来源只读，修改副本重新经过当前策略与 schema。 */
export async function resolveToolInputReuse(
  context: ToolInputReuseContext,
  toolName: string,
  input: Record<string, unknown>,
  consumerCallId?: string,
  options: ToolInputReuseOptions = {}
): Promise<Record<string, unknown>> {
  if (!Object.hasOwn(input, 'reuse')) return input
  const request = ToolInputReuseSchema.parse(input)
  if (!request.reuse.startsWith('attempt:'))
    throw new AppError('VALIDATION', 'Use the attempt reference returned by the failed call')
  if (!context.sessionId || !context.contextPayloadStore)
    throw new AppError('UNAVAILABLE', 'Saved tool input is unavailable')
  const callId = request.reuse.slice('attempt:'.length)
  const [saved, settled] = await Promise.all([
    context.contextPayloadStore.findByHash(context.sessionId, await key(callId, 'input')),
    context.contextPayloadStore.findByHash(context.sessionId, await key(callId, 'outcome')),
  ])
  if (
    !saved ||
    saved.toolName !== InputToolName ||
    !settled ||
    settled.toolName !== OutcomeToolName
  )
    throw new AppError(
      'VALIDATION',
      'Attempt not found or still running; inspect its result before retrying'
    )
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
    throw new AppError(
      'VALIDATION',
      'Previous call may already have applied; inspect its receipt and current state before issuing a new operation'
    )
  let args = structuredClone(original.args)
  for (const change of request.changes) {
    let cursor: unknown = args
    for (const [index, segment] of change.path.entries()) {
      if (isString(segment) && ForbiddenKeys.has(segment))
        throw new AppError('VALIDATION', 'Unsafe parameter path')
      if (!cursor || !isObject(cursor) )
        throw new AppError('VALIDATION', 'Parameter path does not exist')
      if (isArray(cursor) && (!isNumber(segment) || segment >= cursor.length))
        throw new AppError('VALIDATION', 'Array paths require an existing numeric index')
      if (!isArray(cursor) && !isString(segment))
        throw new AppError('VALIDATION', 'Object paths require a field name')
      const target = cursor as Record<string | number, unknown>
      const last = index === change.path.length - 1
      if (!last) {
        if (!Object.hasOwn(target, segment))
          throw new AppError('VALIDATION', 'Parent parameter path does not exist')
        cursor = target[segment]
      } else if (change.op === 'set') {
        Object.defineProperty(target, segment, {
          value: structuredClone(change.value),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      } else {
        if (!Object.hasOwn(target, segment))
          throw new AppError('VALIDATION', 'Parameter to remove does not exist')
        if (isArray(cursor)) cursor.splice(segment as number, 1)
        else delete target[segment]
      }
    }
  }
  if (Object.hasOwn(args, 'reuse'))
    throw new AppError('VALIDATION', 'Nested reuse is not an executable input')
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
        throw new AppError(
          'VALIDATION',
          'This attempt already has a retry; inspect that retry and use its failure reference if needed',
          undefined,
          { retry: JSON.parse(existing.serializedResult).consumerCallId }
        )
      await put(context, callId, 'claim', { kind: 'tool-attempt-claim', consumerCallId })
    })
  claims.set(identity, task)
  try {
    await task
  } finally {
    if (claims.get(identity) === task) claims.delete(identity)
  }
}
