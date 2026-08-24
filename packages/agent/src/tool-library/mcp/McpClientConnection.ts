// MCP 接入通道（宪章 §2 第③通道）——单个外部 MCP 服务器的进程外连接。
//
// 这一层只拥有 MCP 协议连接、工具/资源枚举、调用与关闭；server 配置存储、凭据存储、
// OAuth 用户授权/回调交互、自动批准策略和产品状态文案继续由具体宿主负责。

import { type OAuthClientProvider, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'

import {
  isArray,
  isBoolean,
  isPresent,
  isRecord,
  isString,
  Log,
  toNullable,
  toOptional,
} from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

/** 连接超时（ms）——server 起不来时不无限挂起。 */
export const McpConnectTimeoutMs = 30_000
/** 单次工具调用/资源读取超时（ms）。 */
export const McpCallTimeoutMs = 120_000

const log = Log.tag('McpClientConnection')

export type McpTransportKind = 'stdio' | 'http' | 'sse' | 'auto'

/**
 * OAuth provider 仍由产品实现和持久化。可选 authorizationUrl 只用于把 SDK 的 401
 * 归一化成可展示、可恢复的协议错误，不授予 Platform 发起授权交互或写入凭据的权限。
 */
export interface McpAuthorizationProvider extends OAuthClientProvider {
  readonly authorizationUrl?: LooseOptional<URL>
}

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

/** 远程 MCP 明确要求 OAuth 时抛出；登录流程仍由产品宿主拥有。 */
export class McpAuthorizationRequiredError extends Error {
  public constructor(readonly authorizationUrl: Nullable<string>) {
    super('MCP OAuth authorization is required.')
    this.name = 'McpAuthorizationRequiredError'
  }
}

type McpRemoteTransport = SSEClientTransport | StreamableHTTPClientTransport

interface McpPendingAuthorization {
  readonly client: Client
  readonly transport: McpRemoteTransport
}

/** 单个 MCP 服务器的 host 无关协议连接。 */
export class McpClientConnection {
  private client: Nullable<Client> = null
  private transport: Nullable<Transport> = null
  private pendingAuthorization: Nullable<McpPendingAuthorization> = null

  constructor(
    private readonly serverName: string,
    private readonly spec: McpConnectionSpec,
    private readonly options: { connectTimeoutMs?: number; callTimeoutMs?: number } = {}
  ) {}

  public get isConnected(): boolean {
    return isPresent(this.client)
  }

  public get hasPendingAuthorization(): boolean {
    return isPresent(this.pendingAuthorization)
  }

  /** 建立连接并 initialize；auto 仅在非鉴权错误时从 HTTP 回退 SSE。 */
  public async connect(): Promise<void> {
    if (this.client) return
    if (this.pendingAuthorization) {
      const provider = this.spec.authProvider as McpAuthorizationProvider | undefined
      throw new McpAuthorizationRequiredError(
        toNullable(provider?.authorizationUrl?.toString())
      )
    }

    const transportKinds = this.spec.transport === 'auto'
      ? ['http', 'sse'] as const
      : [this.spec.transport ?? 'stdio'] as const
    const errors: string[] = []
    for (const transportKind of transportKinds) {
      const transport = this.createTransport(transportKind)
      const client = new Client(this.spec.client ?? { name: 'velaros-mcp-host', version: '1.0.0' })
      try {
        await client.connect(transport, {
          timeout: this.options.connectTimeoutMs ?? McpConnectTimeoutMs,
        })
        this.client = client
        this.transport = transport
        return
      } catch (error) {
        if (error instanceof UnauthorizedError) {
          const provider = this.spec.authProvider as McpAuthorizationProvider | undefined
          if (transportKind !== 'stdio' && provider) {
            this.pendingAuthorization = {
              client,
              transport: transport as McpRemoteTransport,
            }
          } else {
            await this.closeClientQuietly(client)
            await this.closeTransportQuietly(transport)
          }
          throw new McpAuthorizationRequiredError(
            toNullable(provider?.authorizationUrl?.toString())
          )
        }
        await this.closeClientQuietly(client)
        await this.closeTransportQuietly(transport)
        errors.push(`${transportKind}: ${AppError.getMessage(error)}`)
        if (this.isMcpTimeoutError(error)) {
          errors[errors.length - 1] = `${transportKind}: 连接超时（${this.options.connectTimeoutMs ?? McpConnectTimeoutMs}ms）`
        }
      }
    }

    throw new AppError(
      'UNAVAILABLE',
      `MCP 服务器「${this.serverName}」连接失败：${errors.join('; ')}`
    )
  }

  /**
   * 完成已经由产品 UI/回调端口取得 code 的 OAuth 挑战。
   * Platform 只推进协议 transport 并释放挑战连接；产品仍决定如何展示 URL、接收回调和持久化凭据。
   */
  public async completeAuthorization(code: string): Promise<void> {
    const pending = this.pendingAuthorization
    if (!pending) throw new AppError('INVALID_STATE', 'No MCP OAuth authorization is pending.')
    this.pendingAuthorization = null
    try {
      await pending.transport.finishAuth(code)
    } finally {
      await this.closeClientQuietly(pending.client)
    }
  }

  /** 列出该 server 暴露的工具（已解析为受控 McpToolDescriptor）。 */
  public async listTools(): Promise<McpToolDescriptor[]> {
    const response = await this.requireClient().listTools()
    const rawTools = isArray(response.tools) ? response.tools : []
    const descriptors: McpToolDescriptor[] = []
    for (const raw of rawTools) {
      const descriptor = this.parseToolDescriptor(raw)
      if (descriptor) descriptors.push(descriptor)
    }
    return descriptors
  }

  /** 枚举资源，完整跟随 MCP cursor 分页。 */
  public async listResources(): Promise<McpResourceDescriptor[]> {
    const resources: McpResourceDescriptor[] = []
    let cursor: string | undefined
    do {
      const response = await this.requireClient().listResources(cursor ? { cursor } : undefined)
      for (const resource of response.resources) {
        resources.push({
          uri: resource.uri,
          name: resource.name || resource.uri,
          description: toNullable(resource.description),
          mimeType: toNullable(resource.mimeType),
        })
      }
      cursor = response.nextCursor
    } while (cursor)
    return resources
  }

  /** 读取一个资源并把 text/blob 联合收敛成稳定、可序列化形状。 */
  public async readResource(
    uri: string,
    abortSignal?: AbortSignal
  ): Promise<McpResourceContent[]> {
    const response = await this.requireClient().readResource(
      { uri },
      {
        timeout: this.options.callTimeoutMs ?? McpCallTimeoutMs,
        signal: abortSignal,
      }
    )
    return response.contents.map((content) => ({
      uri: content.uri,
      mimeType: toNullable(content.mimeType),
      text: 'text' in content ? content.text : null,
      blob: 'blob' in content ? content.blob : null,
    }))
  }

  /** 调用一个工具；超时或 server 中断时抛 AppError。 */
  public async callTool(
    toolName: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal
  ): Promise<McpRawCallResult> {
    const client = this.requireClient()
    try {
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        {
          timeout: this.options.callTimeoutMs ?? McpCallTimeoutMs,
          resetTimeoutOnProgress: true,
          signal: abortSignal,
        }
      )
      return isRecord(result) ? result : {}
    } catch (error) {
      if (this.isMcpTimeoutError(error)) {
        throw new AppError(
          'TIMEOUT',
          `MCP 工具调用超时：${this.serverName}/${toolName}（${this.options.callTimeoutMs ?? McpCallTimeoutMs}ms）。`,
          error
        )
      }
      throw AppError.from(error)
    }
  }

  /** 关闭连接；失败静默（释放优先）。 */
  public async close(): Promise<void> {
    const client = this.client
    const transport = this.transport
    const pendingAuthorization = this.pendingAuthorization
    this.client = null
    this.transport = null
    this.pendingAuthorization = null
    if (client) await this.closeClientQuietly(client)
    else if (transport) await this.closeTransportQuietly(transport)
    if (pendingAuthorization) await this.closeClientQuietly(pendingAuthorization.client)
  }

  private createTransport(transport: Exclude<McpTransportKind, 'auto'>): Transport {
    if (transport === 'stdio') return new StdioClientTransport({
        command: this.spec.command,
        args: [...this.spec.args],
        env: { ...getDefaultEnvironment(), ...this.spec.env },
        cwd: toOptional(this.spec.cwd),
        stderr: 'pipe',
      })
    if (!this.spec.url) {
      throw new AppError('INVALID_ARGUMENT', `MCP 服务器「${this.serverName}」缺少远程 URL。`)
    }
    const url = new URL(this.spec.url)
    const requestInit: RequestInit = { headers: { ...this.spec.headers } }
    return transport === 'sse'
      ? new SSEClientTransport(url, { requestInit, authProvider: this.spec.authProvider })
      : new StreamableHTTPClientTransport(url, { requestInit, authProvider: this.spec.authProvider })
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new AppError('UNAVAILABLE', `MCP 服务器「${this.serverName}」尚未连接。`)
    }
    return this.client
  }

  private parseToolDescriptor(raw: unknown): Nullable<McpToolDescriptor> {
    const record = asRecord(raw) ?? {}
    const name = readString(record, 'name')
    if (!name) return null

    const inputSchema = isRecord(record.inputSchema) ? record.inputSchema : { type: 'object' }
    const description = readString(record, 'description') || readString(record, 'title')
    const annotations = isRecord(record.annotations) ? record.annotations : {}

    return {
      name,
      description: description || null,
      inputSchema,
      annotations: {
        title: readString(annotations, 'title') || null,
        readOnlyHint: isBoolean(annotations.readOnlyHint) ? annotations.readOnlyHint : false,
        destructiveHint: isBoolean(annotations.destructiveHint) ? annotations.destructiveHint : false,
        idempotentHint: isBoolean(annotations.idempotentHint) ? annotations.idempotentHint : false,
      },
    }
  }

  private isMcpTimeoutError(error: unknown): boolean {
    const record = isRecord(error) ? error : {}
    return (
      record.code === ErrorCode.RequestTimeout ||
      (isString(record.name) && (record.name === 'TimeoutError' || record.name === 'AbortError'))
    )
  }

  private async closeClientQuietly(client: Client): Promise<void> {
    try {
      await client.close()
    } catch {
      // arch-guard:silent-catch-ok 关闭失败仍视为已释放，不阻断整体停机。
      log.debug('mcp client close failed', { server: this.serverName })
    }
  }

  private async closeTransportQuietly(transport: Transport): Promise<void> {
    try {
      await transport.close()
    } catch {
      // arch-guard:silent-catch-ok 连接失败后的 transport 释放不覆盖原始连接错误。
      log.debug('mcp transport close failed', { server: this.serverName })
    }
  }
}
