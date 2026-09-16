/**
 * Kernel wire 协议主版本号，等于 `KernelVersionAxes.protocol`。
 *
 * 版本常量独立于握手与能力 schema，免得两者互相 import。协议 v2 移除了内建的具体能力动词，
 * 改成通用的能力模块发现与调用信封。
 */
import { KernelVersionAxes } from '../../contract/constants'

/** 本机 RPC 的 wire 协议主版本；两端必须完全相同。 */
export const KernelProtocolVersion = KernelVersionAxes.protocol
