# HTML 工件（`@velaros-ai/ui/html-artifacts`）

**把模型的增量文本流，直接变成一个实时、隔离的 HTML 界面。**

零运行时依赖的浏览器库：统一负责协议解析、iframe 生命周期、补丁传输、受限高度协商、链接校验和资源清理——
接入方不用自己拼 `postMessage` 和流式渲染那一摊。不依赖 React、Electron、Agent Loop，也不绑定任何一家模型 API。
它原来是独立包 `@velaros-ai/html-artifacts`，2026-09-18 并进 `@velaros-ai/ui` 成为一个单元（ADR 0014），名字与行为不变。
模块卡片见 [`html-artifacts/MODULE.md`](../html-artifacts/MODULE.md)，对外承诺见 [`html-artifacts/spec/invariants.md`](../html-artifacts/spec/invariants.md)。

| 入口 | 内容 |
| --- | --- |
| `@velaros-ai/ui/html-artifacts` | 三件能力：增量协议 `htmlArtifactProtocol`、沙箱文档 `htmlArtifactDocuments`、浏览器宿主 `mountHtmlArtifact()` |
| `@velaros-ai/ui/html-artifacts/contracts` | 它的子集，只有约定常量与可移植数据类型；只要数据不要能力时用它 |

## 快速开始

```ts
import { mountHtmlArtifact } from '@velaros-ai/ui/html-artifacts'

const container = document.querySelector<HTMLElement>('#preview')
if (!container) throw new Error('Missing #preview')

const artifact = mountHtmlArtifact(container, {
  maxHeight: 720,
  onPrompt: (prompt) => sendToModel(prompt),
  onLink: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
  onError: (error) => console.error(error.phase, error.message),
})

await artifact.consume(modelTextStream)

// 外层视图销毁时：
artifact.dispose()
```

`modelTextStream` 可以是任意模型服务给的 `AsyncIterable<string>`。

挂载会在目标元素内创建**一个 `sandbox="allow-scripts"` 的 iframe**。生成的代码只能在沙箱里跑；
打开链接、继续提问这类能力是**宿主显式授权的回调**，不是沙箱自己的权力。

## 三件必须理解的机制

### 1. 流边界：chunk 可以停在任何地方

Chunk 可以断在半个 HTML 标签、CSS 规则、脚本或 Base64 载荷中间。**只有完整、安全的协议边界才会被送进 iframe。**
应用已有自己的流循环时，用 `write()` + `finish()` 代替 `consume()`：

```ts
for await (const chunk of modelTextStream) artifact.write(chunk)
artifact.finish()

artifact.reset()    // 复用同一个 iframe 接下一次回答
artifact.dispose()  // 移除 iframe 与全部宿主监听器
```

### 2. 高度：绝对值，单向

iframe 运行时上报的是**去重后的绝对内容高度**，宿主直接应用——不加 padding，也不把 viewport 增长反馈回测量过程（那正是无限撑高的来源）。
`maxHeight` 在 iframe 内部和浏览器宿主层**两侧都生效**：超高内容或 `100vh` 这类 viewport 耦合页面会留在沙箱里滚动，不会把外层页面顶穿。

```ts
mountHtmlArtifact(container, { initialHeight: 360, minHeight: 1, maxHeight: 720 })
```

### 3. 链接：默认只放行 http / https

无效或主动执行型 URL（`javascript:` 一类）通过 `onError` 上报，**永远不会到达 `onLink`**。

## 宿主回调

`onMarkdown` / `onPrompt` / `onLink` / `onMessage` / `onEvent` / `onError`。这六个是沙箱与外界之间的全部通道——**没有隐式能力**。

## Artifact 协议

v1 线格式刻意保持很小：

```html
<artifact version="1" id="profile-card" title="Profile card">
  <patch type="replace"><main id="app"></main></patch>
  <patch type="append" target="#app"><h1>Hello</h1></patch>
  <patch type="style" id="base">#app { padding: 24px; }</patch>
  <patch type="script" id="boot">console.log('ready')</patch>
</artifact>
```

patch 载荷本身含有协议闭合标签时，用 `encoding="base64"`。

协议这件能力提供两种形态：自己管状态的 `htmlArtifactProtocol.createParser()`，以及宿主自己持久化状态的
`htmlArtifactProtocol.createState()` / `.applyChunk(state, chunk)` / `.finalize(state)`。`HtmlArtifactProtocolLimits` 用于给不可信或异常超长的流设资源上限。

自己托管 iframe（不用 `mountHtmlArtifact`）的宿主拿 `htmlArtifactDocuments`：
`buildDocument` / `buildShellDocument` / `normalizeSource` / `inferContentKind` / `resolveFrameFit` / `normalizeExternalUrl`。

## 宿主的安全责任

交给它的 HTML 一律当**不可信输入**。改沙箱、脚本、URL 或消息桥之前先读这一节：

- 用沙箱 iframe。够用的最小策略通常是 `sandbox="allow-scripts"`，不给 `allow-same-origin`。
- 接受任何桥消息之前，先核对 `MessageEvent.source` 是不是这个 iframe 的 `contentWindow`。
- 在宿主里把消息载荷再校验一遍：消息名只是路由提示，不是授权。
- 文件、进程、凭据、剪贴板、支付与网络这些权力一律留在 iframe 外面。
- 外部跳转经 `htmlArtifactDocuments.normalizeExternalUrl`，或者同样严格的宿主策略。
- 按宿主自己的威胁模型配内容安全策略（CSP）。

生成的 iframe 外壳会上报运行时错误，但不授予任何宿主能力；它的 `postMessage` 桥只是一条请求通道。
发现漏洞请先别公开利用细节，经 GitHub 仓库的安全报告渠道联系维护者。

## 边界：它不负责什么

只维护**可复用的流式协议与沙箱机制**。不含模型提示词、聊天状态、Agent 调度、Electron IPC、产品 UI、权限、Widget、记忆或 Kernel 内部实现。
