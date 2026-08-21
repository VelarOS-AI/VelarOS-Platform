import { z } from 'zod'

/**
 * Provider-owned Agent Surface contract used by web extensions and other thin
 * clients. It is deliberately host-neutral: Desktop and VelarOS Terminal are
 * peer implementations of this boundary.
 */
export const ProviderSurfaceProtocolVersion = 1 as const

export const ProviderSurfaceWorkspaceSpaceSchema = z.enum([
  'system',
  'project',
  'browser',
])
export type ProviderSurfaceWorkspaceSpace = z.infer<
  typeof ProviderSurfaceWorkspaceSpaceSchema
>

export const ProviderSurfaceWorkspaceOptionSchema = z.strictObject({
  id: z.string().min(1),
  space: ProviderSurfaceWorkspaceSpaceSchema,
  label: z.string().min(1),
  description: z.string().nullable(),
})
export type ProviderSurfaceWorkspaceOption = z.infer<
  typeof ProviderSurfaceWorkspaceOptionSchema
>

export const ProviderSurfaceWorkspaceCatalogSchema = z.strictObject({
  revision: z.string().min(1),
  workspaces: z.array(ProviderSurfaceWorkspaceOptionSchema),
})
export type ProviderSurfaceWorkspaceCatalog = z.infer<
  typeof ProviderSurfaceWorkspaceCatalogSchema
>

export const ProviderSurfaceToolContractBindingSchema = z.strictObject({
  id: z.string().min(1),
  catalogRevision: z.string().min(1),
  renewedAt: z.number().int().nonnegative(),
  acknowledgedAt: z.number().int().nonnegative().nullable(),
  turnsSinceRefresh: z.number().int().nonnegative(),
  needsRefresh: z.boolean(),
})
export type ProviderSurfaceToolContractBinding = z.infer<
  typeof ProviderSurfaceToolContractBindingSchema
>

export const ProviderSurfaceBindingSchema = z.strictObject({
  provider: z.string().min(1),
  surfaceOwner: z.literal('provider'),
  workspaceSpace: ProviderSurfaceWorkspaceSpaceSchema,
  providerConversationId: z.string().nullable(),
  providerParentMessageId: z.string().nullable(),
  selectedModelId: z.string().nullable(),
  selectedReasoningEffort: z.string().nullable(),
  capabilityValues: z.record(z.string(), z.union([z.boolean(), z.string()])),
  adapterRevision: z.string().nullable(),
  toolContract: ProviderSurfaceToolContractBindingSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type ProviderSurfaceBinding = z.infer<typeof ProviderSurfaceBindingSchema>

export const ProviderSurfaceToolDescriptorSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  category: z.string().optional(),
  readOnly: z.boolean().optional(),
})
export type ProviderSurfaceToolDescriptor = z.infer<
  typeof ProviderSurfaceToolDescriptorSchema
>

/** Catalog payloads use `revision`; calls echo it as `catalogRevision`. */
export const ProviderSurfaceToolCatalogSchema = z.strictObject({
  protocolVersion: z.literal(ProviderSurfaceProtocolVersion),
  revision: z.string().min(1),
  tools: z.array(ProviderSurfaceToolDescriptorSchema),
})
export type ProviderSurfaceToolCatalog = z.infer<
  typeof ProviderSurfaceToolCatalogSchema
>

export const ProviderSurfaceToolCallSchema = z.strictObject({
  protocolVersion: z.literal(ProviderSurfaceProtocolVersion),
  contractId: z.string().min(1),
  catalogRevision: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
})
export type ProviderSurfaceToolCall = z.infer<
  typeof ProviderSurfaceToolCallSchema
>

const StandardBase64Schema = z.string()
  .min(4)
  .max(32 * 1_024 * 1_024)
  .regex(/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u)

export const ProviderSurfaceArtifactSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('image'),
    mediaType: z.enum(['image/png', 'image/jpeg']),
    data: StandardBase64Schema,
    name: z.string().min(1).max(255),
  }),
])
export type ProviderSurfaceArtifact = z.infer<
  typeof ProviderSurfaceArtifactSchema
>

export const ProviderSurfaceToolResultSchema = z.strictObject({
  protocolVersion: z.literal(ProviderSurfaceProtocolVersion),
  contractId: z.string().min(1),
  catalogRevision: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(['success', 'error', 'denied']),
  output: z.unknown().optional(),
  artifacts: z.array(ProviderSurfaceArtifactSchema).max(4).optional(),
  error: z.string().optional(),
})
export type ProviderSurfaceToolResult = z.infer<
  typeof ProviderSurfaceToolResultSchema
>

export function createProviderSurfaceBinding(
  provider: string,
  workspaceSpace: ProviderSurfaceWorkspaceSpace,
  now = Date.now(),
): ProviderSurfaceBinding {
  return {
    provider,
    surfaceOwner: 'provider',
    workspaceSpace,
    providerConversationId: null,
    providerParentMessageId: null,
    selectedModelId: null,
    selectedReasoningEffort: null,
    capabilityValues: {},
    adapterRevision: null,
    toolContract: null,
    createdAt: now,
    updatedAt: now,
  }
}
