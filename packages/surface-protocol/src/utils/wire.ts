/**
 * 线格式的 zod schema 与它们的失败收集。schema 不出包：外面只拿得到 `providerSurfaceWire` 的几个 `check*`。
 * 每个 schema 都 `satisfies z.ZodType<T>` 对齐 `types/surface-protocol.ts` 里手写的类型；schema 与类型走形，这里编译就红。
 */
import { z } from 'zod'

import {
  ProviderSurfaceArtifactMediaTypes,
  ProviderSurfaceLimits,
  ProviderSurfaceProtocol,
  ProviderSurfaceToolResultStatuses,
  ProviderSurfaceWorkspaceSpaces,
} from '../contract/constants.js'
import type {
  ProviderSurfaceArtifact,
  ProviderSurfaceBinding,
  ProviderSurfaceIssue,
  ProviderSurfaceToolCall,
  ProviderSurfaceToolCatalog,
  ProviderSurfaceToolContractBinding,
  ProviderSurfaceToolDescriptor,
  ProviderSurfaceToolResult,
  ProviderSurfaceWorkspaceCatalog,
  ProviderSurfaceWorkspaceOption,
} from '../types/surface-protocol.js'

/** 标准 base64：只认标准字母表与合法的补位，长度按常量表的上下限卡。 */
const standardBase64 = z.string()
  .min(ProviderSurfaceLimits.artifactBase64MinChars)
  .max(ProviderSurfaceLimits.artifactBase64Chars)
  .regex(/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u)

const workspaceSpaceSchema = z.enum(ProviderSurfaceWorkspaceSpaces)

const workspaceOptionSchema = z.strictObject({
  id: z.string().min(1),
  space: workspaceSpaceSchema,
  label: z.string().min(1),
  description: z.string().nullable(),
}) satisfies z.ZodType<ProviderSurfaceWorkspaceOption>

/** 工作区目录：可选的工作区与它的版本。 */
export const workspaceCatalogSchema = z.strictObject({
  revision: z.string().min(1),
  workspaces: z.array(workspaceOptionSchema),
}) satisfies z.ZodType<ProviderSurfaceWorkspaceCatalog>

const toolContractBindingSchema = z.strictObject({
  id: z.string().min(1),
  catalogRevision: z.string().min(1),
  renewedAt: z.number().int().nonnegative(),
  acknowledgedAt: z.number().int().nonnegative().nullable(),
  turnsSinceRefresh: z.number().int().nonnegative(),
  needsRefresh: z.boolean(),
}) satisfies z.ZodType<ProviderSurfaceToolContractBinding>

/** provider 自持的绑定。 */
export const bindingSchema = z.strictObject({
  provider: z.string().min(1),
  surfaceOwner: z.literal('provider'),
  workspaceSpace: workspaceSpaceSchema,
  providerConversationId: z.string().nullable(),
  providerParentMessageId: z.string().nullable(),
  selectedModelId: z.string().nullable(),
  selectedReasoningEffort: z.string().nullable(),
  capabilityValues: z.record(z.string(), z.union([z.boolean(), z.string()])),
  adapterRevision: z.string().nullable(),
  toolContract: toolContractBindingSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<ProviderSurfaceBinding>

const toolDescriptorSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  category: z.string().optional(),
  readOnly: z.boolean().optional(),
}) satisfies z.ZodType<ProviderSurfaceToolDescriptor>

/** 工具目录：载荷用 `revision`，调用回执回显成 `catalogRevision`。 */
export const toolCatalogSchema = z.strictObject({
  protocolVersion: z.literal(ProviderSurfaceProtocol.version),
  revision: z.string().min(1),
  tools: z.array(toolDescriptorSchema),
}) satisfies z.ZodType<ProviderSurfaceToolCatalog>

/** 一条入站的工具调用。 */
export const toolCallSchema = z.strictObject({
  protocolVersion: z.literal(ProviderSurfaceProtocol.version),
  contractId: z.string().min(1),
  catalogRevision: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<ProviderSurfaceToolCall>

const artifactSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('image'),
    mediaType: z.enum(ProviderSurfaceArtifactMediaTypes),
    data: standardBase64,
    name: z.string().min(1).max(ProviderSurfaceLimits.artifactNameChars),
  }),
]) satisfies z.ZodType<ProviderSurfaceArtifact>

/** 一条工具调用的回执。 */
export const toolResultSchema = z.strictObject({
  protocolVersion: z.literal(ProviderSurfaceProtocol.version),
  contractId: z.string().min(1),
  catalogRevision: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(ProviderSurfaceToolResultStatuses),
  output: z.unknown().optional(),
  artifacts: z.array(artifactSchema).max(ProviderSurfaceLimits.artifactsPerResult).optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<ProviderSurfaceToolResult>

/** 把 zod 的失败收成问题列表：只留路径与错误码，载荷值一个字都不带出来。 */
export function collectIssues(error: z.ZodError): ProviderSurfaceIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code }))
}
