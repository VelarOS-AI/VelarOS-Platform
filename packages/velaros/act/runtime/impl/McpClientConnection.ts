import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import { isArray, isPresent, isRecord, Log, toNullable, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import { McpLimits } from '../contract/constants.js'
import type {
  McpAuthorizationProvider,
  McpConnectionOptions,
  McpConnectionSpec,
} from '../contract/requires.js'
import type {
  McpRawCallResult,
  McpResourceContent,
  McpResourceDescriptor,
  McpToolDescriptor,
  McpTransportKind,
} from '../types/mcp.js'
import type {
  McpPendingAuthorization,
  McpPendingConnection,
  McpRemoteTransport,
} from '../types/mcp-runtime.js'
import {
  isMcpTimeoutError,
  mcpAuthorizationRequired,
  parseMcpToolDescriptor,
} from '../utils/mcp-protocol.js'

/** 外部 MCP 连接的完整生命周期。 */
export interface McpClientConnectionApi {
  /** 现在有没有一条 initialize 完成、可以发请求的连接；连接被对端关掉后会自动变回 false。 */
  readonly isConnected: boolean
  /** 是不是卡在 OAuth 上：连接因 401 挂起、正等宿主把用户换来的 code 交回来。true 时 `connect()` 只会重新抛授权错误，得先走 `completeAuthorization`。 */
  readonly hasPendingAuthorization: boolean
  /** 连上并 initialize：已连着就直接返回，正在连就并到同一个 Promise 上（不会重复起进程）。`transport: 'auto'` 时先试 Streamable HTTP，非鉴权失败才回退 SSE。需要 OAuth 时抛 `McpAuthorizationRequiredError`，全部 transport 都失败时抛 `UNAVAILABLE` 并把每种的原因拼进文案。 */
  connect(): Promise<void>
  /** 宿主拿到用户授权的 code 之后调这里推进 OAuth：交给挂起的 transport 去换 token，然后释放这条挑战连接（换完还要再 `connect()` 一次）。当前没有挂起的授权时抛 `INVALID_STATE`。 */
  completeAuthorization(code: string): Promise<void>
  /** 列出这个 server 暴露的全部工具，自动跟随 cursor 翻完所有页；缺 `name` 的条目直接跳过。server 重复回同一个 cursor（会翻不完）时抛 `EXECUTION`。没连接时抛 `UNAVAILABLE`。 */
  listTools(): Promise<McpToolDescriptor[]>
  /** 列出这个 server 暴露的全部资源，同样跟随 cursor 翻完所有页；`name` 缺失时退回用 uri 当名字。没连接时抛 `UNAVAILABLE`。 */
  listResources(): Promise<McpResourceDescriptor[]>
  /** 读一个资源，把 SDK 的 text/blob 联合收敛成固定形状（两个字段都在，没有的那个是 null）；超过 `callTimeoutMs` 或 `abortSignal` 取消时抛错。 */
  readResource(uri: string, abortSignal?: AbortSignal): Promise<McpResourceContent[]>
  /** 调一个工具，原样把 server 的结果记录交回（不是记录就给空对象），解析和 isError 判定在 `translateMcpCallResult` 那层做。有进度上报会重置超时；真超时抛 `TIMEOUT` 并带上服务器名、工具名和毫秒数。 */
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    abortSignal?: AbortSignal
  ): Promise<McpRawCallResult>
  /** 关连接：中断还在进行的连接尝试、关掉 client 与 transport、丢掉挂起的授权。关闭过程中的错误一律吞掉（释放优先），可重复调，也可以关完再 `connect()`。 */
  close(): Promise<void>
}

// MCP 接入通道（宪章 §2 第③通道）——单个外部 MCP 服务器的进程外连接。
//
// 这一层只拥有 MCP 协议连接、工具/资源枚举、调用与关闭；server 配置存储、凭据存储、
// OAuth 用户授权/回调交互、自动批准策略和产品状态文案继续由具体宿主负责。

/** 连接超时（ms）——server 起不来时不无限挂起；值在合同表 `McpLimits.connectTimeoutMs`。 */

/** 单次工具调用/资源读取超时（ms）；值在合同表 `McpLimits.callTimeoutMs`。 */

const log = Log.tag('McpClientConnection')

/**
 * 单个外部 MCP 服务器的进程外连接：起 transport、initialize、枚举工具和资源、发调用、收尾。
 *
 * 实现是 `McpClientConnection`，宿主给每个已配置的 server 建一个，连接状态只在这个实例里；
 * server 配置与凭据存储、OAuth 的用户交互与回调、自动批准策略和产品状态文案都不在这层。
 * 失败一律是 `AppError`：没连上是 `UNAVAILABLE`，调用超时是 `TIMEOUT`，需要 OAuth 是 `McpAuthorizationRequiredError`。
 */

