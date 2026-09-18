/** 截图选项的合成（宿主缺省 + 调用方给的）、模型入参到端口选项的换算，以及截图回执给模型的那一份投影。 */

import { isEmpty, isFalse, isPresent, isTrue } from '@velaros-ai/core'
import { optionalWhen } from '@velaros-ai/core/utils/optionalWhen'

import type {
  BrowserCaptureScreenshotOptions,
  BrowserDomStabilityOptions,
  BrowserScreenshot,
  BrowserScreenshotArtifact,
  BrowserScreenshotInput,
  BrowserScreenshotModelImageOptions,
  BrowserScreenshotPolicyDefaults,
  BrowserScreenshotPolicyOptions,
} from '../types/browser.js'

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

/**
 * 把模型给的截图入参换成端口的截图选项：缺省截当前视口（整页要 fullPage），给模型看时要一张压缩过的图；
 * 标注、视口尺寸、等待与比较照入参，没给的走缺省（会等一小会儿网络空闲与页面稳定）。
 */
export function buildModelScreenshotOptions(input: BrowserScreenshotInput, modelFacing: boolean): BrowserCaptureScreenshotOptions {
  const options: BrowserScreenshotPolicyOptions = { modelFacing, fullPage: !!input.fullPage, annotateElements: !!input.annotate }
  if (isPresent(input.path)) options.path = input.path
  if (isPresent(input.region)) options.region = input.region
  if (isPresent(input.width)) options.width = input.width
  if (isPresent(input.height)) options.height = input.height
  if (isPresent(input.waitForNetworkIdle)) options.waitForNetworkIdle = input.waitForNetworkIdle
  if (isPresent(input.waitForDomStable)) options.waitForDomStable = input.waitForDomStable
  if (isPresent(input.compareWithPrevious)) options.compareWithPrevious = input.compareWithPrevious
  return buildBrowserScreenshotOptions(options)
}

/** 截图回执给模型的那一份：落盘位置、原图尺寸、截的是哪一块、交给模型的图怎么换算、标注说明与比较；图的字节不进返回值。 */
export function projectScreenshot(artifact: BrowserScreenshotArtifact): BrowserScreenshot {
  const shot: BrowserScreenshot = {
    path: artifact.path,
    relativePath: artifact.relativePath,
    width: artifact.width,
    height: artifact.height,
    bytes: artifact.bytes,
  }
  if (artifact.capture) shot.capture = artifact.capture
  if (artifact.modelImage) {
    const image: BrowserScreenshot['image'] = { width: artifact.modelImage.width, height: artifact.modelImage.height, scale: artifact.modelImage.scale }
    if (artifact.modelImage.coordinateMap) image.coordinateMap = artifact.modelImage.coordinateMap
    shot.image = image
  }
  const legend = artifact.metadata?.elementLegend ?? []
  if (!isEmpty(legend)) shot.legend = legend
  if (artifact.diff) shot.diff = artifact.diff
  if (artifact.metadata?.login) shot.login = artifact.metadata.login
  if (artifact.loginGate) shot.loginGate = artifact.loginGate
  return shot
}
