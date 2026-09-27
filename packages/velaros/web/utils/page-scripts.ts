/**
 * 在页面里跑的脚本：宿主经 `WebPage.evaluate` 求值，交回可结构化克隆的普通对象。结果页脚本在页面加载途中也会跑（结果一出现就抓），
 * 所以一并交回 document.readyState，外面据此判断结果传齐了没有。
 * 它们是字符串，不是本单元的代码：只用页面自己的 DOM，不引任何东西；数字从可调参数表拼进去。
 * 页面只抓原始材料（链接、文字），解跳转链接、去重、切分都在外面做，好测也好改；
 * 交回的东西形状可能不对（页面改过全局对象），外面先经 `utils/scans.ts` 收一遍再用。
 */

import { WebTuning } from './tuning.js'

/** 并空白、去首尾：页面脚本里各处共用的那一小段。 */
const CleanText = "const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();"

/**
 * Bing 结果页：`#b_results > li.b_algo` 一条一个结果，标题链接在 h2 里（是 bing.com/ck/a 跳转链接），摘要在 .b_caption 的段落里
 * （去掉摘要前头「网页」「WEB」那个小标签）；再交回正文开头一段认验证页，以及 Bing 有没有明说「没有结果」（.b_no）。
 */
export const BingResultsScript = `(() => {
  ${CleanText}
  const textOf = (node) => {
    if (!node) return '';
    const copy = node.cloneNode(true);
    for (const icon of Array.from(copy.querySelectorAll('.algoSlug_icon'))) icon.remove();
    return clean(copy.textContent);
  };
  const hits = Array.from(document.querySelectorAll('#b_results > li.b_algo')).map((item) => {
    const link = item.querySelector('h2 a[href]') || item.querySelector('a[href]');
    const snippet = item.querySelector('.b_caption p') || item.querySelector('.b_algoSlug') || item.querySelector('.b_caption') || item.querySelector('p');
    return { title: clean(link && link.textContent), href: link ? link.href : '', snippet: textOf(snippet) };
  });
  const body = document.body ? String(document.body.innerText || '') : '';
  return { hits, text: body.slice(0, ${WebTuning.search.probeTextChars}), noResults: !!document.querySelector('#b_results .b_no'), ready: String(document.readyState) };
})()`

/**
 * Google 结果页：自然结果都是一个包着 h3 的链接（`#rso`、`#search` 里的 `a h3`），同一个链接只算一次；
 * 摘要在同一条结果的块里（.VwiC3b、data-sncf，旧版纯 HTML 页是 .BNeawe.s3v9rd）。链接可能是 /url?q= 跳转链接，
 * 外面解开。再交回正文开头一段认验证页；Google 没有可靠的「没有结果」标记，noResults 恒为假。
 */
export const GoogleResultsScript = `(() => {
  ${CleanText}
  const root = document.querySelector('#rso') || document.querySelector('#search') || document.querySelector('#main') || document.body;
  const seen = new Set();
  const hits = [];
  for (const heading of root ? Array.from(root.querySelectorAll('a h3')) : []) {
    const link = heading.closest('a[href]');
    if (!link || seen.has(link)) continue;
    seen.add(link);
    const block = link.closest('.g, .MjjYud, .xpd') || link.parentElement;
    const snippet = block ? block.querySelector('.VwiC3b, [data-sncf="1"], .BNeawe.s3v9rd, [style*="-webkit-line-clamp"]') : null;
    hits.push({ title: clean(heading.textContent), href: link.href, snippet: clean(snippet && snippet.textContent) });
  }
  const body = document.body ? String(document.body.innerText || '') : '';
  return { hits, text: body.slice(0, ${WebTuning.search.probeTextChars}), noResults: false, ready: String(document.readyState) };
})()`

/** 等渲染时看一眼：文档加载到哪一步、body 的正文现在多少个字符。 */
export const SettleProbeScript = `(() => ({
  ready: String(document.readyState),
  length: document.body ? String(document.body.innerText || '').length : 0,
}))()`

/**
 * 读正文：这一页是不显示的一次性页面，直接在真页面上删东西，innerText 才按排版给出段落换行（删在副本上就没有排版了）。
 * 脚本、样式、noscript、svg、iframe、带 hidden 的一律删；导航、页眉页脚、侧栏、表单、aria-hidden 的块只在它不包着大半正文时删
 * （整页包在一个 form 里的老站点、弹窗打开时被标成 aria-hidden 的正文都得留着）。
 * article、main、[role=main] 里字最多的那个占到全页的一定比例，就只读它，否则读整个 body。交回标题、innerText 原文与文档的媒体类型。
 */
export const ReadableTextScript = `(() => {
  const body = document.body;
  const result = { title: String(document.title || '').trim(), text: '', contentType: String(document.contentType || '') };
  if (!body) return result;
  const size = (node) => String(node.textContent || '').length;
  for (const node of Array.from(body.querySelectorAll('script, style, noscript, svg, iframe, [hidden]'))) node.remove();
  const total = size(body);
  for (const node of Array.from(body.querySelectorAll('nav, header, footer, aside, form, [aria-hidden="true"]'))) {
    if (node.isConnected && size(node) <= total * ${WebTuning.read.wrapperShare}) node.remove();
  }
  const remaining = size(body);
  let root = body;
  let best = 0;
  for (const candidate of Array.from(body.querySelectorAll('article, main, [role="main"]'))) {
    const length = size(candidate);
    if (length > best) {
      best = length;
      root = candidate;
    }
  }
  if (best < remaining * ${WebTuning.read.mainShare}) root = body;
  result.text = String(root.innerText || '');
  return result;
})()`
