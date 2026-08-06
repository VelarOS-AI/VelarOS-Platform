// 域：可注入能力与模块的 wire 契约。
//
// Kernel 只理解模块生命周期、能力寻址、作用域句柄和调用信封；具体产品域协议由
// 各能力包自行定义，并把其 payload 放入本通用信封。
import { z } from 'zod'

import { KernelProtocolVersion } from './version'

/** 能力模块的进程隔离形态(宪章 Ring 0 第 9 项:部署决策的唯一表达位)。 */
export const CapabilityIsolationSchema = z.enum([
  'in-process',
  'worker',
  'remote',
  'sidecar',
])
export type CapabilityIsolation = z.infer<typeof CapabilityIsolationSchema>

/** 模块提供的稳定能力令牌；调用方依赖令牌，不依赖实现包。 */
export const CapabilityTokenSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
})
export type CapabilityToken = z.infer<typeof CapabilityTokenSchema>

/** 模块对另一能力令牌的版本化依赖。 */
export const CapabilityRequirementSchema = z.strictObject({
  id: z.string().min(1),
  versionRange: z.string().min(1).nullable(),
})
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>

/**
 * Kernel 通用作用域引用。
 *
 * `kind` 只用于模块自己的路由/诊断，Kernel 不枚举其值，也不内建任何产品空间。
 */
export const ScopeRefSchema = z.strictObject({
  id: z.string().min(1),
  ownerModuleId: z.string().min(1),
  kind: z.string().min(1).nullable(),
})
export type ScopeRef = z.infer<typeof ScopeRefSchema>

/** 模块拥有的资源句柄；本地路径、页面实例或数据库主键不穿透信任边界。 */
export const ResourceRefSchema = z.strictObject({
  id: z.string().min(1),
  ownerModuleId: z.string().min(1),
  scope: ScopeRefSchema.nullable(),
  mediaType: z.string().min(1).nullable(),
})
export type ResourceRef = z.infer<typeof ResourceRefSchema>

/** 可注入模块的完整发现描述符。 */
export const KernelModuleDescriptorSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.number().int().positive(),
  provides: z.array(CapabilityTokenSchema),
  requires: z.array(CapabilityRequirementSchema),
  optionalRequires: z.array(CapabilityRequirementSchema),
  permissions: z.array(z.string().min(1)),
  isolation: CapabilityIsolationSchema,
  catalogRevision: z.string().min(1),
})
export type KernelModuleDescriptor = z.infer<typeof KernelModuleDescriptorSchema>

/**
 * 通用能力调用请求。
 *
 * `input` 的精确 schema 归能力协议包；Kernel Host 只校验和路由外层信封。
 */
export const CapabilityCallRequestSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  callId: z.string().min(1),
  /** 通过 `capability.session.open` 绑定该能力的 capability session。 */
  sessionId: z.string().min(1),
  capabilityId: z.string().min(1),
  operation: z.string().min(1),
  scope: ScopeRefSchema.nullable(),
  input: z.unknown(),
})
export type CapabilityCallRequest = z.infer<typeof CapabilityCallRequestSchema>

export const CapabilityCallErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).nullable(),
})
export type CapabilityCallError = z.infer<typeof CapabilityCallErrorSchema>

export const CapabilityCallSuccessSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  callId: z.string().min(1),
  status: z.literal('ok'),
  output: z.unknown(),
})
export type CapabilityCallSuccess = z.infer<typeof CapabilityCallSuccessSchema>

export const CapabilityCallFailureSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  callId: z.string().min(1),
  status: z.literal('error'),
  error: CapabilityCallErrorSchema,
})
export type CapabilityCallFailure = z.infer<typeof CapabilityCallFailureSchema>

export const CapabilityCallResponseSchema = z.discriminatedUnion('status', [
  CapabilityCallSuccessSchema,
  CapabilityCallFailureSchema,
])
export type CapabilityCallResponse = z.infer<typeof CapabilityCallResponseSchema>

/**
 * 场景级能力绑定条目。
 *
 * `operations` 为 `null` 表示该能力下全部操作；非空数组则仅覆盖列出的 operation。
 */
export const CapabilityRequireItemSchema = z.strictObject({
  capabilityId: z.string().min(1),
  operations: z.array(z.string().min(1)).nullable(),
  scope: ScopeRefSchema.nullable(),
})
export type CapabilityRequireItem = z.infer<typeof CapabilityRequireItemSchema>

/**
 * 打开能力会话：一次声明本连接场景需要的能力集。
 *
 * 只绑定已装载能力；未装载返回 CAPABILITY_NOT_AVAILABLE。断连后会话失效。
 */
export const CapabilitySessionOpenRequestSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  requires: z.array(CapabilityRequireItemSchema).min(1),
})
export type CapabilitySessionOpenRequest = z.infer<
  typeof CapabilitySessionOpenRequestSchema
>

export const CapabilitySessionOpenSuccessSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  status: z.literal('ok'),
  sessionId: z.string().min(1),
  requires: z.array(CapabilityRequireItemSchema),
})
export type CapabilitySessionOpenSuccess = z.infer<
  typeof CapabilitySessionOpenSuccessSchema
>

export const CapabilitySessionOpenFailureSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  status: z.literal('error'),
  error: CapabilityCallErrorSchema,
})
export type CapabilitySessionOpenFailure = z.infer<
  typeof CapabilitySessionOpenFailureSchema
>

export const CapabilitySessionOpenResponseSchema = z.discriminatedUnion(
  'status',
  [CapabilitySessionOpenSuccessSchema, CapabilitySessionOpenFailureSchema],
)
export type CapabilitySessionOpenResponse = z.infer<
  typeof CapabilitySessionOpenResponseSchema
>

export const CapabilitySessionCloseRequestSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  sessionId: z.string().min(1),
})
export type CapabilitySessionCloseRequest = z.infer<
  typeof CapabilitySessionCloseRequestSchema
>

export const CapabilitySessionCloseResponseSchema = z.strictObject({
  protocolVersion: z.literal(KernelProtocolVersion),
  closed: z.boolean(),
})
export type CapabilitySessionCloseResponse = z.infer<
  typeof CapabilitySessionCloseResponseSchema
>
