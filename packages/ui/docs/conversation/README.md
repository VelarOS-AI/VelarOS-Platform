# @velaros-ai/ui/conversation

完整的公共入口、宿主端口、生命周期和第三方接入方式见
[中文 API 文档](./docs/api.zh-CN.md)。

聊天渲染门面包（批 5，绞杀者式抽取）。用户新 UI 的会话渲染件：消息块管线、工具卡族、
`UserActionCard` / `AskUserCarousel`、`FileChangeSummaryList`、流式起搏（`ChatStreamPacer`
屏显节奏唯一权威）、`ChatConversationPane` 组合层。底座（`CardKit` / `ActionCard` / 原语）
留在 `@velaros-ai/ui`，本包消费之。

## Responsibility

- 承载用户新 UI 的会话渲染半壁：流式起搏、消息块分发、工具卡族与组合层。
- 定义窄注入契约（i18n / action / render-slot），把宿主能力反转进包，包本体零 IPC。
- 自持纯展示 DTO、Result 结构、计时器与展示元数据；不依赖 Kernel/Core/Agent/Workspace 运行时。
- 作为聊天渲染件的唯一长期归属；desktop 只保留 store→props 投影与端口实现的胶水。
- 已入包（步骤 1）：`ChatStreamPacer` 屏显节奏起搏器（React-free）+ `streamPaceBudget`
  纯预算函数；`ConversationLocalizationProvider` 窄本地化 Provider。
- 已入包（步骤 3）：`tool-render/` 工具渲染能力注入契约（`ChatToolRenderCapabilities` +
  Provider/hook），reverse-shared 的能力端口从 desktop 迁入，宿主反向消费。
- 步骤 2（CSS 平行树同居）已在 desktop 内完成：`chat/conversation` 的 CSS module 逐个与组件同居，
  为组件入包铺路。
- 已入包（pass-4，shell 収口）：会话壳三件 `ChatConversationPane`（844L 组合层）/ `ChatTranscript` /
  `ChatScrollNavigator` + 其派生 hook 与纯 util（transcript 模型 / 窗口 / 滚动 / live-status /
  awaiting-confirmation / 交互状态 / 派生索引 / 翻页哨兵 / rafSchedule / worker 线程时间轴）;
  三处 IPC(goal 生命周期读写 / 执行指导)反转成注入端口 `ConversationActionPort`,宿主留 rendererIpc 实现。
  至此聊天页整页可由包件重组,desktop 只剩 store→props 投影 + 端口/slot 实现胶水;仅通用 composer 待迁(pass-5)。

## Public Imports

- `@velaros-ai/ui/conversation` — 门面：流式起搏与本地化 Provider 的聚合导出。
- `@velaros-ai/ui/conversation/contracts` — 纯展示 DTO 与结构化 `Result<T>` 契约；产品运行时在
  composition boundary 把富领域对象投影为这些结构，不向组件包泄露运行时所有权。
- `@velaros-ai/ui/conversation/stream` — `ChatStreamPacer` 起搏器 + `streamPaceBudget` 纯预算函数；
  思考增量去重经构造注入，起搏器不反依 desktop 状态半壁。
- `@velaros-ai/ui/conversation/i18n` — `ConversationLocalizationProvider` / `useConversationI18n`
  窄本地化契约；具体文案实现由宿主注入。
- `@velaros-ai/ui/conversation/tool-render` — 工具渲染能力注入契约 `ChatToolRenderCapabilities` +
  `ChatToolRenderCapabilitiesProvider` / `useChatToolRenderCapabilities`；具体 IPC 绑定由宿主注入
  （desktop 的 `createLiveChatToolRenderCapabilities`）。工具展示名/描述/摘要纯 util
  （`toolPresentation` / `toolCallSummary`）也归此，翻译经注入的纯函数 translator。
- `@velaros-ai/ui/conversation/status` — 会话运行状态渲染纯 util（`getChatStatusMeta` /
  `getChatNoticeMeta` / `getChatInlineNoticeMeta`）；接收 `locale` + 运行态窄投影 `ChatStatusRuntime`。
