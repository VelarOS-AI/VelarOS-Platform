/** 预览 HTML 的拼装：页面骨架、样式表、摘要标签、幻灯片卡片与工作表表格。 */

import { isEmpty, isPresent } from '@velaros-ai/core'

import type { NormalizedWordInput } from '../../types/office.js'
import type { ParsedOfficePreview, PreviewSheet, PreviewSlide } from '../../types/preview.js'

import { escapeHtml, truncateText } from './sanitize.js'

/** 拼出完整预览页：抬头（类型、标题、路径、摘要）+ 正文，可选自动刷新脚本。 */
export function buildOfficePreviewHtml(input: {
  parsed: ParsedOfficePreview
  inputPath: string
  normalizedInput: Nullable<NormalizedWordInput>
  autoRefresh: boolean
}): string {
  const normalizedNotice = input.normalizedInput?.convertedFromLegacyDoc
    ? `<p class="notice">旧版 .doc 已用 ${escapeHtml(
        input.normalizedInput.converter ?? 'LibreOffice'
      )} 临时转成 .docx 后解析。</p>`
    : ''
  const autoRefreshScript = input.autoRefresh
    ? `<script>setInterval(function(){ if(!document.hidden) location.reload(); }, 5000);</script>`
    : ''

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(input.parsed.title)} · Office 预览</title>`,
    '<style>',
    buildPreviewCss(),
    '</style>',
    '</head>',
    '<body>',
    '<main class="page">',
    '<header class="preview-header">',
    `<p class="eyebrow">${escapeHtml(input.parsed.kind.toUpperCase())} 预览</p>`,
    `<h1>${escapeHtml(input.parsed.title)}</h1>`,
    `<p class="path">${escapeHtml(input.inputPath)}</p>`,
    normalizedNotice,
    buildSummaryHtml(input.parsed.summary),
    '</header>',
    '<section class="document-surface">',
    input.parsed.htmlBody || '<p>没有可预览的内容。</p>',
    '</section>',
    '</main>',
    autoRefreshScript,
    '</body>',
    '</html>',
  ].join('\n')
}

/** 预览页的样式表。 */
export function buildPreviewCss(): string {
  return `
:root {
  color-scheme: light;
  --paper: #ffffff;
  --ink: #172033;
  --muted: #667085;
  --line: #d8dee8;
  --soft: #f4f7fb;
  --accent: #286f6c;
  --accent-2: #8c4a2f;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #eef2f6;
  color: var(--ink);
  font-family: Inter, "Aptos", "Segoe UI", system-ui, sans-serif;
  line-height: 1.55;
}
.page { max-width: 1120px; margin: 0 auto; padding: 32px 20px 56px; }
.preview-header {
  border-bottom: 1px solid var(--line);
  margin-bottom: 24px;
  padding-bottom: 18px;
}
.eyebrow {
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  margin: 0 0 8px;
  text-transform: uppercase;
}
h1 { font-size: 34px; line-height: 1.16; margin: 0 0 8px; }
h2 { font-size: 24px; margin: 28px 0 10px; }
h3 { font-size: 19px; margin: 22px 0 8px; }
.path, .notice { color: var(--muted); font-size: 13px; margin: 4px 0; overflow-wrap: anywhere; }
.notice { color: var(--accent-2); }
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.summary span {
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--soft);
  color: #344054;
  font-size: 12px;
  padding: 5px 8px;
}
.document-surface {
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 16px 36px rgba(23, 32, 51, 0.08);
  padding: 34px;
}
.document-surface p { margin: 0 0 12px; }
.document-surface table {
  width: 100%;
  border-collapse: collapse;
  margin: 14px 0 22px;
  font-size: 14px;
}
.document-surface th, .document-surface td {
  border: 1px solid var(--line);
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
}
.document-surface th { background: var(--soft); font-weight: 700; }
.slide-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}
.slide-preview {
  aspect-ratio: 16 / 9;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: linear-gradient(135deg, #ffffff 0%, #f7fafc 100%);
  padding: 18px;
  overflow: hidden;
}
.slide-preview .slide-number { color: var(--accent); font-size: 12px; font-weight: 700; }
.slide-preview h2 { font-size: 20px; margin: 8px 0 10px; }
.slide-preview ul { margin: 0; padding-left: 18px; color: #344054; }
.sheet-preview { margin-bottom: 30px; }
@media (max-width: 720px) {
  .page { padding: 20px 12px 36px; }
  .document-surface { padding: 20px 14px; }
  h1 { font-size: 27px; }
}
`
}

/** 把摘要字段排成一串标签；字段名保持原样，只做大小写与分词。 */
export function buildSummaryHtml(summary: Record<string, unknown>): string {
  const items = Object.entries(summary)
    .filter(([, value]) => isPresent(value))
    .map(
      ([key, value]) => `<span>${escapeHtml(humanizeKey(key))}: ${escapeHtml(String(value))}</span>`
    )
    .join('')
  return items ? `<div class="summary">${items}</div>` : ''
}

/** 一页幻灯片的预览卡片。 */
export function buildSlidePreviewHtml(slide: PreviewSlide): string {
  return [
    '<article class="slide-preview">',
    `<div class="slide-number">第 ${slide.index} 页</div>`,
    `<h2>${escapeHtml(slide.title)}</h2>`,
    !isEmpty(slide.bullets)
      ? `<ul>${slide.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '',
    '</article>',
  ].join('\n')
}

/** 一张工作表的预览表格。 */
export function buildSheetPreviewHtml(sheet: PreviewSheet): string {
  return [
    '<section class="sheet-preview">',
    `<h2>${escapeHtml(sheet.name)}</h2>`,
    `<p class="path">${sheet.rowCount} 行 · ${sheet.columnCount} 列</p>`,
    '<table>',
    '<tbody>',
    ...sheet.rows.map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(truncateText(cell, 120))}</td>`).join('')}</tr>`
    ),
    '</tbody>',
    '</table>',
    '</section>',
  ].join('\n')
}

/** 把驼峰字段名拆成带空格的可读标签（字段名本身保持原样）。 */
export function humanizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (first) => first.toUpperCase())
}
