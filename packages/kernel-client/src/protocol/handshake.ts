// 域：协议版本与能力协商握手（宪章 §1 能力协商）。
import { z } from 'zod'

import { KernelModuleDescriptorSchema } from './capability'
import { KernelProtocolVersion } from './version'

/**
 * kernel 协议主版本号。
 *
 * 同一 major 内 wire 形状**只增不改**（见 README）：新增字段走可选/新 entry 类型，
 * 已发布字段与语义在同 major 内冻结。老包配新 kernel 必须能跑（协商降能力），
 * 新包配老 kernel 必须拒载。
 */
export { KernelProtocolVersion }

/**
 * 握手形状：连接建立时 kernel 上报的协议版本、kernel 版本与能力清单。
 *
 * `protocolVersion` 是**对端自报的版本号**，故校验放到 `z.number().int().positive()`——不用 `z.literal`
 * 钉死。理由（修「版本协商自败」）：literal 钉死会让异版本对端的握手在 schema 层就**拒绝解析**，可接受性
 * 判定还没跑就先自败；握手帧必须能先被读出对端版本，兼容与否交给逻辑层的滑动窗口判定
 * （`negotiateKernelProtocol`，见同目录 negotiation.ts）。`z.literal(KernelProtocolVersion)` 只保留在**协商后**流转的
 * 载荷帧（工具信封 / 目录快照 / 租约拒绝）上——那些帧已在协商成功之后，必须逐帧盖章精确匹配。
 */
export const KernelHandshakeSchema = z.strictObject({
  protocolVersion: z.number().int().positive(),
  kernelVersion: z.string(),
  modules: z.array(KernelModuleDescriptorSchema),
})
export type KernelHandshake = z.infer<typeof KernelHandshakeSchema>
