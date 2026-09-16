// 域：kernel 协议握手可接受性判定（逻辑层，宪章 §1 能力协商）。
//
// 握手 schema 先读出对端版本，再由本层做精确版本判定并给出升级方向。
// 不接受历史版本，也不维护滑动兼容窗口。
import type { KernelHandshake } from './handshake'
import { KernelProtocolVersion } from './version'

/** 握手判定结果：接受，或带升级指引的拒绝（`reason` 指出哪一侧过时）。 */
export type KernelProtocolNegotiation =
  | {
      status: 'accepted'
      localVersion: number
      peerVersion: number
    }
  | {
      status: 'rejected'
      /** `peer-too-old`：须对端升级；`peer-too-new`：须本端升级。 */
      reason: 'peer-too-old' | 'peer-too-new'
      localVersion: number
      peerVersion: number
      /** 面向操作者的升级指引（哪一侧该升到哪个版本）。 */
      guidance: string
    }

/**
 * 只有与本端完全相同的协议版本才接受。
 *
 * @param handshake 对端上报的握手（只读 `protocolVersion`；schema 已放宽故任意正整数版本都能先解析出来）。
 * @param localVersion 本端协议版本，缺省 {@link KernelProtocolVersion}。
 */
export function negotiateKernelProtocol(
  handshake: Pick<KernelHandshake, 'protocolVersion'>,
  localVersion: number = KernelProtocolVersion
): KernelProtocolNegotiation {
  const peerVersion = handshake.protocolVersion
  if (peerVersion < localVersion) return {
      status: 'rejected',
      reason: 'peer-too-old',
      localVersion,
      peerVersion,
      guidance: `对端协议 v${peerVersion} 低于本端 v${localVersion}，请对端升级。`,
    }
  if (peerVersion > localVersion) return {
      status: 'rejected',
      reason: 'peer-too-new',
      localVersion,
      peerVersion,
      guidance: `对端协议 v${peerVersion} 高于本端 v${localVersion}，请升级本端 VelarOS。`,
    }
  return { status: 'accepted', localVersion, peerVersion }
}

/** 便捷判定：对端握手是否与本端版本精确一致。 */
export function isKernelProtocolAccepted(
  handshake: Pick<KernelHandshake, 'protocolVersion'>,
  localVersion: number = KernelProtocolVersion
): boolean {
  return negotiateKernelProtocol(handshake, localVersion).status === 'accepted'
}
