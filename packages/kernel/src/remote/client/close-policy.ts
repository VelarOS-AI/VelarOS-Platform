// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:关闭码判决与重连退避——「还试不试」的那张表。
//
// 与 `./handshake` 是同一类文件:把决定从连接层的噪声里摘出来,单独一眼能看完。默认姿态是
// 重连;停手是例外,而且每一条例外都要说得出为什么重连没用。
//
// `Replaced` 归在停手一侧是照 remote-node 契约的判词(4003「不重连」):顶替我们的是同一个
// clientId 的另一条连接,抢回来只会两边互踢。
import { isUndefined } from '@velaros-ai/core'
import {
  RemoteNodeCloseCode,
  type RemoteNodeCloseCodeValue,
} from '@velaros-ai/kernel/contracts/protocol'

import {
  RemoteNodeClientError,
  RemoteNodeClientErrorCodes,
  RemoteNodeReconnectInitialDelayMs,
  RemoteNodeReconnectJitterRatio,
  RemoteNodeReconnectMaxDelayMs,
} from './contracts'

/** 退避指数上限:500ms << 6 已越过 30s 天花板,再涨只是让数字难看。 */
const MaxBackoffExponent = 6

export type RemoteNodeCloseAction =
  | { readonly kind: 'reconnect' }
  | {
      readonly kind: 'stop'
      readonly error: RemoteNodeClientError
      /** 停手同时该不该把本机凭据一并清掉(Node 已经不认它了)。 */
      readonly clearCredentials: boolean
    }

const StopTable: Readonly<Record<number, {
  readonly code: RemoteNodeClientError['code']
  readonly message: string
  readonly clearCredentials: boolean
}>> = {
  [RemoteNodeCloseCode.ProtocolMismatch]: {
    clearCredentials: false,
    code: RemoteNodeClientErrorCodes.ProtocolMismatch,
    message: 'Remote node closed the connection: transport protocol mismatch',
  },
  [RemoteNodeCloseCode.Unauthorized]: {
    // 留着不被承认的凭据只会让下一次连接重复失败,清掉,把人引回配对。
    clearCredentials: true,
    code: RemoteNodeClientErrorCodes.Unauthorized,
    message: 'Remote node rejected this client; pair the host again',
  },
  [RemoteNodeCloseCode.Replaced]: {
    clearCredentials: false,
    code: RemoteNodeClientErrorCodes.Superseded,
    message: 'Remote node connection was replaced by a newer one from this client',
  },
}

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
    RemoteNodeReconnectMaxDelayMs,
    RemoteNodeReconnectInitialDelayMs
      * 2 ** Math.min(Math.max(attempt, 0), MaxBackoffExponent),
  )
  const jitter = base * RemoteNodeReconnectJitterRatio * (Math.random() * 2 - 1)
  return Math.max(RemoteNodeReconnectInitialDelayMs, Math.round(base + jitter))
}
