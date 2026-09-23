/** 脚本的操作表在 Kernel 登记，全部调用经过同一个能力调用器。 */
import { isEmpty } from '@velaros-ai/core'
import type { KernelApi } from '@velaros-ai/kernel'
import { createKernel, kernelModules, KernelVersionAxes } from '@velaros-ai/kernel'

import type {
  CodeCapabilityCall,
  CodeCapabilityOutcome,
  CodeCapabilityPort,
} from '../contract/requires.js'
import type { CapabilityOperationTable } from '../types/operations.js'
import type { CodeAttachment } from '../types/outcome.js'
import { shapeOperationFailure } from '../utils/capability-failure.js'

class CapabilityOperationPort implements CodeCapabilityPort {
  private readonly kernel: KernelApi
  private readonly operations: Readonly<Record<string, readonly string[]>>

  public constructor(table: CapabilityOperationTable) {
    this.kernel = createKernel()
    this.operations = Object.freeze(
      Object.fromEntries(
        Object.entries(table).map(([namespace, operations]) => [
          namespace,
          Object.freeze(Object.keys(operations)),
        ])
      )
    )
    for (const [namespace, operations] of Object.entries(table)) {
      const token = kernelModules.token(`velaros.script.${namespace}`)
      const callable = kernelModules.callable(
        Object.fromEntries(
          Object.entries(operations).map(([name, operation]) => [
            name,
            {
              metadata: { permissions: [] },
              invoke: async (_scope, input, signal): Promise<CodeCapabilityOutcome> => {
                const attachments: CodeAttachment[] = []
                const value = await operation(input, {
                  signal,
                  attach: (attachment) => attachments.push(attachment),
                })
                return !isEmpty(attachments) ? { value, attachments } : { value }
              },
            },
          ])
        )
      )
      this.kernel.registerModule(
        kernelModules.define({
          manifest: {
            id: token.id,
            version: token.version,
            apiVersion: KernelVersionAxes.moduleApi,
            provides: [token],
            requires: [],
            optionalRequires: [],
            permissions: [],
            isolation: 'in-process',
          },
          activate: (context) => {
            context.registerService(token, callable)
          },
        })
      )
    }
  }

  public listOperations(): Readonly<Record<string, readonly string[]>> {
    return this.operations
  }

  public async invoke(
    call: CodeCapabilityCall,
    signal?: AbortSignal
  ): Promise<CodeCapabilityOutcome> {
    try {
      await this.kernel.start()
      return (await this.kernel.invokeCapability({
        capabilityId: `velaros.script.${call.namespace}`,
        operation: call.operation,
        input: call.input,
        signal: signal ?? new AbortController().signal,
      })) as CodeCapabilityOutcome
    } catch (cause) {
      return { error: shapeOperationFailure(cause) }
    }
  }
}

/** 挂载脚本操作到 Kernel；领域参数和危险命令判断由操作自身负责。 */
export function createCapabilityPort(table: CapabilityOperationTable): CodeCapabilityPort {
  return new CapabilityOperationPort(table)
}
