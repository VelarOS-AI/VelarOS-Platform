import type { RemoteHostTool, RemoteHostToolContext, RemoteHostToolInput } from '../../types/connectors.js'
import { convertMcpInputSchema } from '../../utils/connectors/mcp-tool-translation'
import { isRemoteNodeClientFailure } from '../../utils/connectors/remote-node-mcp'

/**
 * 远程主机工具的翻译面：把远程节点广播的一条工具描述翻成一条标准 VelaTool。
 *
 * 无状态，由远程主机服务在同步节点清单时逐条调用；产出的工具进注册面后与本机工具走同一条执行路
 * （ToolExecutor / ApprovalPort / span / 循环守卫），不为「远程」另开一条。
 * 每次调用前都要用户确认，失败时若连接中断得原样上抛「可能已半执行」，绝不压成普通失败。
 */
export interface RemoteHostToolFactoryApi {
  /**
   * 翻一条远程工具：名字用调用方给的 canonicalName（同名工具靠它区分机器），描述里点明目标机器，
   * 只读工具给 inspect 角色并允许记住授权，其余一律 execute 且每次都问。
   */
  create(input: RemoteHostToolInput): RemoteHostTool
}

class RemoteHostToolFactory implements RemoteHostToolFactoryApi {
  public create(input: RemoteHostToolInput): RemoteHostTool {
    const { canonicalName, categoryId, hostLabel, descriptor, invoker } = input
    const summary = descriptor.description.trim()

    const tool: RemoteHostTool = {
      name: canonicalName,
      category: categoryId,
      role: descriptor.readOnly ? 'inspect' : 'execute',
      description:
        `在远程主机「${hostLabel}」上执行的工具「${descriptor.name}」（跨机调用，不作用于本机）。${summary}`,
      schema: convertMcpInputSchema(descriptor.inputSchema),
      // network = 中性 I/O 元数据，不作可见性门槛（与 MCP 工具同一处理）。
      permissions: ['network'],
      isConcurrencySafe: () => descriptor.readOnly,
      execute: async (
        rawInput: Record<string, unknown>,
        ctx: RemoteHostToolContext,
      ): Promise<unknown> => {
        const decision = await ctx.approval.awaitConfirmationDecision(
          `AI 请求在远程主机「${hostLabel}」上执行「${descriptor.name}」。是否允许？`,
          ctx.abortSignal,
          {
            approvalRisk: descriptor.readOnly ? 'low' : 'high',
            riskScope: `remote-host:${canonicalName}`,
            rememberRiskScope: descriptor.readOnly,
          },
          // 这里刻意不给 `detail`：ConfirmationRequestDetail 的规矩是「生产者与渲染分支同一批改」，
          // 只加 kind 不加渲染分支会自动回落散文。上面的 message 已经点明了目标机器与工具名。
        )
        if (!decision.approved) return {
            skipped: true,
            host: hostLabel,
            tool: descriptor.name,
            message: decision.message ?? '用户未批准该远程调用。',
          }

        try {
          return await invoker.invoke(descriptor, rawInput ?? {}, ctx.abortSignal)
        } catch (error) {
          // 「可能已半执行」必须原样上抛给模型：一次可能跑了一半的构建或代码签名，如果被压成
          // 普通失败，模型的下一步几乎必然是重试——那正是最不该自动做的动作。
          if (isRemoteNodeClientFailure(error) && error.resultUnknown) return {
              failed: true,
              resultUnknown: true,
              host: hostLabel,
              tool: descriptor.name,
              message:
                `与远程主机「${hostLabel}」的连接在调用期间中断，该操作**可能已经执行了一部分**。`
                + '重试前请先在目标机器上确认当前状态，不要假定它没有生效。',
            }
          throw error
        }
      },
    }

    return tool
  }
}

/** 宿主进程唯一的一份远程工具翻译面；无状态，任何节点的任何一条描述都从这里进来。 */
export const remoteHostToolFactory: RemoteHostToolFactoryApi = new RemoteHostToolFactory()

