/**
 * 真实任务报告的 HTML：只放闭集状态、度量与问题分类计数，自由文本和身份留在私有原档。
 * 纯渲染：不碰 Node 模块、不发请求。
 */
import type { RealTaskAssertionOutcome, RealTaskHealth } from '../../contract/constants.js'
import { FindingSeverities, RealTaskFindingClasses } from '../../contract/constants.js'
import type { RealTaskAssessment } from '../../types/agent-lab.js'

import { assertSelfContainedHtml, escapeHtml, valueCell } from './html.js'

/** 渲染一格度量；未知显示破折号。 */
function metric(
  label: string,
  value: number | RealTaskAssertionOutcome | RealTaskHealth | null
): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${valueCell(value)}</strong></div>`
}

/** 只展示评估中的闭集状态、真实数值和问题分类数量，自由文本留在私有原档。 */
export function renderRealTaskReportHtml(assessment: RealTaskAssessment): string {
  const metrics = [
    metric('任务结果', assessment.outcome),
    metric('执行健康', assessment.health),
    metric('模型调用', assessment.metrics.modelCalls),
    metric('工具调用', assessment.metrics.toolCalls),
    metric('工具错误', assessment.metrics.toolErrors),
    metric('重复错误', assessment.metrics.repeatedToolErrors),
    metric('并行冗余调用', assessment.metrics.redundantToolCalls),
    metric('输入 token', assessment.metrics.tokensIn),
    metric('输出 token', assessment.metrics.tokensOut),
  ].join('')
  const counts = new Map<string, number>()
  for (const finding of assessment.findings) {
    const key = `${finding.class}:${finding.severity}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const findings =
    RealTaskFindingClasses.flatMap((category) =>
      FindingSeverities.flatMap((severity) => {
        const count = counts.get(`${category}:${severity}`) ?? 0
        return count === 0
          ? []
          : [
              `<article class="finding ${severity}" data-finding-class="${category}" data-finding-severity="${severity}"><header><strong>${escapeHtml(category)}</strong><code>${escapeHtml(severity)}</code></header><p>发现条数 ${valueCell(count)}</p></article>`,
            ]
      })
    ).join('') || '<p class="empty">未记录问题分类。</p>'
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VelarOS 真实任务评测</title><style>:root{color-scheme:light dark;--bg:#0b0d12;--panel:#151922;--line:#2c3442;--text:#edf2f7;--muted:#9aa7b8;--good:#3ddc97;--warn:#f2bd5a;--bad:#ff7081}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}main{max-width:1100px;margin:auto;padding:32px}h1{margin:0 0 6px;font-size:30px}.verdict{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:6px 10px;margin:12px 0}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0 26px}.metric,.finding{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px}.metric span{display:block;color:var(--muted)}.metric strong{font-size:18px}.finding{margin:10px 0;border-left:4px solid var(--warn)}.finding.fail{border-left-color:var(--bad)}.finding.info{border-left-color:#7c9cff}.finding header{display:flex;justify-content:space-between;gap:16px}.finding p,.finding code{color:var(--muted)}.empty{padding:18px;border:1px solid var(--line);border-radius:12px;color:var(--good)}</style></head><body><main><p>VelarOS Agent Lab · 真实工作负载</p><h1>真实任务评测</h1><span class="verdict">${escapeHtml(assessment.verdict)}</span><section class="metrics">${metrics}</section><h2>问题分类</h2>${findings}</main></body></html>`
  assertSelfContainedHtml(html)
  return html
}
