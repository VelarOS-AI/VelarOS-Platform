// MCP 工具 → 标准 VelaTool 描述符的翻译（宪章 §2 第③通道核心）。
//
// 翻译规则：
//  1. 外部身份编译为 canonical id：`mcp.<server>:<tool>`；provider 传输名由请求编译器另行生成。
//  2. inputSchema（JSON Schema）→ zod（z.fromJSONSchema，回转校验兜底），模型看到真实参数。
//  3. 描述透传（kind:'mcp' 的 provider 在注册面跳过七段式结构校验，故可用纯文本描述）。
//  4. execute 走同一条 Ring 0 执行路：先经 ApprovalPort 确认（config 可白名单免确认），再调用
//     MCP server，结果经 mcpCallResult 翻译回信封。进程外运行=天然隔离。
//  riskClass：readOnly 且非 destructive → 低风险（standard-open 可自动放行）；否则高风险默认确认。

import { createHash } from 'node:crypto'

import { z } from 'zod'

import type {
  ToolApprovalRiskLevel,
  ToolCapabilitySchema,
  ToolCategoryId,
  ToolRole,
} from '@velaros-ai/agent/protocol'
import { schemaToInputSchema } from '@velaros-ai/agent/tool-contract'
import { isBoolean } from '@velaros-ai/core'

import type { VelaTool } from '../defineVelaTool'
import type { KernelToolContext } from '../KernelToolContext'

import { translateMcpCallResult } from './mcpCallResult'
import type { McpClientConnection, McpToolDescriptor } from './McpClientConnection'

/**
 * 外部 MCP 工具默认归入的类别（shared/resident，跨空间可见；不新增封闭轴枚举）。
 *
 * 宿主可用 {@link TranslateMcpToolInput.categoryId} 显式覆盖成自己的分类。
 */
const DefaultMcpToolCategoryId: ToolCategoryId = 'agent-control'

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

function stableExternalNameHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

function canonicalizeMcpNameSegment(segment: string, fallback: string, separator: '-' | '_'): string {
  const disallowedCharacters = separator === '-' ? /[^a-z0-9-]+/gu : /[^a-z0-9_]+/gu
  const normalized = segment
    .toLowerCase()
    .replace(disallowedCharacters, separator)
    .replace(new RegExp(`${separator}+`, 'gu'), separator)
    .replace(/^[-_]+|[-_]+$/gu, '')
  const leadingSafe = /^[a-z]/u.test(normalized) ? normalized : `${fallback}${separator}${normalized || 'unnamed'}`
  return leadingSafe === segment ? leadingSafe : `${leadingSafe}${separator}${stableExternalNameHash(segment)}`
}

/** 构造 MCP 工具的内部 canonical id；provider 长度限制不污染注册身份。 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  const server = canonicalizeMcpNameSegment(serverName, 'server', '-')
  const tool = canonicalizeMcpNameSegment(toolName, 'tool', '_')
  return `mcp.${server}:${tool}`
}

/**
 * MCP inputSchema（JSON Schema）→ zod。
 *
 * z.fromJSONSchema 编译失败、或编译结果无法回转成 provider JSON schema（会退化成不可调用兜底）时，
 * 一律降级为宽容 passthrough 对象——宁可模型看不到参数细节，也不让整个工具变成不可调用桩。
 */
export function convertMcpInputSchema(inputSchema: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  const converted = tryConvertJsonSchema(inputSchema)
  return (converted ?? z.looseObject({})) as z.ZodType<Record<string, unknown>>
}

function tryConvertJsonSchema(inputSchema: Record<string, unknown>): Nullable<z.ZodType> {
  let converted: z.ZodType
  try {
    converted = z.fromJSONSchema(inputSchema as never)
  } catch {
    // arch-guard:silent-catch-ok 编译失败即降级为宽容 passthrough，失败细节非需上报。
    return null
  }
  try {
    // 回转校验：确认能表示成 provider 输入 schema（io:'input'），否则模型面会退化。
    schemaToInputSchema(converted)
  } catch {
    // arch-guard:silent-catch-ok 回转失败即降级为宽容 passthrough，失败细节非需上报。
    return null
  }
  return converted
}

