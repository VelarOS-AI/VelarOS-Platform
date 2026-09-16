import { isFalse, isTrue } from '@velaros-ai/core'
import { optionalWhen } from '@velaros-ai/core/utils/optionalWhen'

import type { BrowserCaptureScreenshotOptions, BrowserDomStabilityOptions, BrowserScreenshotModelImageOptions, BrowserScreenshotPolicyDefaults, BrowserScreenshotPolicyOptions } from '../types/browser.js'

import { BrowserTuning } from './tuning'

export const BrowserScreenshotDefaultNetworkIdleMs = BrowserTuning.screenshot.networkIdleMs

export const BrowserScreenshotDefaultDomStable: Required<BrowserDomStabilityOptions> = {
  stableFrames: BrowserTuning.screenshot.domStableFrames,
  sampleIntervalMs: BrowserTuning.screenshot.domStableSampleIntervalMs,
  maxWaitMs: BrowserTuning.screenshot.domStableMaxWaitMs,
}

export const BrowserScreenshotDefaultModelImage: Required<BrowserScreenshotModelImageOptions> = {
  maxWidth: 1280,
  maxHeight: 900,
  quality: 72,
  highlightViewport: true,
}

/** 把模型图选项与缺省值合成一份完整的选项。 */
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

/** 把宿主与调用方给的截图选项合成一份完整的选项。 */
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
