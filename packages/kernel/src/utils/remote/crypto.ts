// Platform Kernel 统一持有与宿主无关的远程节点实现。
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
} from 'node:crypto'

import { Log } from '@velaros-ai/core'

import type { RemoteNodeKeyPair } from '../../types/remote'

const log = Log.tag('RemoteNodeCrypto')

/**
 * 新生成一对设备身份密钥(Ed25519)。
 *
 * 配对时 Client 只交出公钥;私钥永不上线,也永不进日志或协议帧。这是本传输与插件桥
 * (长期 bearer token 每次连接明文重发)的关键差别——跨机链路上不存在可重放的长期秘密。
 */
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

/** 摇一枚六位配对码;用 `randomInt` 而不是 `Math.random`,它是一次性人工仪式里的唯一秘密。 */
export function createPairingCode(): string {
  return String(randomInt(100_000, 1_000_000))
}

/** 定长常数时间比较配对码:长度不等直接判否,避免 `timingSafeEqual` 因长度差异抛出。 */
export function remoteNodeCodesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes)
}

/** 用私钥给一枚 challenge 签名,返回 base64 签名串;私钥不进日志也不进返回值。 */
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

/** 本机在这条链路上的身份;只在没有凭据时生成一次,之后随凭据一起落盘。 */
export function createClientId(): string {
  return `client-${randomBytes(12).toString('base64url')}`
}

/** Node 的长期身份;宿主没指定 nodeId 时用它,重启不变的那部分由宿主自己保存。 */
export function createNodeId(): string {
  return `node-${randomBytes(12).toString('base64url')}`
}