- `@velaros-ai/ui/conversation/render-slots` — 管线黑名单卡件的注入面 `ConversationRenderSlots`
  （§12.9 封闭有限具名集合）+ `ConversationRenderSlotsProvider` / `useConversationRenderSlots`；
  宿主在装配点提供 desktop 卡件实现。pass-3b2 分发器（`MessageContentBlock` + `MessageMarkdownBlocks`）
  入包后，过渡 slot `messageContentBlock` 退役；slot 面为**全永久**：黑名单卡（能力批准 / 定时任务提案 /
  旗标任务 / 浏览器截图组 / worker 线程面板）+ **block-dispatch viewmodel 容器**（`systemToolInstall` /
  `askUser` / `userActionCard`——包内 MessageContentBlock 分发到宿主薄容器，wizard 判定 + onActionComplete
  构造在包内，localStorage 可见性谓词在宿主 `userActionCard` slot 实现内应用）+ `messageFileChangeSummary`。
- 根门面（`.`）：气泡族 `MessageBubble`（+ User/Assistant 气泡、Segments、Footer、StatusMarker、
  InlineRuntimeNotice、UserAttachmentGallery，pass-3b1）+ 单块分发器 `MessageContentBlock` /
  `MessageMarkdownBlocks` / `useMessageMarkdownComponents`（pass-3b2，包内相对消费，不进门面）+ 消息动作行、
  渲染模型 `messageBubbleRenderModel` / 成本估算 / 动作项 / 思考翻译 / live-text 纯 util、品牌帆标 `VelarSailMark`；
  以及 blocks **hook 注入面** `ConversationBlockHooks`（`useMessageActionView` 反转宿主 message-action
  viewmodel；`useAutoTranslateThinkingEnabled` 反转宿主思考自动翻译开关）+ `ConversationBlockHooksProvider`。
  运行标记渲染切片走 `ConversationRunMarkerView` 投影，宿主完整 `ChatMessageRunMarker` 结构超型可赋值。
- 根门面（`.`，pass-4 shell 収口）：会话壳 `ChatConversationPane`（+`ChatConversationPaneProps`）/
  `ChatTranscript`（+导航句柄类型）/ `ChatScrollNavigator` + live-status hook `useQueuedLiveStatusText` +
  worker 线程时间轴纯 util（`groupWorkerThreadsByTranscriptAnchor` 等）；4 个 pane 私有 hook
  （transcript 模型 / 窗口 / 滚动 / awaiting）是实现细节不进门面。壳消费的运行态经 `ConversationView`
  §12.8 窄投影穿过：`runtime`→`ConversationRuntimeView`、`messageRunMarkers`、`turnContexts`、
  `pricingCatalog` 从 shell 边界穿过。**空间能力位下沉**：`ConversationView` 不透传原始 `WorkspaceSpaceKind`
  枚举，改由宿主边界从 space 描述符投影 `supportsWorkspaceFiles`（文件变更汇总 / 回退选文件能力位），
  包内壳按能力位分派,不散写枚举硬分派(no-enum-dispatch 门)。
- 动作端口 `ConversationActionPort`（+`ConversationActionPortProvider` / `useConversationActionPort`）：
  会话壳三处 IPC（`getGoalLifecycle` / `updateGoalLifecycle` / `provideExecutionGuidance`）反转成注入端口；
  goal 生命周期读写返回 `{ok, goal}` 软失败语义（`ok:false` 保持当前不清空，IPC 抛错冒泡到壳 catch）。
  desktop 在 `I18nProvider` 装配点绑定 `rendererIpc.chat.*` 实现。
- `@velaros-ai/ui/conversation/artifacts` — HTML 制品渲染件（`HtmlArtifactBlock` 沙箱预览 + 源码视图）；
  重件经此子路径按需 lazy 加载，不进根门面（避免任意 root import 预载沙箱）。
- `@velaros-ai/ui/conversation/html-preview` — 沙箱 iframe 预览簇（`HtmlPreviewFrame` / `HtmlPreviewToolbar` /
  便携文档构建 `buildHtmlPreviewDocument`）；经 `@velaros-ai/html-artifacts` 渲染，同样重件按需加载。
- `@velaros-ai/ui/conversation/markdown` — streamdown 消息 markdown 渲染配置/源构建/链接/代码围栏/流式冲刷纯 util 簇；聊天渲染 + 流式管线 + 设置面板共享。
- `@velaros-ai/ui/conversation/composer` — 会话输入框第五原子（pass-5 renderer 収官収尾）：`ChatComposer` / `ChatInput`
  组合层 + 输入框零件（`ComposerModelRunSelector` / `ComposerAddMenu` / `ComposerFilePreview` / skill·评论·下一步补全菜单 /
  语音输入）+ 复用型 hooks（`useChatInputFileAttachments` / `useComposerAddMenuState` / `useComposerPromptFeatures` …）+
  注入端口 `ConversationComposerPort`（本地语音三件 IPC / 云特性开关 / 提示 toast，`emptyConversationComposerPort` 供预览占位）+
  composer↔引导 DOM 事件名契约。数据 + 会话层回调经 `ChatComposerControl` 投影穿过；宿主保留草稿队列提交 wiring
  （`useChatPageComposerSurface` 深耦合 chatStore + IPC）+ 端口/插槽实现胶水。`ScheduledTaskComposerDialog` 复用同套零件拼装定时任务编辑面。
