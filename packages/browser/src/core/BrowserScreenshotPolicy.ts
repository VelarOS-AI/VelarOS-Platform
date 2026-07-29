import { isFalse, isTrue } from '@velaros-ai/core'
import { optionalWhen } from '@velaros-ai/core/utils/optionalWhen'

import type {
  BrowserCaptureScreenshotOptions,
  BrowserDomStabilityOptions,
  BrowserScreenshotModelImageOptions,
} from './types.js'

export const BrowserScreenshotDefaultNetworkIdleMs = 700

export const BrowserScreenshotDefaultDomStable: Required<BrowserDomStabilityOptions> = {
  stableFrames: 5,
  sampleIntervalMs: 80,
  maxWaitMs: 2500,
}

export const BrowserScreenshotDefaultModelImage: Required<BrowserScreenshotModelImageOptions> = {
  maxWidth: 1280,
  maxHeight: 900,
  quality: 72,
  highlightViewport: true,
}

export interface BrowserScreenshotPolicyOptions extends BrowserCaptureScreenshotOptions {
  /**
   * 面向模型的截图会额外携带压缩后的标记图片，用作供应商输入。
   * 保存到磁盘的制品路径仍指向干净的原始截图。
   */
  modelFacing?: boolean
}

export interface BrowserScreenshotPolicyDefaults {
  compareWithPrevious?: boolean
  fullPage?: BrowserCaptureScreenshotOptions['fullPage']
  includeModelImage?: BrowserCaptureScreenshotOptions['includeModelImage']
  modelFacing?: boolean
  path?: string
  waitForDomStable?: BrowserCaptureScreenshotOptions['waitForDomStable']
  waitForNetworkIdle?: BrowserCaptureScreenshotOptions['waitForNetworkIdle']
}

function mergeModelImageOptions(
  input: BrowserCaptureScreenshotOptions['includeModelImage'],
  modelFacing: boolean
): BrowserCaptureScreenshotOptions['includeModelImage'] {
  if (isFalse(input)) return modelFacing ? BrowserScreenshotDefaultModelImage : false

  if (!input) return optionalWhen(modelFacing, BrowserScreenshotDefaultModelImage)

  if (isTrue(input)) return BrowserScreenshotDefaultModelImage

  return {
    ...BrowserScreenshotDefaultModelImage,
    ...input,
    highlightViewport: modelFacing ? true : !isFalse(input.highlightViewport),
  }
}

export function buildBrowserScreenshotOptions(
  input: BrowserScreenshotPolicyOptions = {},
  defaults: BrowserScreenshotPolicyDefaults = {}
): BrowserCaptureScreenshotOptions {
  const modelFacing = !!(input.modelFacing ?? defaults.modelFacing)
  const captureInput = { ...input } as BrowserCaptureScreenshotOptions
  delete (captureInput as BrowserScreenshotPolicyOptions).modelFacing
  const includeModelImage = mergeModelImageOptions(
    input.includeModelImage ?? defaults.includeModelImage,
    modelFacing
  )

  return {
    ...captureInput,
    path: input.path ?? defaults.path,
    waitForNetworkIdle:
      input.waitForNetworkIdle ??
      defaults.waitForNetworkIdle ??
      BrowserScreenshotDefaultNetworkIdleMs,
    waitForDomStable:
      input.waitForDomStable ?? defaults.waitForDomStable ?? BrowserScreenshotDefaultDomStable,
    fullPage: input.fullPage ?? defaults.fullPage ?? true,
    compareWithPrevious: input.compareWithPrevious ?? defaults.compareWithPrevious ?? modelFacing,
    includeModelImage,
  }
}
