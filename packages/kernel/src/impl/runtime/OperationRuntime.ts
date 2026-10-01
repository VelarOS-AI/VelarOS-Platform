import { Ajv, type ValidateFunction } from 'ajv'

import { Log } from '@velaros-ai/core'
import { isTrue, isUndefined } from '@velaros-ai/core'
import { isArray, isEmpty, isString } from '@velaros-ai/core'
import { AppError, createAbortError } from '@velaros-ai/core/error'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import { KernelVersionAxes } from '../../contract/constants.js'
import type { OperationRuntimeApi } from '../../contract/provides.js'
import type {
  InvocationJournal,
  KernelCallableCapabilityOperation,
  OperationDefinition,
  OperationRuntimeOptions,
} from '../../contract/requires.js'
import type { ModelImage } from '../../types/model.js'
import type {
  InvocationReceipt,
  InvocationReconciliation,
  InvocationRecord,
  ModuleBinding,
  ModuleDescription,
  ModulePage,
  ModuleQuery,
  OperationCall,
  OperationDescriptor,
  OperationRuntimeCloseOptions,
  PendingInvocation,
  PreparedInvocation,
} from '../../types/operations.js'
import { validateModelImages } from '../../utils/runtime/model-request.js'
import {
  awaitOperationRead,
  canonicalOperationJson,
  describeSchemaErrors,
  immutableOperationJson,
  operationFingerprint,
  operationSchemaType,
  validateOperationSchema,
} from '../../utils/runtime/operation-schema.js'
import { KernelTuning } from '../../utils/tuning.js'

import { createKernel, type KernelApi } from './Kernel.js'
import { kernelModules } from './KernelModuleKit.js'
export type { OperationRuntimeApi } from '../../contract/provides.js'

class OperationRuntime implements OperationRuntimeApi {
  private readonly kernel: KernelApi = createKernel()
  private readonly descriptions = new Map<string, ModuleDescription>()
  private readonly leases = new Map<string, Set<string>>()
  private readonly journal: InvocationJournal
  private readonly active = new Map<string, AbortController>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly phases = new Map<string, PendingInvocation>()
  private draining?: Promise<void>
  private readonly settlementFailures: unknown[] = []
  private readonly validators = new Map<
    string,
    { input: ValidateFunction; output: ValidateFunction }
  >()
  private readonly dispatches = new Map<
    string,
    { key: string; promise: Promise<InvocationReceipt> }
  >()
  private readonly observable = new Set<string>()
  private started?: Promise<void>
  private closing = false

