import { createHash, timingSafeEqual } from 'node:crypto'
import { lstat, unlink } from 'node:fs/promises'
import type { AddressInfo, Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isNull, isUndefined, Log } from '@velaros-ai/core'

import type { KernelRpcEndpoint } from '../../types/kernel.js'
import type { KernelRpcServerFrame } from '../../types/wire.js'
import { isNodeError } from '../fs'

const log = Log.tag('KernelRpcEndpoint')

/** 让服务端在指定端点上开始监听；监听成功或失败都只结算一次。 */
export function listenOnKernelRpcEndpoint(
  server: Server,
  endpoint: KernelRpcEndpoint
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    if (endpoint.kind === 'unix') {
      server.listen(endpoint.path)
    } else {
      server.listen(endpoint.port, endpoint.host)
    }
  })
}

/** 监听起来之后回真正绑上的端点：unix 就是请求的那个，tcp 要把内核分配的端口填回去。 */
export function resolveBoundKernelRpcEndpoint(
  server: Server,
  requested: KernelRpcEndpoint
): KernelRpcEndpoint {
  if (requested.kind === 'unix') return requested
  const address = server.address() as Nullable<AddressInfo>
  if (isNull(address)) throw new Error('Kernel RPC 服务端没有地址')
  return {
    kind: 'tcp',
    host: '127.0.0.1',
    port: address.port,
  }
}

/** 关掉服务端；本来就没在监听时直接返回。 */
export function closeKernelRpcServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (isUndefined(error)) resolve()
      else reject(error)
    })
  })
}

/** 删掉上一轮留下的 socket 文件；路径上不是 socket 就拒绝覆盖，文件不在则当作没事。 */
export async function removeStaleKernelRpcSocket(path: string): Promise<void> {
  try {
    const stats = await lstat(path)
    if (!stats.isSocket()) {
      throw new Error(`Kernel RPC 路径 "${path}" 不是 socket，拒绝覆盖`)
    }
    await unlink(path)
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
  }
}

/**
 * 常数时间比较两个认证令牌。
 *
 * 先各取 SHA-256 摘要再比：摘要长度固定，`timingSafeEqual` 不会因为长度不同而抛错，比较耗时
 * 也不随「前几个字符对上了几个」变化，令牌猜不出来。
 */
export function kernelRpcTokensMatch(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest()
  const rightDigest = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

/** 往连接上写一帧换行分隔的 JSON；序列化不了或写不出去时记一条日志并回 false。 */
export function sendKernelRpcFrame(socket: Socket, frame: KernelRpcServerFrame): boolean {
  try {
    socket.write(`${JSON.stringify(frame)}\n`)
    return true
  } catch (error) {
    log.warn('Kernel RPC 的响应帧序列化或写出失败', { error })
    return false
  }
}

/** 按平台折一个缺省的本机 RPC 端点：Windows 走回环 TCP，其余走临时目录下的 unix socket。 */
export function createDefaultKernelRpcEndpoint(name: string = 'velaros-kernel'): KernelRpcEndpoint {
  if (process.platform === 'win32') return { kind: 'tcp', host: '127.0.0.1', port: 0 }
  const safeName = name.replaceAll(/[^a-zA-Z0-9._-]/g, '-')
  return {
    kind: 'unix',
    path: join(tmpdir(), `${safeName}-${process.pid}.sock`),
  }
}
