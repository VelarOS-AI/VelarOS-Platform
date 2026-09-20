/** Electron 截图里用不着实例状态的那部分：裁剪、缩放、标注与差分的纯计算。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import electron from 'electron'

import { isString, isTrue } from '@velaros-ai/core'
import { isArray, isFalse, isObject, isPlainObject, isPresent, optionalWhenLazy } from '@velaros-ai/core'

import type { BrowserCaptureScreenshotOptions, BrowserDomStabilityOptions, BrowserElementTargetHint, BrowserLoginDetection, BrowserScreenshotCaptureRegion, BrowserScreenshotElementLabel, BrowserScreenshotElementLabelOptions, BrowserScreenshotElementLegendItem, BrowserScreenshotMetadata, BrowserScreenshotModelImage, BrowserScreenshotModelImageOptions, BrowserScreenshotRegionOptions } from '../../types/browser'
import type { ScreencastFrameDecoder } from '../../types/cdp.js'
import type { BrowserPageDriverScreenshotOptions } from '../../types/driver'
import type { BrowserSession } from '../../types/electron'
import type { ExternalBrowserPageSession } from '../../types/runtime.js'
import type { BrowserWorkspacePath } from '../../types/workspace.js'
import { clampInteger, clampNumber, readBoundedString, readFiniteNumber } from '../numbers.js'
import { browserLoginDetectionScriptFragment } from '../page-scripts/login-detection'
import { BrowserTuning } from '../tuning'
import { resolveBrowserWorkspacePath } from '../workspace-paths'

import { evaluateInWebContents } from './evaluate'

/** 元素标注选项归一；关掉时返回 null。 */
export function resolveScreenshotElementLabelOptions(
  options: BrowserCaptureScreenshotOptions['annotateElements']
): Nullable<BrowserScreenshotElementLabelOptions> {
  if (!options) return null
  if (isObject(options) && isFalse(options.enabled)) return null

  const rawMaxElements = optionalWhenLazy(
    isObject(options),
    () => (options as BrowserScreenshotElementLabelOptions).maxElements
  )
  return {
    enabled: true,
    maxElements: clampInteger(rawMaxElements, 1, 120, BrowserTuning.screenshot.elementLabelLimit),
  }
}

/** 等 DOM 稳定的选项归一；关掉时返回 null。 */
export function resolveDomStabilityOptions(
  options: BrowserCaptureScreenshotOptions['waitForDomStable']
): Nullable<BrowserDomStabilityOptions> {
  if (!options) return null

  const rawOptions = isObject(options) ? options : {}
  return {
    stableFrames: clampInteger(rawOptions.stableFrames, 3, 16, 5),
    sampleIntervalMs: clampInteger(rawOptions.sampleIntervalMs, 16, 250, 80),
    maxWaitMs: clampInteger(rawOptions.maxWaitMs, 250, 8000, 2500),
  }
}

/** 整页截图选项归一；关掉时返回 null。 */
export function resolveScreenshotFullPageOptions(
  options: BrowserCaptureScreenshotOptions['fullPage']
): Nullable<{ maxWidth: number; maxHeight: number }> {
  if (!options) return null
  if (isObject(options) && isFalse(options.enabled)) return null

  const rawOptions = isObject(options) ? options : {}
  return {
    maxWidth: clampInteger(rawOptions.maxWidth, 320, 32_000, BrowserTuning.screenshot.fullPageMaxWidth),
    maxHeight: clampInteger(
      rawOptions.maxHeight,
      240,
      32_000,
      BrowserTuning.screenshot.fullPageMaxHeight
    ),
  }
}

/** 给模型的图的选项归一；关掉时返回 null。 */
export function resolveScreenshotModelImageOptions(
  options: BrowserCaptureScreenshotOptions['includeModelImage']
): Nullable<Required<BrowserScreenshotModelImageOptions>> {
  if (!options) return null

  const rawOptions = isObject(options) ? options : {}
  return {
    maxWidth: clampInteger(rawOptions.maxWidth, 320, 3840, BrowserTuning.screenshot.modelImageMaxWidth),
    maxHeight: clampInteger(
      rawOptions.maxHeight,
      240,
      2160,
      BrowserTuning.screenshot.modelImageMaxHeight
    ),
    quality: clampInteger(rawOptions.quality, 1, 100, BrowserTuning.screenshot.modelImageQuality),
    highlightViewport: !isFalse(rawOptions.highlightViewport),
  }
}

