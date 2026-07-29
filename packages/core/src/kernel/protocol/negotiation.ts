// 域：kernel 协议握手可接受性判定（逻辑层，宪章 §1 能力协商）。
//
// 握手 schema 已放宽到 `z.number().int().positive()`——它让异版本对端的握手**能被读出**。可接受性**判定**
// 是逻辑，归本层。滑动窗口 N±1：kernel N 兼容 pack N±1，窗外拒载并给升级指引（哪一侧该升）。
// 纯函数、无 IO——判定即数据，客户端连接校验与 Kernel 内部 runtime 共用同一份判定。
import type { KernelHandshake } from './handshake'
import { KernelProtocolVersion } from './version'

/**
 * 协议兼容滑动窗口半径：本端 N 兼容对端 N±1。
 *
 * 这是**逻辑层策略常数**（不是逐帧盖章的 wire 常量，故不进 wire schema）。放宽/收紧窗口是协商策略演进，
 * 不改 wire 形状。
 */
export const KernelProtocolCompatibilityRadius = 1

/** 握手判定结果：接受，或带升级指引的拒绝（`reason` 指出哪一侧过时）。 */
export type KernelProtocolNegotiation =
  | {
      status: 'accepted'
      localVersion: number
      peerVersion: number
    }
  | {
      status: 'rejected'
      /** `peer-too-old`：对端低于窗口下界，须对端升级；`peer-too-new`：对端高于上界，须本端升级。 */
      reason: 'peer-too-old' | 'peer-too-new'
      localVersion: number
      peerVersion: number
      /** 面向操作者的升级指引（哪一侧该升到哪个版本）。 */
      guidance: string
    }

/**
 * 判定对端握手的协议版本可否被本端接受（滑动窗口 N±1）。
 *
 * @param handshake 对端上报的握手（只读 `protocolVersion`；schema 已放宽故任意正整数版本都能先解析出来）。
 * @param localVersion 本端协议版本，缺省 {@link KernelProtocolVersion}。
 * @param radius 兼容窗口半径，缺省 {@link KernelProtocolCompatibilityRadius}。
 */
export function negotiateKernelProtocol(
  handshake: Pick<KernelHandshake, 'protocolVersion'>,
  localVersion: number = KernelProtocolVersion,
  radius: number = KernelProtocolCompatibilityRadius
): KernelProtocolNegotiation {
  const peerVersion = handshake.protocolVersion
  if (peerVersion < localVersion - radius) return {
      status: 'rejected',
      reason: 'peer-too-old',
      localVersion,
      peerVersion,
      guidance: `对端协议 v${peerVersion} 低于本端 v${localVersion} 的兼容下界 v${localVersion - radius}，请对端升级。`,
    }
  if (peerVersion > localVersion + radius) return {
      status: 'rejected',
      reason: 'peer-too-new',
      localVersion,
      peerVersion,
      guidance: `对端协议 v${peerVersion} 高于本端 v${localVersion} 的兼容上界 v${localVersion + radius}，请升级本端 VelarOS。`,
    }
  return { status: 'accepted', localVersion, peerVersion }
}

/** 便捷判定：对端握手是否落在兼容窗口内。 */
export function isKernelProtocolAccepted(
  handshake: Pick<KernelHandshake, 'protocolVersion'>,
  localVersion: number = KernelProtocolVersion,
  radius: number = KernelProtocolCompatibilityRadius
): boolean {
  return negotiateKernelProtocol(handshake, localVersion, radius).status === 'accepted'
}
