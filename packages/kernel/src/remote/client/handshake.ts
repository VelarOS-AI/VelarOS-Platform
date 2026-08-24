// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:握手判决——从一枚 challenge 到「签名 / 配对 / 停手」三选一。
//
// 抽成纯函数是为了让这张判定表可以单独盯:授权是这条跨机链路唯一的门,它的分支不该埋在
// 连接层的重连噪声里。函数只读入参、只产出决定,不碰 socket 也不碰落盘。
//
// 私钥出现在本文件的唯一形式是「进 signChallenge 产出一段签名」;新生成的密钥对随
// `pair` 决定一起交还调用方,由调用方在 `paired` 到达后才落盘——配对没成就该被丢掉。
import { isNonBlankString, isPresent } from '@velaros-ai/core'
import type {
  RemoteNodeAuthenticate,
  RemoteNodeChallenge,
  RemoteNodePair,
} from '@velaros-ai/kernel/contracts/protocol'
import { RemoteNodeProtocolVersion } from '@velaros-ai/kernel/contracts/protocol'

import {
  generateRemoteNodeKeyPair,
  type RemoteNodeKeyPair,
  signChallenge,
} from '../shared/crypto'

import {
  RemoteNodeClientError,
  RemoteNodeClientErrorCodes,
  type RemoteNodeCredentials,
} from './contracts'

export type RemoteNodeHandshakeStep =
  | { readonly kind: 'authenticate', readonly frame: RemoteNodeAuthenticate }
  | {
      readonly kind: 'pair'
      readonly frame: RemoteNodePair
      readonly keyPair: RemoteNodeKeyPair
    }
  | { readonly kind: 'stop', readonly error: RemoteNodeClientError }

export interface RemoteNodeHandshakeInput {
  readonly challenge: RemoteNodeChallenge
  readonly credentials: Nullable<RemoteNodeCredentials>
  readonly pairingCode: LooseOptional<string>
}

/**
 * 判定本次 challenge 该怎么应答。
 *
 * 两个"需要重新配对"的入口刻意合并:全新设备,和本机凭据已丢而 Node 还记着旧公钥——
 * 后者从 Client 视角与前者无异,都只能重做人工仪式,分开处理只会多一条走不到的分支。
 */
export function planRemoteNodeHandshake(
  input: RemoteNodeHandshakeInput,
): RemoteNodeHandshakeStep {
  if (input.challenge.protocolVersion !== RemoteNodeProtocolVersion) return {
      kind: 'stop',
      error: new RemoteNodeClientError({
        code: RemoteNodeClientErrorCodes.ProtocolMismatch,
        message: `Remote node speaks transport version ${input.challenge.protocolVersion}, this client speaks ${RemoteNodeProtocolVersion}`,
        resultUnknown: false,
        retryable: false,
      }),
    }

  const credentials = input.credentials
  if (input.challenge.paired && isPresent(credentials)) return {
      kind: 'authenticate',
      frame: {
        type: 'authenticate',
        signature: signChallenge(
          credentials.privateKey,
          input.challenge.challenge,
        ),
      },
    }

  const pairingCode = input.pairingCode
  if (!isNonBlankString(pairingCode)) return {
      kind: 'stop',
      error: new RemoteNodeClientError({
        code: RemoteNodeClientErrorCodes.PairingRequired,
        message: 'Remote node requires pairing; supply a 6-digit pairing code',
        resultUnknown: false,
        retryable: false,
      }),
    }

  const keyPair = generateRemoteNodeKeyPair()
  return {
    kind: 'pair',
    keyPair,
    frame: {
      type: 'pair',
      pairingCode: pairingCode.trim(),
      publicKey: keyPair.publicKey,
    },
  }
}
