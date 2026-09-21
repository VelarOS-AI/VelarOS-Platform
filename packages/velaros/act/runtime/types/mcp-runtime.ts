import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** 已建立的远端鉴权连接。 */
export type McpRemoteTransport = SSEClientTransport | StreamableHTTPClientTransport

/** OAuth 挑战期间保留的连接。 */
export interface McpPendingAuthorization {
  /** 当前客户端实例。 */
  readonly client: Client
  /** 当前协议传输连接。 */
  readonly transport: McpRemoteTransport
}

/** 正在握手的连接及取消权。 */
export interface McpPendingConnection {
  /** 握手取消信号。 */
  controller: AbortController
  /** 当前客户端实例。 */
  client: Nullable<Client>
  /** 当前协议传输连接。 */
  transport: Nullable<Transport>
  /** 握手完成承诺。 */
  promise: Promise<void>
}
