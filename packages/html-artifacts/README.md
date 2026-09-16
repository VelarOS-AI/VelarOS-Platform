# @velaros-ai/html-artifacts

**把模型的增量文本流,直接变成一个实时、隔离的 HTML 界面。**

该包与 Platform 其余第一方源码一致，采用 Apache License 2.0。
它是零运行时依赖的浏览器库:统一负责协议解析、iframe 生命周期、补丁传输、
受限高度协商、链接校验和资源清理——接入方不用自己拼 `postMessage` 和流式渲染那一摊。

不依赖 React、Electron、Agent Loop,也不绑定任何一家模型 API。

## 分区

| 入口 | 内容 |
| --- | --- |
| `@velaros-ai/html-artifacts` | 包根,三件能力都在这里:增量协议 `htmlArtifactProtocol`、沙箱文档 `htmlArtifactDocuments`、浏览器宿主 `mountHtmlArtifact()` |
| `@velaros-ai/html-artifacts/contracts` | 包根的子集,只有约定常量与可移植数据类型;只要数据不要能力时用它 |

> 0.2.0 起入口收成这两个。原来的 `/protocol`、`/sandbox`、`/browser`、`/runtime` 已删除,
> 里面的函数改成三件能力上的方法(对照表见 [MODULE.md](./MODULE.md) 与下文)。

## 安装

`@velaros-ai/html-artifacts` 是托管在 GitHub Packages 上的**公开包(public package)**。
GitHub 的 npm registry 目前安装公开包**仍然需要认证**:
在本机或其他受控消费环境中，使用至少带 `read:packages` 权限的 personal access token
(classic)，通过进程环境或凭据管理器注入。把 `@velaros-ai` scope 映射到
`https://npm.pkg.github.com`，提供 token 后:

```bash
npm install @velaros-ai/html-artifacts
```

> 在 VelarOS-Platform 单仓内,`dist/` 不入版本库(仓根 `.gitignore` 忽略 `dist/`),
> 由构建产出;走 npm 包的消费方拿到的是发布时打进 tarball 的 `dist/`。

## 快速开始

```ts
import { mountHtmlArtifact } from '@velaros-ai/html-artifacts'

const container = document.querySelector<HTMLElement>('#preview')
if (!container) throw new Error('Missing #preview')

const artifact = mountHtmlArtifact(container, {
  maxHeight: 720,
  onPrompt: (prompt) => sendToModel(prompt),
  onLink: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
  onError: (error) => console.error(error.phase, error.message),
})

await artifact.consume(modelTextStream)

// 外层视图销毁时:
artifact.dispose()
```

`modelTextStream` 可以是任意模型服务给的 `AsyncIterable<string>`。

挂载会在目标元素内创建**一个 `sandbox="allow-scripts"` 的 iframe**。
生成的代码只能在沙箱里跑;打开链接、继续提问这类能力是**宿主显式授权的回调**,
不是沙箱自己的权力。

## 三件必须理解的机制

### 1. 流边界:chunk 可以停在任何地方

Chunk 可以断在半个 HTML 标签、CSS 规则、脚本或 Base64 载荷中间。
**只有完整、安全的协议边界才会被送进 iframe。**
应用已有自己的流循环时,用 `write()` + `finish()` 代替 `consume()`:

```ts
for await (const chunk of modelTextStream) artifact.write(chunk)
artifact.finish()

artifact.reset()    // 复用同一个 iframe 接下一次回答
artifact.dispose()  // 移除 iframe 与全部宿主监听器
```

### 2. 高度:绝对值,单向

iframe 运行时上报的是**去重后的绝对内容高度**,宿主直接应用——
不加 padding,也不把 viewport 增长反馈回测量过程(那正是无限撑高的来源)。
`maxHeight` 在 iframe 内部和浏览器宿主层**两侧都生效**:
超高内容或 `100vh` 这类 viewport 耦合页面会留在沙箱里滚动,不会把外层页面顶穿。

```ts
mountHtmlArtifact(container, { initialHeight: 360, minHeight: 1, maxHeight: 720 })
```

### 3. 链接:默认只放行 http / https

无效或主动执行型 URL(`javascript:` 一类)通过 `onError` 上报,**永远不会到达 `onLink`**。

## 宿主回调

`onMarkdown` / `onPrompt` / `onLink` / `onMessage` / `onEvent` / `onError`。
这六个是沙箱与外界之间的全部通道——**没有隐式能力**。

## Artifact 协议

v1 线格式刻意保持很小:

```html
<artifact version="1" id="profile-card" title="Profile card">
  <patch type="replace"><main id="app"></main></patch>
  <patch type="append" target="#app"><h1>Hello</h1></patch>
  <patch type="style" id="base">#app { padding: 24px; }</patch>
  <patch type="script" id="boot">console.log('ready')</patch>
</artifact>
```

patch 载荷本身含有协议闭合标签时,用 `encoding="base64"`。

协议这件能力提供两种形态:自己管状态的 `htmlArtifactProtocol.createParser()`,
以及宿主自己持久化状态的 `htmlArtifactProtocol.createState()` / `.applyChunk(state, chunk)` /
`.finalize(state)`。`HtmlArtifactProtocolLimits` 用于给不可信或异常超长的流设资源上限。

自己托管 iframe(不用 `mountHtmlArtifact`)的宿主拿 `htmlArtifactDocuments`:
`buildDocument` / `buildShellDocument` / `normalizeSource` / `inferContentKind` /
`resolveFrameFit` / `normalizeExternalUrl`。

## 边界:本包不负责什么

只维护**可复用的流式协议与沙箱机制**。
不含模型提示词、聊天状态、Agent 调度、Electron IPC、产品 UI、权限、
Widget、Memory 或 VelarOS Kernel 内部实现。

通用修复先落在这里;产品只消费确定版本,自己那一层适配留在产品侧。

## 开发

```bash
npm run check     # typecheck + 验收与实现测试 + 生产 demo 构建 + 包契约
npm run demo
```

结构按仓库的模块所有权标准走:`src/` 下只有 `contract`、`types`、`impl`、`utils`、`exports` 五个目录,
对外承诺登记在 [spec/invariants.md](./spec/invariants.md),模块卡片是 [MODULE.md](./MODULE.md);
门是仓根的 `bun run check:module-ownership`。

包级门:`check:package-contract`(元数据 / exports / 文档 / 运行时导入 / 严格外部类型),
由仓根 `check:html-artifacts-package` 挂进 `check:gates`。产物一致性由它「逐个入口打包安装再
import」那一步覆盖;本包独立成仓时代那个比对 `dist` 的 `check:dist`、以及要 `v<version>` 标签的
`scripts/prepare-release.mjs` 与包内 `release:dry-run` 脚本都已删除——仓根 `.gitignore` 忽略 `dist/`,
前者两条断言恒为空;发版统一走仓根的 `release:local`,后者无人调用。

## 安全

生成的 HTML 属于**不可信输入**。改沙箱、脚本、URL 或消息桥之前,
先读 [SECURITY.md](./SECURITY.md)。

## 许可证

Apache License 2.0 © 2026 VelarOS-AI contributors（见 [LICENSE](./LICENSE)）。
