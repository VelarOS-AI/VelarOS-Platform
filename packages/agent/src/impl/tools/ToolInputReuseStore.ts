import { z } from 'zod'

import { isArray, isEmpty, isNumber, isObject, isPlainObject, isString, isUndefined,Log } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { ToolInputReuseEnvelopeSchema, WithToolInputReuse } from '../../types/toolkit.js'
import type { AttemptInput, ToolAttemptOutcome, ToolInputChange, ToolInputReuseContext, ToolInputReuseOptions } from '../../types/tools.js'
import { ClaimToolName, contractVersion, describeParameterPath, ForbiddenInputChangeKeys, inputScope, InputToolName, OutcomeToolName, reusableInputField, toolAttemptPayloadHash,ToolInputReuseSchema } from '../../utils/tools/tool-input-reuse'
import { createContextPayloadRef } from '../context/InMemoryContextPayloadStore'
import { ToolInputReuseError } from '../errors/ToolInputReuseError'

export { readReusableAttemptInput, ToolInputReuseSchema } from '../../utils/tools/tool-input-reuse'
export { ToolInputReuseError } from '../errors/ToolInputReuseError'

/** 失败回执 inputReuse.note：执行器给新失败和「复用请求本身有误」两处回执共用同一句说明。 */
export const ToolInputReuseNote: string =
  '重试同一个工具，根上只给 reuse 与 changes。changes 的每一项用 op（set 或 remove）加 path（已保存参数里的真实字段路径，写成数组），op 为 set 时再给修正后的 value。没写进 changes 的字段会自动恢复并重新校验。'

/**
 * 工具参数复用的账房：记住「哪些 schema 套过复用信封」，并把每次调用的原参数、执行结论与认领记录
 * 写进当前会话的 payload 存储，供下一次 `reuse` 引用。
 *
 * 宿主进程一份（文件末尾那个 `toolInputReuseStore`），状态全在实例里：schema 登记表是弱引用，
 * schema 被回收即消失；认领串行表只活在内存里，跨重启的去重仍以持久化的 claim 记录为准。
 * 会话与存储都由每次调用传进来的 `ToolInputReuseContext` 决定，实例本身不绑定任何会话。
 */
export interface ToolInputReuseStoreApi {
  /**
   * 登记一份已经套好复用信封的 schema。`withToolInputReuse` 包完就登记，之后执行策略才认得出
   * 这个工具支持 reuse；登记表按 schema 对象身份弱引用，schema 不再被引用时自动消失。
   */
  markReusable(schema: object): void
  /** 这份 schema 是否由 `withToolInputReuse` 包出来；执行策略据此决定要不要保存原参数、要不要给失败回执带 inputReuse。 */
  supportsReuse(schema: object): boolean
  /**
   * 工具真正执行前保存这次调用的完整参数，失败后才有东西可复用。
   * 会话或存储缺失时不保存并返回 false（调用方据此不给回执带 inputReuse）；保存成功返回 true。
   */
  saveAttemptInput(
    context: ToolInputReuseContext,
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
    inputContractVersion?: number
  ): Promise<boolean>
  /**
   * 调用结束后记录它到底有没有生效。只有 `not-applied` 的调用允许被复用，
   * 所以这条记录缺席等同于「仍在执行」，参数一律不可复用。
   */
  saveAttemptOutcome(
    context: ToolInputReuseContext,
    callId: string,
    outcome: ToolAttemptOutcome,
    metrics?: {
      /** 模型这次请求的字符量，用于观察复用相对重发省了多少。 */
      requestedChars: number
      /** 实际写进 provider 的字符量。 */
      effectiveChars: number
      /** 这次调用本身是否走的复用路径。 */
      reused: boolean
    }
  ): Promise<void>
  /**
   * 把带 `reuse` 的请求还原成可执行参数：校验来源记录仍可复用、施加 changes、按需迁移契约版本，
   * 并在给出 consumerCallId 时认领原调用（同一次失败只许被复用一次）。
   * 输入没有 `reuse` 时原样返回。还原不成立时抛 `ToolInputReuseError`（原调用仍可再试）或 `AppError`。
   */
  resolveReuse(
    context: ToolInputReuseContext,
    toolName: string,
    input: Record<string, unknown>,
    consumerCallId?: string,
    options?: ToolInputReuseOptions
  ): Promise<Record<string, unknown>>
}