/** 按图片实际尺寸算出这张截图对应页面上的哪块区域。 */
export function buildViewportCaptureRegion(
  metadata: BrowserScreenshotMetadata,
  imageWidth: number,
  imageHeight: number
): BrowserScreenshotCaptureRegion {
  return {
    mode: 'viewport',
    coordinateSpace: 'page-css-px',
    x: metadata.scrollX,
    y: metadata.scrollY,
    width: Math.max(1, metadata.viewportWidth),
    height: Math.max(1, metadata.viewportHeight),
    documentWidth: metadata.documentWidth,
    documentHeight: metadata.documentHeight,
    viewport: {
      x: metadata.scrollX,
      y: metadata.scrollY,
      width: Math.max(1, metadata.viewportWidth),
      height: Math.max(1, metadata.viewportHeight),
    },
    clipped: imageWidth <= 0 || imageHeight <= 0,
  }
}

/** 把区域截图的 selector 或矩形解析成页面上的实际矩形。 */
export async function resolveScreenshotRegionRect(
  session: BrowserSession,
  region: BrowserScreenshotRegionOptions
): Promise<Nullable<{ x: number; y: number; width: number; height: number }>> {
  if (region.selector?.trim()) {
    const selectorLiteral = JSON.stringify(region.selector.trim())
    const resolved = (await evaluateInWebContents(
      session.webContents,
      `(() => {
        const el = document.querySelector(${selectorLiteral});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(window.scrollX + r.x),
          y: Math.round(window.scrollY + r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      })()`,
      true
    )) as Nullable<{ x?: number; y?: number; width?: number; height?: number }>
    if (
      resolved &&
      Number.isFinite(resolved.x) &&
      Number.isFinite(resolved.y) &&
      Number.isFinite(resolved.width) &&
      Number.isFinite(resolved.height)
    )
      return {
        x: resolved.x!,
        y: resolved.y!,
        width: resolved.width!,
        height: resolved.height!,
      }
    return null
  }

  if (
    Number.isFinite(region.x) &&
    Number.isFinite(region.y) &&
    Number.isFinite(region.width) &&
    Number.isFinite(region.height)
  )
    return {
      x: region.x!,
      y: region.y!,
      width: region.width!,
      height: region.height!,
    }

  return null
}

/** 把给模型的那张图另存一份，返回它的产物记录。 */
export async function writeScreenshotModelImage(
  workspaceRoot: string,
  originalRelativePath: string,
  modelImage: BrowserScreenshotModelImage
): Promise<BrowserScreenshotModelImage> {
  const extension = modelImage.mediaType === 'image/jpeg' ? 'jpg' : 'png'
  const originalName = basename(originalRelativePath.replace(/\\/g, '/'))
  const stem = originalName.replace(/\.[^.]*$/, '') || `screenshot-${Date.now()}`
  const relativePath = `artifacts/screenshots/model/${stem}-model.${extension}`
  const path = resolve(workspaceRoot, relativePath)

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.from(modelImage.data, 'base64'))

  return {
    ...modelImage,
    path,
    relativePath,
  }
}

