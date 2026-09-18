# @velaros-ai/ui/html-artifacts 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 先看三件能力各自类上方的接口（`impl/` 里，`contract/provides.ts` 登记它们），常量表在 `contract/constants.ts`，注入面在 `contract/requires.ts`。
> 门禁：`bun run check:module-ownership`、`bun run check:html-artifacts-package`。

## 这是什么

把模型的增量文本流，直接变成一个实时、隔离的 HTML 界面。
一条流可以断在半个标签、半条 CSS 规则、半段 Base64 里，本包负责只把完整、安全的边界送进一个 `sandbox="allow-scripts"` 的 iframe，
再把沙箱里发生的事（提问、外链、自定义消息、脚本出错、尺寸变化）按宿主显式给的回调交回去。

它刻意不认产品：不依赖 React、Electron、Agent Loop，也不绑定任何一家模型 API；零运行时依赖，整条引用链不碰 Node 模块。
VelarOS 自己的两个消费方——`@velaros-ai/ui` 的聊天预览与 Desktop 的会话制品——都只用前两件能力（自己托管 iframe）；
第三件 `mountHtmlArtifact` 是给「不想自己托管 iframe」的接入方的整套实现。

以前是独立包 `@velaros-ai/html-artifacts`，2026-09-18 并进 `@velaros-ai/ui` 成为它的一个单元，入口换成 `@velaros-ai/ui/html-artifacts` 子路径（ADR 0014）。
用法与宿主的安全责任见 ui 的 [`docs/html-artifacts.md`](../docs/html-artifacts.md)。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：三件能力的 API 定义在各自类的上方，这里 re-export；对外的值都按接口标注类型：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `htmlArtifactProtocol` | `HtmlArtifactProtocolApi` | 增量协议：`createState` / `applyChunk` / `finalize`（宿主自己持久化状态时用）与 `createParser` |
| 经 `createParser()` 取得 | `HtmlArtifactProtocolParserApi` | 自己管状态的解析器：`state` / `write` / `finish` / `getSnapshot` / `reset` |
| `htmlArtifactDocuments` | `HtmlArtifactDocumentsApi` | 沙箱文档：`buildDocument` / `buildShellDocument` / `normalizeSource` / `inferContentKind` / `resolveFrameFit` / `normalizeExternalUrl` |
| `mountHtmlArtifact` | `HtmlArtifactController` | 浏览器宿主工厂：在一个元素里挂一个制品，返回控制它的句柄 |
| `HtmlArtifactProtocolContract` | 契约常量 | 协议版本与两种标签名 |
| `HtmlArtifactPatchTypes` | 契约常量 | 补丁的四种类型 |
| `HtmlArtifactProtocolModes` | 契约常量 | 解析器的三种模式 |
| `HtmlArtifactProtocolDiagnosticCodes` | 契约常量 | 解析期诊断码 |
| `HtmlArtifactHostErrorPhases` | 契约常量 | 宿主错误的四个来源分段 |
| `HtmlArtifactDefaults` | 契约常量 | 尺寸缺省与上限、缺省标题、外壳根元素 id |
| `HtmlArtifactProtocolLimitDefaults` | 契约常量 | 协议七项资源上限的缺省值 |
| `HtmlArtifactBridgeMessageTypes` | 契约常量 | 滚轮消息名与七个缺省桥接消息名 |
| `HtmlArtifactExternalUrlProtocols` | 契约常量 | 外链缺省放行的协议 |

**注入面**，声明在 `contract/requires.ts`：只有一个口子 `HtmlArtifactBrowserEnvironment`——宿主可替换的浏览器边界（建桥 id、造 iframe、订阅消息、代滚），
webview 与测试用；不给就用包自带的 DOM 实现。

