# DevTools Performance Engine（vendor 产物）

`devtoolsPerformanceEngine.mjs` 是生成文件，请勿手改；
重新生成：`node scripts/build/buildDevtoolsPerformanceEngine.mjs`。

## 内容与来源

- **引擎本体**：[chrome-devtools-frontend](https://www.npmjs.com/package/chrome-devtools-frontend)
  `1.0.1652307` 的 `front_end/models/trace`（trace 解析 + insights）与
  `front_end/models/ai_assistance/data_formatters`（面向 agent 的文本格式化器），
  以及它们的传递依赖。
  License: BSD-3-Clause, Copyright The Chromium Authors。
- **消费方式**：入口子集、locales/codemirror stub 的做法吸收自
  [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
  （Apache-2.0, Copyright Google LLC）。

## 导出面

- `TraceEngine`：`TraceModel.Model.createWithAllHandlers()` 等 trace 引擎全量命名空间。
- `PerformanceTraceFormatter` / `PerformanceInsightFormatter`：把 parsedTrace/insight
  格式化成模型可读文本。
- `AgentFocus`：formatter 需要的 trace 聚焦上下文。

## 约束

- Node-only（Electron 主进程），依赖 Node ≥ 22 的 iterator helpers / Set 方法。
- i18n 固定 en-US；formatter 输出为英文文本，供模型消费，不面向用户 UI。
- 包内含少量懒加载 worker 的 `import.meta` 引用，trace 解析路径不会触发。
