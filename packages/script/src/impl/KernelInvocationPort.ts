import { isNull, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModuleBinding, OperationRuntimeApi } from '@velaros-ai/kernel'

import type {
  CodeCapabilityCall,
  CodeCapabilityOutcome,
  CodeCapabilityPort,
  KernelScriptSessionOptions,
} from '../contract/requires.js'
import { shapeOperationFailure } from '../utils/capability-failure.js'

export class KernelInvocationPort implements CodeCapabilityPort {
  private readonly bindings = new Map<string, ModuleBinding>()
  private readonly operations: Readonly<Record<string, readonly string[]>>
  private readonly runtime: OperationRuntimeApi
  private readonly sessionId: string
  private readonly executionId: string
  private calls = 0
  private readonly mode: 'execute' | 'observe'

  public constructor(options: KernelScriptSessionOptions, imported: ReadonlySet<string>) {
    this.mode = options.mode ?? 'execute'
    this.runtime = options.runtime
    this.sessionId = options.sessionId
    this.executionId = options.executionId
    const operations: Record<string, readonly string[]> = Object.create(null)
    let offset: Nullable<number> = 0
    while (!isNull(offset)) {
      const page = this.runtime.list({ offset })
      for (const item of page.items) {
        const id = item.binding.moduleId
        if (!imported.has(id)) continue
        if (options.allowedModules && !options.allowedModules.includes(id)) continue
        this.bindings.set(id, this.runtime.bind(this.sessionId, id))
        operations[id] = Object.freeze([...item.operations])
      }
      offset = page.nextOffset
    }
    this.operations = Object.freeze(operations)
  }

  public listOperations(): Readonly<Record<string, readonly string[]>> {
    return this.operations
  }

  public async invoke(
    call: CodeCapabilityCall,
    signal?: AbortSignal
  ): Promise<CodeCapabilityOutcome> {
    try {
      const binding = this.bindings.get(call.namespace)
      if (!binding) throw new AppError('NOT_FOUND', `本次程序没有模块绑定 ${call.namespace}`)
      const receipt = await this.runtime.invoke(
        {
          mode: this.mode,
          id: `${this.executionId}:${++this.calls}`,
          sessionId: this.sessionId,
          executionId: this.executionId,
          binding,
          operation: call.operation,
          input: toNullable(call.input),
        },
        signal
      )
      return receipt.error
        ? {
            attachments: receipt.attachments,
            error: {
              code: receipt.error.code,
              message: `${receipt.error.message}（调用 ${receipt.invocation.id}，效果 ${receipt.effect}）`,
            },
          }
        : { value: receipt.value, attachments: receipt.attachments }
    } catch (error) {
      return { error: shapeOperationFailure(error) }
    }
  }
}
