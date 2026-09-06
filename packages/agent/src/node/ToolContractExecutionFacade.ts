// Node Host 面：Agent 工具契约目录、租约与单调用执行的唯一实现。
import { createHash } from 'node:crypto'

import { isEmpty, isNull, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { resolveToolReadOnly } from '../tool-contract/define'
import { readToolSchemaDiscoveryNames, ToolContractDiscoveryDescriptors } from '../tool-contract/discovery'
export { ToolContractDiscoveryDescriptors } from '../tool-contract/discovery'

import type { ToolDescriptor as RegistryToolDescriptor } from '../protocol'
import {
  AgentProtocolVersion,
  type DescribeToolSchemaResponse,
  type HostProjection,
  type LeaseDenialReason,
  type LeaseDeniedResponse,
  ToolCatalogDiscoveryToolName,
  type ToolCatalogEntry,
  type ToolCatalogSnapshot,
  ToolSchemaDiscoveryToolName,
  type VelarToolCallEnvelope,
  type VelarToolResultEnvelope,
} from '../protocol'
import {
  ToolExecutionPolicy,
  type ToolExecutionPolicyContext,
  type ToolExecutionPolicyRegistry,
} from '../tools/ExecutionPolicy'
import { buildExecutionFailureResult } from '../tools/ExecutionPolicyFailures'
import {
  ToolExecutor,
  type ToolExecutorEvents,
  type ToolResult,
} from '../tools/Executor'

export interface ToolContractExecutionContext extends ToolExecutionPolicyContext {
  setCurrentVisibleToolNames(toolNames: string[]): void
  setCurrentVisibleToolRegistrationSignatures?(
    signatures: Record<string, string>,
  ): void
}

export interface ToolContractCatalogRegistry<TContext extends ToolContractExecutionContext> {
  listAvailable(
    context: TContext,
    allowList?: string[],
  ): RegistryToolDescriptor[]
  describeToolInputSchema(
    context: TContext,
    toolName: string,
  ): Nullable<{ description: string; schema: unknown }>
  getRegistrationSignature(toolName: string): Nullable<string>
}

export type ToolContractExecutionRegistry<TContext extends ToolContractExecutionContext> =
  Omit<ToolExecutionPolicyRegistry, 'listAvailable'> & ToolContractCatalogRegistry<TContext>

/**
 * Host 组装的每会话工具契约绑定。
 *
 * Agent 对会话状态零所有权：Host 注入上下文、可见工具与 session scope；目录租约、schema
 * 自恢复、安全校验顺序和结果信封由本门面统一拥有。
 */
export interface ToolContractExecutionBinding<TContext extends ToolContractExecutionContext> {
  readonly toolContext: TContext
  readonly allowedToolNames: string[]
  readonly hostProjection: HostProjection
  readonly projectDescriptor: (descriptor: ToolCatalogEntry) => ToolCatalogEntry
  readonly runInSessionScope: <T>(run: () => Promise<T>) => Promise<T>
}

function normalizeSchema(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

/**
 * Agent tool contract 的无状态 Node Host 门面。
 *
 * 固定顺序是安全契约：先校验 catalog revision，再处理发现工具，再校验当前目录成员，最后
 * 经标准 ToolExecutionPolicy / ToolExecutor 派发。Host 不能重排或绕过其中任何一层。
 */
export class ToolContractExecutionFacade<
  TContext extends ToolContractExecutionContext,
> {
  public constructor(
    private readonly toolRegistry: ToolContractExecutionRegistry<TContext>,
  ) {}

  /** 解析投影后的可见工具目录，并按协议固定算法计算不透明 revision。 */
  public resolveCatalog(
    binding: ToolContractExecutionBinding<TContext>,
    options: { readOnly: boolean },
  ): { tools: ToolCatalogEntry[]; catalogRevision: string } {
    const tools = this.listCatalogDescriptors(binding, options.readOnly)
    const catalogRevision = createHash('sha256')
      .update(JSON.stringify(tools))
      .digest('base64url')
      .slice(0, 20)
    return { tools, catalogRevision }
  }

  public describeToolSchema(
    binding: ToolContractExecutionBinding<TContext>,
    name: string,
    options: { readOnly: boolean },
  ): Nullable<DescribeToolSchemaResponse> {
    const { tools, catalogRevision } = this.resolveCatalog(binding, options)
    const tool = tools.find((descriptor) => descriptor.name === name)
    return tool ? { tool, catalogRevision } : null
  }

  public async executeTool(
    binding: ToolContractExecutionBinding<TContext>,
    envelope: VelarToolCallEnvelope,
    options: { readOnly: boolean; onProgress: (chunk: string) => void },
  ): Promise<VelarToolResultEnvelope | LeaseDeniedResponse> {
    const { tools, catalogRevision } = this.resolveCatalog(binding, options)

    if (envelope.catalogRevision !== catalogRevision) return this.leaseDenied('stale-revision', envelope.contractId, catalogRevision)
    if (envelope.toolName === ToolCatalogDiscoveryToolName) return this.successEnvelope(
        envelope,
        catalogRevision,
        this.catalogSnapshot(tools, catalogRevision),
      )
    if (envelope.toolName === ToolSchemaDiscoveryToolName) return this.describeSchemasResult(envelope, tools, catalogRevision)

    const descriptor = tools.find((tool) => tool.name === envelope.toolName)
    if (!descriptor) return this.leaseDenied('out-of-scope', envelope.contractId, catalogRevision)
    return this.dispatchTool(binding, envelope, tools, catalogRevision, options.onProgress)
  }

  private listCatalogDescriptors(
    binding: ToolContractExecutionBinding<TContext>,
    readOnly: boolean,
  ): ToolCatalogEntry[] {
    const excluded = new Set(binding.hostProjection.excludeToolNames ?? [])
    const includeCategories = binding.hostProjection.includeCategories
    const tools = this.toolRegistry
      .listAvailable(binding.toolContext, binding.allowedToolNames)
      .filter((tool) => !excluded.has(tool.name))
      .filter(
        (tool) => isNull(includeCategories) || includeCategories.includes(tool.categoryId),
      )
      .filter((tool) => !readOnly || this.isReadOnlyDescriptor(tool))
      .map((tool) => binding.projectDescriptor(
        this.buildRawDescriptor(binding.toolContext, tool),
      ))
      .sort((left, right) => left.name.localeCompare(right.name))
    return [...ToolContractDiscoveryDescriptors, ...tools]
  }

  private buildRawDescriptor(
    context: TContext,
    tool: RegistryToolDescriptor,
  ): ToolCatalogEntry {
    const schema = this.toolRegistry.describeToolInputSchema(context, tool.name)
    return {
      name: tool.name,
      description: schema?.description ?? tool.description,
      inputSchema: normalizeSchema(schema?.schema),
      category: tool.categoryId,
      readOnly: this.isReadOnlyDescriptor(tool),
    }
  }

  /** effectKind 是行为真值；旧工具没有 capability 元数据时才回退 role。 */
  private isReadOnlyDescriptor(tool: RegistryToolDescriptor): boolean {
    return resolveToolReadOnly(tool)
  }

  private describeSchemasResult(
    envelope: VelarToolCallEnvelope,
    tools: ToolCatalogEntry[],
    catalogRevision: string,
  ): VelarToolResultEnvelope {
    const names = readToolSchemaDiscoveryNames(envelope.input)
    if (isEmpty(names)) return this.errorEnvelope(
        envelope,
        catalogRevision,
        'names 必须包含 1 到 12 个工具名。',
      )
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    return this.successEnvelope(envelope, catalogRevision, {
      catalogRevision,
      tools: names.flatMap((name) => {
        const descriptor = byName.get(name)
        return descriptor ? [descriptor] : []
      }),
      missing: names.filter((name) => !byName.has(name)),
    })
  }

  private async dispatchTool(
    binding: ToolContractExecutionBinding<TContext>,
    envelope: VelarToolCallEnvelope,
    tools: ToolCatalogEntry[],
    catalogRevision: string,
    onProgress: (chunk: string) => void,
  ): Promise<VelarToolResultEnvelope> {
    this.applyVisibleTools(binding.toolContext, tools)
    try {
      return await binding.runInSessionScope(async () => {
        const executionPolicy = new ToolExecutionPolicy(
          this.toolRegistry as ToolExecutionPolicyRegistry,
        )
        const events: ToolExecutorEvents = {
          emitRuntime: () => undefined,
          emitNotice: () => undefined,
          emitToolStart: () => undefined,
          emitToolProgress: (payload) => onProgress(payload.chunk),
          emitToolMetadata: () => undefined,
          emitToolDone: () => undefined,
        }
        const executor = new ToolExecutor(binding.toolContext, events, executionPolicy)
        executor.enqueue(
          envelope.toolCallId,
          envelope.toolName,
          envelope.input,
          executionPolicy.resolveConcurrencySafe(envelope.toolName, envelope.input),
        )
        const [result] = await executor.collectAll()
        if (!result) {
          throw new AppError('INVARIANT', `工具 ${envelope.toolName} 没有返回执行结果。`)
        }
        return this.toResultEnvelope(envelope, catalogRevision, result)
      })
    } catch (error) {
      const appError = AppError.from(error)
      return {
        ...this.baseEnvelope(envelope, catalogRevision),
        status: buildExecutionFailureResult(envelope.toolName, appError).error === 'tool_denied'
          ? 'denied'
          : 'error',
        error: appError.message,
      }
    }
  }

  private applyVisibleTools(context: TContext, tools: ToolCatalogEntry[]): void {
    context.setCurrentVisibleToolNames(
      tools
        .map((tool) => tool.name)
        .filter(
          (name) => name !== ToolCatalogDiscoveryToolName
            && name !== ToolSchemaDiscoveryToolName,
        ),
    )
    context.setCurrentVisibleToolRegistrationSignatures?.(
      Object.fromEntries(
        tools.flatMap((tool) => {
          const signature = this.toolRegistry.getRegistrationSignature(tool.name)
          return signature ? [[tool.name, signature]] : []
        }),
      ),
    )
  }

  private toResultEnvelope(
    envelope: VelarToolCallEnvelope,
    catalogRevision: string,
    result: ToolResult,
  ): VelarToolResultEnvelope {
    const base = this.baseEnvelope(envelope, catalogRevision)
    if (result.error) return {
        ...base,
        status: isPlainObject(result.result) && result.result.error === 'tool_denied' ? 'denied' : 'error',
        error: result.error,
        output: result.modelResult ?? result.result,
      }
    return { ...base, status: 'success', output: result.modelResult ?? result.result }
  }

  private catalogSnapshot(
    tools: ToolCatalogEntry[],
    catalogRevision: string,
  ): ToolCatalogSnapshot {
    return { protocolVersion: AgentProtocolVersion, catalogRevision, tools }
  }

  private baseEnvelope(
    envelope: VelarToolCallEnvelope,
    catalogRevision: string,
  ): Pick<
    VelarToolResultEnvelope,
    'protocolVersion' | 'contractId' | 'catalogRevision' | 'toolCallId' | 'toolName'
  > {
    return {
      protocolVersion: AgentProtocolVersion,
      contractId: envelope.contractId,
      catalogRevision,
      toolCallId: envelope.toolCallId,
      toolName: envelope.toolName,
    }
  }

  private successEnvelope(
    envelope: VelarToolCallEnvelope,
    catalogRevision: string,
    output: unknown,
  ): VelarToolResultEnvelope {
    return { ...this.baseEnvelope(envelope, catalogRevision), status: 'success', output }
  }

  private errorEnvelope(
    envelope: VelarToolCallEnvelope,
    catalogRevision: string,
    error: string,
  ): VelarToolResultEnvelope {
    return { ...this.baseEnvelope(envelope, catalogRevision), status: 'error', error }
  }

  private leaseDenied(
    reason: LeaseDenialReason,
    contractId: string,
    latestCatalogRevision: string,
  ): LeaseDeniedResponse {
    return {
      protocolVersion: AgentProtocolVersion,
      status: 'lease-denied',
      reason,
      contractId,
      latestCatalogRevision,
    }
  }
}
