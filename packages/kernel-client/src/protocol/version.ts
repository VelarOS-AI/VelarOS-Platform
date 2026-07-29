/**
 * Kernel wire 协议主版本号。
 *
 * 版本常量独立于握手与能力 schema，避免二者互相 import。协议 v2 移除了内建
 * `bindWorkspace` 动词，改为通用能力模块发现与调用信封。
 */
export const KernelProtocolVersion = 2