/** 算出「图片坐标 → 页面坐标」的映射，模型按图点击时要用。 */
export function buildScreenshotModelCoordinateMap(
  capture: BrowserScreenshotCaptureRegion,
  imageWidth: number,
  imageHeight: number
): NonNullable<BrowserScreenshotModelImage['coordinateMap']> {
  const pageToImageScaleX = imageWidth / Math.max(1, capture.width)
  const pageToImageScaleY = imageHeight / Math.max(1, capture.height)
  const viewportX = clampNumber(
    capture.viewport.x,
    capture.x,
    capture.x + capture.width,
    capture.x
  )
  const viewportY = clampNumber(
    capture.viewport.y,
    capture.y,
    capture.y + capture.height,
    capture.y
  )
  const viewport = {
    x: viewportX,
    y: viewportY,
    width: Math.max(1, Math.min(capture.viewport.width, capture.x + capture.width - viewportX)),
    height: Math.max(
      1,
      Math.min(capture.viewport.height, capture.y + capture.height - viewportY)
    ),
  }
  const viewportRectInImage = {
    x: Math.round((viewport.x - capture.x) * pageToImageScaleX),
    y: Math.round((viewport.y - capture.y) * pageToImageScaleY),
    width: Math.max(1, Math.round(viewport.width * pageToImageScaleX)),
    height: Math.max(1, Math.round(viewport.height * pageToImageScaleY)),
  }

  return {
    coordinateSpace: 'page-css-px',
    pageToImageScaleX,
    pageToImageScaleY,
    imageToPageScaleX: Math.max(1, capture.width) / imageWidth,
    imageToPageScaleY: Math.max(1, capture.height) / imageHeight,
    viewportRectInImage,
    visibleViewport: {
      x: capture.viewport.x,
      y: capture.viewport.y,
      width: capture.viewport.width,
      height: capture.viewport.height,
    },
  }
}

/** 把一张截图压成一小片采样，用来和上一张比差异。 */
export function buildScreenshotDiffSample(image: Electron.NativeImage): Buffer {
  return image
    .resize({
      width: 64,
      height: 64,
      quality: 'good',
    })
    .toBitmap()
}

/** 比两片采样，给出这次截图和上一张差了多少。 */
export function compareScreenshotDiffSamples(
  previousSample: Buffer,
  sample: Buffer
): {
  changedPixels: number
  totalPixels: number
  changedRatio: number
} {
  const totalPixels = Math.floor(Math.min(previousSample.byteLength, sample.byteLength) / 4)
  let changedPixels = 0

  for (let pixelIndex = 0; pixelIndex < totalPixels; pixelIndex += 1) {
    const offset = pixelIndex * 4
    const delta =
      Math.abs((previousSample[offset] ?? 0) - (sample[offset] ?? 0)) +
      Math.abs((previousSample[offset + 1] ?? 0) - (sample[offset + 1] ?? 0)) +
      Math.abs((previousSample[offset + 2] ?? 0) - (sample[offset + 2] ?? 0)) +
      Math.abs((previousSample[offset + 3] ?? 0) - (sample[offset + 3] ?? 0))

    if (delta > 28) {
      changedPixels += 1
    }
  }

  return {
    changedPixels,
    totalPixels,
    changedRatio:
      totalPixels > 0 ? Math.round((changedPixels / totalPixels) * 10_000) / 10_000 : 0,
  }
}

/** 外部浏览器上的区域截图矩形解析。 */
export async function resolveExternalScreenshotRegionRect(
  session: ExternalBrowserPageSession,
  region: BrowserScreenshotRegionOptions
): Promise<Nullable<{ x: number; y: number; width: number; height: number }>> {
  if (region.selector?.trim()) {
    const selectorLiteral = JSON.stringify(region.selector.trim())
    const resolved = await session.driver.executeJavaScript<
      Nullable<{ x?: number; y?: number; width?: number; height?: number }>
    >(
      `(() => {
        const el = document.querySelector(${selectorLiteral});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(window.scrollX + r.x),
          y: Math.round(window.scrollY + r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      })()`,
      true
    )
    if (
      resolved &&
      Number.isFinite(resolved.x) &&
      Number.isFinite(resolved.y) &&
      Number.isFinite(resolved.width) &&
      Number.isFinite(resolved.height)
    )
      return {
        x: resolved.x!,
        y: resolved.y!,
        width: resolved.width!,
        height: resolved.height!,
      }
    return null
  }

  if (
    Number.isFinite(region.x) &&
    Number.isFinite(region.y) &&
    Number.isFinite(region.width) &&
    Number.isFinite(region.height)
  )
    return {
      x: region.x!,
      y: region.y!,
      width: region.width!,
      height: region.height!,
    }

  return null
}

/** 读这个会话最近发生的几件事，附在截图元数据里。 */
export function readRecentBrowserEvents(
  session: BrowserSession
): BrowserScreenshotMetadata['recentEvents'] {
  return session.diagnostics
    .filter((entry) => entry.kind !== 'console')
    .slice(-8)
    .map((entry) => ({ ...entry }))
}