- `@velaros-ai/ui/conversation/i18n`（含实例化 translator）：
  `ConversationTranslatorRuntime` / `ConversationTranslatorProvider` /
  `useConversationTranslatorRuntime`——每个窗口或 React root 独立拥有翻译端口。旧的
  `configureConversationTranslator` / `conversationTranslate` / `conversationLookupMessage`
  默认单例只为兼容保留。

```ts
import { ChatStreamPacer, useChatToolRenderCapabilities } from '@velaros-ai/ui/conversation'
import {
  ConversationLocalizationProvider,
  ConversationTranslatorRuntime,
  useConversationI18n,
} from '@velaros-ai/ui/conversation/i18n'
```

## 0.2 consumer migration

- Upgrade `@velaros-ai/ui` and `@velaros-ai/ui/conversation` together to `0.2.x`.
- Conversation UI 只依赖 `@velaros-ai/ui` 与 HTML 沙箱包；宿主运行时能力全部通过显式 ports 注入，
  包依赖图中不存在 Kernel、Agent 或 Core。
- Product adapters may import the pure DTO/Result surface from `@velaros-ai/ui/conversation/contracts`.
  Existing Desktop message, stream, workspace-root, worker-thread and timer objects remain structurally
  assignable; the Desktop renderer typecheck is used as a compatibility smoke test.
- Existing supported component imports remain valid because every current Desktop/Workbench deep path is now
  listed explicitly in package exports. New deep imports must first become an intentional public export.

## Boundary

- 包内不得依赖 `src/renderer`、Desktop store、Desktop IPC 实例或 `react-router`。
- 包内不得依赖任何 VelarOS Kernel/Core/Agent/Workspace/Browser/Memory/Model/Capabilities 运行时包；
  只允许消费 `@velaros-ai/ui` 与 `@velaros-ai/html-artifacts` 这两个 UI/沙箱库。
- 包内不得依赖 Desktop i18n；desktop 在 `I18nProvider` 注入现有 `useI18n()` 实现。
- 宿主能力（openPath / IPC 动作 / 导航 / goal 生命周期）一律经 props 回调或注入端口进入。
- 跨复用的无状态原语（`CardKit` / `ActionCard`）属于 `@velaros-ai/ui`，不放入本包。
- 门面收口：外部只准依赖 `package.json#exports` 显式列出的根门面与受支持子路径；未导出的
  `src` / `dist` 原子均是实现细节。

## 包内 backlog（后续步骤，登记不合并、避免行为漂移）

- **两套平行折叠卡机制**：`ToolDisclosureCard`（@velaros-ai/ui）vs `RichToolOutputCard`
  （tool-render 富卡壳）——本批不合并，随包走后作为包内 backlog。
- **tool-render / cards / blocks 三原子全部入包**（tool-render pass-1/1.5/2/3a，气泡+动作+模型 pass-3b1，
  markdown 分发器 pass-3b2）；黑名单件与 viewmodel 容器（`FlaggedTaskSuggestionCard` /
  `ScheduledTaskProposalCard` / `CapabilityAutoApprovalNoticeCard` / `BrowserScreenshotGroup` /
  `WorkerThreadPanel` / `SystemToolInstallSuggestionCard` / `AskUserCarousel` / `UserActionCard` /
  `MessageFileChangeSummary`）已改注入 render-slot；过渡 slot `messageContentBlock` 已退役。
- **shell 収口件 `ChatConversationPane`（+`ChatTranscript` / `ChatScrollNavigator`）已入包**（pass-4，
  走 `ConversationActionPort`）；sticky-dock 异构内容收敛为单一判别式 slot `stickyDockItemContent`，
  消息边界错误屏障走 `renderMessageBoundary` slot（宿主留 `RenderErrorBoundary` + 陈旧模块自愈耦合）。
- **会话输入框 `ChatComposer` / `ChatInput` 及全部输入框零件已入包**（pass-5，`./composer` 子路径，走
  `ConversationComposerPort`）。**renderer 收官战役全部完成：聊天页 100% 由 `@velaros-ai/ui/conversation` 重组**，
  desktop 只剩会话层权威（store / IPC / 发送）与端口/插槽实现胶水。
