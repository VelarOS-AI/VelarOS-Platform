// Platform Kernel 统一持有与宿主无关的远程节点实现。
// 域:`RemoteNodeSocket` 端口的默认实现——Electron 主进程里的 `ws`。
//
// 单独成文件是为了把对 `ws` 的编译期依赖收在一处:测试与未来的替代传输注入自己的
// factory 即可,不必把整包拖上 `ws` 的类型。
import { WebSocket } from 'ws'

import { isPresent } from '@velaros-ai/core'

import type { RemoteNodeSocket, RemoteNodeSocketFactory } from '../../contract/requires'
/**
 * 建立到 Node 的 WebSocket。
 *
 * 单帧上限交给协议层判定(见 shared/frames 的 `RemoteNodeMaxFrameBytes` 校验),这里不再设
 * `maxPayload`:截图类输出本就按图片体量走同一条连接,socket 层提前砍会把可诊断的协议
 * 拒绝退化成无来由的断链。
 */
export const createRemoteNodeWebSocket: RemoteNodeSocketFactory = (
  url: string,
): RemoteNodeSocket => new WebSocket(url)

/** 摘掉一条 socket 上的全部监听;换连接前必须先摘,否则旧 socket 的 close 会干扰新连接。 */
export function detachRemoteNodeSocket(
  socket: LooseOptional<RemoteNodeSocket>,
): void {
  if (!isPresent(socket)) return
  socket.removeAllListeners()
}