/** 把标注出来的元素拼成一份可读的图例。 */
export function buildScreenshotElementLegend(
  labels: BrowserScreenshotElementLabel[]
): BrowserScreenshotElementLegendItem[] {
  return labels.map((label) => {
    const role = label.role || label.tagName || 'element'
    const quotedText = label.text ? ` "${label.text}"` : ''
    const selectorText = label.selector ? ` (${label.selector})` : ''
    const target: BrowserElementTargetHint = {
      ref: `@e${label.index}`,
      css: label.selector,
      role: label.role,
      text: label.text,
      name: null,
      attributes: {},
    }

    return {
      index: label.index,
      label: `[${label.index}]`,
      role: label.role,
      text: label.text,
      selector: label.selector,
      description: `[${label.index}] ${role}${quotedText}${selectorText}`,
      target,
    }
  })
}

/** 页面脚本给的元素标注归一成回执的形状。 */
export function normalizeScreenshotElementLabels(value: unknown): BrowserScreenshotElementLabel[] {
  if (!isArray(value)) return []

  return value
    .map((item): Nullable<BrowserScreenshotElementLabel> => {
      if (!isPlainObject(item)) return null

      const index = clampInteger(readFiniteNumber(item.index), 1, 10_000, 1)
      const x = Math.round(readFiniteNumber(item.x) ?? 0)
      const y = Math.round(readFiniteNumber(item.y) ?? 0)
      const width = Math.max(1, Math.round(readFiniteNumber(item.width) ?? 1))
      const height = Math.max(1, Math.round(readFiniteNumber(item.height) ?? 1))

      return {
        index,
        tagName: readBoundedString(item.tagName, 32) ?? 'element',
        role: readBoundedString(item.role, 80),
        text: readBoundedString(item.text, 120),
        selector: readBoundedString(item.selector, 240),
        x,
        y,
        width,
        height,
      }
    })
    .filter((label): label is BrowserScreenshotElementLabel => !!label)
}

/** 页面脚本给的光标位置归一；形状不对就当没有。 */
export function normalizeScreenshotCursor(value: unknown): BrowserScreenshotMetadata['cursor'] {
  if (!isPlainObject(value)) return null

  const x = readFiniteNumber(value.x)
  const y = readFiniteNumber(value.y)

  // readFiniteNumber 已保证有限，缺席即非法坐标。
  if (!isPresent(x) || !isPresent(y)) return null

  return {
    x: Math.round(x),
    y: Math.round(y),
    pressed: !!value.pressed,
  }
}

/** 给一份「没检测到登录墙」的空结果。 */
export function createEmptyLoginDetection(): BrowserLoginDetection {
  return {
    requiresLogin: false,
    confidence: 0,
    reason: '未检测到明确登录墙。',
    signals: [],
    passwordInputs: 0,
    usernameInputs: 0,
    loginButtons: 0,
    loginLinks: 0,
    forms: 0,
  }
}

/** 拼一段在页面里读截图元数据（滚动位置、视口、光标）的脚本。 */
export function buildScreenshotMetadataScript(): string {
  return `(() => {
const pointer = document.getElementById('__velaros_virtual_pointer__');
${browserLoginDetectionScriptFragment}
const readPointerNumber = (name) => {
  if (!pointer) return null;
  const value = Number(pointer.dataset[name]);
  return Number.isFinite(value) ? value : null;
};
const pointerX = readPointerNumber('x');
const pointerY = readPointerNumber('y');
const root = document.documentElement;
const body = document.body;
const viewportWidth = Math.max(1, Math.round(window.innerWidth || root.clientWidth || 1));
const viewportHeight = Math.max(1, Math.round(window.innerHeight || root.clientHeight || 1));
const documentWidth = Math.max(
  viewportWidth,
  Math.round(root.scrollWidth || 0),
  Math.round(root.offsetWidth || 0),
  Math.round(root.clientWidth || 0),
  body ? Math.round(body.scrollWidth || 0) : 0,
  body ? Math.round(body.offsetWidth || 0) : 0
);
const documentHeight = Math.max(
  viewportHeight,
  Math.round(root.scrollHeight || 0),
  Math.round(root.offsetHeight || 0),
  Math.round(root.clientHeight || 0),
  body ? Math.round(body.scrollHeight || 0) : 0,
  body ? Math.round(body.offsetHeight || 0) : 0
);
return {
  viewportWidth,
  viewportHeight,
  scrollX: Math.max(0, Math.round(window.scrollX || root.scrollLeft || 0)),
  scrollY: Math.max(0, Math.round(window.scrollY || root.scrollTop || 0)),
  documentWidth,
  documentHeight,
  deviceScaleFactor: Number(window.devicePixelRatio) || 1,
  cursor: pointerX === null || pointerY === null ? null : {
    x: Math.round(pointerX),
    y: Math.round(pointerY),
    pressed: pointer.dataset.pressed === 'true',
  },
  login: detectLogin(),
};
})()`
}

