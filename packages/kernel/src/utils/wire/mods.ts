import { z } from 'zod'

import type {
  KernelModPackDescriptor,
  KernelModPackKind,
  ModsInstallFromDirectoryRequest,
  ModsInstallFromDirectoryResponse,
  ModsListRequest,
  ModsListResponse,
  ModsSetEnabledRequest,
  ModsSetEnabledResponse,
} from '../../types/wire'

import { KernelProtocolVersion } from './version'

export type {
  KernelModPackDescriptor,
  KernelModPackKind,
  ModsInstallFromDirectoryRequest,
  ModsInstallFromDirectoryResponse,
  ModsListRequest,
  ModsListResponse,
  ModsSetEnabledRequest,
  ModsSetEnabledResponse,
} from '../../types/wire'

export const KernelModPackKindSchema = z.enum(['system', 'user', 'contrib']) satisfies z.ZodType<KernelModPackKind>

export const KernelModPackDescriptorSchema = z.strictObject({
  id: z.string().min(1),
  kind: KernelModPackKindSchema,
  version: z.string().min(1),
  enabled: z.boolean(),
  provides: z.array(z.string().min(1)),
  specifier: z.string().min(1),
}) satisfies z.ZodType<KernelModPackDescriptor>

export const ModsListRequestSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
}) satisfies z.ZodType<ModsListRequest>

export const ModsListResponseSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  packs: z.array(KernelModPackDescriptorSchema),
}) satisfies z.ZodType<ModsListResponse>

export const ModsSetEnabledRequestSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  id: z.string().min(1),
  enabled: z.boolean(),
}) satisfies z.ZodType<ModsSetEnabledRequest>

export const ModsSetEnabledResponseSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  ok: z.boolean(),
  reloadRequired: z.boolean(),
}) satisfies z.ZodType<ModsSetEnabledResponse>

export const ModsInstallFromDirectoryRequestSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  directory: z.string().min(1),
}) satisfies z.ZodType<ModsInstallFromDirectoryRequest>

export const ModsInstallFromDirectoryResponseSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  pack: KernelModPackDescriptorSchema,
  reloadRequired: z.boolean(),
}) satisfies z.ZodType<ModsInstallFromDirectoryResponse>
