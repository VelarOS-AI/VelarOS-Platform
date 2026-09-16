// 域：协议版本与能力协商握手（宪章 §1 能力协商）。
import { z } from 'zod'

import { KernelModuleDescriptorSchema } from './capability'
import { KernelProtocolVersion } from './version'

/**
 * kernel 协议主版本号。
 *
 * 每个版本只接受完全相同的 wire 版本。协议变化直接提升版本，旧数据不在运行时迁移。
 */
export { KernelProtocolVersion }

/**
 * 握手形状：连接建立时 kernel 上报的协议版本、kernel 版本与能力清单。
 *
 * `protocolVersion` 是**对端自报的版本号**，故校验放到 `z.number().int().positive()`——不用 `z.literal`
 * 钉死。异版本握手仍需先解析出版本号，才能由 `negotiateKernelProtocol` 返回明确升级方向；
 * 其余载荷帧全部用 `z.literal(KernelProtocolVersion)` 精确匹配。
 */
export const KernelHandshakeSchema = z.strictObject({
  protocolVersion: z.number().int().positive(),
  kernelVersion: z.string(),
  modules: z.array(KernelModuleDescriptorSchema),
})
export type KernelHandshake = z.infer<typeof KernelHandshakeSchema>