class ToolInputReuseStore implements ToolInputReuseStoreApi {
  /** 已套过复用信封的 schema 集合；弱引用，工具注销后不拖住 schema。 */
  private readonly reusableSchemas = new WeakSet<object>()
  // 执行由宿主进程管理；多个运行器使用不同存储包装时仍需串行认领。
  // 认领记录跨重启保存，异常或未知子调用必须先检查状态再决定后续动作。
  /** 按「会话 + 项目根 + callId」串行的认领队列，只保证同进程内不并发认领同一次失败调用。 */
  private readonly claims = new Map<string, Promise<void>>()
  /** changes 不许写入的字段名，挡住原型污染。 */
  private readonly forbiddenKeys = ForbiddenInputChangeKeys
  /** 三类 attempt 记录各自的 toolName 标记，读回时靠它区分参数、结论与认领。 */
  private readonly attemptToolNames: Readonly<Record<'input' | 'outcome' | 'claim', string>> = {
    input: InputToolName,
    outcome: OutcomeToolName,
    claim: ClaimToolName,
  }

  public markReusable(schema: object): void {
    this.reusableSchemas.add(schema)
  }

  public supportsReuse(schema: object): boolean {
    return this.reusableSchemas.has(schema)
  }

  public async saveAttemptInput(
    context: ToolInputReuseContext,
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
    inputContractVersion?: number
  ): Promise<boolean> {
    if (!context.sessionId || !context.contextPayloadStore) return false
    await this.put(context, callId, 'input', {
      kind: 'tool-attempt-input',
      version: 1,
      toolName,
      scope: inputScope(context),
      contractVersion: contractVersion(inputContractVersion),
      args,
    } satisfies AttemptInput)
    return true
  }

  public async saveAttemptOutcome(
    context: ToolInputReuseContext,
    callId: string,
    outcome: ToolAttemptOutcome,
    metrics?: { requestedChars: number; effectiveChars: number; reused: boolean }
  ): Promise<void> {
    await this.put(context, callId, 'outcome', { kind: 'tool-attempt-outcome', outcome, metrics })
  }

