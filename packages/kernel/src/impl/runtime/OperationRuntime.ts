import { Ajv, type ValidateFunction } from 'ajv'

import { KernelVersionAxes } from '../../contract/constants.js'
import type { OperationRuntimeApi } from '../../contract/provides.js'
import type { InvocationJournal, KernelCallableCapabilityOperation, OperationRuntimeOptions } from '../../contract/requires.js'
import type { ModelImage } from '../../types/model.js'
import type { InvocationReceipt, InvocationReconciliation, InvocationRecord, ModuleBinding, ModuleDescription, ModulePage, ModuleQuery, OperationCall, OperationDescriptor, PreparedInvocation } from '../../types/operations.js'
import { validateModelImages } from '../../utils/runtime/model-request.js'
import { canonicalOperationJson, immutableOperationJson, operationFingerprint, operationSchemaType, validateOperationSchema } from '../../utils/runtime/operation-schema.js'
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
  private readonly pending = new Set<Promise<InvocationReceipt>>()
  private readonly validators = new Map<string, { input: ValidateFunction; output: ValidateFunction }>()
  private readonly dispatches = new Map<string, { key: string; promise: Promise<InvocationReceipt> }>()
  private readonly observable = new Set<string>()
  private started?: Promise<void>
  private closing = false

  public constructor(private readonly options: OperationRuntimeOptions) {
    this.journal = options.journal
    const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false })
    for (const definition of options.modules) {
      const binding = immutableOperationJson(definition.binding)
      if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u.test(binding.moduleId)) throw new Error(`模块身份无效 ${binding.moduleId}`)
      if (this.descriptions.has(binding.moduleId)) throw new Error(`模块挂载歧义 ${binding.moduleId}`)
      if (!binding.instanceId || !Number.isSafeInteger(binding.generation) || binding.generation < 1 || !binding.schemaRevision) throw new Error('模块实例身份不完整')
      if (definition.surface && (definition.surface.specifier !== binding.moduleId || definition.surface.revision !== binding.schemaRevision || [...definition.surface.methods].sort().join(',') !== Object.keys(definition.operations).sort().join(','))) throw new Error('生成合同与模块挂载不一致')
      const descriptors: Record<string, OperationDescriptor> = Object.create(null)
      const handlers: Record<string, KernelCallableCapabilityOperation> = Object.create(null)
      for (const [name, operation] of Object.entries(definition.operations)) {
        if (!/^[A-Za-z_$][\w$]*$/u.test(name) || ['constructor','prototype','__proto__'].includes(name)) throw new Error(`操作名无效 ${name}`)
        const descriptor = immutableOperationJson({ summary: operation.summary, input: operation.input, output: operation.output, effects: operation.effects, ...(operation.examples ? { examples: operation.examples } : {}) })
        const generated = definition.surface?.operations[name]
        if (definition.surface && (!generated || canonicalOperationJson({input:generated.input,output:generated.output,effects:generated.effects}) !== canonicalOperationJson({input:descriptor.input,output:descriptor.output,effects:descriptor.effects}))) throw new Error('生成合同与运行时操作不一致')
        validateOperationSchema(descriptor.input)
        validateOperationSchema(descriptor.output)
        descriptors[name] = descriptor
        this.validators.set(`${binding.moduleId}/${name}`, { input: ajv.compile(descriptor.input), output: ajv.compile(descriptor.output) })
        // 处理器在 Kernel 的可调用服务中注册，宿主与脚本不会各保留一份分发器。
        const run = operation.run
        const observe = operation.observe
        if (observe) this.observable.add(`${binding.moduleId}/${name}`)
        if (operation.reconcile) this.reconcilers.set(`${binding.moduleId}/${name}`, operation.reconcile)
        handlers[name] = { metadata: { permissions: [] }, invoke: async (_scope, input, signal) => {
          const prepared = input as PreparedInvocation
          let effect: InvocationReceipt['effect'] = descriptor.effects === 'none' ? 'none' : 'unknown'
          let declaredEffect = false
          const attachments:ModelImage[]=[]
          try {
            const invoke = prepared.mode === 'observe' && observe ? observe : run
            const value = await invoke(prepared.input, { invocation: prepared, signal, attach: image => { const frozen=immutableOperationJson(image);validateModelImages([...attachments,frozen]);attachments.push(frozen) }, recordEffect: next => { effect = next; declaredEffect = true } })
            if (!declaredEffect) effect = descriptor.effects === 'none' ? 'none' : prepared.mode === 'observe' ? 'unknown' : 'committed'
            return { value, effect, attachments }
          } catch (error) {
            return { effect, attachments, error: { code: signal.aborted ? 'CANCELLED' : (error as {code?:string;reason?:string})?.code ?? (error as {reason?:string})?.reason ?? 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) } }
          }
        } }
      }
      const declarations = `declare module ${JSON.stringify(binding.moduleId)} {\n${Object.entries(descriptors).map(([name, op]) => `export function ${name}(input${op.input.type === 'null' || op.input.anyOf?.some(schema => schema.type === 'null') ? '?' : ''}: ${operationSchemaType(op.input)}): Promise<${operationSchemaType(op.output)}>;`).join('\n')}\n}`
      this.descriptions.set(binding.moduleId, immutableOperationJson({ binding, summary: definition.summary, operations: descriptors, declarations: definition.surface?.declarations ?? declarations, ...(definition.surface?.template ? {template:definition.surface.template} : {}) }))
      const token = kernelModules.token<object>(binding.moduleId)
      this.kernel.registerModule(kernelModules.define({
        manifest: { id: binding.moduleId, version: '1.0.0', apiVersion: KernelVersionAxes.moduleApi, provides: [token], requires: [], optionalRequires: [], permissions: [], isolation: 'in-process' },
        activate: async context => {
          await definition.activate?.()
          context.registerService(token, kernelModules.callable(handlers))
          return { dispose: async () => { await definition.dispose?.() } }
        },
      }))
      // 准备函数是显式的输入契约，注册时捕获，运行时不再读取可变定义。
      for (const [name, operation] of Object.entries(definition.operations)) if (operation.prepare) this.preparers.set(`${binding.moduleId}/${name}`, operation.prepare)
    }
  }

  private readonly reconcilers = new Map<string, (invocation: PreparedInvocation, signal: AbortSignal) => Promise<Omit<InvocationReconciliation, 'checkedAt'> | null>>()

  private readonly preparers = new Map<string, (input: unknown) => unknown | Promise<unknown>>()

  public start(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('运行时已经关闭'))
    this.started ??= this.kernel.start()
    return this.started
  }

  public list(query: ModuleQuery = {}): ModulePage {
    const offset = query.offset ?? 0
    const limit = query.limit ?? KernelTuning.modulePageSize
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('模块分页范围无效')
    const needle = (query.query ?? '').toLocaleLowerCase()
    const all = [...this.descriptions.values()].filter(item => `${item.binding.moduleId} ${item.summary} ${Object.keys(item.operations).join(' ')}`.toLocaleLowerCase().includes(needle)).sort((a,b) => a.binding.moduleId.localeCompare(b.binding.moduleId))
    return { items: all.slice(offset, offset + limit).map(item => ({ binding: item.binding, summary: item.summary, operations: Object.keys(item.operations) })), nextOffset: offset + limit < all.length ? offset + limit : null }
  }

  public describe(moduleId: string): ModuleDescription {
    const description = this.descriptions.get(moduleId)
    if (!description) throw new Error(`未挂载模块 ${moduleId}，请先查询 modules.list`)
    return description
  }

  public bind(sessionId: string, moduleId: string): ModuleBinding {
    if (this.closing || !sessionId) throw new Error('会话已经关闭或身份无效')
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
    const frozen = immutableOperationJson(call)
    const id = JSON.stringify([frozen.sessionId, frozen.id])
    const key = canonicalOperationJson(frozen)
    const existing = this.dispatches.get(id)
    if (existing) return existing.key === key ? existing.promise : Promise.reject(Object.assign(new Error('同一调用号已经绑定其他请求'), {code:'IDEMPOTENCY_CONFLICT'}))
    const pending = this.dispatch(frozen, signal)
    this.dispatches.set(id, { key, promise: pending })
    this.pending.add(pending)
    void pending.finally(() => { this.pending.delete(pending); this.dispatches.delete(id) }).catch(() => {})
    return pending
  }

  private async dispatch(call: OperationCall, signal?: AbortSignal): Promise<InvocationReceipt> {
    await this.start()
    if (signal?.aborted || this.closing) throw new Error('调用已取消')
    const description = this.describe(call.binding.moduleId)
    if (canonicalOperationJson(description.binding) !== canonicalOperationJson(call.binding) || !this.leases.get(call.sessionId)?.has(call.binding.moduleId)) throw new Error('模块绑定已经失效')
    if (!call.id || !call.sessionId || !call.executionId) throw new Error('调用身份不完整')
    const key = `${call.binding.moduleId}/${call.operation}`
    const validators = this.validators.get(key)
    if (!validators) throw new Error(`未知操作 ${call.operation}`)
    const original = immutableOperationJson(call.input)
    if (!validators.input(original)) throw Object.assign(new Error(`输入不符合 schema: ${JSON.stringify(validators.input.errors)}`),{code:'INPUT_SCHEMA',effect:'none'})
    const requestFingerprint = await operationFingerprint({ ...call, input: original })
    const prior = await this.journal.read(call.sessionId, call.id)
    if (prior) {
      if (prior.prepared.requestFingerprint !== requestFingerprint) throw Object.assign(new Error('同一调用号已经绑定其他请求'), {code:'IDEMPOTENCY_CONFLICT'})
      if (prior.receipt) return immutableOperationJson(prior.receipt)
      throw new Error('调用已派发或需要恢复核对，不能自动重放')
    }
    let prepared = immutableOperationJson({ ...call, input:original, inputFingerprint:await operationFingerprint(original), requestFingerprint })
    const existing = await this.journal.claim(prepared)
    if (existing) {
      if (existing.prepared.requestFingerprint !== prepared.requestFingerprint) throw Object.assign(new Error('同一调用号已经绑定其他请求'), {code:'IDEMPOTENCY_CONFLICT'})
      if (existing.receipt) return immutableOperationJson(existing.receipt)
      throw new Error('调用已派发或需要恢复核对，不能自动重放')
    }
    const reserved=prepared
    try{
      signal?.throwIfAborted()
      if (call.mode === 'observe' && description.operations[call.operation]!.effects !== 'none' && !this.observable.has(key)) {
        throw Object.assign(new Error(`观察脚本会每轮重跑，禁止调用 ${key}；请在一次性执行入口操作。`), {code:'OBSERVATION_EFFECT_DENIED'})
      }
      const prepare=this.preparers.get(key)
      const input=prepare?immutableOperationJson(await prepare(original)):original
      if(!validators.input(input))throw new Error(`准备后的参数不符合 schema: ${JSON.stringify(validators.input.errors)}`)
      prepared=immutableOperationJson({...reserved,input,inputFingerprint:await operationFingerprint(input)})
      await this.options.beforeDispatch?.(prepared, description.operations[call.operation]!, signal ?? new AbortController().signal)
    }catch(error){
      const receipt:InvocationReceipt={invocation:reserved,outcome:signal?.aborted?'cancelled':'failed',effect:'none',retry:'safe',error:{code:signal?.aborted?'CANCELLED':(error as {code?:string;reason?:string})?.code??(error as {reason?:string})?.reason??'PREPARE_FAILED',message:String(error)}}
      await this.journal.settle(receipt)
      return immutableOperationJson(receipt)
    }
    await this.journal.prepare(prepared)
    const controller = new AbortController()
    const cancel = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted || this.closing || !this.leases.get(call.sessionId)?.has(call.binding.moduleId)) controller.abort()
    const activeKey = `${call.sessionId}/${call.id}`
    this.active.set(activeKey, controller)
    let receipt: InvocationReceipt
    try {
      if (controller.signal.aborted) {
        receipt = { invocation: prepared, outcome: 'cancelled', effect: 'none', retry: 'safe', error: { code: 'CANCELLED', message: '派发前已经取消' } }
      } else {
        const result = await this.kernel.invokeCapability({ capabilityId: call.binding.moduleId, operation: call.operation, input: prepared, signal: controller.signal }) as { value?: unknown; attachments?:readonly ModelImage[]; effect: InvocationReceipt['effect']; error?: { code: string; message: string } }
        let error = result.error
        let value: unknown
        if (!error) {
          try {
            value = immutableOperationJson(result.value)
            if (!validators.output(value)) error = { code: 'OUTPUT_SCHEMA', message: `返回值不符合 schema: ${JSON.stringify(validators.output.errors)}` }
          } catch (failure) { error = { code: 'OUTPUT_ENCODING', message: String(failure) } }
        }
        receipt = { invocation: prepared, outcome: error ? (controller.signal.aborted ? 'cancelled' : 'failed') : 'succeeded', effect: result.effect, ...(result.attachments?.length ? {attachments:result.attachments} : {}), retry: result.effect === 'none' ? 'safe' : 'requires-check', ...(value !== undefined ? { value } : {}), ...(error ? { error } : {}) }
      }
      await this.journal.settle(receipt)
      return immutableOperationJson(receipt)
    } finally {
      this.active.delete(activeKey)
      signal?.removeEventListener('abort', cancel)
    }
  }

  public async reconcile(sessionId: string, id: string, signal: AbortSignal = new AbortController().signal): Promise<InvocationRecord | null> {
    signal.throwIfAborted()
    if (this.dispatches.has(JSON.stringify([sessionId,id]))) throw new Error('仍在执行的操作不能核对')
    const record = await this.journal.read(sessionId,id)
    if (!record || record.reconciliation || (record.receipt && record.receipt.effect !== 'unknown')) return record
    const { binding, operation } = record.prepared
    if (canonicalOperationJson(this.describe(binding.moduleId).binding) !== canonicalOperationJson(binding)) throw new Error('原模块实例已变化，不能用新实例核对旧操作')
    const reconcile = this.reconcilers.get(`${binding.moduleId}/${operation}`)
    if (!reconcile || !this.journal.recordReconciliation) return record
    const result = await reconcile(record.prepared, signal)
    signal.throwIfAborted()
    if (!result) return record
    if (!['none','committed','partial'].includes(result.effect) || !['succeeded','failed'].includes(result.outcome) || typeof result.evidence !== 'string' || !result.evidence.trim() || result.evidence.length > 16000) throw new Error('领域核对结果无效')
    await this.journal.recordReconciliation(sessionId,id,{...immutableOperationJson(result),checkedAt:new Date().toISOString()})
    return this.journal.read(sessionId,id)
  }

  public async dispose(): Promise<void> {
    this.closing = true
    for (const controller of this.active.values()) controller.abort()
    await Promise.allSettled([...this.pending])
    await this.kernel.dispose()
    this.leases.clear()
  }
}

/** 创建一份模块运行时；挂载、发现和所有调用入口共享它。 */
export function createOperationRuntime(options: OperationRuntimeOptions): OperationRuntimeApi {
  return new OperationRuntime(options)
}