  public constructor(private readonly options: OperationRuntimeOptions) {
    this.journal = options.journal
    const ajv = new Ajv({
      strict: true,
      allErrors: true,
      coerceTypes: false,
      useDefaults: false,
      removeAdditional: false,
    })
    for (const definition of options.modules) {
      const binding = immutableOperationJson(definition.binding)
      if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u.test(binding.moduleId))
        throw new AppError('VALIDATION', `模块身份无效 ${binding.moduleId}`)
      if (this.descriptions.has(binding.moduleId))
        throw new AppError('CONFLICT', `模块挂载歧义 ${binding.moduleId}`)
      if (
        !binding.instanceId ||
        !Number.isSafeInteger(binding.generation) ||
        binding.generation < 1 ||
        !binding.schemaRevision
      )
        throw new AppError('VALIDATION', '模块实例身份不完整')
      if (
        definition.surface &&
        (definition.surface.specifier !== binding.moduleId ||
          definition.surface.revision !== binding.schemaRevision ||
          [...definition.surface.methods].sort().join(',') !==
            Object.keys(definition.operations).sort().join(','))
      )
        throw new AppError('INVARIANT', '生成合同与模块挂载不一致')
      const descriptors: Record<string, OperationDescriptor> = Object.create(null)
      const handlers: Record<string, KernelCallableCapabilityOperation> = Object.create(null)
      for (const [name, operation] of Object.entries(definition.operations)) {
        if (
          !isUndefined(operation.allowedModes) &&
          (!isArray(operation.allowedModes) ||
            isEmpty(operation.allowedModes) ||
            new Set(operation.allowedModes).size !== operation.allowedModes.length ||
            operation.allowedModes.some((mode) => !['execute', 'observe'].includes(mode)))
        )
          throw new AppError('VALIDATION', '操作模式必须是不重复的 execute/observe 非空集合')
        if (
          !/^[A-Za-z_$][\w$]*$/u.test(name) ||
          ['constructor', 'prototype', '__proto__'].includes(name)
        )
          throw new AppError('VALIDATION', `操作名无效 ${name}`)
        const descriptorFields: OperationDescriptor = {
          summary: operation.summary,
          input: operation.input,
          output: operation.output,
          effects: operation.effects,
        }
        if (operation.allowedModes)
          Object.assign(descriptorFields, { allowedModes: operation.allowedModes })
        if (operation.examples) Object.assign(descriptorFields, { examples: operation.examples })
        const descriptor = immutableOperationJson(descriptorFields)
        const generated = definition.surface?.operations[name]
        if (
          definition.surface &&
          (!generated ||
            canonicalOperationJson({
              input: generated.input,
              output: generated.output,
              effects: generated.effects,
              allowedModes: [...(generated.allowedModes ?? ['execute', 'observe'])].sort(),
            }) !==
              canonicalOperationJson({
                input: descriptor.input,
                output: descriptor.output,
                effects: descriptor.effects,
                allowedModes: [...(descriptor.allowedModes ?? ['execute', 'observe'])].sort(),
              }))
        )
          throw new AppError('INVARIANT', '生成合同与运行时操作不一致')
        validateOperationSchema(descriptor.input)
        validateOperationSchema(descriptor.output)
        descriptors[name] = descriptor
        this.validators.set(`${binding.moduleId}/${name}`, {
          input: ajv.compile(descriptor.input),
          output: ajv.compile(descriptor.output),
        })
        // 处理器在 Kernel 的可调用服务中注册，宿主与脚本不会各保留一份分发器。
        const run = operation.run
        const observe = operation.observe
        if (observe) this.observable.add(`${binding.moduleId}/${name}`)
        if (operation.reconcile)
          this.reconcilers.set(`${binding.moduleId}/${name}`, operation.reconcile)
        handlers[name] = {
          metadata: { permissions: [] },
          invoke: async (_scope, input, signal) => {
            const prepared = input as PreparedInvocation
            let effect: InvocationReceipt['effect'] =
              descriptor.effects === 'none' ? 'none' : 'unknown'
            let declaredEffect = false
            let observation: InvocationReceipt['observation']
            let diagnostic: InvocationReceipt['diagnostic']
            const attachments: ModelImage[] = []
            const startedAt = new Date().toISOString()
            try {
              const invoke = prepared.mode === 'observe' && observe ? observe : run
              const context = {
                invocation: prepared,
                signal,
                recordDiagnostic: (value: NonNullable<InvocationReceipt['diagnostic']>) => {
                  if (!value || !isString(value.code) || !isString(value.message))
                    throw new AppError('VALIDATION', '调用诊断必须包含分类码和文本')
                  const truncated =
                    value.truncated ||
                    value.code.length > KernelTuning.operationDiagnosticCodeChars ||
                    value.message.length > KernelTuning.operationDiagnosticMessageChars
                  const recorded: NonNullable<InvocationReceipt['diagnostic']> = {
                    code: value.code.slice(0, KernelTuning.operationDiagnosticCodeChars),
                    message: value.message.slice(0, KernelTuning.operationDiagnosticMessageChars),
                  }
                  if (truncated) Object.assign(recorded, { truncated: true })
                  diagnostic = immutableOperationJson(recorded)
                },
                recordObservation: (evidence: NonNullable<InvocationReceipt['observation']>) => {
                  if (
                    prepared.mode !== 'observe' ||
                    !isTrue(evidence.completed) ||
                    !['full', 'partial', 'none'].includes(evidence.protection)
                  )
                    throw new AppError('VALIDATION', '观察收束证据无效')
                  observation = immutableOperationJson(evidence)
                },
                attach: (image: ModelImage) => {
                  const frozen = immutableOperationJson(image)
                  validateModelImages([...attachments, frozen])
                  attachments.push(frozen)
                },
                recordEffect: (next: InvocationReceipt['effect']) => {
                  effect = next
                  declaredEffect = true
                },
              }
              const value = await invoke(prepared.input, context)
              if (!declaredEffect)
                effect =
                  descriptor.effects === 'none'
                    ? 'none'
                    : prepared.mode === 'observe'
                      ? 'unknown'
                      : 'committed'
              return { value, effect, attachments, observation, diagnostic, startedAt }
            } catch (error) {
              return {
                effect,
                attachments,
                diagnostic,
                startedAt,
                error: {
                  code: signal.aborted
                    ? 'CANCELLED'
                    : ((error as { code?: string; reason?: string })?.code ??
                      (error as { reason?: string })?.reason ??
                      'OPERATION_FAILED'),
                  message: error instanceof Error ? error.message : String(error),
                },
              }
            }
          },
        }
      }
      const declarations = `declare module ${JSON.stringify(binding.moduleId)} {\n${Object.entries(
        descriptors
      )
        .map(
          ([name, op]) =>
            `export function ${name}(input${op.input.type === 'null' || op.input.anyOf?.some((schema) => schema.type === 'null') ? '?' : ''}: ${operationSchemaType(op.input)}): Promise<${operationSchemaType(op.output)}>;`
        )
        .join('\n')}\n}`
      const description: ModuleDescription = {
        binding,
        summary: definition.summary,
        operations: descriptors,
        declarations: definition.surface?.declarations ?? declarations,
      }
      const template = definition.surface?.template ?? definition.template
      if (template) Object.assign(description, { template })
      this.descriptions.set(binding.moduleId, immutableOperationJson(description))
      const token = kernelModules.token<object>(binding.moduleId)
      this.kernel.registerModule(
        kernelModules.define({
          manifest: {
            id: binding.moduleId,
            version: '1.0.0',
            apiVersion: KernelVersionAxes.moduleApi,
            provides: [token],
            requires: [],
            optionalRequires: [],
            permissions: [],
            isolation: 'in-process',
          },
          activate: async (context) => {
            await definition.activate?.()
            context.registerService(token, kernelModules.callable(handlers))
            return {
              dispose: async () => {
                await definition.dispose?.()
              },
            }
          },
        })
      )
      // 准备函数是显式的输入契约，注册时捕获，运行时不再读取可变定义。
      for (const [name, operation] of Object.entries(definition.operations))
        if (operation.prepare) this.preparers.set(`${binding.moduleId}/${name}`, operation.prepare)
    }
  }

  private readonly reconcilers = new Map<
    string,
    (
      invocation: PreparedInvocation,
      signal: AbortSignal
    ) => Promise<Nullable<Omit<InvocationReconciliation, 'checkedAt'>>>
  >()

  private readonly preparers = new Map<string, NonNullable<OperationDefinition['prepare']>>()

  public start(): Promise<void> {
    if (this.closing) return Promise.reject(new AppError('CLOSED', '运行时已经关闭'))
    this.started ??= this.kernel.start()
    return this.started
  }

  public list(query: ModuleQuery = {}): ModulePage {
    const offset = query.offset ?? 0
    const limit = query.limit ?? KernelTuning.modulePageSize
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new AppError('VALIDATION', '模块分页范围无效')
    const needle = (query.query ?? '').toLocaleLowerCase()
    const all = [...this.descriptions.values()]
      .filter((item) =>
        `${item.binding.moduleId} ${item.summary} ${Object.keys(item.operations).join(' ')}`
          .toLocaleLowerCase()
          .includes(needle)
      )
      .sort((a, b) => a.binding.moduleId.localeCompare(b.binding.moduleId))
    return {
      items: all.slice(offset, offset + limit).map((item) => ({
        binding: item.binding,
        summary: item.summary,
        operations: Object.keys(item.operations),
      })),
      nextOffset: offset + limit < all.length ? offset + limit : null,
    }
  }

  public describe(moduleId: string): ModuleDescription {
    const description = this.descriptions.get(moduleId)
    if (!description)
      throw new AppError('NOT_FOUND', `未挂载模块 ${moduleId}，请先查询 modules.list`)
    return description
  }

  public bind(sessionId: string, moduleId: string): ModuleBinding {
    if (this.closing || !sessionId) throw new AppError('CLOSED', '会话已经关闭或身份无效')
    const binding = this.describe(moduleId).binding
    const leases = this.leases.get(sessionId) ?? new Set<string>()
    leases.add(moduleId)
    this.leases.set(sessionId, leases)
    return binding
  }

  public release(sessionId: string, moduleId: string): void {
    this.leases.get(sessionId)?.delete(moduleId)
  }

  public invoke(call: OperationCall, signal?: AbortSignal): Promise<InvocationReceipt> {
    if (this.closing) return Promise.reject(new AppError('CLOSED', '运行时已经关闭'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? createAbortError())
    const frozen = immutableOperationJson(call)
    const id = JSON.stringify([frozen.sessionId, frozen.id])
    const key = canonicalOperationJson(frozen)
    const existing = this.dispatches.get(id)
    if (existing)
      return existing.key === key
        ? existing.promise
        : Promise.reject(new AppError('IDEMPOTENCY_CONFLICT', '同一调用号已经绑定其他请求'))
    const controller = new AbortController()
    const cancel = (): void => controller.abort(signal?.reason ?? createAbortError())
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    this.active.set(id, controller)
    this.phases.set(id, {
      id: frozen.id,
      sessionId: frozen.sessionId,
      executionId: frozen.executionId,
      moduleId: frozen.binding.moduleId,
      operation: frozen.operation,
      phase: 'start',
      cancelRequested: false,
    })
    const physical = this.dispatch(frozen, controller.signal)
    // 只取消调用方的等待。物理处理器与最终 journal.settle 继续持有资源和身份。
    const observed = awaitOperationRead(physical, controller.signal)
    this.dispatches.set(id, { key, promise: observed })
    this.inFlight.add(physical)
    void physical
      .finally(() => {
        this.inFlight.delete(physical)
        this.dispatches.delete(id)
        this.active.delete(id)
        this.phases.delete(id)
        signal?.removeEventListener('abort', cancel)
      })
      .catch(() => {
        Log.tag('ActRuntime').debug('OperationRuntime 调用未能完整结算')
      })
    return observed
  }

  private phase(call: OperationCall, phase: PendingInvocation['phase']): void {
    const id = JSON.stringify([call.sessionId, call.id])
    const prior = this.phases.get(id)
    if (prior) this.phases.set(id, { ...prior, phase })
  }

  public pending(): readonly PendingInvocation[] {
    return immutableOperationJson(
      [...this.phases].map(([id, state]) => ({
        ...state,
        cancelRequested: !!this.active.get(id)?.signal.aborted,
      }))
    )
  }

  private async dispatch(call: OperationCall, signal: AbortSignal): Promise<InvocationReceipt> {
    await this.start()
    if (signal?.aborted || this.closing) throw new AppError('CANCELLED', '调用已取消')
    const description = this.describe(call.binding.moduleId)
    if (
      canonicalOperationJson(description.binding) !== canonicalOperationJson(call.binding) ||
      !this.leases.get(call.sessionId)?.has(call.binding.moduleId)
    )
      throw new AppError('CONFLICT', '模块绑定已经失效')
    if (!call.id || !call.sessionId || !call.executionId)
      throw new AppError('VALIDATION', '调用身份不完整')
    const key = `${call.binding.moduleId}/${call.operation}`
    const validators = this.validators.get(key)
    if (!validators) throw new AppError('NOT_FOUND', `未知操作 ${call.operation}`)
    const original = immutableOperationJson(call.input)
    if (!validators.input(original))
      throw AppError.withFields(
        'INPUT_SCHEMA',
        `输入不符合 schema：${describeSchemaErrors(validators.input.errors)}`,
        { effect: 'none' }
      )
    this.phase(call, 'journal')
    const requestFingerprint = await operationFingerprint({ ...call, input: original })
    const prior = await this.journal.read(call.sessionId, call.id)
    if (prior) {
      if (prior.prepared.requestFingerprint !== requestFingerprint)
        throw new AppError('IDEMPOTENCY_CONFLICT', '同一调用号已经绑定其他请求')
      if (prior.receipt) return immutableOperationJson(prior.receipt)
      throw new AppError('CONFLICT', '调用已派发或需要恢复核对，不能自动重放')
    }
    let prepared = immutableOperationJson({
      ...call,
      input: original,
      inputFingerprint: await operationFingerprint(original),
      requestFingerprint,
    })
    const existing = await this.journal.claim(prepared)
    if (existing) {
      if (existing.prepared.requestFingerprint !== prepared.requestFingerprint)
        throw new AppError('IDEMPOTENCY_CONFLICT', '同一调用号已经绑定其他请求')
      if (existing.receipt) return immutableOperationJson(existing.receipt)
      throw new AppError('CONFLICT', '调用已派发或需要恢复核对，不能自动重放')
    }
    const reservedAt = new Date().toISOString()
    const reserved = prepared
    try {
      signal?.throwIfAborted()
      if (
        description.operations[call.operation]!.allowedModes &&
        !description.operations[call.operation]!.allowedModes!.includes(call.mode ?? 'execute')
      )
        throw new AppError('OPERATION_MODE_DENIED', '当前脚本入口不允许调用此能力')
      if (
        call.mode === 'observe' &&
        description.operations[call.operation]!.effects !== 'none' &&
        !this.observable.has(key)
      ) {
        throw new AppError(
          'OBSERVATION_EFFECT_DENIED',
          `观察脚本会每轮重跑，禁止调用 ${key}；请在一次性执行入口操作。`
        )
      }
      const prepare = this.preparers.get(key)
      this.phase(call, 'prepare')
      const input = prepare ? immutableOperationJson(await prepare(original, { signal })) : original
      signal.throwIfAborted()
      if (!validators.input(input))
        throw new AppError(
          'VALIDATION',
          `准备后的参数不符合 schema：${describeSchemaErrors(validators.input.errors)}`
        )
      prepared = immutableOperationJson({
        ...reserved,
        input,
        inputFingerprint: await operationFingerprint(input),
      })
      this.phase(call, 'beforeDispatch')
      await this.options.beforeDispatch?.(prepared, description.operations[call.operation]!, signal)
      signal.throwIfAborted()
    } catch (error) {
      Log.tag('ActRuntime').debug('OperationRuntime 已进入异常处理或降级分支')
      const receipt: InvocationReceipt = {
        invocation: reserved,
        lifecycle: { reservedAt, settledAt: new Date().toISOString() },
        outcome: signal?.aborted ? 'cancelled' : 'failed',
        effect: 'none',
        retry: 'safe',
        error: {
          code: signal?.aborted
            ? 'CANCELLED'
            : ((error as { code?: string; reason?: string })?.code ??
              (error as { reason?: string })?.reason ??
              'PREPARE_FAILED'),
          message: String(error),
        },
      }
      this.phase(call, 'settle')
      await this.settle(receipt)
      return immutableOperationJson(receipt)
    }
    this.phase(call, 'journal')
    await this.journal.prepare(prepared)
    const preparedAt = new Date().toISOString()
    const controller = new AbortController()
    const cancel = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (
      signal?.aborted ||
      this.closing ||
      !this.leases.get(call.sessionId)?.has(call.binding.moduleId)
    )
      controller.abort()
    let receipt: InvocationReceipt
    try {
      if (controller.signal.aborted) {
        receipt = {
          invocation: prepared,
          lifecycle: { reservedAt, preparedAt, settledAt: new Date().toISOString() },
          outcome: 'cancelled',
          effect: 'none',
          retry: 'safe',
          error: { code: 'CANCELLED', message: '派发前已经取消' },
        }
      } else {
        this.phase(call, 'handler')
        const result = (await this.kernel.invokeCapability({
          capabilityId: call.binding.moduleId,
          operation: call.operation,
          input: prepared,
          signal: controller.signal,
        })) as {
          value?: unknown
          startedAt: string
          observation?: InvocationReceipt['observation']
          diagnostic?: InvocationReceipt['diagnostic']
          attachments?: readonly ModelImage[]
          effect: InvocationReceipt['effect']
          error?: { code: string; message: string }
        }
        let error = result.error
        let value: unknown
        if (!error) {
          try {
            value = immutableOperationJson(result.value)
            if (!validators.output(value))
              error = {
                code: 'OUTPUT_SCHEMA',
                message: `返回值不符合 schema：${describeSchemaErrors(validators.output.errors)}`,
              }
          } catch (failure) {
            Log.tag('ActRuntime').debug('OperationRuntime 已进入异常处理或降级分支')
            error = { code: 'OUTPUT_ENCODING', message: String(failure) }
          }
        }
        receipt = {
          invocation: prepared,
          lifecycle: {
            reservedAt,
            preparedAt,
            startedAt: result.startedAt,
            settledAt: new Date().toISOString(),
          },
          outcome: error ? (controller.signal.aborted ? 'cancelled' : 'failed') : 'succeeded',
          effect: result.effect,
          retry: result.effect === 'none' ? 'safe' : 'requires-check',
        }
        if (!error && result.observation)
          Object.assign(receipt, { observation: result.observation })
        if (result.attachments?.length) Object.assign(receipt, { attachments: result.attachments })
        if (result.diagnostic) Object.assign(receipt, { diagnostic: result.diagnostic })
        if (!isUndefined(value)) Object.assign(receipt, { value })
        if (error) Object.assign(receipt, { error })
      }
      this.phase(call, 'settle')
      await this.settle(receipt)
      return immutableOperationJson(receipt)
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  public reconcile(
    sessionId: string,
    id: string,
    signal: AbortSignal = new AbortController().signal
  ): Promise<Nullable<InvocationRecord>> {
    if (this.closing) return Promise.reject(new AppError('CLOSED', '运行时已经关闭'))
    if (signal.aborted) return Promise.reject(signal.reason ?? createAbortError())
    const controller = new AbortController()
    const cancel = (): void => controller.abort(signal.reason ?? createAbortError())
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    const key = JSON.stringify([sessionId, id, 'reconcile', crypto.randomUUID()])
    this.active.set(key, controller)
    this.phases.set(key, {
      id,
      sessionId,
      executionId: '',
      moduleId: '',
      operation: 'reconcile',
      phase: 'reconcile',
      cancelRequested: false,
    })
    const physical = this.reconcileRecord(sessionId, id, controller.signal, key)
    this.inFlight.add(physical)
    void physical
      .finally(() => {
        this.inFlight.delete(physical)
        this.active.delete(key)
        this.phases.delete(key)
        signal.removeEventListener('abort', cancel)
      })
      .catch(() => {
        Log.tag('ActRuntime').debug('OperationRuntime 核对已结束')
      })
    return awaitOperationRead(physical, controller.signal)
  }

  private async reconcileRecord(
    sessionId: string,
    id: string,
    signal: AbortSignal,
    activeKey: string
  ): Promise<Nullable<InvocationRecord>> {
    signal.throwIfAborted()
    if (this.dispatches.has(JSON.stringify([sessionId, id])))
      throw new AppError('CONFLICT', '仍在执行的操作不能核对')
    const record = await this.journal.read(sessionId, id)
    if (!record || record.reconciliation || (record.receipt && record.receipt.effect !== 'unknown'))
      return record
    const { binding, operation } = record.prepared
    this.phases.set(activeKey, {
      id,
      sessionId,
      executionId: record.prepared.executionId,
      moduleId: binding.moduleId,
      operation,
      phase: 'reconcile',
      cancelRequested: signal.aborted,
    })
    if (
      canonicalOperationJson(this.describe(binding.moduleId).binding) !==
      canonicalOperationJson(binding)
    )
      throw new AppError('CONFLICT', '原模块实例已变化，不能用新实例核对旧操作')
    const reconcile = this.reconcilers.get(`${binding.moduleId}/${operation}`)
    if (!reconcile || !this.journal.recordReconciliation) return record
    const result = await reconcile(record.prepared, signal)
    signal.throwIfAborted()
    if (!result) return record
    if (
      !['none', 'committed', 'partial'].includes(result.effect) ||
      !['succeeded', 'failed'].includes(result.outcome) ||
      !isString(result.evidence) ||
      !result.evidence.trim() ||
      result.evidence.length > 16000
    )
      throw new AppError('INVARIANT', '领域核对结果无效')
    await this.journal.recordReconciliation(sessionId, id, {
      ...immutableOperationJson(result),
      checkedAt: new Date().toISOString(),
    })
    return this.journal.read(sessionId, id)
  }

  private async settle(receipt: InvocationReceipt): Promise<void> {
    try {
      await this.journal.settle(receipt)
    } catch (error) {
      // 处理器已真实结束，不能伪造持久化成功；后台失败必须在关闭时可观察。
      this.settlementFailures.push(error)
      throw error
    }
  }

  public async dispose(options: OperationRuntimeCloseOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? KernelTuning.operationCloseTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new AppError('VALIDATION', '关闭等待时限必须是非负有限数字')
    const timers = new TimerScope({ name: 'OperationRuntime.close' })
    let deadline: Optional<AbortSignal>
    try {
      await timers.withTimeout(timeoutMs, (signal) => {
        deadline = signal
        return this.drain()
      })
    } catch (error) {
      if (deadline?.aborted)
        throw AppError.withFields('TIMEOUT', '运行时仍在等待真实调用或模块资源收束', {
          pending: this.pending(),
        })
      throw error
    } finally {
      timers.dispose()
    }
  }

  public drain(): Promise<void> {
    this.closing = true
    for (const controller of this.active.values())
      controller.abort(createAbortError('运行时正在关闭'))
    this.draining ??= this.finishClose()
    return this.draining
  }

  private async finishClose(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
    await this.kernel.dispose()
    this.leases.clear()
    if (!isEmpty(this.settlementFailures))
      throw new AggregateError(
        this.settlementFailures,
        '调用回执持久化失败；保留的意图需要恢复核对'
      )
  }
}

/** 创建一份模块运行时；挂载、发现和所有调用入口共享它。 */
export function createOperationRuntime(options: OperationRuntimeOptions): OperationRuntimeApi {
  return new OperationRuntime(options)
}
