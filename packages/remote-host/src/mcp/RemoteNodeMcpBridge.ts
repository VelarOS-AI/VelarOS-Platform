// 域:把一台远程能力节点投影成 MCP 服务器。
//
// ## 为什么需要这一层
// Desktop 有 Kernel,可以走 isolation:'remote' 那条能力级的路;但 Codex、Claude Code 这类
// 外部 agent 永远不会有 VelarOS Kernel,它们能说的唯一通用协议是 MCP。本层让"谁来调"这件事
// 不再影响 Host:**到 Host 仍然只有 remote-node 一条线**(一套配对认证、一份审计、一个授权核心),
// MCP 只是贴在 agent 那一侧的适配面。
//
// ## 刻意不做的事
// 不在这里加任何授权判断。放行与否由两端既有的闸决定(调用方自己的审批 + 节点的 permission
// broker);这一层多判一次,就会变成第三份谁都不认识、又谁都绕不开的影子策略。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  isPresent,
  isString,
  isUndefined,
  Log,
  stringifyPretty,
} from '@velaros-ai/core'
import type { RemoteNodeToolDescriptor } from '@velaros-ai/kernel/contracts/protocol'

import {
  RemoteNodeClient,
  RemoteNodeClientError,
} from '../client'

const log = Log.tag('RemoteNodeMcpBridge')

export interface RemoteNodeMcpBridgeOptions {
  readonly client: RemoteNodeClient
  readonly serverName?: string
  readonly serverVersion?: string
}

/**
 * MCP 工具名的合法字符面比我们的 canonical id 窄,且各家客户端宽严不一。
 *
 * 节点侧的名字可能自带冒号(`computer:screenshot`),这里压成下划线。压平是单向的,
 * 所以必须留一张反查表——不能靠再解析一次名字把它还原回去。
 */
function toMcpToolName(descriptor: RemoteNodeToolDescriptor): string {
  return descriptor.name.replaceAll(/[^a-zA-Z\d_-]/gu, '_')
}

function describeTool(
  descriptor: RemoteNodeToolDescriptor,
  nodeName: string,
): string {
  const summary = descriptor.description.trim()
  return `在远程主机「${nodeName}」上执行(跨机调用,不作用于本机)。${summary}`
}

/**
 * 把节点清单与调用面接到一个 MCP Server 上。
 *
 * 返回未连接传输的 Server;调用方自行挑 stdio / HTTP 传输并 `connect`。
 */
export function createRemoteNodeMcpServer(
  options: RemoteNodeMcpBridgeOptions,
): Server {
  const { client } = options
  const server = new Server(
    {
      name: options.serverName ?? 'velaros-remote-host',
      version: options.serverVersion ?? '0.1.0',
    },
    { capabilities: { tools: { listChanged: true } } },
  )

  // 名字压平是有损的,反查表是唯一能把 MCP 调用还原成能力路由的东西。
  let toolsByMcpName = new Map<string, RemoteNodeToolDescriptor>()

  const indexTools = (descriptors: readonly RemoteNodeToolDescriptor[]): void => {
    toolsByMcpName = new Map(
      descriptors.map((descriptor) => [toMcpToolName(descriptor), descriptor]),
    )
  }

  client.onManifestChanged((manifest) => {
    indexTools(manifest.tools)
    // 通知失败不该影响调用面:客户端顶多晚一轮拿到新目录,而抛出去会打断连接。
    void server.sendToolListChanged().catch((error: unknown) => {
      log.debug('MCP tool list change notification failed', { error })
    })
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const session = await client.connect()
    indexTools(session.manifest.tools)
    return {
      tools: session.manifest.tools.map((descriptor) => ({
        name: toMcpToolName(descriptor),
        description: describeTool(descriptor, session.node.nodeName),
        inputSchema: descriptor.inputSchema as { type: 'object' },
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const session = await client.connect()
    if (toolsByMcpName.size === 0) indexTools(session.manifest.tools)
    const descriptor = toolsByMcpName.get(request.params.name)
    if (isUndefined(descriptor)) return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: `远程主机「${session.node.nodeName}」上没有工具「${request.params.name}」。`
            + '目录可能已变化,请重新列出工具。',
        }],
      }

    try {
      const output = await client.invoke(
        {
          capabilityId: descriptor.capabilityId,
          operation: descriptor.operation,
          input: request.params.arguments ?? {},
        },
        extra.signal,
      )
      return {
        content: [{ type: 'text' as const, text: stringifyOutput(output) }],
      }
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: explainFailure(error, session.node.nodeName) }] }
    }
  })

  return server
}

/**
 * 失败文本。
 *
 * 「结果未知」必须原样穿过 MCP 边界:MCP 只有 isError 一个布尔位,如果把半执行压成普通
 * 报错,读到它的 agent 下一步几乎必然是重试——而一次可能已经跑了一半的签名或构建,重试
 * 正是最不该自动做的动作。所以这一档在文本里说死。
 */
function explainFailure(error: unknown, nodeName: string): string {
  if (error instanceof RemoteNodeClientError && error.resultUnknown) {
    return `与远程主机「${nodeName}」的连接在调用期间中断,该操作**可能已经执行了一部分**。`
      + '不要直接重试:先在目标机器上确认当前状态,再决定是否重来。'
  }
  if (error instanceof RemoteNodeClientError) {
    return isPresent(error.nodeError)
      ? `远程调用失败(${error.code}):${error.nodeError.message}`
      : `远程调用失败(${error.code}):${error.message}`
  }
  return `远程调用失败:${error instanceof Error ? error.message : String(error)}`
}

function stringifyOutput(output: unknown): string {
  if (isString(output)) return output
  try {
    return stringifyPretty(output) ?? String(output)
  } catch (error) {
    // 能力输出里混进循环引用或 BigInt 时不该把整次调用判失败:调用本身已经成功了,
    // 退回可读的字符串形式,并把序列化故障留在日志里。
    log.debug('Remote tool output could not be serialized', { error })
    return String(output)
  }
}
