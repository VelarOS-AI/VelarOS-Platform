import { z } from 'zod'

import {
  renderParameterDescription as parameterDescription,
} from '@velaros-ai/core/utils/ToolDescription'
import { requiredResultLimit } from '@velaros-ai/core/utils/ToolInputBounds'


export const browserReadPageStorageSchema = z.object({
  includeLocalStorage: z.boolean().optional().describe(
    parameterDescription({
      description: '是否读取 localStorage。',
      notes: ['默认 true。'],
    })
  ),
  includeSessionStorage: z.boolean().optional().describe(
    parameterDescription({
      description: '是否读取 sessionStorage。',
      notes: ['默认 true。'],
    })
  ),
  includeCookies: z.boolean().optional().describe(
    parameterDescription({
      description: '是否读取当前页 cookie。',
      notes: ['默认 false。'],
    })
  ),
  storageScope: z.enum(['current-origin', 'all-origins']).optional().describe(
    parameterDescription({
      description: 'localStorage/sessionStorage 读取范围。',
      values: [
        'current-origin：只读取当前页面 origin。',
        'all-origins：外部 CDP 模式读取当前 frame tree 涉及的 origin；webview 仍只读取当前页面 origin。',
      ],
      notes: ['默认 current-origin。'],
    })
  ),
  cookieScope: z.enum(['current-url', 'all']).optional().describe(
    parameterDescription({
      description: 'cookie 读取范围。',
      values: [
        'current-url：只读取当前 URL 可匹配的 cookie。',
        'all：外部 CDP 模式读取整个浏览器 cookie jar；webview 仍只能读取当前页面可见 cookie。',
      ],
      notes: ['仅 includeCookies=true 时生效；默认 current-url。'],
    })
  ),
  limit: requiredResultLimit(300, '每类最多返回多少项'),
  maxValueChars: z
    .number()
    .int()
    .positive()
    .max(50000)
    .optional()
    .describe(
      parameterDescription({
        description: '每个值最多返回多少字符。',
        notes: ['默认 4000。'],
      })
    ),
})

export type BrowserReadPageStorageInput = z.infer<typeof browserReadPageStorageSchema>

export const browserReadPageStorageGuidedSchema = browserReadPageStorageSchema.extend({
  limit: z.number().int().positive().max(300).optional().describe(
    parameterDescription({
      description: '每类最多返回多少项。',
      notes: ['默认 50。'],
    })
  ),
})

export type BrowserReadPageStorageGuidedInput = z.infer<typeof browserReadPageStorageGuidedSchema>

export function normalizeBrowserReadPageStorageGuided(
  input: BrowserReadPageStorageGuidedInput
): BrowserReadPageStorageInput {
  return {
    ...input,
    limit: input.limit ?? 50,
  }
}

