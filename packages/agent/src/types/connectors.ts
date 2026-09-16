/**
 * 一台已登记的远程能力节点。
 *
 * `url` 指向目标机器上 `termel serve` 暴露的节点地址。**建议只填私有覆盖网(Tailscale /
 * WireGuard)地址**:本传输在应用层做设备密钥认证,但不自建 TLS,网络层加密与隔离由覆盖网承担。
 */
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import type { RemoteNodeManifest,RemoteNodeToolDescriptor } from '@velaros-ai/kernel/contracts/protocol'
import type { RemoteNodeClient } from '@velaros-ai/kernel/remote/client'

import type { ApprovalPort } from '../contract/requires.js'
import type { McpClientConnection } from '../impl/connectors/McpClientConnection.js'
import type { createRemoteHostTool } from '../impl/connectors/RemoteHostToolFactory.js'

import type { ToolCategoryId, ToolResultModelContentPart } from './agent.js'
import type { VelaTool } from './builtin.js'
import type { ToolContractRuntimeSpec } from './toolkit.js'

export interface RemoteHostDefinition {
  readonly id: string
  readonly label: string
  readonly url: string
  readonly enabled: boolean
}

/** 连接态投影,供设置页展示。刻意不含任何密钥材料。 */
export interface RemoteHostStatus {
  readonly id: string
  readonly label: string
  readonly connected: boolean
  readonly paired: boolean
  readonly nodeName: Nullable<string>
  readonly toolCount: number
  readonly lastError: Nullable<string>
}

export interface RemoteNodeMcpBridgeOptions {
  readonly client: RemoteNodeClient
  readonly serverName?: string
  readonly serverVersion?: string
}

export interface SafeFetchOptions {
  lookupIpAddresses?: (hostname: string) => Promise<readonly string[]>
}

export type McpTransportKind = 'stdio' | 'http' | 'sse' | 'auto'

/** host 无关的 MCP 连接规格；enabled/autoApprove/retry 等宿主策略不在此层。 */
export interface McpConnectionSpec {
  /** 缺省保持历史行为：stdio。auto 按 Streamable HTTP -> SSE 回退。 */
  transport?: McpTransportKind
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  cwd: Nullable<string>
  url?: LooseOptional<string>
  headers?: Readonly<Record<string, string>>
  authProvider?: OAuthClientProvider
  client?: {
    readonly name: string
    readonly version: string
  }
}

/** MCP 工具行为提示（annotations），用于推断 riskClass/角色/并发安全。 */
export interface McpToolAnnotations {
  title: Nullable<string>
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
}

/** 从 MCP server 列出的单个工具描述符（已在边界解析成受控形状）。 */
export interface McpToolDescriptor {
  name: string
  description: Nullable<string>
  /** JSON Schema（MCP inputSchema，type:'object'）；翻译层经 z.fromJSONSchema 转 zod。 */
  inputSchema: Record<string, unknown>
  annotations: McpToolAnnotations
}

export interface McpResourceDescriptor {
  uri: string
  name: string
  description: Nullable<string>
  mimeType: Nullable<string>
}

export interface McpResourceContent {
  uri: string
  mimeType: Nullable<string>
  text: Nullable<string>
  blob: Nullable<string>
}

/** MCP callTool 的原始返回（SDK result 对象）；结果翻译在 mcpCallResult.ts。 */
export type McpRawCallResult = Record<string, unknown>

export type McpRemoteTransport = SSEClientTransport | StreamableHTTPClientTransport

export interface McpPendingAuthorization {
  readonly client: Client
  readonly transport: McpRemoteTransport
}

export interface McpPendingConnection {
  controller: AbortController
  client: Nullable<Client>
  transport: Nullable<Transport>
  promise: Promise<void>
}

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

/** 一条已投影好的工具贡献；宿主按结构注册,不需要认识本包的任何类型。 */
export interface RemoteHostToolEntry {
  readonly name: string
  readonly categoryId: string
  readonly tool: ReturnType<typeof createRemoteHostTool>
}

export interface ConnectedHost {
  readonly definition: RemoteHostDefinition
  readonly client: RemoteNodeClient
  manifest: Nullable<RemoteNodeManifest>
  dispose: () => void
}

export interface EntryArguments {
  readonly url: string
  readonly hostSlug: string
  readonly clientName: string
  readonly pairingCode: Nullable<string>
}

/** config 的自动放行策略：true=全部免确认；string[]=仅这些（原始）工具名免确认。 */
export type McpAutoApprovePolicy = boolean | readonly string[]

/** 翻译产物：注册进 ToolRegistry 所需的三元组 + 原始工具名（用于 autoApprove 匹配）。 */
export interface TranslatedMcpTool {
  /** MCP 工具的 canonical id。 */
  name: string
  /** MCP server 上的原始工具名。 */
  originalName: string
  categoryId: ToolCategoryId
  tool: VelaTool
}

export interface TranslateMcpToolInput {
  connection: Pick<McpClientConnection, 'callTool'>
  serverName: string
  descriptor: McpToolDescriptor
  autoApprove: McpAutoApprovePolicy
  categoryId?: ToolCategoryId
}

export interface ParsedMcpContent {
  text: string
  modelContent: ToolResultModelContentPart[]
}
