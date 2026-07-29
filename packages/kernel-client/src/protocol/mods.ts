import { z } from 'zod'

import { KernelProtocolVersion } from './version'

export const KernelModPackKindSchema = z.enum(['system', 'user', 'contrib'])
export type KernelModPackKind = z.infer<typeof KernelModPackKindSchema>

export const KernelModPackDescriptorSchema = z.strictObject({
  id: z.string().min(1),
  kind: KernelModPackKindSchema,
  version: z.string().min(1),
  enabled: z.boolean(),
  provides: z.array(z.string().min(1)),
  specifier: z.string().min(1),
})
export type KernelModPackDescriptor = z.infer<typeof KernelModPackDescriptorSchema>

export const ModsListRequestSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
})
export type ModsListRequest = z.infer<typeof ModsListRequestSchema>

export const ModsListResponseSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  packs: z.array(KernelModPackDescriptorSchema),
})
export type ModsListResponse = z.infer<typeof ModsListResponseSchema>

export const ModsSetEnabledRequestSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  id: z.string().min(1),
  enabled: z.boolean(),
})
export type ModsSetEnabledRequest = z.infer<typeof ModsSetEnabledRequestSchema>

export const ModsSetEnabledResponseSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  ok: z.boolean(),
  reloadRequired: z.boolean(),
})
export type ModsSetEnabledResponse = z.infer<typeof ModsSetEnabledResponseSchema>

export const ModsInstallFromDirectoryRequestSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  directory: z.string().min(1),
})
export type ModsInstallFromDirectoryRequest = z.infer<
  typeof ModsInstallFromDirectoryRequestSchema
>

export const ModsInstallFromDirectoryResponseSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  pack: KernelModPackDescriptorSchema,
  reloadRequired: z.boolean(),
})
export type ModsInstallFromDirectoryResponse = z.infer<
  typeof ModsInstallFromDirectoryResponseSchema
>
