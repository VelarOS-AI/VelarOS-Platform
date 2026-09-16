// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:握手判决——从一枚 challenge 到「签名 / 配对 / 停手」三选一。
//
// 抽成纯函数是为了让这张判定表可以单独盯:授权是这条跨机链路唯一的门,它的分支不该埋在
// 连接层的重连噪声里。函数只读入参、只产出决定,不碰 socket 也不碰落盘。
//
// 私钥出现在本文件的唯一形式是「进 signChallenge 产出一段签名」;新生成的密钥对随
// `pair` 决定一起交还调用方,由调用方在 `paired` 到达后才落盘——配对没成就该被丢掉。
import { isNonBlankString, isNumber, isPresent, isRecord, Log } from '@velaros-ai/core'

import { RemoteNodeClientErrorCodes } from '../../contract/constants'
import type {
  RemoteNodeHandshakeInput,
  RemoteNodeHandshakeStep,
} from '../../types/remote'
import { RemoteNodeClientError } from '../errors'
import {
  type RemoteNodePlatform,
  RemoteNodePlatformSchema,
  RemoteNodeProtocolVersion,
} from '../wire/remote-node'

import { generateRemoteNodeKeyPair, signChallenge } from './crypto'

const log = Log.tag('RemoteNodeHandshake')

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
        message: `远程节点说的是传输协议 v${input.challenge.protocolVersion}，本客户端说的是 v${RemoteNodeProtocolVersion}`,
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
        message: '远程节点需要配对；请提供 6 位配对码',
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

/** Node 侧只认三种平台;本机不在其列时按 darwin 上报,握手不该因为一个展示字段失败。 */
export function resolveRemoteNodeHostPlatform(): RemoteNodePlatform {
  const platform = process.platform
  if (platform === 'linux' || platform === 'win32') return platform
  return 'darwin'
}

/** Node 自报平台;不在协议认得的三种之内直接抛,监听端不该带着一个说不清的身份上线。 */
export function resolveRemoteNodePlatform(): RemoteNodePlatform {
  const parsed = RemoteNodePlatformSchema.safeParse(process.platform)
  if (!parsed.success) {
    throw new Error(`远程节点不支持 ${process.platform} 这个平台`)
  }
  return parsed.data
}

/**
 * 从一帧解不开的报文里捞出「这是一帧版本不符的 hello」,捞不出就是 `null`。
 *
 * 必要之恶:`RemoteNodeClientFrameSchema` 用 `z.literal` 把版本钉死,版本不符的 hello 连
 * discriminated union 都进不去,只会得到一句「不匹配 schema」。要给对端一个明确的升级方向,
 * 只能在这里对原文做一次窄范围窥视——窥视结果只用于报错,不参与任何授权判断。
 */
export function readMismatchedHelloVersion(raw: { toString(): string }): Nullable<number> {
  let value: unknown
  try {
    value = JSON.parse(raw.toString()) as unknown
  } catch (error) {
    log.debug('远程节点的帧不是合法 JSON', { error })
    return null
  }
  if (!isRecord(value) || value.type !== 'hello') return null
  const version = value.protocolVersion
  return isNumber(version) && version !== RemoteNodeProtocolVersion ? version : null
}
