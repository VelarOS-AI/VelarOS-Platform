# `@velaros-ai/ui/conversation` 中文 API

## 定位与非目标

本包提供宿主无关的 React 会话界面：消息块、工具卡、流式显示节奏、输入框、HTML 预览和明确的
宿主能力端口。它只依赖 UI 与沙箱库，不依赖 Kernel、Agent、Workspace、Browser、Memory、
Model、Electron IPC、路由器或 Desktop Store。

本包不拥有会话持久化、模型调用、工具执行、权限决策和导航。宿主保留权威状态，只把渲染所需的窄
投影与操作端口传入。

## 安装

```bash
npm install @velaros-ai/ui/conversation @velaros-ai/ui react
```

按需引入 UI 令牌和会话组件使用的 CSS。宿主若启用 HTML 预览，需要让构建器支持动态 `import()`。

## 公共入口

| 入口 | 用途 |
| --- | --- |
| `.` | 会话壳、消息块、状态、流式与工具渲染公共面 |
| `./contracts` | 框架无关的会话 DTO 与端口类型 |
| `./composer` | 输入框与 Composer 端口 |
| `./stream` | `ChatStreamPacer` 与节奏算法 |
| `./tool-render` | 工具渲染注册表和工具卡 |
| `./render-slots` | 宿主自定义渲染槽 |
| `./i18n` | React 与纯函数本地化入口 |
| `./artifacts`、`./html-preview` | 按需加载的 HTML Artifact 界面 |
| `./markdown`、`./status` | Markdown 与状态展示 |

只有 `package.json#exports` 中的路径受版本兼容承诺。

## 核心类与接口

### `ChatStreamPacer`

该类按会话拥有 FIFO、帧租约、推理增量去重和终止排空状态。`ChatStreamPacerOptions` 的
`FrameTimerPort` 与所有写入回调由宿主注入：

```ts
const pacer = new ChatStreamPacer({
  timers,
  applyTextChunk,
  applyDeferredLiveEvent,
  applyImmediateLiveEvent,
  applyCachedEvent,
  appendImmediateText,
  isSessionStreaming,
  getReasoningAppendText,
})
```

### `ToolRendererRegistry`

每个应用、租户或嵌入面可以创建独立注册表，避免测试和多个宿主之间共享可变注册：

```tsx
const registry = new ToolRendererRegistry()
  .register('search', SearchToolCard)
  .setFallback(GenericToolCard)

<ToolCallBlock block={block} registry={registry} />
```

`ToolRenderRegistry` 是为旧接入与内置工具卡保留的共享默认实例。新宿主应优先显式创建实例。

### `ConversationTranslatorRuntime`

该类拥有一个 composition root 的纯函数翻译端口。多个窗口、多个 React root 和测试应分别创建，
从而避免最后一次全局配置覆盖其他界面：

```ts
const translatorRuntime = new ConversationTranslatorRuntime(translator)
translatorRuntime.translate('zh-CN', 'status.running')
translatorRuntime.dispose()
```

`ConversationLocalizationProvider` 默认会为当前 React root 创建并安装隔离实例；需要跨 React 与
非 React 模型共享同一实例时，传入 `translatorRuntime`。内部组件从
`useConversationTranslatorRuntime()` 取当前实例，纯模型 API 的最后一个可选参数也接受该实例。
`configureConversationTranslator()`、`conversationTranslate()` 与
`conversationLookupMessage()` 的默认全局实例仅为旧应用兼容。

### 宿主端口

- `ConversationActionPort`：目标生命周期、执行指导等会话动作。
- `ConversationComposerPort`：语音、云能力和提示反馈。
- `ConversationBlockHooks`：消息动作视图与偏好读取。
- Render Slots：把具有宿主业务语义的卡片、边界和 Dock 内容注入会话壳。

## 生命周期/并发

