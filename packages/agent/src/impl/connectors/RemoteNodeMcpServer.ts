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
import type {
  RemoteNodeToolDescriptor,
} from '@velaros-ai/kernel'

import type { RemoteNodeMcpBridgeOptions } from '../../types/connectors.js'
import { describeTool, explainFailure, log, stringifyOutput, toMcpToolName } from '../../utils/connectors/remote-node-mcp'

/**
 * 一台远程节点的 MCP 适配面：把节点的工具清单与调用面接到一个 MCP Server 上。
 *
 * 由 `createRemoteNodeMcpServer` 按一个 remote-node 客户端建一份，构造时就把 `tools/list`、
 * `tools/call` 两个处理器和清单变更通知挂好。自身只持有「MCP 工具名 → 能力描述」的反查表——
 * 名字压平是有损的,没有这张表就没法把一次 MCP 调用还原成能力路由;清单每次变化即整表重建。
 * 这一层不做任何授权判断,放行与否由调用方自己的审批和节点的 permission broker 决定。
 */
export interface RemoteNodeMcpServerApi {
  /** 接好清单与调用面、但**尚未连接任何传输**的 MCP Server;调用方自行挑 stdio / HTTP 传输并 `connect`。 */
  readonly server: Server
}

class RemoteNodeMcpServer implements RemoteNodeMcpServerApi {
  public readonly server: Server
  // 名字压平是有损的,反查表是唯一能把 MCP 调用还原成能力路由的东西。
  /** MCP 工具名 → 节点能力描述;清单一变整表重建,调用时认不出名字就提示客户端重新列出工具。 */
  private toolsByMcpName = new Map<string, RemoteNodeToolDescriptor>()

  constructor(options: RemoteNodeMcpBridgeOptions) {
    const { client } = options
    this.server = new Server(
      {
        name: options.serverName ?? 'velaros-remote-host',
        version: options.serverVersion ?? '0.1.0',
      },
      { capabilities: { tools: { listChanged: true } } },
    )

    client.onManifestChanged((manifest) => {
      this.indexTools(manifest.tools)
      // 通知失败不该影响调用面:客户端顶多晚一轮拿到新目录,而抛出去会打断连接。
      void this.server.sendToolListChanged().catch((error: unknown) => {
        log.debug('MCP tool list change notification failed', { error })
      })
    })

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const session = await client.connect()
      this.indexTools(session.manifest.tools)
      return {
        tools: session.manifest.tools.map((descriptor) => ({
          name: toMcpToolName(descriptor),
          description: describeTool(descriptor, session.node.nodeName),
          inputSchema: descriptor.inputSchema as { type: 'object' },
        })),
      }
    })

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const session = await client.connect()
      if (this.toolsByMcpName.size === 0) this.indexTools(session.manifest.tools)
      const descriptor = this.toolsByMcpName.get(request.params.name)
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
  }

  /** 按节点最新清单重建反查表;整表替换而不是增量合并,下线的工具不会留在表里被继续调到。 */
  private indexTools(descriptors: readonly RemoteNodeToolDescriptor[]): void {
    this.toolsByMcpName = new Map(
      descriptors.map((descriptor) => [toMcpToolName(descriptor), descriptor]),
    )
  }
}

/**
 * 把节点清单与调用面接到一个 MCP Server 上。
 *
 * 返回未连接传输的 Server;调用方自行挑 stdio / HTTP 传输并 `connect`。
 */
export function createRemoteNodeMcpServer(
  options: RemoteNodeMcpBridgeOptions,
): Server {
  return new RemoteNodeMcpServer(options).server
}
