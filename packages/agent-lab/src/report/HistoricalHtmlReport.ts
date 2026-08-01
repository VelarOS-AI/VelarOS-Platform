import type { RunArchiveView } from "../archive/index.js";

import { assertSelfContainedHtml } from "./HtmlReport.js";

export interface HistoricalReportOptions {
  readonly title?: string;
  readonly generatedAt?: number;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cell(value: unknown): string {
  return value === null || value === undefined
    ? '<span data-value="null">—</span>'
    : escapeHtml(value);
}

/** Renders untouched v0/v1/v2/v3 archives while preserving every absent field as unknown. */
export function renderHistoricalReportHtml(
  views: readonly RunArchiveView[],
  options: HistoricalReportOptions = {},
): string {
  const title = options.title ?? "VelarOS Agent Lab 历史归档";
  const rows = views
    .map(
      (view) =>
        `<tr><td>${escapeHtml(view.shape)}</td><td>${cell(view.runId)}</td><td>${cell(view.sessionId)}</td><td>${cell(view.passed)}</td><td>${cell(view.total)}</td><td>${cell(view.findings?.length)}</td><td>${cell(view.drops?.length)}</td><td>${view.errors.length ? escapeHtml(view.errors.join("; ")) : "—"}</td></tr>`,
    )
    .join("");
  const generatedAt = options.generatedAt ?? null;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>:root{color-scheme:light dark;--bg:#0b0d12;--panel:#141821;--line:#2b3240;--text:#eef2f7;--muted:#9ba7b7}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}main{max-width:1280px;margin:auto;padding:32px}h1{margin-bottom:4px}.muted{color:var(--muted)}.table{overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:16px;margin-top:24px}table{width:100%;border-collapse:collapse;min-width:900px}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--line)}th{color:var(--muted)}</style></head><body><main><h1>${escapeHtml(title)}</h1><p class="muted">${views.length} 份归档 · 缺失字段显示为 —，不借 0 表达</p><p class="muted">生成时间 ${generatedAt === null ? '<span data-value="null">—</span>' : escapeHtml(new Date(generatedAt).toISOString())}</p><div class="table"><table><thead><tr><th>形状</th><th>run</th><th>session</th><th>通过</th><th>总数</th><th>判词</th><th>丢弃</th><th>读取错误</th></tr></thead><tbody>${rows}</tbody></table></div></main></body></html>`;
  assertSelfContainedHtml(html);
  return html;
}
