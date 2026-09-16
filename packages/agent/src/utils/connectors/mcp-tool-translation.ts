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

import { isBoolean, optionalWhen } from '@velaros-ai/core'

import type { ToolApprovalRiskLevel,ToolCapabilitySchema, ToolCategoryId, ToolRole } from '../../types/agent.js'
import type { VelaTool } from '../../types/builtin.js'
import type { McpAutoApprovePolicy, McpToolDescriptor, TranslatedMcpTool, TranslateMcpToolInput } from '../../types/connectors.js'
import type { KernelToolContext } from '../../types/tool-context.js'
import { schemaToInputSchema } from '../toolkit/schema-bundle'
import { createApprovalOperationKey } from '../toolkit/task-approval'

import { describeMcpApprovalArguments } from './mcp-approval-arguments'
import { translateMcpCallResult } from './mcp-call-result'

/**
 * 外部 MCP 工具默认归入的类别（shared/resident，跨空间可见；不新增封闭轴枚举）。
 *
 * 宿主可用 {@link TranslateMcpToolInput.categoryId} 显式覆盖成自己的分类。
 */
const DefaultMcpToolCategoryId: ToolCategoryId = 'agent-control'

/**
 * 给一个外部名算稳定短指纹（SHA-256 取前 8 个十六进制字符），供归一后的名字拼在尾部做消歧。
 * 同一个外部名永远得到同一串，所以 canonical id 跨进程、跨重启都不变；截到 8 位是"够分辨"与"名字别太长"之间的折中。
 */
function stableExternalNameHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

/**
 * 把一段外部名（server 名或 tool 名）归一成 canonical id 能用的形态：转小写、非法字符折成分隔符、
 * 压掉连续分隔符、去掉首尾分隔符；开头不是字母时在前面补 `fallback`（归一后为空则用 `unnamed`）。
 * **只要归一结果与原串不同，就在尾部再拼一段稳定短指纹**——归一是多对一的（`My Tool` 与 `my-tool` 会撞成同一个），
 * 不加指纹，两个不同的外部工具会共用一个 canonical id，调用就会打到错的那个上。
 * `separator` 单独传是因为 server 段用 `-`、tool 段用 `_`，两处允许的字符集不同。
 */
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

/**
 * 试着把一份 JSON Schema 编译成 zod，并**回转校验**它能不能表示成 provider 的输入 schema；两步任一失败都返回 null。
 * 回转那一步不能省：能编译不等于能表示成 provider 输入面，编译得出却回转退化的 schema 会让这个工具在模型面上变成不可调用桩。
 * 失败细节刻意不上报——调用方拿到 null 就降级成宽容 passthrough，这是设计中的兼容路径，不是故障。
 */
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

/**
 * 判这次调用要不要跳过用户确认。策略是 boolean 时按整台 server 一刀切（true = 该 server 全部工具免确认）；
 * 是数组时只有**原始**工具名逐字命中才免确认——必须用原始名而非 canonical id，白名单是用户照着 MCP server 自己的工具名写的。
 * 返回 false 就走 ApprovalPort 问用户，这是默认形态。
 */
function isToolAutoApproved(policy: McpAutoApprovePolicy, originalName: string): boolean {
  // boolean → 整 server 放行/全需确认；数组 → 仅命中的原始工具名放行。
  if (isBoolean(policy)) return policy
  return policy.includes(originalName)
}

/**
 * 判这个 MCP 工具能不能按"只读"对待：server 声明了 `readOnlyHint` **且没有**声明 `destructiveHint` 才为真。
 * 两个标注同时出现时按破坏性算——标注是外部 server 自己给的，冲突时一律取更保守的一侧。
 * 风险等级、工具角色、能力声明三处都从这一个判据派生，保证它们永远一致。
 */
function isReadOnlyMcpTool(descriptor: McpToolDescriptor): boolean {
  return descriptor.annotations.readOnlyHint && !descriptor.annotations.destructiveHint
}