export const browserEvaluateScriptSchema = z.object({
  script: z
    .string()
    .min(1)
    .max(20000)
    .describe(
      parameterDescription({
        description: '要执行的 JavaScript。',
        usage: [
          'mode=expression 时传表达式。',
          'mode=function-body 时传 async function body。',
        ],
      })
    ),
  mode: z.enum(['expression', 'function-body']).optional().describe(
    parameterDescription({
      description: '脚本执行模式。',
      values: [
        'expression：把 script 当作表达式执行。',
        'function-body：把 script 当作 async function body 执行。',
      ],
      notes: ['默认 expression。'],
    })
  ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(30000)
    .optional()
    .describe(
      parameterDescription({
        description: '异步等待超时毫秒数。',
        notes: ['默认 5000。'],
      })
    ),
  maxResultChars: z
    .number()
    .int()
    .positive()
    .max(200000)
    .optional()
    .describe(
      parameterDescription({
        description: '结果 JSON 最多返回多少字符。',
        notes: ['默认 20000。'],
      })
    ),
})

export type BrowserEvaluateScriptInput = z.infer<typeof browserEvaluateScriptSchema>

export const browserEvaluateScriptPresetSchema = z
  .object({
    preset: z
      .enum([
        'title',
        'url',
        'body_text',
        'selector_text',
        'selector_attribute',
        'selector_count',
        'selector_visible',
        'selector_value',
        'selector_enabled',
        'selector_checked',
        'selector_box',
        'selector_styles',
        'json_ld',
        'media_sources',
      ])
      .describe(
        parameterDescription({
          description: '常用页面读取预设。',
          values: [
            'title：读取 document.title。',
            'url：读取当前 location.href。',
            'body_text：读取正文文本。',
            'selector_text：读取 selector 匹配元素的文本。',
            'selector_attribute：读取 selector 匹配元素的指定属性。',
            'selector_count：统计 selector 匹配数量。',
            'selector_visible：判断第一个匹配元素是否可见。',
            'selector_value：读取第一个匹配控件的 value。',
            'selector_enabled：判断第一个匹配元素是否可操作。',
            'selector_checked：判断第一个匹配复选/单选元素是否选中。',
            'selector_box：读取第一个匹配元素的视口矩形。',
            'selector_styles：读取第一个匹配元素的常用计算样式。',
            'json_ld：读取 JSON-LD 脚本内容。',
            'media_sources：枚举页面图片/视频/音频 URL（含 fetchable 标记）。',
          ],
          notes: ['需要任意 JS 时切到 direct/expert。'],
        })
      ),
    selector: z.string().min(1).max(1000).optional().describe(
      parameterDescription({
        description: 'selector_* 预设使用的 CSS selector。',
        usage: ['preset 以 selector_ 开头时必须提供。'],
      })
    ),
    attribute: z.string().min(1).max(120).optional().describe(
      parameterDescription({
        description: 'selector_attribute 预设使用的属性名。',
        usage: ['preset=selector_attribute 时必须提供。'],
      })
    ),
    limit: z.number().int().positive().max(100).optional().describe(
      parameterDescription({
        description: '最多返回多少项。',
        notes: ['默认 20。'],
      })
    ),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(50000)
      .optional()
      .describe(
        parameterDescription({
          description: '最多返回多少字符。',
          notes: ['默认 4000。'],
        })
      ),
  })
  .superRefine((input, issueCtx) => {
    const needsSelector = input.preset.startsWith('selector_')
    if (needsSelector && !input.selector?.trim()) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selector'],
        message: 'selector_* 预设必须提供 selector。',
      })
    }
    if (input.preset === 'selector_attribute' && !input.attribute?.trim()) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attribute'],
        message: 'selector_attribute 预设必须提供 attribute。',
      })
    }
  })

export type BrowserEvaluateScriptPresetInput = z.infer<typeof browserEvaluateScriptPresetSchema>