**数据面**是 `types/html-artifacts.ts`（可移植）：协议事件与状态（`HtmlArtifactProtocolEvent`、`HtmlArtifactProtocolStreamState`、`HtmlArtifactProtocolStateSnapshot`、
`HtmlArtifactDescriptor`、`HtmlArtifactSnapshot`、`HtmlArtifactActionState`、`HtmlArtifactRenderPatch`、`HtmlArtifactProtocolDiagnostic`、`HtmlArtifactProtocolLimits`、
`HtmlArtifactProtocolStreamOptions`、`HtmlArtifactActionType`），以及文档与适配（`HtmlArtifactContentKind`、`HtmlArtifactBridgeMessages`、`HtmlArtifactDocumentOptions`、
`HtmlArtifactShellDocumentOptions`、`HtmlArtifactFrameFit`、`HtmlArtifactFrameFitInput`、`NormalizeHtmlArtifactExternalUrlOptions`）；
带回调的挂载选项 `MountHtmlArtifactOptions` 与宿主错误 `HtmlArtifactHostError` 在 `types/browser.ts`，不进可移植文件。

两个入口对应 `@velaros-ai/ui` 包清单 `exports` 里的 `./html-artifacts` 子路径，源文件是单元目录上的入口文件，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./html-artifacts` | 任何浏览器环境，含渲染进程与扩展 | 三件能力、注入面、常量表与全部公开数据 |
| `./html-artifacts/contracts` | 同上，只要数据不要能力时 | 常量表与可移植数据 |

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 解析一段流 | `htmlArtifactProtocol.applyChunk(state, chunk)` → `utils/protocol-stream.ts` 的状态机按模式推进（Markdown → 制品 → 补丁）→ 只在完整安全的边界上吐事件 → 尾巴留在 `state.buffer` 等下一个 chunk |
| 自己管状态 | `htmlArtifactProtocol.createParser(options)` → `HtmlArtifactProtocolParser` 持有那个状态 → `write` / `finish` 转给同一组纯函数，`state` 给一份逐层冻结的快照 |
| 造一份 iframe 文档 | `htmlArtifactDocuments.buildDocument(source, options)` / `.buildShellDocument(options)` → `utils/shell-document.ts` 拼头部桥接脚本、尺寸控制器（源码来自 `utils/size-controller.ts`，缺省值从常量表插值）与补丁运行时 |
| 算 frame 尺寸 | `htmlArtifactDocuments.resolveFrameFit(input)` → `utils/frame-fit.ts` 按宽度比例给缩放比，超过 `hostMaxScaleDownWidthRatio` 倍就停止缩放 |
| 过一个外链 | `htmlArtifactDocuments.normalizeExternalUrl(value, options)` → `utils/external-url.ts` 按协议白名单判，不合法给 null |
| 挂一个制品 | `mountHtmlArtifact(target, options)` → `HtmlArtifactRuntime` 建桥（注入面给 id）、造 iframe、写外壳 → 解析事件经 `postMessage` 送进沙箱 → 沙箱回来的消息按桥接消息名分流到六个宿主回调 → `reset()` 换外壳复用、`dispose()` 收干净 |

## 依赖什么

- 零运行时依赖：不依赖 `@velaros-ai/core`，守卫与迷你日志在 `utils/runtime-guards.ts`、`utils/runtime-log.ts` 各自留一份最小实现。
- 不碰 Node 内置模块、不读环境变量、不读写磁盘、不发请求。
- 只用浏览器里本来就有的东西：`postMessage`、`iframe`、`URL`、`ResizeObserver` / `MutationObserver`（没有时退化成定时上报）。

## 状态归谁

- 协议状态：要么在调用方手里（`createState` 给出来的纯数据，宿主可以自己序列化持久化），要么在解析器实例里。`htmlArtifactProtocol` 自己没有状态。
- `htmlArtifactDocuments` 完全无状态，同样的入参给同样的出参。
- 挂载出来的每个制品各持一份状态：iframe、解析器、这一实例专属的桥接消息名、未送达的消息队列、最近动过的制品 id。同页多个制品互不影响。

## 生命周期

- `htmlArtifactProtocol` 与 `htmlArtifactDocuments` 随进程存在，没有要释放的东西。
- 一个挂载出来的制品：`mountHtmlArtifact()` 建 → `ready` 在外壳加载完后落定 → `write` / `finish` 或 `consume` 喂流 → `reset()` 换一份干净外壳接下一次回答（iframe 身份保留）→ `dispose()` 移除 iframe 与全部监听器。
- `dispose()` 之后再调 `write` / `finish` / `reset` 会抛错；重复 `dispose()` 是空操作。

## 失败语义

- 解析期的问题不中断流：按 `artifact-diagnostic` 事件报出来，宿主侧转成 `phase: 'protocol'` 的错误；同一个指纹只报一次。
- 非法外链不抛错、不进 `onLink`，只经 `onError` 的 `phase: 'security'` 报出来。
- 沙箱里的脚本出错经消息桥回到 `phase: 'runtime'`；宿主自己的回调抛错被接住，转成 `phase: 'host'`，不会把宿主的渲染打断。
- 只有三种程序错误会抛：挂载目标不是元素、同一时刻消费第二条流、`dispose()` 之后继续用。
- 外面按 `phase` 与诊断码判断，不按文字；文字是中文，只给人看。

## 不变量

共 7 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。
按检验方式：测试 5 条、门禁 1 条、类型 1 条。未验证 0 条。

## 非目标

- 不管模型怎么被提示出这段协议：提示词、聊天状态、Agent 调度都在别处。
- 不管产品 UI：折叠、工具栏、下载、复制代码这些由消费方自己做，本包只给机制。
- 不管权限与审批：打开链接、继续提问是宿主显式授权的回调，不是沙箱自己的权力。
- 不做 Widget、Memory、Kernel 那一摊：本包只维护可复用的流式协议与沙箱机制。

## 结构

```text
html-artifacts/
  contract/     对外合同：provides.ts 登记三件能力的 API（定义在各自类上方，这里 re-export），requires.ts 只有一个注入口子，constants.ts 是协议约定、尺寸缺省、资源上限、桥接消息名与外链白名单
  types/        只放类型：html-artifacts.ts 是可移植数据，browser.ts 是带回调的挂载选项与宿主错误，internals.ts 是不出包的工作类型
  impl/         一类一文件：HtmlArtifactProtocol、HtmlArtifactProtocolParser、HtmlArtifactDocuments、HtmlArtifactRuntime、DomHtmlArtifactEnvironment
  utils/        protocol-stream.ts 状态机本体、shell-document.ts 文档构造、size-controller.ts 注入脚本源码、frame-fit.ts 宿主缩放、external-url.ts 外链白名单、host-bridge.ts 宿主侧小工具、runtime-guards.ts 与 runtime-log.ts 零依赖副本、tuning.ts 可调参数
  index.ts      `./html-artifacts` 入口，只转发
  contracts.ts  `./html-artifacts/contracts` 入口，只转发
