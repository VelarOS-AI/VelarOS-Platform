import { convertMcpInputSchema } from '@velaros-ai/agent'
import type {
  ApprovalPort,
  ToolContractRuntimeSpec,
} from '@velaros-ai/agent/tool-contract'
import type { RemoteNodeToolDescriptor } from '@velaros-ai/kernel/contracts/protocol'
import { RemoteNodeClientError } from '@velaros-ai/kernel/remote/client'

/**
 * 本包用到的最小工具上下文。
 *
 * 只声明真正读到的两格:审批端口与中止信号。宿主的完整 ToolContext 比这宽得多,但把它整个
 * 拉进来等于让本包认识宿主——逆变兼容让窄上下文在宿主注册面上装配无摩擦。
 */
export interface RemoteHostToolContext {
  readonly abortSignal: AbortSignal
  readonly approval: ApprovalPort
}

/** 与宿主工具形状同构;宿主注册面按结构消费,不需要认识本包。 */
export type RemoteHostTool = ToolContractRuntimeSpec<
  Record<string, unknown>,
  RemoteHostToolContext
>

/** 一次远端调用的最小执行面；由 RemoteHostService 绑定到具体节点的 client。 */
export interface RemoteHostToolInvoker {
  invoke(
    descriptor: RemoteNodeToolDescriptor,
    input: Record<string, unknown>,
    signal: LooseOptional<AbortSignal>,
  ): Promise<unknown>
}

export interface RemoteHostToolInput {
  readonly canonicalName: string
  readonly hostLabel: string
  /** 已由装配层收窄过的类别归属；无类别的描述符在投影时就被拒了，不会走到这里。 */
  readonly categoryId: string
  readonly descriptor: RemoteNodeToolDescriptor
  readonly invoker: RemoteHostToolInvoker
}

/**
 * 把节点广播的一条工具描述翻成标准 VelaTool。
 *
 * 走的是与 MCP 工具同一条路：进注册面即继承 ToolExecutor / ApprovalPort / span / 循环守卫，
 * 不为"远程"另开执行路（宪章 §15 原则二：能力进入产品只有主干一条路）。
 *
 * 描述里写明**目标机器**是必需的而非装饰：模型看到两份 `run_command` 时，唯一能区分"这条在
 * 哪台机器上执行"的线索就是名字和描述，选错机器的后果是在错误的主机上跑构建或删文件。
 */
export function createRemoteHostTool(input: RemoteHostToolInput): RemoteHostTool {
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
        if (error instanceof RemoteNodeClientError && error.resultUnknown) return {
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