export function normalizeBrowserEvaluateScriptPreset(
  input: BrowserEvaluateScriptPresetInput
): BrowserEvaluateScriptInput {
  const selector = JSON.stringify(input.selector ?? '')
  const attribute = JSON.stringify(input.attribute ?? '')
  const maxChars = input.maxChars ?? 4000
  const limit = input.limit ?? 20

  const scripts: Record<BrowserEvaluateScriptPresetInput['preset'], string> = {
    title: 'return { title: document.title || "" };',
    url: 'return { url: location.href };',
    body_text: [
      'const text = document.body?.innerText || "";',
      `return { text: text.slice(0, ${maxChars}), truncated: text.length > ${maxChars} };`,
    ].join('\n'),
    selector_text: [
      `const nodes = Array.from(document.querySelectorAll(${selector})).slice(0, ${limit});`,
      `return nodes.map((el, index) => { const text = el.innerText || el.textContent || ""; return { index, text: text.slice(0, ${maxChars}), truncated: text.length > ${maxChars} }; });`,
    ].join('\n'),
    selector_attribute: [
      `const nodes = Array.from(document.querySelectorAll(${selector})).slice(0, ${limit});`,
      `return nodes.map((el, index) => ({ index, value: el.getAttribute(${attribute}) }));`,
    ].join('\n'),
    selector_count: `return { count: document.querySelectorAll(${selector}).length };`,
    selector_visible: [
      `const el = document.querySelector(${selector});`,
      'if (!el) return { found: false, visible: false };',
      'const r = el.getBoundingClientRect();',
      'const style = getComputedStyle(el);',
      "return { found: true, visible: !!(r.width || r.height) && style.visibility !== 'hidden' && style.display !== 'none' };",
    ].join('\n'),
    selector_value: [
      `const el = document.querySelector(${selector});`,
      'if (!el) return { found: false, value: null, truncated: false };',
      'const raw = "value" in el ? el.value : el.getAttribute("value") ?? el.textContent ?? "";',
      'const value = String(raw);',
      `return { found: true, value: value.slice(0, ${maxChars}), truncated: value.length > ${maxChars} };`,
    ].join('\n'),
    selector_enabled: [
      `const el = document.querySelector(${selector});`,
      'if (!el) return { found: false, enabled: false };',
      'const disabled = el.matches(":disabled") || el.getAttribute("aria-disabled") === "true";',
      'return { found: true, enabled: !disabled };',
    ].join('\n'),
    selector_checked: [
      `const el = document.querySelector(${selector});`,
      'if (!el) return { found: false, checked: null };',
      'const ariaChecked = el.getAttribute("aria-checked");',
      'const checked = "checked" in el ? Boolean(el.checked) : ariaChecked === null ? null : ariaChecked;',
      'return { found: true, checked };',
    ].join('\n'),
    selector_box: [
      `const el = document.querySelector(${selector});`,
      'if (!el) return { found: false, box: null, visible: false };',
      'const r = el.getBoundingClientRect();',
      'const style = getComputedStyle(el);',
      'return {',
      '  found: true,',
      '  box: { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left },',
      '  visible: !!(r.width || r.height) && style.visibility !== "hidden" && style.display !== "none",',
      '};',
    ].join('\n'),
    selector_styles: [
      `const el = document.querySelector(${selector});`,
      'if (!el) return { found: false, styles: null };',
      'const style = getComputedStyle(el);',
      'return {',
      '  found: true,',
      '  styles: {',
      '    display: style.display,',
      '    visibility: style.visibility,',
      '    opacity: style.opacity,',
      '    position: style.position,',
      '    pointerEvents: style.pointerEvents,',
      '    cursor: style.cursor,',
      '    color: style.color,',
      '    backgroundColor: style.backgroundColor,',
      '    fontSize: style.fontSize,',
      '    zIndex: style.zIndex,',
      '  },',
      '};',
    ].join('\n'),
    json_ld: [
      `const nodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, ${limit});`,
      'return nodes.map((node, index) => {',
      '  try { return { index, ok: true, value: JSON.parse(node.textContent || "null") }; }',
      '  catch (error) { return { index, ok: false, error: String(error) }; }',
      '});',
    ].join('\n'),
    media_sources: [
      'const resolveUrl = (raw) => {',
      '  if (!raw || typeof raw !== "string") return null;',
      '  try { return new URL(raw.trim(), location.href).href; } catch { return null; }',
      '};',
      'const isFetchable = (url) => /^https?:/i.test(url);',
      'const seen = new Set();',
      'const items = [];',
      'const add = (entry) => { if (!entry?.url || seen.has(entry.url)) return; seen.add(entry.url); items.push(entry); };',
      'const push = (kind, url, extra = {}) => {',
      '  const resolved = resolveUrl(url);',
      '  if (!resolved || resolved.startsWith("data:") || resolved.startsWith("blob:")) return;',
      '  add({ kind, url: resolved, fetchable: isFetchable(resolved), ...extra });',
      '};',
      'for (const img of Array.from(document.querySelectorAll("img"))) {',
      '  push("image", img.currentSrc || img.src, { tagName: "img", attribute: "src", alt: img.alt || null });',
      '}',
      'for (const video of Array.from(document.querySelectorAll("video"))) {',
      '  push("video", video.currentSrc || video.src, { tagName: "video", attribute: "src" });',
      '  for (const source of Array.from(video.querySelectorAll("source"))) {',
      '    push("video", source.src || source.getAttribute("src"), { tagName: "source", attribute: "src" });',
      '  }',
      '}',
      `return { items: items.slice(0, ${limit}), truncated: items.length > ${limit} };`,
    ].join('\n'),
  }

  return {
    script: scripts[input.preset],
    mode: 'function-body',
    timeoutMs: 5000,
    maxResultChars: Math.min(200000, Math.max(20000, maxChars * Math.min(limit, 20))),
  }
}
