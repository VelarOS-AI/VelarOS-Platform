# @velaros-ai/browser-tools 中文接口文档

## 定位与非目标

本包提供可注册到任意兼容 Agent runtime 的浏览器工具定义、Zod 输入 schema、能力声明和工具上下文协议。工具通过 `ToolBrowserApi` 调用宿主浏览器，不直接依赖 Electron。

本包不创建浏览器、不保存会话、不管理 UI，也不依赖某个 Agent 循环实现。

## 安装

```bash
npm install @velaros-ai/browser-tools @velaros-ai/browser-core @velaros-ai/core zod
```

要求 Node.js 20 及以上。

## 公共入口

```ts
import {
  browserTools,
  type BrowserToolContext,
  type ToolBrowserApi,
  type VelaTool,
} from '@velaros-ai/browser-tools'

import { runBrowserToolsCli } from '@velaros-ai/browser-tools/cli'
```

## 核心类与接口

- `browserTools`：按工具名索引的不可变工具定义集合。
- `ToolBrowserApi`：已经绑定到当前 session 的浏览器能力端口。
- `BrowserToolContext`：单次执行的 browser、abortSignal 和宿主附加上下文。
- `VelaTool`：包含名称、schema、权限、能力元数据和 `execute()` 的结构契约。

工具面覆盖会话、检查、交互、页面数据、网络、阻塞事件、上传、导出、性能、录屏、产物、recipe 和用户脚本。

## 生命周期/并发

工具定义本身无状态，可在进程内复用。宿主应为每次调用创建或解析一个绑定当前 session 的 `BrowserToolContext`。取消通过 `AbortSignal` 传递；实际动作串行化由注入的 browser runtime 负责。

## 依赖注入

第三方宿主只需实现 `ToolBrowserApi`。可以使用 `CdpBrowserRuntime.bindBrowserApi()`，也可以把 Playwright、远程浏览器服务或自研 runtime 适配为相同接口。

## 错误模型

Zod 在最外层校验输入；工具内部不重复归一化同一输入。无活动会话、权限不足和执行失败应由宿主 API 抛出 `AppError` 或等价结构错误。Agent runtime 应保留错误代码和 cause。

## 最小第三方示例

```ts
import {
  browserTools,
  type BrowserToolContext,
  type ToolBrowserApi,
} from '@velaros-ai/browser-tools'

const browser: ToolBrowserApi = createPlaywrightBrowserAdapter(page)

for (const tool of Object.values(browserTools)) {
  thirdPartyAgent.registerTool({
    name: tool.name,
    schema: tool.schema,
    execute: (input, signal) => {
      const context: BrowserToolContext = {
        browser,
        abortSignal: signal,
        execution: null,
      }
      return tool.execute(input, context)
    },
  })
}
```

## 扩展点

新增浏览器工具应使用现有工具 contract，声明权限、effect、并发语义和 Zod schema。宿主专属操作不应进入默认 `browserTools`；可在应用侧组合自己的额外工具集合。

## 兼容策略

现有工具名、输入 schema 和 `ToolBrowserApi` 必选成员保持兼容。新增宿主专属能力优先设计为可选方法。删除或重命名工具需要新的主版本。
