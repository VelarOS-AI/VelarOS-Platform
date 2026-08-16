import type { HtmlArtifactRenderPatch } from '@velaros-ai/html-artifacts/protocol'
import type {
  HtmlArtifactContentKind,
  HtmlArtifactDocumentOptions,
} from '@velaros-ai/html-artifacts/sandbox'
import {
  buildHtmlArtifactDocument,
  buildHtmlArtifactShellDocument,
  inferHtmlArtifactContentKind,
  normalizeHtmlArtifactSource,
} from '@velaros-ai/html-artifacts/sandbox'

import {
  HTML_PREVIEW_MAX_REPORTED_HEIGHT,
  HTML_PREVIEW_MSG_ERROR,
  HTML_PREVIEW_MSG_GENERIC,
  HTML_PREVIEW_MSG_OPEN_LINK,
  HTML_PREVIEW_MSG_PATCH,
  HTML_PREVIEW_MSG_RENDER,
  HTML_PREVIEW_MSG_RESIZE,
  HTML_PREVIEW_MSG_SEND_PROMPT,
} from './htmlPreviewConstants'
import { HTML_PREVIEW_DESIGN_CSS, HTML_PREVIEW_SVG_FIT_CSS } from './htmlPreviewDesignCss'

const HTML_PREVIEW_ROOT_ID = 'velaros-html-preview-root'
const HTML_PREVIEW_BRIDGE_MESSAGES = {
  render: HTML_PREVIEW_MSG_RENDER,
  patch: HTML_PREVIEW_MSG_PATCH,
  resize: HTML_PREVIEW_MSG_RESIZE,
  sendPrompt: HTML_PREVIEW_MSG_SEND_PROMPT,
  openLink: HTML_PREVIEW_MSG_OPEN_LINK,
  generic: HTML_PREVIEW_MSG_GENERIC,
  error: HTML_PREVIEW_MSG_ERROR,
} as const

export function getHtmlPreviewCodeLanguage(source: string): string {
  return inferHtmlArtifactContentKind(source) === 'svg' ? 'svg' : 'html'
}

function resolveHtmlPreviewBodyStyle(kind: HtmlArtifactContentKind): string {
  return kind === 'svg'
    ? 'margin:0;width:100%;min-height:100%;overscroll-behavior:contain;background:transparent;color:var(--color-text-primary);'
    : 'margin:0;padding:16px;overscroll-behavior:contain;font-family:var(--font-sans);background:transparent;color:var(--color-text-primary);'
}

// iframe 与宿主隔离,不继承 app 的 CSS 变量。渲染时把 app 当前主题+品牌 token 读出来注入,
// 让制品自动贴合明暗主题与品牌色(见 skill:html-artifact-output 的品牌变量约定)。
// app token → 制品变量的映射:左侧是制品里可用的名字,右侧是从宿主根读取的 app 变量。
const BRAND_TOKEN_MAP: ReadonlyArray<readonly [artifactVar: string, appVar: string]> = [
  ['--color-text-primary', '--foreground'],
  ['--color-text-secondary', '--foreground-secondary'],
  ['--color-text-tertiary', '--foreground-tertiary'],
  ['--color-border-primary', '--border'],
  ['--brand-bg', '--background'],
  ['--brand-surface', '--surface-settings-card'],
  ['--brand-fg', '--foreground'],
  ['--brand-fg-secondary', '--foreground-secondary'],
  ['--brand-border', '--border'],
  ['--brand-primary', '--primary'],
  ['--brand-primary-foreground', '--primary-foreground'],
  ['--brand-accent', '--accent'],
  ['--brand-radius', '--radius'],
  ['--brand-font', '--font-sans'],
]

function buildBrandTokenRootCss(): string {
  try {
    const rootStyle = window.getComputedStyle(document.documentElement)
    const declarations = BRAND_TOKEN_MAP.map(([artifactVar, appVar]) => {
      const value = rootStyle.getPropertyValue(appVar).trim()
      return value ? `${artifactVar}:${value};` : ''
    })
      .filter((declaration) => declaration.length > 0)
      .join('')

    return declarations ? `:root{${declarations}}` : ''
  } catch {
    // arch-guard:silent-catch-ok 非浏览器环境无法读取样式，制品沙箱明确回落到内置浅色 token。
    return ''
  }
}

