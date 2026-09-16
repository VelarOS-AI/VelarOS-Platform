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
  isUndefined,
} from '@velaros-ai/core'
import type { RemoteNodeToolDescriptor } from '@velaros-ai/kernel/contracts/protocol'

import type { RemoteNodeMcpBridgeOptions } from '../../types/connectors.js'
import { describeTool, explainFailure, log, stringifyOutput, toMcpToolName } from '../../utils/connectors/remote-node-mcp'







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




