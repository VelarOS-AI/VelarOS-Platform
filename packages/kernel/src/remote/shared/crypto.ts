// Platform Kernel owns the host-neutral remote-node implementation.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto'

import { Log } from '@velaros-ai/core'

const log = Log.tag('RemoteNodeCrypto')

/**
 * 设备身份 = Ed25519 密钥对。
 *
 * 配对时 Client 只交出公钥;私钥永不上线,也永不进日志或协议帧。这是本传输与插件桥
 * (长期 bearer token 每次连接明文重发)的关键差别——跨机链路上不存在可重放的长期秘密。
 */
export interface RemoteNodeKeyPair {
  readonly publicKey: string
  readonly privateKey: string
}

export function generateRemoteNodeKeyPair(): RemoteNodeKeyPair {
  const pair = generateKeyPairSync('ed25519')
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' })
      .toString('base64'),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
  }
}

/** 每次连接一枚新 challenge,签名不可跨连接重放。 */
export function createChallenge(): string {
  return randomBytes(32).toString('base64url')
}

export function createPairingCode(): string {
  return String(randomInt(100_000, 1_000_000))
}

export function signChallenge(
  privateKey: string,
  challenge: string,
): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  return signBytes(null, Buffer.from(challenge, 'utf8'), key)
    .toString('base64')
}

/**
 * 校验签名。任何格式错误一律按「验签失败」返回 false,不抛——调用点只需要一个布尔判决,
 * 把畸形公钥和错误签名区分开只会给攻击者送信息。
 */
export function verifyChallengeSignature(
  publicKey: string,
  challenge: string,
  signature: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
    return verifyBytes(
      null,
      Buffer.from(challenge, 'utf8'),
      key,
      Buffer.from(signature, 'base64'),
    )
  } catch (error) {
    // 只记调试级:验签失败在正常运行里就是"未授权的人来敲门",按告警级记会让日志被扫描噪音淹没。
    // 注意别把 error 之外的任何东西带进日志——公钥与签名都是对端可控输入。
    log.debug('Remote node challenge signature rejected', { error })
    return false
  }
}

/** 进程纪元:每次启动重生成,Client 据此识别对端重启。 */
export function createEpoch(): string {
  return randomBytes(16).toString('base64url')
}

export function createClientId(): string {
  return `client-${randomBytes(12).toString('base64url')}`
}

export function createNodeId(): string {
  return `node-${randomBytes(12).toString('base64url')}`
}