function buildHtmlPreviewDocumentOptions(source: string): HtmlArtifactDocumentOptions {
  const contentKind = inferHtmlArtifactContentKind(source)

  return {
    contentKind,
    // 品牌 token 覆盖块必须排在沙箱基础 CSS 之后,才能覆盖后者的硬编码浅色默认值。
    designCss: `${HTML_PREVIEW_DESIGN_CSS}${buildBrandTokenRootCss()}`,
    svgFitCss: HTML_PREVIEW_SVG_FIT_CSS,
    bodyStyle: resolveHtmlPreviewBodyStyle(contentKind),
    bridgeMessages: HTML_PREVIEW_BRIDGE_MESSAGES,
    maxReportedHeight: HTML_PREVIEW_MAX_REPORTED_HEIGHT,
  }
}

export function buildHtmlPreviewDocument(
  source: string,
  patches: readonly HtmlArtifactRenderPatch[] = []
): string {
  return buildHtmlArtifactDocument(source, {
    ...buildHtmlPreviewDocumentOptions(source),
    initialPatches: patches,
  })
}

export function buildHtmlPreviewFrameShell(source: string): string {
  return buildHtmlArtifactShellDocument({
    ...buildHtmlPreviewDocumentOptions(source),
    rootId: HTML_PREVIEW_ROOT_ID,
  })
}

// —— 纯净导出文档(查看源码/复制/下载共用) ——
// 只含页面自身需要的东西:meta、基础视觉 CSS(设计 CSS+品牌 token 快照)、模型内容与已应用
// 的补丁;不带桥接/测量/补丁运行时等宿主内部逻辑,双击即可独立运行(用户裁定:三个导出面
// 一致且纯净)。渲染 iframe 仍走内部壳(buildHtmlPreviewFrameShell),两者职责分离。

function applyExportPatch(doc: Document, patch: HtmlArtifactRenderPatch): void {
  if (patch.type === 'style') {
    const styleId = patch.styleId || 'default'
    const existing = doc.head.querySelector(`style[data-artifact-style="${CSS.escape(styleId)}"]`)
    const style = existing ?? doc.createElement('style')
    style.setAttribute('data-artifact-style', styleId)
    style.textContent = patch.css
    if (!existing) doc.head.appendChild(style)
    return
  }
  if (patch.type === 'script') {
    const scriptId = patch.scriptId || 'default'
    doc.body
      .querySelectorAll(`script[data-artifact-script="${CSS.escape(scriptId)}"]`)
      .forEach((node) => node.remove())
    const script = doc.createElement('script')
    script.setAttribute('data-artifact-script', scriptId)
    script.textContent = patch.code
    doc.body.appendChild(script)
    return
  }

  // replace/append:与运行时 findPatchTarget 同语义(无 target 即根容器)。离线文档惰性
  // (脚本不执行),这里直接落最终 DOM 状态——运行时的 dom-diff 只是为了平滑更新,终态等价。
  let target: Nullable<Element> = doc.body
  if (patch.target) {
    try {
      target = doc.body.querySelector(patch.target)
    } catch {
      // arch-guard:silent-catch-ok 非法选择器只让当前 patch 无目标，不得中断其余文档更新。
      target = null
    }
  }
  if (!target) return
  if (patch.type === 'append') {
    target.insertAdjacentHTML('beforeend', patch.html)
    return
  }
  target.innerHTML = patch.html
}

export function buildPortableHtmlDocument(
  sourceHtml: string,
  patches: readonly HtmlArtifactRenderPatch[] = []
): string {
  const source = normalizeHtmlArtifactSource(sourceHtml)
  const contentKind = inferHtmlArtifactContentKind(source)
  const svgCss = contentKind === 'svg' ? HTML_PREVIEW_SVG_FIT_CSS : ''

  const doc = document.implementation.createHTMLDocument('')
  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  const viewport = doc.createElement('meta')
  viewport.setAttribute('name', 'viewport')
  viewport.setAttribute('content', 'width=device-width,initial-scale=1')
  const baseStyle = doc.createElement('style')
  baseStyle.textContent = `${HTML_PREVIEW_DESIGN_CSS}${buildBrandTokenRootCss()}${svgCss}body{${resolveHtmlPreviewBodyStyle(contentKind)}}`
  doc.head.append(charset, viewport, baseStyle)

  doc.body.innerHTML = source
  for (const patch of patches) {
    applyExportPatch(doc, patch)
  }

  return `<!doctype html>${doc.documentElement.outerHTML}`
}