/** 拼一段在页面里给可交互元素画编号的脚本。 */
export function buildScreenshotElementLabelsScript(maxElements: number): string {
  const payload = JSON.stringify({
    maxElements: clampInteger(maxElements, 1, 120, BrowserTuning.screenshot.elementLabelLimit),
  })

  return `(() => {
const payload = ${payload};
const overlayId = '__velaros_screenshot_labels__';
const existing = document.getElementById(overlayId);
if (existing) existing.remove();

const selector = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  '[onclick]'
].join(',');
const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
const candidates = Array.from(document.querySelectorAll(selector));
const seen = new Set();
const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
const quoteAttr = (value) => String(value || '').replace(/"/g, '\\\\"');
const labelFor = (element) =>
  normalizeText(
    element.getAttribute('aria-label') ||
    element.getAttribute('placeholder') ||
    element.getAttribute('title') ||
    element.innerText ||
    element.value ||
    element.textContent
  );
const selectorFor = (element) => {
  const tagName = element.tagName ? element.tagName.toLowerCase() : 'element';
  const testId = element.getAttribute('data-testid') || element.getAttribute('data-test');
  const name = element.getAttribute('name');
  const id = element.getAttribute('id');
  if (id) return '#' + id;
  if (testId) return tagName + '[data-testid="' + quoteAttr(testId) + '"]';
  if (name) return tagName + '[name="' + quoteAttr(name) + '"]';
  return tagName;
};
const isVisible = (element) => {
  const rect = element.getBoundingClientRect();
  if (rect.width < 6 || rect.height < 6) return false;
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.03;
};
const items = [];
for (const element of candidates) {
  if (!(element instanceof Element) || seen.has(element) || !isVisible(element)) continue;
  seen.add(element);
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.right);
  const bottom = Math.min(viewportHeight, rect.bottom);
  items.push({
    element,
    tagName: element.tagName ? element.tagName.toLowerCase() : 'element',
    role: element.getAttribute('role') || null,
    text: labelFor(element) || null,
    selector: selectorFor(element),
    x: Math.round(left),
    y: Math.round(top),
    width: Math.max(1, Math.round(right - left)),
    height: Math.max(1, Math.round(bottom - top)),
  });
}

items.sort((a, b) => a.y - b.y || a.x - b.x);
const labels = items.slice(0, payload.maxElements).map((item, index) => ({
  index: index + 1,
  tagName: item.tagName,
  role: item.role,
  text: item.text,
  selector: item.selector,
  x: item.x,
  y: item.y,
  width: item.width,
  height: item.height,
}));

const overlay = document.createElement('div');
overlay.id = overlayId;
overlay.setAttribute('aria-hidden', 'true');
Object.assign(overlay.style, {
  position: 'fixed',
  inset: '0',
  zIndex: '2147483645',
  pointerEvents: 'none',
  overflow: 'hidden',
  font: '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
});

for (const label of labels) {
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed',
    left: label.x + 'px',
    top: label.y + 'px',
    width: label.width + 'px',
    height: label.height + 'px',
    border: '2px solid rgba(10, 132, 255, 0.88)',
    borderRadius: '5px',
    background: 'rgba(10, 132, 255, 0.08)',
    boxShadow: '0 0 0 1px rgba(255, 255, 255, 0.72)',
    boxSizing: 'border-box',
  });
  const badge = document.createElement('div');
  badge.textContent = String(label.index);
  Object.assign(badge.style, {
    position: 'fixed',
    left: Math.min(viewportWidth - 26, Math.max(2, label.x - 1)) + 'px',
    top: Math.max(2, label.y - 12) + 'px',
    minWidth: '18px',
    height: '18px',
    padding: '0 5px',
    borderRadius: '999px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0a84ff',
    color: '#ffffff',
    border: '1px solid rgba(255, 255, 255, 0.94)',
    boxShadow: '0 4px 12px rgba(15, 23, 42, 0.22)',
    boxSizing: 'border-box',
  });
  overlay.appendChild(box);
  overlay.appendChild(badge);
}

(document.body || document.documentElement).appendChild(overlay);
return labels;
})()`
}

