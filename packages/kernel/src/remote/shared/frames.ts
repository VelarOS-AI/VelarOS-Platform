// Platform Kernel owns the host-neutral remote-node implementation.
import { isString, isUndefined, Log } from '@velaros-ai/core'
import {
  type RemoteNodeClientFrame,
  RemoteNodeClientFrameSchema,
  RemoteNodeMaxFrameBytes,
  type RemoteNodeServerFrame,
  RemoteNodeServerFrameSchema,
} from '@velaros-ai/kernel/contracts/protocol'

const log = Log.tag('RemoteNodeFrames')

export type FrameDecodeResult<TFrame> =
  | { readonly ok: true, readonly frame: TFrame }
  | { readonly ok: false, readonly reason: string }

function decode<TFrame>(
  raw: unknown,
  parse: (input: unknown) => { success: boolean, data?: TFrame },
): FrameDecodeResult<TFrame> {
  if (!(raw instanceof Buffer) && !isString(raw)) return { ok: false, reason: 'Frame payload is neither text nor binary' }
  const text = raw.toString()
  if (Buffer.byteLength(text, 'utf8') > RemoteNodeMaxFrameBytes) return { ok: false, reason: 'Frame exceeds the protocol size limit' }
  let input: unknown
  try {
    input = JSON.parse(text) as unknown
  } catch {
    return { ok: false, reason: 'Frame is not valid JSON' }
  }
  const parsed = parse(input)
  if (!parsed.success || isUndefined(parsed.data)) return { ok: false, reason: 'Frame does not match the protocol schema' }
  return { ok: true, frame: parsed.data }
}

export function decodeClientFrame(
  raw: unknown,
): FrameDecodeResult<RemoteNodeClientFrame> {
  return decode(raw, (input) => RemoteNodeClientFrameSchema.safeParse(input))
}

export function decodeServerFrame(
  raw: unknown,
): FrameDecodeResult<RemoteNodeServerFrame> {
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
  frame: RemoteNodeClientFrame | RemoteNodeServerFrame,
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
