// Platform Kernel 统一持有与宿主无关的远程节点实现。
import { isString, isUndefined, Log } from '@velaros-ai/core'

import type { FrameDecodeResult } from '../../types/remote'
import {
  type RemoteNodeClientFrame,
  RemoteNodeClientFrameSchema,
  RemoteNodeMaxFrameBytes,
  type RemoteNodeServerFrame,
  RemoteNodeServerFrameSchema,
} from '../wire/remote-node'

const log = Log.tag('RemoteNodeFrames')

/** 把一帧原始载荷解成协议帧:先判类型与体积,再解 JSON,最后过 schema;任何一步失败都给可读因由。 */
function decode<TFrame>(
  raw: unknown,
  parse: (input: unknown) => { success: boolean; data?: TFrame }
): FrameDecodeResult<TFrame> {
  if (!(raw instanceof Buffer) && !isString(raw))
    return { ok: false, reason: '帧的载荷既不是文本也不是二进制' }
  const text = raw.toString()
  if (Buffer.byteLength(text, 'utf8') > RemoteNodeMaxFrameBytes)
    return { ok: false, reason: '帧超过了协议的体积上限' }
  let input: unknown
  try {
    input = JSON.parse(text) as unknown
  } catch {
    return { ok: false, reason: '帧不是合法 JSON' }
  }
  const parsed = parse(input)
  if (!parsed.success || isUndefined(parsed.data))
    return { ok: false, reason: '帧不符合协议 schema' }
  return { ok: true, frame: parsed.data }
}

/** 解一帧 Client 发来的报文(Node 侧收帧用);解不开只返回因由,不抛。 */
export function decodeClientFrame(raw: unknown): FrameDecodeResult<RemoteNodeClientFrame> {
  return decode(raw, (input) => RemoteNodeClientFrameSchema.safeParse(input))
}

/** 解一帧 Node 发来的报文(Client 侧收帧用);解不开只返回因由,不抛。 */
export function decodeServerFrame(raw: unknown): FrameDecodeResult<RemoteNodeServerFrame> {
  return decode(raw, (input) => RemoteNodeServerFrameSchema.safeParse(input))
}

/**
 * 序列化并投递一帧。
 *
 * 序列化失败(能力输出里混进了循环引用或 BigInt)必须当成本帧失败,而不是让异常穿透到
 * 连接层把整条链路打死——一个坏结果不该带走其它在途调用。
 */
export function sendFrame(
  socket: { send(data: string): void },
  frame: RemoteNodeClientFrame | RemoteNodeServerFrame
): boolean {
  let text: string
  try {
    text = JSON.stringify(frame)
  } catch (error) {
    log.warn('Remote node frame could not be serialized', {
      error,
      type: frame.type,
    })
    return false
  }
  if (Buffer.byteLength(text, 'utf8') > RemoteNodeMaxFrameBytes) {
    log.warn('Remote node frame exceeds the protocol size limit', {
      type: frame.type,
    })
    return false
  }
  try {
    socket.send(text)
    return true
  } catch (error) {
    log.debug('Remote node frame could not be written', {
      error,
      type: frame.type,
    })
    return false
  }
}
