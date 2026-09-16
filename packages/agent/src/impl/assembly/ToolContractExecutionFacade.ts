// Node Host 面：Agent 工具契约目录、租约与单调用执行的唯一实现。
import { createHash } from 'node:crypto'

import { isNull } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { DescribeToolSchemaResponse, LeaseDeniedResponse, ToolCatalogEntry, ToolDescriptor as RegistryToolDescriptor, VelarToolCallEnvelope, VelarToolResultEnvelope } from '../../types/agent.js'
import type { ToolContractExecutionBinding,ToolContractExecutionContext, ToolContractExecutionRegistry } from '../../types/execution.js'
import type { ToolExecutionPolicyRegistry, ToolExecutorEvents } from '../../types/tools.js'
import { resolveToolReadOnly } from '../../utils/toolkit/define-tool-contract'
import { ToolContractDiscoveryDescriptors } from '../../utils/toolkit/discovery'
import { normalizeSchema } from '../../utils/toolkit/schema-bundle'
import { buildExecutionFailureResult } from '../../utils/tools/execution-policy-failures'
import { ToolCatalogDiscoveryToolName, ToolSchemaDiscoveryToolName } from '../../utils/wire/lease'
import { buildLeaseDeniedResponse, buildToolCatalogSnapshot, buildToolContractBaseEnvelope, buildToolContractResultEnvelope, buildToolContractSuccessEnvelope, buildToolSchemaDiscoveryEnvelope } from '../../utils/wire/tool-contract-envelopes'
import { ToolExecutionPolicy } from '../tools/ToolExecutionPolicy'
import { ToolExecutor } from '../tools/ToolExecutor'

/**
 * Agent tool contract 的无状态 Node Host 门面：外部进程（CLI、remote host）经它看目录、读 schema、跑一次工具。
 *
 * 固定顺序是安全契约：先校验 catalog revision，再处理发现工具，再校验当前目录成员，最后经标准
 * ToolExecutionPolicy / ToolExecutor 派发；Host 不能重排或绕过其中任何一层。门面自己不存状态，
 * 每次调用所需的工具上下文、允许名单与投影都由入参里的 binding 带进来。
 */
export interface ToolContractExecutionFacadeApi<
  TContext extends ToolContractExecutionContext,
> {
  /**
   * 解析这份 binding 此刻能看到的工具目录（含两条常驻自恢复工具），并按协议固定算法算出不透明 revision。
   * `options.readOnly` 为真时只留只读工具。revision 变了就说明目录漂移，旧租约必须重新取目录。
   */
  resolveCatalog(
    binding: ToolContractExecutionBinding<TContext>,
    options: { readOnly: boolean },
  ): {
    /** 本次投影后的工具条目，按工具名排序；发现工具固定排在最前。 */
    tools: ToolCatalogEntry[]
    /** 这份目录内容的指纹，作为租约凭据；工具集合或 schema 一变它就变。 */
    catalogRevision: string
  }
  /** 按精确工具名读一条目录条目及其入参 schema；当前目录里没有这个名字就返回 null。模型 schema 漂移后的恢复路径。 */
  describeToolSchema(
    binding: ToolContractExecutionBinding<TContext>,
    name: string,
    options: { readOnly: boolean },
  ): Nullable<DescribeToolSchemaResponse>
  /**
   * 跑一次工具调用：先比对信封里的 catalogRevision，对不上直接 lease-denied（`stale-revision`）；
   * 两条发现工具就地答复；目录里没有这个工具名同样 lease-denied（`out-of-scope`）；其余交给标准执行链。
   * 工具自身失败不抛，折成 status 为 `error` / `denied` 的结果信封返回，`onProgress` 逐段收流式输出。
   */
  executeTool(
    binding: ToolContractExecutionBinding<TContext>,
    envelope: VelarToolCallEnvelope,
    options: {
      /** 为真时这次租约只允许只读工具，写工具连目录都看不到。 */
      readOnly: boolean
      /** 工具的流式输出逐段回调，用于把进度推给远端调用方。 */
      onProgress: (chunk: string) => void
    },
  ): Promise<VelarToolResultEnvelope | LeaseDeniedResponse>
}

export class ToolContractExecutionFacade<
  TContext extends ToolContractExecutionContext,
> implements ToolContractExecutionFacadeApi<TContext> {
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

    if (envelope.catalogRevision !== catalogRevision) return buildLeaseDeniedResponse('stale-revision', envelope.contractId, catalogRevision)
    if (envelope.toolName === ToolCatalogDiscoveryToolName) return buildToolContractSuccessEnvelope(
        envelope,
        catalogRevision,
        buildToolCatalogSnapshot(tools, catalogRevision),
      )
    if (envelope.toolName === ToolSchemaDiscoveryToolName) return buildToolSchemaDiscoveryEnvelope(envelope, tools, catalogRevision)

    const descriptor = tools.find((tool) => tool.name === envelope.toolName)
    if (!descriptor) return buildLeaseDeniedResponse('out-of-scope', envelope.contractId, catalogRevision)
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
      .filter((tool) => !readOnly || resolveToolReadOnly(tool))
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
      // effectKind 是行为真值；旧工具没有 capability 元数据时才回退 role。
      readOnly: resolveToolReadOnly(tool),
    }
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
        return buildToolContractResultEnvelope(envelope, catalogRevision, result)
      })
    } catch (error) {
      const appError = AppError.from(error)
      return {
        ...buildToolContractBaseEnvelope(envelope, catalogRevision),
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

}