spec/           不变量登记、验收测试与共用的浏览器假件
test/           实现细节测试
demo/           一个不进包的演示页
```

**分层。** 从上到下三层，下层不许引上层（登记在 `scripts/ownership/governed-modules.mjs`）：
浏览器宿主 `HtmlArtifactRuntime.ts` → 三件能力的出口与注入面缺省实现 `HtmlArtifactProtocol.ts` / `HtmlArtifactDocuments.ts` / `DomHtmlArtifactEnvironment.ts` → 解析器 `HtmlArtifactProtocolParser.ts`。
utils 在所有层之下，只引 utils、types 与合同。

**类与接口。** 类实现的接口定义在类文件里、紧挨在类的上方并导出，在 `contract/provides.ts` 登记（注入面的在 `requires.ts`）；类的公开成员只能是接口里的成员。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `HtmlArtifactProtocol.ts` | `HtmlArtifactProtocolApi`（同文件，provides 登记） | 增量协议的唯一出口，实例 `htmlArtifactProtocol` |
| `HtmlArtifactProtocolParser.ts` | `HtmlArtifactProtocolParserApi`（同文件，provides 登记） | 自己管状态的解析器，经 `createParser()` 取得 |
| `HtmlArtifactDocuments.ts` | `HtmlArtifactDocumentsApi`（同文件，provides 登记） | 沙箱文档与尺寸、外链判定的唯一出口，实例 `htmlArtifactDocuments` |
| `HtmlArtifactRuntime.ts` | `HtmlArtifactController`（同文件，provides 登记） | 一个 iframe 接一条流的整条生命周期，经工厂 `mountHtmlArtifact()` 取得 |
| `DomHtmlArtifactEnvironment.ts` | `HtmlArtifactBrowserEnvironment`（`contract/requires.ts`） | 注入面的缺省实现，直接用当前窗口与文档 |