/** 解析截图落盘路径：与站点工作区的其它落盘同一份判定（按真实路径，解开符号链接）。 */
export async function resolveScreenshotPath(
  workspaceRoot: string,
  requestedPath?: string
): Promise<BrowserWorkspacePath> {
  const relativePath =
    requestedPath?.trim() ||
    `artifacts/screenshots/browser-${new Date().toISOString().replace(/[:.]/g, '-')}.png`

  return resolveBrowserWorkspacePath(workspaceRoot, relativePath, '截图路径')
}

/** 外部浏览器的截图选项归一：把区域、整页与模型图选项合成驱动要的那一份。 */
export async function resolveExternalScreenshotOptions(
  session: ExternalBrowserPageSession,
  metadata: BrowserScreenshotMetadata,
  options: BrowserCaptureScreenshotOptions
): Promise<BrowserPageDriverScreenshotOptions> {
  if (options.region) {
    const clip = await resolveExternalScreenshotRegionRect(session, options.region)
    if (clip)
      return {
        mode: 'region',
        metadata,
        clip,
      }
  }

  const fullPageOptions = resolveScreenshotFullPageOptions(options.fullPage)
  if (fullPageOptions)
    return {
      mode: 'full-page',
      metadata,
      maxWidth: fullPageOptions.maxWidth,
      maxHeight: fullPageOptions.maxHeight,
    }

  return {
    mode: 'viewport',
    metadata,
  }
}

/** 页面脚本给的登录墙检测结果归一；形状不对就当没检测到。 */
export function normalizeLoginDetection(value: unknown): BrowserLoginDetection {
  if (!isPlainObject(value)) return createEmptyLoginDetection()

  const confidence = clampNumber(readFiniteNumber(value.confidence), 0, 1, 0)
  const signals = isArray(value.signals) ? value.signals.filter(isString).slice(0, 12) : []

  return {
    requiresLogin: isTrue(value.requiresLogin) && confidence >= 0.62,
    confidence: Math.round(confidence * 100) / 100,
    reason: readBoundedString(value.reason, 180) ?? '未检测到明确登录墙。',
    signals,
    passwordInputs: clampInteger(readFiniteNumber(value.passwordInputs), 0, 50, 0),
    usernameInputs: clampInteger(readFiniteNumber(value.usernameInputs), 0, 50, 0),
    loginButtons: clampInteger(readFiniteNumber(value.loginButtons), 0, 50, 0),
    loginLinks: clampInteger(readFiniteNumber(value.loginLinks), 0, 50, 0),
    forms: clampInteger(readFiniteNumber(value.forms), 0, 50, 0),
  }
}

/** 录屏帧解码：JPEG → RGBA（electron nativeImage,toBitmap 为 BGRA 需换序）。 */
export function createElectronScreencastFrameDecoder(): ScreencastFrameDecoder {
  return (bytes, maxWidth) => {
    let image = electron.nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return null

    if (image.getSize().width > maxWidth) {
      image = image.resize({ width: maxWidth })
    }
    const { width, height } = image.getSize()
    const rgba = Buffer.from(image.toBitmap())
    for (let offset = 0; offset < rgba.length; offset += 4) {
      const blue = rgba[offset]!
      rgba[offset] = rgba[offset + 2]!
      rgba[offset + 2] = blue
    }
    return { width, height, rgba }
  }
}