`ChatStreamPacer` 为每个 `sessionId` 保持一条动画帧链。`clearSession()` 取消帧并删除状态；
`flushImmediate()` 先按序提交积压再结束该会话。终止事件在正文平滑排空后应用，错误和交互事件立即
按序处理。

React Provider 的生命周期由宿主组合根拥有。卸载会话面前应取消外部流，清理对应 Pacer 会话，并
销毁宿主持有的 `ConversationTranslatorRuntime`。Provider 自动创建的实例随 React root 一起回收，
不存在跨 root 的可变翻译状态。

## 依赖注入

应用能力只能通过 Props、Provider、Render Slot 或 Port 注入。推荐在应用组合根一次完成适配：

```tsx
<ConversationActionPortProvider value={actions}>
  <ConversationComposerPortProvider value={composer}>
    <ConversationLocalizationProvider
      value={localization}
      translatorRuntime={translatorRuntime}
    >
      <ChatConversationPane {...viewProjection} />
    </ConversationLocalizationProvider>
  </ConversationComposerPortProvider>
</ConversationActionPortProvider>
```

库内契约是宿主模型的窄结构投影；结构可赋值时直接传入，不要求 DTO 来回转换。

## 错误模型

端口按各自契约返回结构化软失败或抛出异常。会话壳不会把所有错误改包成统一状态；宿主应在能力边界
记录错误，并通过 Render Slot 或现有错误视图展示。流式 Pacer 保证顺序，不负责重试模型请求。

## 最小第三方示例

```tsx
import { ToolCallBlock, ToolRendererRegistry } from '@velaros-ai/ui/conversation/tool-render'
import type { ToolCallBlock as ToolCall } from '@velaros-ai/ui/conversation/contracts'

const renderers = new ToolRendererRegistry()
renderers.register('weather', WeatherToolCard)

export function ToolMessage({ block }: { block: ToolCall }) {
  return <ToolCallBlock block={block} registry={renderers} />
}
```

第三方应用只需实现自己的会话存储、模型流和端口，不需要实现 VelarOS 接口或引入 Kernel。

## 扩展点

- 用独立 `ToolRendererRegistry` 注册应用工具卡。
- 用 Render Slots 的**增强槽**注入业务卡片（必填，缺注入即不显示，正文不受影响）。
- 用 Render Slots 的**替换槽** `messageMarkdown` / `messageCodeBlock` 换掉内置的正文 markdown 渲染器
  与围栏代码块渲染器。两格是 `ConversationRenderSlots` 上的**可选**属性，语义与增强槽相反：不提供 =
  官方内置件原行为；提供后由替换件全权渲染那一格。props 由官方件真实入参收窄
  （`ConversationMarkdownSlotProps` = `{ text, isStreaming }`；`ConversationCodeBlockSlotProps` =
  `{ language, code, isStreaming }`），不透传内部形状。
  - `text` 是官方渲染器逐字消费的那份正文；`isStreaming` 只用于静态呈现，替换件**不得自带揭示层**
    （屏显节奏的唯一权威是 `ChatStreamPacer`）。
  - 失败方向恒为官方件：替换件返回 `null`（弃权）、渲染抛错、或围栏正文取不到，都回落内置实现。
- 用端口 Provider 接入任意传输、Store 和权限系统。
- 用 `ChatStreamPacerOptions` 接入浏览器帧、测试时钟或自定义调度器。
- 用 `contracts` 子路径共享纯类型而不加载 React 组件。
- 用 `ConversationTranslatorRuntime` 为不同 root、租户或测试注入独立翻译目录。

纯投影和节奏预算继续使用纯函数；拥有跨事件状态的 Pacer 与 Registry 使用类；React 视图保持函数
组件，避免形式主义的 class 包装。

## 兼容策略

公共根入口和显式子路径遵循语义化版本。旧的进程级翻译配置函数继续保留但已弃用；新代码使用实例
Runtime 与 Provider。宿主专有字段不会加入通用契约；新能力通过可选字段、端口或新子路径演进。
内部 `src` / `dist` 深路径不属于公共 API。
