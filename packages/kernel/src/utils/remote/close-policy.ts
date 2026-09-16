// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:关闭码判决与重连退避——「还试不试」的那张表。
//
// 与 `./handshake` 是同一类文件:把决定从连接层的噪声里摘出来,单独一眼能看完。默认姿态是
// 重连;停手是例外,而且每一条例外都要说得出为什么重连没用。
//
// `Replaced` 归在停手一侧是照 remote-node 契约的判词(4003「不重连」):顶替我们的是同一个
// clientId 的另一条连接,抢回来只会两边互踢。
import { isUndefined } from '@velaros-ai/core'

import { RemoteNodeClientErrorCodes } from '../../contract/constants'
import type { RemoteNodeCloseAction } from '../../types/remote'
import { RemoteNodeClientError } from '../errors'
import { KernelTuning } from '../tuning'
import {
  RemoteNodeCloseCode,
  type RemoteNodeCloseCodeValue,
} from '../wire/remote-node'

const StopTable: Readonly<Record<number, {
  readonly code: RemoteNodeClientError['code']
  readonly message: string
  readonly clearCredentials: boolean
}>> = {
  [RemoteNodeCloseCode.ProtocolMismatch]: {
    clearCredentials: false,
    code: RemoteNodeClientErrorCodes.ProtocolMismatch,
    message: '远程节点关闭了连接：传输协议版本对不上',
  },
  [RemoteNodeCloseCode.Unauthorized]: {
    // 留着不被承认的凭据只会让下一次连接重复失败,清掉,把人引回配对。
    clearCredentials: true,
    code: RemoteNodeClientErrorCodes.Unauthorized,
    message: '远程节点拒绝了本客户端；请重新配对这台主机',
  },
  [RemoteNodeCloseCode.Replaced]: {
    clearCredentials: false,
    code: RemoteNodeClientErrorCodes.Superseded,
    message: '本连接被同一客户端的新连接顶替',
  },
}

/** 按关闭码判「还试不试」:表里有的停手(带因由与要不要清凭据),表外一律重连。 */
export function planRemoteNodeCloseAction(
  code: number | RemoteNodeCloseCodeValue,
): RemoteNodeCloseAction {
  const entry = StopTable[code]
  if (isUndefined(entry)) return { kind: 'reconnect' }
  return {
    kind: 'stop',
    clearCredentials: entry.clearCredentials,
    error: new RemoteNodeClientError({
      code: entry.code,
      message: entry.message,
      resultUnknown: false,
      retryable: false,
    }),
  }
}

/** 指数退避 + 抖动:多台 Client 同时掉线时不要在同一毫秒一起回来砸 Node。 */
export function computeReconnectDelayMs(attempt: number): number {
  const base = Math.min(
    KernelTuning.remoteClientReconnectInitialDelayMs
      * 2 ** Math.min(Math.max(attempt, 0), KernelTuning.remoteClientReconnectMaxExponent),
  )
  const jitter = base * KernelTuning.remoteClientReconnectJitterRatio * (Math.random() * 2 - 1)
  return Math.min(
    KernelTuning.remoteClientReconnectMaxDelayMs,
    Math.max(KernelTuning.remoteClientReconnectInitialDelayMs, Math.round(base + jitter)),
  )
}
