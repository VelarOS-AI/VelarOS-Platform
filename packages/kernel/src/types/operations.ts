import type { ModelImage } from './model.js'

/** 可序列化的模块 schema；采用 JSON Schema draft-07 的明确子集。 */
export interface OperationSchema {
  readonly $ref?: string
  readonly definitions?: Readonly<Record<string, OperationSchema>>
  readonly not?: OperationSchema
  readonly type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  readonly description?: string
  readonly properties?: Readonly<Record<string, OperationSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | OperationSchema
  readonly items?: OperationSchema | readonly OperationSchema[]
  readonly additionalItems?: boolean
  readonly enum?: readonly (string | number | boolean | null)[]
  readonly const?: string | number | boolean | null
  readonly anyOf?: readonly OperationSchema[]
  readonly minimum?: number
  readonly maximum?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly minItems?: number
  readonly maxItems?: number
}

/** 从领域 TypeScript 接口生成的同一操作合同；宿主参数不属于模型输入。 */
export interface OperationSurface {
  readonly specifier: string
  readonly namespace: string
  readonly methods: readonly string[]
  readonly declarations: string
  readonly template: string
  readonly revision: string
  readonly operations: Readonly<Record<string, OperationDescriptor & { readonly hasInput: boolean }>>
}

/** 挂载实例的不可变身份；作用域由宿主选定。 */
export interface ModuleBinding {
  readonly moduleId: string
  readonly instanceId: string
  readonly generation: number
  readonly schemaRevision: string
}

/** 不包含处理器的公开操作契约。 */
export interface OperationDescriptor {
  readonly summary: string
  readonly input: OperationSchema
  readonly output: OperationSchema
  readonly effects: 'none' | 'write'
  readonly examples?: readonly unknown[]
}

/** 发现结果与脚本声明的唯一来源。 */
export interface ModuleDescription {
  readonly template?: string
  readonly binding: ModuleBinding
  readonly summary: string
  readonly operations: Readonly<Record<string, OperationDescriptor>>
  readonly declarations: string
}

/** 简短模块发现卡片。 */
export interface ModuleCard {
  readonly binding: ModuleBinding
  readonly summary: string
  readonly operations: readonly string[]
}

/** 模块发现的有界分页条件。 */
export interface ModuleQuery { readonly query?: string; readonly offset?: number; readonly limit?: number }

/** 模块发现的一页结果。 */
export interface ModulePage { readonly items: readonly ModuleCard[]; readonly nextOffset: number | null }

/** 参数在准备阶段固定，处理器与持久记录使用同一份。 */
export interface PreparedInvocation {
  /** 由宿主执行口签发，脚本参数不能提升该模式。 */
  readonly mode?: 'execute' | 'observe'
  readonly id: string
  readonly sessionId: string
  readonly executionId: string
  readonly binding: ModuleBinding
  readonly operation: string
  readonly input: unknown
  readonly inputFingerprint: string
  readonly requestFingerprint: string
}

/** 最终结果与外部效果独立记录。 */
export interface InvocationReceipt {
  readonly invocation: PreparedInvocation
  readonly outcome: 'succeeded' | 'failed' | 'cancelled'
  readonly effect: 'none' | 'committed' | 'partial' | 'unknown'
  readonly retry: 'safe' | 'requires-check' | 'never'
  /** 能力产生的图像与返回值独立保存。 */
  readonly attachments?: readonly ModelImage[]
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

/** 有意图却没有终态时，恢复者必须核对真实效果。 */
/** 领域只读核对得到的追加事实，原始回执保持不变。 */
export interface InvocationReconciliation {
  readonly outcome: 'succeeded' | 'failed'
  readonly effect: 'none' | 'committed' | 'partial'
  readonly evidence: string
  readonly checkedAt: string
}
export interface InvocationRecord {
  readonly reconciliation?: InvocationReconciliation
  readonly phase: 'reserved' | 'prepared' | 'settled'
  readonly prepared: PreparedInvocation
  readonly receipt?: InvocationReceipt
}

/** 一次调用的宿主身份与稳定调用号。 */
export interface OperationCall {
  /** 本次脚本的宿主执行模式。 */
  readonly mode?: 'execute' | 'observe'
  readonly id: string
  readonly sessionId: string
  readonly executionId: string
  readonly binding: ModuleBinding
  readonly operation: string
  readonly input: unknown
}
