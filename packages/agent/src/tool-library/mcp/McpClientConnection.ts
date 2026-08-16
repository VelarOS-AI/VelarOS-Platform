// MCP 接入通道（宪章 §2 第③通道）——单个外部 MCP 服务器的进程外连接。
//
// 复用官方 `@modelcontextprotocol/sdk` 客户端（stdio 传输），把连接/列表/调用/关闭收敛成一个
// host 无关的连接对象。翻译与注册在 mcpToolTranslation.ts；具体宿主负责配置与装配。
// SSE/HTTP 传输暂未实现（见文末 TODO）——进程外运行是 MCP 工具的天然隔离边界。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'

import { isArray, isBoolean, isPresent, isRecord, isString, Log, toOptional } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { asRecord, readString } from '@velaros-ai/core/utils/unknownJsonRecord'

/** 连接超时（ms）——server 起不来时不无限挂起。 */
export const McpConnectTimeoutMs = 30_000
/** 单次工具调用超时（ms）。 */
export const McpCallTimeoutMs = 120_000

const log = Log.tag('McpClientConnection')

/**
 * host 无关的 MCP stdio 连接规格（仅连接必需字段；enabled/autoApprove 等宿主策略不在此层）。
 */
export interface McpConnectionSpec {
  command: string
  args: readonly string[]
  env: Readonly<Record<string, string>>
  cwd: Nullable<string>
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

/** MCP callTool 的原始返回（SDK result 对象）；结果翻译在 mcpCallResult.ts。 */
export type McpRawCallResult = Record<string, unknown>

/**
 * 单个 MCP 服务器的 stdio 连接。
 *
 * 生命周期由上层（desktop McpServerManager）编排：connect 成功→列表→翻译→注册；连接/列表
 * 失败=该组工具缺席+日志，不 brick（provider 层降级）。
 */
export class McpClientConnection {
  private client: Nullable<Client> = null
  private transport: Nullable<StdioClientTransport> = null

  constructor(
    private readonly serverName: string,
    private readonly spec: McpConnectionSpec,
    private readonly options: { connectTimeoutMs?: number; callTimeoutMs?: number } = {}
  ) {}

  public get isConnected(): boolean {
    return isPresent(this.client)
  }

  /** 建立 stdio 连接并 initialize；失败抛 AppError（上层降级为该组工具缺席）。 */
  public async connect(): Promise<void> {
    if (this.client) return

    const transport = new StdioClientTransport({
      command: this.spec.command,
      args: [...this.spec.args],
      // 部分 env（PATH 等）默认继承；配置 env 覆盖之。缺省 env 会替换而非合并，故显式并入安全默认集。
      env: { ...getDefaultEnvironment(), ...this.spec.env },
      // cwd 缺席（null）时归一化为 undefined（继承主进程 cwd）；toOptional 是唯一合法边界转换点。
      cwd: toOptional(this.spec.cwd),
      stderr: 'pipe',
    })
    const client = new Client({ name: 'velaros-mcp-host', version: '1.0.0' })

    try {
      await client.connect(transport, {
        timeout: this.options.connectTimeoutMs ?? McpConnectTimeoutMs,
      })
    } catch (error) {
      await this.closeTransportQuietly(transport)
      throw new AppError(
        'UNAVAILABLE',
        this.isMcpTimeoutError(error)
          ? `MCP 服务器「${this.serverName}」连接超时（${this.options.connectTimeoutMs ?? McpConnectTimeoutMs}ms）。`
          : `MCP 服务器「${this.serverName}」连接失败：${AppError.getMessage(error)}`,
        error
      )
    }

    this.client = client
    this.transport = transport
  }

  /** 列出该 server 暴露的工具（已解析为受控 McpToolDescriptor）。 */
  public async listTools(): Promise<McpToolDescriptor[]> {
    const client = this.requireClient()
    const response = await client.listTools()
    const rawTools = isArray(response.tools) ? response.tools : []
    const descriptors: McpToolDescriptor[] = []
    for (const raw of rawTools) {
      const descriptor = this.parseToolDescriptor(raw)
      if (descriptor) descriptors.push(descriptor)
    }
    return descriptors
  }

  /** 调用一个工具；超时或 server 中断时抛 AppError。返回 SDK 原始 result（由 mcpCallResult 翻译）。 */
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
    this.client = null
    this.transport = null
    if (!client) return
    try {
      await client.close()
    } catch {
      // arch-guard:silent-catch-ok 关闭失败仍视为已释放，不阻断整体停机。
      log.debug('mcp connection close failed', { server: this.serverName })
    }
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

  private async closeTransportQuietly(transport: StdioClientTransport): Promise<void> {
    try {
      await transport.close()
    } catch {
      // arch-guard:silent-catch-ok 连接失败后的 transport 释放不覆盖原始连接错误。
      log.debug('mcp transport close failed', { server: this.serverName })
    }
  }
}

// TODO(mcp-transport): SSE / streamable-HTTP 传输尚未实现——当前仅 stdio。接入时新增
// McpConnectionSpec.transport 判别 + 对应 SDK transport（SSEClientTransport /
// StreamableHTTPClientTransport），连接/列表/调用/关闭四动词形状不变。
