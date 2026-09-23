/**
 * 运行报告的 HTML：一份自包含的单文件，打开就能看，不联网、不拉任何外部资源。
 * 未知一律显示破折号，不借 0 表达。纯渲染：不碰 Node 模块、不发请求。
 */
import type { VerdictLevel } from '../../contract/constants.js'
import type { ReportRenderOptions, RunReportModel } from '../../types/agent-lab.js'

import {
  assertSelfContainedHtml,
  duration,
  percent,
  timestampCell,
  valueCell,
  visibleText,
} from './html.js'

/** 判词分量对应的样式名。 */
function verdictClass(level: VerdictLevel): string {
  if (level === 'critical') return 'critical'
  if (level === 'warning') return 'warning'
  if (level === 'positive') return 'positive'
  return 'information'
}

/** 渲染一次运行：指标、判词、每一段、失败形态与数据缺口。 */
function renderRun(model: RunReportModel): string {
  const metrics = [
    ['完成度', valueCell(model.completion, percent)],
    ['通过段', valueCell(model.passedLegs), ` / ${model.totalLegs}`],
    ['墙钟', valueCell(model.durationMs, duration)],
    ['工具调用', valueCell(model.toolCalls)],
    ['总 token', valueCell(model.totalTokens)],
    ['费用 USD', valueCell(model.costUsd, (value) => value.toFixed(4))],
    ['丢弃', valueCell(model.drops)],
  ]
    .map(
      ([label, value, suffix = '']) =>
        `<div class="metric"><span>${visibleText(label)}</span><strong>${value}${suffix}</strong></div>`
    )
    .join('')

  const verdicts = model.verdicts
    .map(
      (verdict) =>
        `<article class="verdict ${verdictClass(verdict.level)}"><strong>${visibleText(verdict.title)}</strong><p>${visibleText(verdict.detail)}</p><code>${visibleText(verdict.id)}</code></article>`
    )
    .join('')

  const maxDuration = Math.max(1, ...model.legs.map((leg) => leg.durationMs))
  const legs = model.legs
    .map((leg) => {
      const state = leg.passed === true ? 'pass' : leg.passed === false ? 'fail' : 'unknown'
      const width = Math.max(2, (leg.durationMs / maxDuration) * 100)
      return `<tr><td><strong>${visibleText(leg.title)}</strong><small>${visibleText(leg.id)}</small></td><td><span class="state ${state}">${state}</span></td><td>${valueCell(leg.score, percent)}</td><td>${valueCell(leg.toolCalls)}</td><td>${valueCell(leg.contextPercent, (value) => `${value.toFixed(1)}%`)}</td><td><div class="bar"><i style="width:${width.toFixed(2)}%"></i></div><small>${visibleText(duration(leg.durationMs))}</small></td><td>${visibleText(leg.settleKind)}</td></tr>`
    })
    .join('')

  const failures = Object.entries(model.failureCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([name, count]) =>
        `<li><span>${visibleText(name)}</span><strong>${visibleText(count)}</strong></li>`
    )
    .join('')

  const gaps = model.gaps.length
    ? model.gaps
        .map(
          (gap) =>
            `<article class="gap"><strong>${visibleText(gap.title)}</strong><p>${visibleText(gap.effect)}</p><code>${visibleText(gap.face)}</code></article>`
        )
        .join('')
    : '<p class="muted">本次驱动器声明的观测面均为 full。</p>'

  return `<section class="run"><header><div><p class="eyebrow">${visibleText(model.executorLabel)}</p><h2>${visibleText(model.journeyTitle)}</h2><p>${visibleText(model.journeyId)}@${model.journeyVersion} · ${visibleText(model.runId)}</p></div><span class="executor">${visibleText(model.executorId)}</span></header><div class="metrics">${metrics}</div><div class="verdicts">${verdicts}</div><h3>连续旅程</h3><div class="table"><table><thead><tr><th>里程碑</th><th>判定</th><th>得分</th><th>工具</th><th>上下文</th><th>墙钟</th><th>收敛</th></tr></thead><tbody>${legs}</tbody></table></div><div class="columns"><div><h3>失败形态</h3><ul class="failures">${failures || '<li><span>无已分类失败</span><strong>0</strong></li>'}</ul></div><div><h3>数据缺口</h3><div class="gaps">${gaps}</div></div></div></section>`
}

/** 把一批运行报告模型渲染成一份自包含 HTML；渲染完当场核对它确实自包含。 */
export function renderReportHtml(
  models: readonly RunReportModel[],
  options: ReportRenderOptions = {}
): string {
  const title = options.title ?? 'VelarOS Agent Lab'
  const generatedAt = options.generatedAt ?? null
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${visibleText(title)}</title><style>:root{color-scheme:light dark;--bg:#0b0d12;--panel:#141821;--line:#2b3240;--text:#eef2f7;--muted:#9ba7b7;--brand:#7c9cff;--good:#3fd18b;--bad:#ff6f7d;--warn:#f7bd57}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif}main{max-width:1440px;margin:auto;padding:32px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:24px}.hero h1{font-size:32px;margin:0}.muted,.hero p,header p{color:var(--muted)}.run{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:24px;margin:20px 0;box-shadow:0 14px 40px #0003}.run header{display:flex;justify-content:space-between;gap:24px}.run h2{margin:0;font-size:24px}.eyebrow{text-transform:uppercase;letter-spacing:.12em}.executor{height:max-content;padding:6px 10px;border:1px solid var(--line);border-radius:999px}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:22px 0}.metric{border:1px solid var(--line);border-radius:12px;padding:12px}.metric span{display:block;color:var(--muted)}.metric strong{font-size:19px}.verdicts,.gaps{display:grid;gap:10px}.verdict,.gap{border-left:4px solid var(--brand);background:#ffffff08;border-radius:8px;padding:12px 14px}.verdict p,.gap p{margin:4px 0;color:var(--muted)}.verdict code,.gap code{color:var(--muted)}.verdict.critical{border-color:var(--bad)}.verdict.warning{border-color:var(--warn)}.verdict.positive{border-color:var(--good)}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:800px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:10px}td small{display:block;color:var(--muted)}.state{display:inline-block;padding:3px 7px;border-radius:999px;background:#ffffff12}.state.pass{color:var(--good)}.state.fail{color:var(--bad)}.state.unknown{color:var(--warn)}.bar{width:120px;height:8px;background:#ffffff10;border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:var(--brand)}.columns{display:grid;grid-template-columns:minmax(240px,.8fr) minmax(320px,1.2fr);gap:22px;margin-top:22px}.failures{list-style:none;padding:0}.failures li{display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0}@media(max-width:760px){main{padding:16px}.hero,.run header{display:block}.columns{grid-template-columns:1fr}}</style></head><body><main><div class="hero"><div><p class="eyebrow">可复现的连续旅程</p><h1>${visibleText(title)}</h1><p>${models.length} 次运行 · 同一份归档，同一个判定</p></div><p>生成时间 ${timestampCell(generatedAt)}</p></div>${models.map(renderRun).join('')}</main></body></html>`
  assertSelfContainedHtml(html)
  return html
}
