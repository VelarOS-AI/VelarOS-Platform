import type { RealTaskAssessment, RealTaskRecord } from "./Types.js";

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function metric(label: string, value: number | string | null): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${value === null ? "—" : escapeHtml(value)}</strong></div>`;
}

/** Renders a local, self-contained report. It never embeds prompts, answers, paths, or artifacts. */
export function renderRealTaskReportHtml(
  record: RealTaskRecord,
  assessment: RealTaskAssessment,
): string {
  const metrics = [
    metric("任务结果", assessment.outcome),
    metric("执行健康", assessment.health),
    metric("模型调用", assessment.metrics.modelCalls),
    metric("工具调用", assessment.metrics.toolCalls),
    metric("工具错误", assessment.metrics.toolErrors),
    metric("重复错误", assessment.metrics.repeatedToolErrors),
    metric("并行冗余调用", assessment.metrics.redundantToolCalls),
    metric("输入 token", assessment.metrics.tokensIn),
    metric("输出 token", assessment.metrics.tokensOut),
  ].join("");
  const findings = assessment.findings.length
    ? assessment.findings
        .map(
          (finding) =>
            `<article class="finding ${finding.severity}"><header><strong>${escapeHtml(finding.title)}</strong><code>${escapeHtml(finding.class)}</code></header><p>${escapeHtml(finding.detail)}</p><small>${escapeHtml(finding.id)}</small></article>`,
        )
        .join("")
    : '<p class="empty">没有发现执行健康问题。</p>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VelarOS 真实任务评测</title><style>:root{color-scheme:light dark;--bg:#0b0d12;--panel:#151922;--line:#2c3442;--text:#edf2f7;--muted:#9aa7b8;--good:#3ddc97;--warn:#f2bd5a;--bad:#ff7081}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}main{max-width:1100px;margin:auto;padding:32px}h1{margin:0 0 6px;font-size:30px}.meta{color:var(--muted);margin:0 0 24px}.verdict{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:6px 10px;margin:12px 0}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0 26px}.metric,.finding{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px}.metric span{display:block;color:var(--muted)}.metric strong{font-size:18px}.finding{margin:10px 0;border-left:4px solid var(--warn)}.finding.fail{border-left-color:var(--bad)}.finding.info{border-left-color:#7c9cff}.finding header{display:flex;justify-content:space-between;gap:16px}.finding p{color:var(--muted)}.finding small,.finding code{color:var(--muted)}.empty{padding:18px;border:1px solid var(--line);border-radius:12px;color:var(--good)}</style></head><body><main><p>VelarOS Agent Lab · real workload</p><h1>${escapeHtml(record.task.title || "未命名真实任务")}</h1><p class="meta">${escapeHtml(record.id)} · ${escapeHtml(record.executor.executorId)} · 内容策略 ${escapeHtml(record.privacy.classification)}</p><span class="verdict">${escapeHtml(assessment.verdict)}</span><section class="metrics">${metrics}</section><h2>发现的问题</h2>${findings}</main></body></html>`;
}