/** 单个 MCP 服务器的 host 无关协议连接。 */
export class McpClientConnection implements McpClientConnectionApi {
  private client: Nullable<Client> = null
  private transport: Nullable<Transport> = null
  private pendingAuthorization: Nullable<McpPendingAuthorization> = null
  private connecting: Nullable<McpPendingConnection> = null
  private closing: Nullable<Promise<void>> = null

  constructor(
    private readonly serverName: string,
    private readonly spec: McpConnectionSpec,
    private readonly options: McpConnectionOptions = {}
  ) {}

  public get isConnected(): boolean {
    return isPresent(this.client)
  }

  public get hasPendingAuthorization(): boolean {
    return isPresent(this.pendingAuthorization)
  }

  /** 建立连接并 initialize；auto 仅在非鉴权错误时从 HTTP 回退 SSE。 */
  public async connect(): Promise<void> {
    if (this.closing) await this.closing
    if (this.client) return
    if (this.connecting) return this.connecting.promise
    if (this.pendingAuthorization) {
      const provider = this.spec.authProvider as McpAuthorizationProvider | undefined
      throw mcpAuthorizationRequired(toNullable(provider?.authorizationUrl?.toString()))
    }

    const pending: McpPendingConnection = {
      controller: new AbortController(),
      client: null,
      transport: null,
      promise: Promise.resolve(),
    }
    this.connecting = pending
    pending.promise = this.connectPending(pending).finally(() => {
      if (this.connecting === pending) this.connecting = null
    })
    return pending.promise
  }

