import { z } from "zod";

import { renderParameterDescription as parameterDescription } from "@velaros-ai/agent/tool-contract";
import { isBoolean, optionalWhen } from "@velaros-ai/core";

import type {
  BrowserEvaluateScriptResult,
  BrowserPageStorageResult,
} from "../core";

import {
  BrowserControlCapability,
  BrowserObserveCapability,
} from "./Capabilities";
import { requireActiveBrowserSite } from "./Context";
import type {
  BrowserEvaluateScriptInput,
  BrowserReadPageDataInput,
  BrowserReadPageStorageInput,
} from "./PageData";
import {
  browserEvaluateScriptSchema,
  browserReadPageDataSchema,
  browserReadPageStorageGuidedSchema,
  browserReadPageStorageSchema,
  normalizeBrowserReadPageData,
  normalizeBrowserReadPageStorageGuided,
} from "./PageData";
import { defineBrowserTool } from "./Types";

/** 读取当前页面 storage；外部 CDP 模式可读取浏览器 cookie jar 元数据。 */
const browserReadPageStorage = defineBrowserTool<BrowserReadPageStorageInput>({
  name: "browser:read_page_storage",
  role: "inspect",
  summary: "读取当前页面的浏览器存储。",
  suitable: ["需要检查页面 localStorage、sessionStorage 或当前页 cookie。"],
  forbidden: ["不要用它读取 Electron、系统级 cookie 或其他站点存储。"],
  usage: [
    "传 limit；按需开启 includeCookies、storageScope 或调整 maxValueChars。",
  ],
  examples: [{ includeCookies: true, limit: 50 }],
  notes: [
    "webview 读取页面可见 cookie；外部 CDP 模式可返回 cookie jar 元数据和 frame origin storage。",
  ],
  schema: browserReadPageStorageSchema,
  surfaces: {
    guided: {
      role: "inspect",
      summary: "读取当前页面的浏览器存储。",
      suitable: ["需要调整读取范围或启用 cookie 读取。"],
      forbidden: ["不要用它读取当前页面之外的存储。"],
      usage: [
        "可传 includeLocalStorage、includeSessionStorage、includeCookies、storageScope 和 limit。",
      ],
      examples: [{ includeCookies: true, limit: 80 }],
      notes: ["省略 limit 时默认每类 50 项。"],
      schema: browserReadPageStorageGuidedSchema,
      normalize: normalizeBrowserReadPageStorageGuided,
    },
    preset: {
      role: "inspect",
      summary: "用默认上限读取当前页面常用存储。",
      suitable: ["需要快速查看 localStorage 和 sessionStorage。"],
      forbidden: ["不要用它调整读取上限。"],
      usage: ["可传 includeCookies。"],
      examples: [{ includeCookies: true }],
      notes: ["需要精细上限时切到 guided/direct。"],
      schema: z.object({
        includeCookies: z
          .boolean()
          .optional()
          .describe(
            parameterDescription({
              description: "是否读取当前页 cookie。",
              notes: ["默认 false。"],
            }),
          ),
      }),
      normalize: (input) => {
        const includeCookies = input.includeCookies;
        return {
          includeCookies: optionalWhen(
            isBoolean(includeCookies),
            Boolean(includeCookies),
          ),
          limit: 50,
        };
      },
    },
  },
  permissions: ["network"],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (
    {
      includeLocalStorage,
      includeSessionStorage,
      includeCookies,
      storageScope,
      cookieScope,
      limit,
      maxValueChars,
    },
    ctx,
  ): Promise<BrowserPageStorageResult> => {
    ctx.abortSignal.throwIfAborted();
    requireActiveBrowserSite(ctx);

    // external CDP 模式会读当前页对应的浏览器 cookie jar；webview 保持页面可见 cookie。
    return ctx.browser.readPageStorage({
      includeLocalStorage,
      includeSessionStorage,
      includeCookies,
      storageScope,
      cookieScope,
      limit,
      maxValueChars,
    });
  },
});

/** 用固定读取预设查询当前页面数据，不向模型开放 JavaScript。 */
const browserReadPageData = defineBrowserTool<BrowserReadPageDataInput>({
  name: "browser:read_page_data",
  role: "inspect",
  summary: "用受控预设读取当前页面数据。",
  suitable: ["需要读取标题、URL、正文、selector 信息、JSON-LD 或媒体 URL。"],
  forbidden: [
    "不要用它执行页面动作或表达任意脚本逻辑。",
    "需要完整页面结构、链接和交互元素时优先用 browser:inspect_page。",
  ],
  protocol: ["选择最窄的 preset，并按需限制 maxChars 或 limit。"],
  usage: ["传 preset；selector_* 预设按需传 selector 和 attribute。"],
  examples: [
    { preset: "body_text", maxChars: 4000 },
    { preset: "selector_text", selector: ".title", limit: 5 },
  ],
  notes: [
    "所有预设只读取页面状态；需要任意 JavaScript 时改用 browser:evaluate_script。",
  ],
  schema: browserReadPageDataSchema,
  permissions: ["network"],
  capabilities: BrowserObserveCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => true,
  execute: async (input, ctx): Promise<BrowserEvaluateScriptResult> => {
    ctx.abortSignal.throwIfAborted();
    requireActiveBrowserSite(ctx);

    return ctx.browser.evaluateScript(normalizeBrowserReadPageData(input));
  },
});

/** 在当前页面沙盒中执行任意 JavaScript。 */
const browserEvaluateScript = defineBrowserTool<BrowserEvaluateScriptInput>({
  name: "browser:evaluate_script",
  role: "control",
  summary: "在当前浏览器页面上下文执行 JavaScript。",
  suitable: [
    "明确需要用自定义 JavaScript 完成其他 browser 工具未覆盖的检查或调试。",
  ],
  forbidden: [
    "不要用它访问 Node、Electron 主进程或系统资源。",
    "不要用它读取标题、URL、正文、selector、JSON-LD 或媒体 URL；改用 browser:read_page_data。",
    "不要在可用专用 browser 工具时优先写脚本。",
  ],
  protocol: [
    "先判断是否有专用工具；必须执行脚本时限制 timeoutMs 和 maxResultChars。",
  ],
  usage: ["传 script；按脚本形态选择 mode。"],
  examples: [
    // 单表达式：mode=expression，直接返回表达式的值
    { script: "document.title", mode: "expression" },
    // 多语句/需要 return：mode=function-body
    {
      script: 'const els = document.querySelectorAll("a"); return els.length',
      mode: "function-body",
      maxResultChars: 2000,
    },
  ],
  notes: ["结果会结构化序列化并裁剪。"],
  schema: browserEvaluateScriptSchema,
  permissions: ["network"],
  capabilities: BrowserControlCapability,
  isAvailable: (ctx) => ctx.browser.isActive(),
  isConcurrencySafe: () => false,
  execute: async (
    { script, mode, timeoutMs, maxResultChars },
    ctx,
  ): Promise<BrowserEvaluateScriptResult> => {
    ctx.abortSignal.throwIfAborted();
    requireActiveBrowserSite(ctx);

    // runtime 会限制执行环境、等待超时，并裁剪序列化后的返回值。
    return ctx.browser.evaluateScript({
      script,
      mode,
      timeoutMs,
      maxResultChars,
    });
  },
});

/** 页面数据类工具出口。 */
const browserPageDataTools = {
  "browser:read_page_storage": browserReadPageStorage,
  "browser:read_page_data": browserReadPageData,
  "browser:evaluate_script": browserEvaluateScript,
};
export { browserPageDataTools };