function isToolAutoApproved(policy: McpAutoApprovePolicy, originalName: string): boolean {
  // boolean → 整 server 放行/全需确认；数组 → 仅命中的原始工具名放行。
  if (isBoolean(policy)) return policy
  return policy.includes(originalName)
}

function isReadOnlyMcpTool(descriptor: McpToolDescriptor): boolean {
  return descriptor.annotations.readOnlyHint && !descriptor.annotations.destructiveHint
}

function resolveRiskLevel(descriptor: McpToolDescriptor): ToolApprovalRiskLevel {
  return isReadOnlyMcpTool(descriptor) ? 'low' : 'high'
}

function resolveToolRole(descriptor: McpToolDescriptor): ToolRole {
  return isReadOnlyMcpTool(descriptor) ? 'inspect' : 'execute'
}

function resolveToolCapabilities(descriptor: McpToolDescriptor): ToolCapabilitySchema {
  if (isReadOnlyMcpTool(descriptor)) return {
    effectKind: 'read',
    readScopes: ['mcp'],
    concurrency: 'safe',
    canReadArbitrarySource: true,
    reason: 'MCP server declares this external tool read-only',
  }

  return {
    effectKind: descriptor.annotations.destructiveHint ? 'destructive' : 'external',
    readScopes: ['mcp'],
    writeScopes: ['mcp'],
    concurrency: 'unsafe',
    canReadArbitrarySource: true,
    reason: descriptor.annotations.idempotentHint
      ? 'MCP server declares an idempotent external mutation'
      : 'MCP external tool may mutate server state',
  }
}

function buildToolDescription(serverName: string, descriptor: McpToolDescriptor): string {
  const summary = descriptor.description ?? descriptor.annotations.title ?? descriptor.name
  return `外部 MCP 工具「${descriptor.name}」（来自服务器 ${serverName}，进程外运行）。${summary}`
}

/**
 * 把一个 MCP 工具翻译成标准 VelaTool（进注册面走同一条 ToolExecutor / ApprovalPort 执行路）。
 */
export function translateMcpTool(input: TranslateMcpToolInput): TranslatedMcpTool {
  const { connection, serverName, descriptor, autoApprove } = input
  const originalName = descriptor.name
  const canonicalName = buildMcpToolName(serverName, originalName)
  const categoryId = input.categoryId ?? DefaultMcpToolCategoryId
  const riskLevel = resolveRiskLevel(descriptor)
  const capabilities = resolveToolCapabilities(descriptor)

  const tool: VelaTool = {
    name: canonicalName,
    category: categoryId,
    role: resolveToolRole(descriptor),
    description: buildToolDescription(serverName, descriptor),
    schema: convertMcpInputSchema(descriptor.inputSchema),
    // network=中性 I/O 元数据（不作可见性门槛，见 ToolRegistry 过滤注释）。
    permissions: ['network'],
    capabilities,
    isConcurrencySafe: () => capabilities.concurrency === 'safe',
    execute: async (rawInput: Record<string, unknown>, ctx: KernelToolContext): Promise<unknown> => {
      const args = rawInput ?? {}
      if (!isToolAutoApproved(autoApprove, originalName)) {
        const decision = await ctx.approval.awaitConfirmationDecision(
          `AI 请求调用外部 MCP 工具「${originalName}」（服务器 ${serverName}）。是否允许？`,
          ctx.abortSignal,
          {
            approvalRisk: riskLevel,
            riskScope: `mcp:${serverName}:${originalName}`,
            rememberRiskScope: true,
            detail: { kind: 'mcp-tool-call', serverName, toolName: originalName },
          }
        )
        if (!decision.approved) return {
            skipped: true,
            server: serverName,
            tool: originalName,
            message: decision.message ?? '用户未批准该 MCP 工具调用。',
          }
      }

      const result = await connection.callTool(originalName, args, ctx.abortSignal)
      return translateMcpCallResult(result, `${serverName}/${originalName}`)
    },
  }

  return { name: canonicalName, originalName, categoryId, tool }
}