  private async connectPending(pending: McpPendingConnection): Promise<void> {
    const transportKinds =
      this.spec.transport === 'auto'
        ? (['http', 'sse'] as const)
        : ([this.spec.transport ?? 'stdio'] as const)
    const errors: string[] = []
    for (const transportKind of transportKinds) {
      pending.controller.signal.throwIfAborted()
      const transport = this.createTransport(transportKind)
      const client = new Client(this.spec.client ?? { name: 'velaros-mcp-host', version: '1.0.0' })
      pending.client = client
      pending.transport = transport
      client.onclose = () => this.handleConnectionClosed(client)
      try {
        await client.connect(transport, {
          timeout: this.options.connectTimeoutMs ?? McpLimits.connectTimeoutMs,
          signal: pending.controller.signal,
        })
        pending.controller.signal.throwIfAborted()
        if (!client.transport)
          throw new AppError(
            'UNAVAILABLE',
            'MCP 连接在握手完成前就断了：transport 已关闭，这次连接不算建立成功。'
          )
        this.client = client
        this.transport = transport
        return
      } catch (error) {
        if (pending.controller.signal.aborted) {
          await this.closeClientQuietly(client)
          await this.closeTransportQuietly(transport)
          pending.controller.signal.throwIfAborted()
        }
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
          throw mcpAuthorizationRequired(toNullable(provider?.authorizationUrl?.toString()))
        }
        await this.closeClientQuietly(client)
        await this.closeTransportQuietly(transport)
        errors.push(`${transportKind}: ${AppError.getMessage(error)}`)
        if (isMcpTimeoutError(error)) {
          errors[errors.length - 1] =
            `${transportKind}: 连接超时（${this.options.connectTimeoutMs ?? McpLimits.connectTimeoutMs}ms）`
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
    if (!pending)
      throw new AppError(
        'INVALID_STATE',
        '当前没有待完成的 MCP OAuth 授权：它可能已经完成或已被取消，重新发起连接拿一个新的授权链接。'
      )
    this.pendingAuthorization = null
    try {
      await pending.transport.finishAuth(code)
    } finally {
      await this.closeClientQuietly(pending.client)
    }
  }

  /** 列出该 server 暴露的工具（已解析为受控 McpToolDescriptor）。 */
  public async listTools(): Promise<McpToolDescriptor[]> {
    const client = this.requireClient()
    const descriptors: McpToolDescriptor[] = []
    const seenCursors = new Set<string>()
    let cursor: Nullable<string> = null
    do {
      const response = isPresent(cursor)
        ? await client.listTools({ cursor })
        : await client.listTools()
      const rawTools = isArray(response.tools) ? response.tools : []
      for (const raw of rawTools) {
        const descriptor = parseMcpToolDescriptor(raw)
        if (descriptor) descriptors.push(descriptor)
      }
      cursor = this.advanceListCursor(response.nextCursor, seenCursors)
    } while (isPresent(cursor))
    return descriptors
  }

  /** 枚举资源，完整跟随 MCP cursor 分页。 */
  public async listResources(): Promise<McpResourceDescriptor[]> {
    const client = this.requireClient()
    const resources: McpResourceDescriptor[] = []
    const seenCursors = new Set<string>()
    let cursor: Nullable<string> = null
    do {
      const response = isPresent(cursor)
        ? await client.listResources({ cursor })
        : await client.listResources()
      for (const resource of response.resources) {
        resources.push({
          uri: resource.uri,
          name: resource.name || resource.uri,
          description: toNullable(resource.description),
          mimeType: toNullable(resource.mimeType),
        })
      }
      cursor = this.advanceListCursor(response.nextCursor, seenCursors)
    } while (isPresent(cursor))
    return resources
  }

  private advanceListCursor(cursor: LooseOptional<string>, seen: Set<string>): Nullable<string> {
    if (!isPresent(cursor)) return null
    if (seen.has(cursor)) {
      throw new AppError(
        'EXECUTION',
        `MCP 服务器「${this.serverName}」重复返回同一个分页 cursor：为避免无限翻页已中止这次枚举，拿到的结果可能不完整。`
      )
    }
    seen.add(cursor)
    return cursor
  }

  /** 读取一个资源并把 text/blob 联合收敛成稳定、可序列化形状。 */
  public async readResource(uri: string, abortSignal?: AbortSignal): Promise<McpResourceContent[]> {
    const response = await this.requireClient().readResource(
      { uri },
      {
        timeout: this.options.callTimeoutMs ?? McpLimits.callTimeoutMs,
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
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: this.options.callTimeoutMs ?? McpLimits.callTimeoutMs,
        resetTimeoutOnProgress: true,
        signal: abortSignal,
      })
      return isRecord(result) ? result : {}
    } catch (error) {
      if (isMcpTimeoutError(error)) {
        throw new AppError(
          'TIMEOUT',
          `MCP 工具调用超时：${this.serverName}/${toolName}（${this.options.callTimeoutMs ?? McpLimits.callTimeoutMs}ms）。`,
          error
        )
      }
      throw AppError.from(error)
    }
  }

  /** 关闭连接；失败静默（释放优先）。 */
  public async close(): Promise<void> {
    if (this.closing) return this.closing
    const pendingConnection = this.connecting
    const client = this.client
    const transport = this.transport
    const pendingAuthorization = this.pendingAuthorization
    this.client = null
    this.transport = null
    this.pendingAuthorization = null
    pendingConnection?.controller.abort(
      new AppError('ABORTED', 'MCP 连接已关闭：正在进行的连接请求被主动中止。')
    )
    const closing = this.closeOwnedConnections(
      client,
      transport,
      pendingAuthorization,
      pendingConnection
    )
    this.closing = closing
    try {
      await closing
    } finally {
      if (this.closing === closing) this.closing = null
    }
  }

  private async closeOwnedConnections(
    client: Nullable<Client>,
    transport: Nullable<Transport>,
    authorization: Nullable<McpPendingAuthorization>,
    pending: Nullable<McpPendingConnection>
  ): Promise<void> {
    if (client) await this.closeClientQuietly(client)
    else if (transport) await this.closeTransportQuietly(transport)
    if (authorization) await this.closeClientQuietly(authorization.client)
    if (pending?.client && pending.client !== client) await this.closeClientQuietly(pending.client)
    if (pending?.transport && pending.transport !== transport)
      await this.closeTransportQuietly(pending.transport)
    if (pending) await Promise.allSettled([pending.promise])
  }

  private handleConnectionClosed(client: Client): void {
    if (this.client !== client) return
    this.client = null
    this.transport = null
    try {
      this.options.onClose?.()
    } catch (error) {
      log.warn('mcp close observer failed', { server: this.serverName, error })
    }
  }

  private createTransport(transport: Exclude<McpTransportKind, 'auto'>): Transport {
    if (transport === 'stdio')
      return new StdioClientTransport({
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
      : new StreamableHTTPClientTransport(url, {
          requestInit,
          authProvider: this.spec.authProvider,
        })
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new AppError('UNAVAILABLE', `MCP 服务器「${this.serverName}」尚未连接。`)
    }
    return this.client
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

/** 建一条到 MCP 服务器的连接；超时与授权口由选项注入。 */
export function createMcpClientConnection(
  serverName: string,
  spec: McpConnectionSpec,
  options: McpConnectionOptions = {}
): McpClientConnectionApi {
  return new McpClientConnection(serverName, spec, options)
}
