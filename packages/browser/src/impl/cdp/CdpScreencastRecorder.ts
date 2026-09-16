/// <reference path="../../gifenc.d.ts" />
import gifenc from 'gifenc'

import { isEmpty, isFalse, isNumber, isPresent, isString } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type { CdpScreencastConsumerOptions, CdpScreencastFrameEvent, CdpScreencastStartOptions, CdpTraceTransport,EncodeScreencastGifOptions, ScreencastCapturedFrame } from '../../types/cdp.js'
import { BrowserTuning } from '../../utils/tuning'

/**
 * 页面录屏（CDP Page.startScreencast）。
 *
 * 帧流按需产生（页面有变化才有帧），每帧必须 ack 才有下一帧；
 * 复用 CdpTraceTransport 会话面，webview 与外部 CDP 浏览器两条路径共用。
 * 产物合成走 GIF：聊天/文件系统里点开即播，不依赖播放器。
 */

export const DefaultScreencastStartOptions: CdpScreencastStartOptions = {
  maxWidth: 800,
  maxHeight: 1200,
  everyNthFrame: 2,
  maxFrames: 600,
}

/**
 * 录屏采集器：经 CDP `Page.startScreencast` 收帧，停录时把帧序列交出去合成 GIF。
 *
 * 一次录制一个实例；帧只在内存里攒，超过上限就停下来如实回报「帧数到顶了」，不悄悄丢中间的帧。
 */
export interface CdpScreencastRecorderApi {
  /** 现在是不是正在录。 */
  isRunning(): boolean
  /** 开始录。 */
  start(options: CdpScreencastStartOptions): Promise<void>
  /** 停止录制并取回全部帧。 */
  stop(): Promise<{ frames: ScreencastCapturedFrame[]; frameLimitReached: boolean }>
  /** 尽力终止（会话关闭/dispose 清理用）。 */
  abort(): Promise<void>
}

export class CdpScreencastRecorder implements CdpScreencastRecorderApi {
  private frames: ScreencastCapturedFrame[] = []
  private capturedFrameCount = 0
  private unsubscribe: Nullable<() => void> = null
  private running = false
  private frameLimitReached = false

  constructor(
    private readonly transport: CdpTraceTransport,
    private readonly consumer: CdpScreencastConsumerOptions = {}
  ) {}

  public isRunning(): boolean {
    return this.running
  }

  public async start(options: CdpScreencastStartOptions): Promise<void> {
    if (this.running) {
      throw new AppError('VALIDATION', '页面录屏已在进行中，请先 stop。')
    }

    this.frames = []
    this.capturedFrameCount = 0
    this.frameLimitReached = false
    // 先订阅再启动，避免首帧竞态丢失。
    this.unsubscribe = this.transport.onEvent<CdpScreencastFrameEvent>(
      'Page.screencastFrame',
      (params) => {
        void this.handleFrame(params, options.maxFrames)
      }
    )

    // startScreencast 可能在 command promise resolve 前就送出首帧，先置 running 避免丢帧。
    this.running = true
    try {
      await this.transport.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.consumer.quality ?? BrowserTuning.screencast.frameQuality,
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        everyNthFrame: options.everyNthFrame,
      })
    } catch (error) {
      this.cleanup()
      throw AppError.from(error)
    }
  }

  /** 停止录制并取回全部帧。 */
  public async stop(): Promise<{ frames: ScreencastCapturedFrame[]; frameLimitReached: boolean }> {
    if (!this.running) {
      throw new AppError('VALIDATION', '当前没有正在进行的页面录屏。')
    }

    try {
      await this.transport.send('Page.stopScreencast').catch(() => {
        // arch-guard:silent-catch-ok 已采集帧仍可返回；finally 会无条件释放本地录屏状态。
      })
      return { frames: this.frames, frameLimitReached: this.frameLimitReached }
    } finally {
      this.frames = []
      this.cleanup()
    }
  }

  /** 尽力终止（会话关闭/dispose 清理用）。 */
  public async abort(): Promise<void> {
    if (!this.running) return
    try {
      await this.transport.send('Page.stopScreencast').catch(() => {
        // arch-guard:silent-catch-ok abort 是幂等清理，页面或 CDP 会话可能已销毁。
      })
    } finally {
      this.frames = []
      this.cleanup()
    }
  }

  private async handleFrame(params: CdpScreencastFrameEvent, maxFrames: number): Promise<void> {
    const sessionId = params?.sessionId
    // 每帧必须 ack，否则浏览器停发后续帧;帧限已到也要 ack 走完协议。
    if (isNumber(sessionId)) {
      await this.transport
        .send('Page.screencastFrameAck', { sessionId })
        .catch(() => {
          // arch-guard:silent-catch-ok 会话关闭时 ack 可能失败；当前帧仍可安全丢弃或消费。
        })
    }

    if (!this.running || this.frameLimitReached) return
    const data = params?.data
    if (!isString(data) || isEmpty(data)) return

    const frame: ScreencastCapturedFrame = {
      bytes: Buffer.from(data, 'base64'),
      timestamp: params?.metadata?.timestamp ?? Date.now() / 1000,
      width: Math.max(1, Math.round(params?.metadata?.deviceWidth ?? 1)),
      height: Math.max(1, Math.round(params?.metadata?.deviceHeight ?? 1)),
    }
    this.capturedFrameCount += 1
    if (!isFalse(this.consumer.retainFrames)) this.frames.push(frame)
    try {
      this.consumer.onFrame?.(frame)
    } catch {
      // arch-guard:silent-catch-ok 帧消费者是 UI 侧回调，它失败不能卡住 CDP screencast 的 ack；
      // 不 ack 会让浏览器停止推帧，等于一个渲染错误直接终结整段录制。
    }
    if (this.capturedFrameCount >= maxFrames) {
      this.frameLimitReached = true
      await this.transport.send('Page.stopScreencast').catch(() => {
        // arch-guard:silent-catch-ok 达到帧上限后本地已停止接收；远端会话可能同时关闭。
      })
    }
  }

  private cleanup(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.running = false
    this.capturedFrameCount = 0
  }
}

/* ------------------------------------------------------------------ *
 * GIF 合成
 * ------------------------------------------------------------------ */

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