/**
 * 定这个外部工具的审批风险等级：只读的给 `'low'`（宿主的 standard-open 档可自动放行），其余一律 `'high'`、默认要用户确认。
 * 只有两档、没有中间态：外部 server 的标注只够支撑"读 / 非读"这一个区分，再细分就是替 server 编内容。
 */
function resolveRiskLevel(descriptor: McpToolDescriptor): ToolApprovalRiskLevel {
  return isReadOnlyMcpTool(descriptor) ? 'low' : 'high'
}

/**
 * 定工具角色：只读的归 `'inspect'`，其余归 `'execute'`。
 * 角色影响分配器怎么分类、提示词怎么介绍这个工具，不参与审批判定（审批看 {@link resolveRiskLevel}）。
 */
function resolveToolRole(descriptor: McpToolDescriptor): ToolRole {
  return isReadOnlyMcpTool(descriptor) ? 'inspect' : 'execute'
}

/**
 * 按只读判据产出这个外部工具的能力声明，两档：
 * 只读档记 `effectKind: 'read'`、并发 `safe`、只有 `mcp` 读作用域；
 * 非只读档按 `destructiveHint` 记 `'destructive'` 或 `'external'`，`mcp` 读写作用域都给，并发一律标 `unsafe`——
 * 进程外 server 并发安不安全本包无从得知，保守当不安全（多花一点串行，总好过并发把外部状态写坏）。
 * 两档都标 `canReadArbitrarySource: true`：外部工具究竟读了什么本包管不着，如实声明才能让上层的数据流策略据此设防。
 */
function resolveToolCapabilities(descriptor: McpToolDescriptor): ToolCapabilitySchema {
  if (isReadOnlyMcpTool(descriptor)) return {
    effectKind: 'read',
    readScopes: ['mcp'],
    concurrency: 'safe',
    canReadArbitrarySource: true,
    reason: 'MCP 服务器声明这个外部工具只读',
  }

  return {
    effectKind: descriptor.annotations.destructiveHint ? 'destructive' : 'external',
    readScopes: ['mcp'],
    writeScopes: ['mcp'],
    concurrency: 'unsafe',
    canReadArbitrarySource: true,
    reason: descriptor.annotations.idempotentHint
      ? 'MCP 服务器声明这是一次幂等的外部写入'
      : 'MCP 外部工具可能改动服务器状态',
  }
}

/**
 * 拼给模型看的工具描述：固定前缀点明"这是外部 MCP 工具、来自哪台 server、进程外运行"，后面接 server 自己给的说明。
 * 说明按 `description → annotations.title → 工具名` 逐级回退，保证永远有一句可读的话，不会出现空描述。
 * 前缀是有意加的：模型得知道这一跳跨出了本进程，行为与内置工具不同——会走审批、可能整个失败、结果不受本包控制。
 */
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
      const destructive = descriptor.annotations.destructiveHint
      if (!isToolAutoApproved(autoApprove, originalName)) {
        const argumentsPreview = describeMcpApprovalArguments(args)
        const approvalScope = destructive ? 'call' : 'task-operation'
        const approvalMessage = [
          `AI 请求调用外部 MCP 工具「${originalName}」（服务器 ${serverName}）。`,
          `参数：${argumentsPreview}`,
          destructive
            ? '本次为破坏性操作；批准仅适用于本次调用。是否允许？'
            : '批准后，当前任务可使用相同参数继续调用该工具。是否允许？',
        ].join('\n')
        const decision = await ctx.approval.awaitConfirmationDecision(
          approvalMessage,
          ctx.abortSignal,
          {
            approvalRisk: riskLevel,
            riskScope: `mcp:${serverName}:${originalName}`,
            operation: {
              key: createApprovalOperationKey(`mcp:${serverName}:${originalName}`, args),
              label: `${serverName} / ${originalName}`,
              target: argumentsPreview,
            },
            rememberRiskScope: !destructive,
            requireManualApproval: optionalWhen(destructive, true),
            detail: {
              kind: 'mcp-tool-call', serverName, toolName: originalName,
              argumentsPreview, approvalScope,
            },
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