  /** 只复用已证实未提交的失败调用；来源只读，修改副本重新经过当前策略与 schema。 */
  public async resolveReuse(
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
      throw new AppError('UNAVAILABLE', '当前上下文没有会话或参数存储，取不回任何已保存的调用参数；这次请直接给出完整参数，不要用 reuse。')
    const callId = reuse.slice('attempt:'.length)
    const [saved, settled, claimed] = await Promise.all([
      context.contextPayloadStore.findByHash(context.sessionId, await toolAttemptPayloadHash(callId, 'input')),
      context.contextPayloadStore.findByHash(context.sessionId, await toolAttemptPayloadHash(callId, 'outcome')),
      context.contextPayloadStore.findByHash(context.sessionId, await toolAttemptPayloadHash(callId, 'claim')),
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
        ? '这条已保存的参数是旧格式，没有记录资源作用域，无法确认它当初属于哪个可信上下文；只能在原上下文里复用，这里请直接给出完整参数。'
        : '这条已保存的参数属于另一个工具或另一个资源作用域，不允许跨界复用；请直接给出完整参数。')
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
    for (const [changeIndex, change] of request.data.changes.entries()) this.applyInputChange(args, change, changeIndex, reuse)
    if (Object.hasOwn(args, 'reuse'))
      throw new ToolInputReuseError('changes 不能在参数里写入 reuse；复用只能有一层。', { reuse }, reuse)
    const sourceContractVersion = contractVersion(original.contractVersion)
    const targetContractVersion = contractVersion(options.inputContractVersion)
    if (sourceContractVersion !== targetContractVersion || original.toolName !== toolName) {
      if (!options.migrateReusedInput)
        throw new AppError('VALIDATION', `已保存的参数用的是第 ${sourceContractVersion} 版参数契约，本工具当前是第 ${targetContractVersion} 版，而且没有登记可用的迁移函数；请按当前 schema 直接给出完整参数。`)
      // 迁移失败时还未执行工具，因此保留原调用的继续修补能力。
      // 来源信息只在记录、作用域和执行结果校验通过后传给迁移回调。
      args = await options.migrateReusedInput({
        input: args, sourceContractVersion, targetContractVersion,
        sourceToolName: original.toolName, sourceCallId: callId, toolCallId: consumerCallId,
      })
      if (!isPlainObject(args) || Object.hasOwn(args, 'reuse'))
        throw new AppError('VALIDATION', '参数契约迁移函数必须返回一份可直接执行的参数对象（普通对象，且不能再带 reuse）；这次返回的不是，复用已中止，原调用仍可再试。')
    }
    if (consumerCallId) await this.claimAttempt(context, callId, consumerCallId)
    return args
  }

  /** 把一条 attempt 记录写进当前会话的 payload 存储；同一 callId 重复写入内容必须一致，否则判身份冲突。 */
  private async put(
    context: ToolInputReuseContext,
    callId: string,
    kind: 'input' | 'outcome' | 'claim',
    value: unknown
  ): Promise<void> {
    if (!context.sessionId || !context.contextPayloadStore) return
    const digest = await toolAttemptPayloadHash(callId, kind)
    const serializedResult = JSON.stringify(value)
    const stored = await context.contextPayloadStore.put({
      sessionId: context.sessionId,
      hash: digest,
      payloadRef: createContextPayloadRef(context.sessionId, digest),
      toolCallId: `attempt:${callId}`,
      toolName: this.attemptToolNames[kind],
      serializedResult,
      chars: serializedResult.length,
      createdAt: Date.now(),
    })
    if (stored.serializedResult !== serializedResult)
      throw new Error(`工具调用记录身份冲突：callId ${callId} 的 ${kind} 记录已经存过一份内容不同的值；拒绝覆盖，否则复用时会取回别人的参数。`)
  }

  /** 在原参数副本上就地施加 changes 的一项；某一段走不通就指出第几项、哪一段、那一层实际有什么，原调用仍可复用。 */
  private applyInputChange(args: Record<string, unknown>, change: ToolInputChange, changeIndex: number, reuse: string): void {
    let cursor: unknown = args
    for (const [index, segment] of change.path.entries()) {
      const parent = describeParameterPath(change.path.slice(0, index))
      const fail = (problem: string, availableKeys?: string[]) => {
        const details: Record<string, unknown> = { reuse, changeIndex, path: change.path, segmentIndex: index }
        if (availableKeys) details.availableKeys = availableKeys
        return new ToolInputReuseError(`changes[${changeIndex}].path ${problem}`, details, reuse)
      }
      if (isString(segment) && this.forbiddenKeys.has(segment)) throw fail(`不能使用字段名 "${segment}"。`)
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

  /** 认领一次失败调用：同一身份串行排队，先查持久化的 claim 记录再落盘，保证一次失败只被复用一次。 */
  private async claimAttempt(
    context: ToolInputReuseContext,
    callId: string,
    consumerCallId: string
  ): Promise<void> {
    const identity = JSON.stringify([context.sessionId, context.project?.getRootPath(), callId])
    const previous = this.claims.get(identity) ?? Promise.resolve()
    const task = previous
      .catch((error) => { Log.tag('ToolInputReuse').debug('前次恢复声明失败，重新检查持久化状态', { error }) })
      .then(async () => {
        const existing = await context.contextPayloadStore!.findByHash(
          context.sessionId!,
          await toolAttemptPayloadHash(callId, 'claim')
        )
        if (existing)
          throw new ToolInputReuseError(`attempt:${callId} 已经被复用过一次；那次重试若也失败且回执带 inputReuse，请改用它的引用。`, {
            reuse: `attempt:${callId}`, retry: JSON.parse(existing.serializedResult).consumerCallId,
          })
        await this.put(context, callId, 'claim', { kind: 'tool-attempt-claim', consumerCallId })
      })
    this.claims.set(identity, task)
    try {
      await task
    } finally {
      if (this.claims.get(identity) === task) this.claims.delete(identity)
    }
  }
}

/** 宿主进程唯一的一份参数复用账房；会话与存储都由每次调用传进来的上下文决定。 */
export const toolInputReuseStore: ToolInputReuseStoreApi = new ToolInputReuseStore()

export const withToolInputReuse: WithToolInputReuse = <T extends z.ZodType>(schema: T): ToolInputReuseEnvelopeSchema<T> => {
  if (!(schema instanceof z.ZodObject)) throw new Error('withToolInputReuse 只能包裹对象 schema（z.object / z.strictObject）：复用信封要在根对象上补 reuse 与 changes 两个字段，非对象 schema 没有可补的位置。')
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
  toolInputReuseStore.markReusable(wrapped)
  return wrapped
}

export function resolveToolInputReuse(
  context: ToolInputReuseContext,
  toolName: string,
  input: Record<string, unknown>,
  consumerCallId?: string,
  options: ToolInputReuseOptions = {}
): Promise<Record<string, unknown>> {
  return toolInputReuseStore.resolveReuse(context, toolName, input, consumerCallId, options)
}
