/** 录屏帧序列合成 GIF：帧间延迟按真实时间戳还原（clamp 防极端值）。 */

import gifenc from 'gifenc'

import { isEmpty, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { EncodeScreencastGifOptions, ScreencastCapturedFrame } from '../types/cdp.js'

import { BrowserTuning } from './tuning'

/** 把录屏帧序列合成 GIF；帧间延迟按真实时间戳还原（clamp 防极端值）。 */
export function encodeScreencastFramesToGif(
  frames: readonly ScreencastCapturedFrame[],
  options: EncodeScreencastGifOptions
): Buffer {
  if (isEmpty(frames)) {
    throw new AppError('EXECUTION_FAILED', '录屏没有采集到任何帧（页面无变化或已隐藏）。')
  }

  const maxWidth = options.maxWidth ?? BrowserTuning.screencast.gifMaxWidth
  const gif = gifenc.GIFEncoder()
  let encodedFrames = 0
  let canvasWidth = 0
  let canvasHeight = 0

  for (const [index, frame] of frames.entries()) {
    const decoded = options.decode(frame.bytes, maxWidth)
    if (!decoded) continue
    if (encodedFrames === 0) {
      canvasWidth = decoded.width
      canvasHeight = decoded.height
    } else if (decoded.width !== canvasWidth || decoded.height !== canvasHeight) {
      // 视口中途变化的帧直接跳过，保持画布稳定。
      continue
    }

    const nextTimestamp = frames[index + 1]?.timestamp
    const delayMs =
      isPresent(nextTimestamp)
        ? Math.min(
            BrowserTuning.screencast.maxFrameDelayMs,
            Math.max(BrowserTuning.screencast.minFrameDelayMs, Math.round((nextTimestamp - frame.timestamp) * 1000))
          )
        : BrowserTuning.screencast.lastFrameDelayMs

    const rgba = new Uint8ClampedArray(
      decoded.rgba.buffer,
      decoded.rgba.byteOffset,
      decoded.rgba.byteLength
    )
    const palette = gifenc.quantize(rgba, 256)
    const indexed = gifenc.applyPalette(rgba, palette)
    gif.writeFrame(indexed, decoded.width, decoded.height, { palette, delay: delayMs })
    encodedFrames += 1
  }

  if (encodedFrames === 0) {
    throw new AppError('EXECUTION_FAILED', '录屏帧全部解码失败，无法合成 GIF。')
  }

  gif.finish()
  return Buffer.from(gif.bytes())
}
