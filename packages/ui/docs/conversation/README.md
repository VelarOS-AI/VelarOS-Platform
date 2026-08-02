# @velaros-ai/ui/conversation

> `@velaros-ai/ui` 的一个导入切片(`packages/ui/src/conversation`)。包总览见
> [包 README](../../README.md)。

## 这个切片是什么

**host 无关的会话渲染件**——一整个聊天页所需要的 React 零件:消息气泡与消息块管线、
工具卡族、流式屏显起搏、输入框、HTML 制品预览、会话壳组合层(`ChatConversationPane`)。

底座(`CardKit` / `ActionCard` / 全部原语)留在 `@velaros-ai/ui`,本切片**消费**它们。

**它是聊天渲染件的唯一长期归属**:宿主(Desktop)只保留会话层权威(store / IPC / 发送)
与「store → props 投影 + 端口 / 插槽实现」的胶水。同一套件也能被任意第三方应用直接用——
第三方只需要实现自己的会话存储、模型流与端口,**不需要引入 Kernel,也不需要实现任何 VelarOS 接口**。

## 三条不可动摇的设计判决

### 1. 屏显节奏的唯一权威是 `ChatStreamPacer`

流式文字的显示节奏**只有一处实现**。`ChatStreamPacer` 是 React-free 的类,
按 `sessionId` 持有 FIFO、帧租约、推理增量去重与终止排空状态;
`streamPaceBudget` 是它的纯预算函数。

**禁止再加任何"揭示层"**:组件直接渲染状态文本,不许自己搞影子打字机。
历史上组件级影子打字机造成过与 pacer 打架的抖动,已整体删除——
连替换槽里的第三方 markdown 渲染器也**不得自带揭示动画**(见下)。

### 2. Render Slot 分两类,语义**相反**

| | 增强槽 | 替换槽 |
| --- | --- | --- |
| 是否必填 | **必填** | **可选** |
| 缺注入时 | 那张卡**不显示**(正文不受影响) | 回落**官方内置件的原行为** |
| 举例 | 能力批准卡 / 定时任务提案 / 旗标任务 / 浏览器截图组 / worker 线程面板 / `systemToolInstall` / `askUser` / `userActionCard` / `messageFileChangeSummary` | `messageMarkdown` / `messageCodeBlock` |

替换槽的 props 由官方件的**真实入参收窄**(`ConversationMarkdownSlotProps` = `{ text, isStreaming }`;
`ConversationCodeBlockSlotProps` = `{ language, code, isStreaming }`),
**不透传 `TextBlock`、运行标记等内部形状**。

- `text` 就是官方渲染器逐字消费的那份正文;`isStreaming` **只用于静态呈现**。
- **失败方向恒为官方件**:替换件返回 `null`(弃权)、渲染抛错、或围栏正文取不到,一律回落内置实现。
- 替换件生效时,官方 markdown 分包**不会被拉起**(改道点开在硬 lazy-import 处)。
- 该错误边界**刻意不带 `resetKeys`**——否则流式期一次崩溃会被放大成每帧重试风暴。

Slot 面是 §12.9 意义上的**封闭有限具名集合**,不是任意扩展点。

### 3. 可变注册表按实例走,不做进程单例

- `ToolRendererRegistry` —— 每个应用 / 租户 / 嵌入面建自己的实例,
  避免测试与多宿主之间共享可变注册。共享默认实例 `ToolRenderRegistry` 只为旧接入与内置卡保留。
- `ConversationTranslatorRuntime` —— 每个窗口 / React root / 测试各自拥有翻译端口。
  `ConversationLocalizationProvider` 默认为当前 root 创建并安装隔离实例;
  需要跨 React 与非 React 模型共享时才显式传入。
  `configureConversationTranslator()` / `conversationTranslate()` /
  `conversationLookupMessage()` 的全局单例**仅为旧应用兼容**,新代码别用
  ——「最后一次全局配置覆盖掉其他界面」是它们的固有故障模式。

## 公共入口

| 入口 | 装什么 |
| --- | --- |
| `.` | 会话壳(`ChatConversationPane` / `ChatTranscript` / `ChatScrollNavigator`)、气泡族、消息块分发器、消息动作行、渲染模型与纯 util、`ConversationBlockHooks` |
| `./contracts` | 框架无关的纯展示 DTO 与结构化 `Result<T>` 契约 |
| `./composer` | 输入框(`ChatComposer` / `ChatInput`)+ 全部零件 + `ConversationComposerPort` |
| `./stream` | `ChatStreamPacer` + `streamPaceBudget` |
| `./tool-render` | `ToolRendererRegistry` / `ToolCallBlock` / 工具能力注入契约 / 工具展示名与摘要纯 util |
| `./render-slots` | `ConversationRenderSlots` + Provider / hook |
| `./i18n` | `ConversationTranslatorRuntime` / Provider / `useConversationI18n` |
| `./status` | 会话运行状态渲染纯 util(`getChatStatusMeta` / `getChatNoticeMeta` / …) |
| `./markdown` | streamdown 渲染配置、链接与围栏处理、流式冲刷纯 util |
| `./artifacts`、`./html-preview` | HTML 制品渲染与沙箱 iframe 预览簇 |

**重件走独立子路径是有意的**:`./artifacts` 与 `./html-preview` 按需 lazy 加载,
这样任意 root import 都不会预载沙箱。

## 宿主端口

应用能力**只能**经 props、Provider、Render Slot 或 Port 进入——包本体**零 IPC**。

- `ConversationActionPort` —— 目标生命周期读写、执行指导。
  goal 读写是 `{ ok, goal }` 软失败语义(`ok:false` 保持当前不清空)。
- `ConversationComposerPort` —— 语音、云能力开关、提示反馈
  (`emptyConversationComposerPort` 供预览占位)。
- `ConversationBlockHooks` —— 反转宿主的 message-action viewmodel 与思考自动翻译开关。
- `ChatToolRenderCapabilities` —— 工具渲染能力,具体 IPC 绑定由宿主注入。
- Render Slots —— 把带宿主业务语义的卡片、边界与 Dock 内容注入会话壳。

推荐在应用装配根一次适配完:

```tsx
<ConversationActionPortProvider value={actions}>
  <ConversationComposerPortProvider value={composer}>
    <ConversationLocalizationProvider value={localization} translatorRuntime={translatorRuntime}>
      <ChatConversationPane {...viewProjection} />
    </ConversationLocalizationProvider>
  </ConversationComposerPortProvider>
</ConversationActionPortProvider>
```

包内契约是宿主模型的**窄结构投影**;结构可赋值就直接传,**不要求 DTO 来回转换**。

最小第三方接入:

```tsx
import type { ToolCallBlock as ToolCall } from '@velaros-ai/ui/conversation/contracts'
import { ToolCallBlock, ToolRendererRegistry } from '@velaros-ai/ui/conversation/tool-render'

const renderers = new ToolRendererRegistry()
  .register('weather', WeatherToolCard)
  .setFallback(GenericToolCard)

export function ToolMessage({ block }: { block: ToolCall }) {
  return <ToolCallBlock block={block} registry={renderers} />
}
```

## 能力位下沉,不散写枚举

会话壳**不接收**原始的 `WorkspaceSpaceKind` 枚举。宿主在边界处从 space 描述符投影出
**能力位**(如 `supportsProjectFiles` —— 决定文件变更汇总与回退选文件是否可用),
包内按能力位分派。这样加一个新空间不需要改包里的任何 `switch`(no-enum-dispatch 门执法)。

## 生命周期与并发

`ChatStreamPacer` 为每个 `sessionId` 维持一条动画帧链:
`clearSession()` 取消帧并删状态;`flushImmediate()` 先按序提交积压再结束该会话。
**终止事件在正文平滑排空后才应用**,错误与交互事件立即按序处理。

React Provider 的生命周期归宿主装配根。卸载会话面之前:取消外部流 → 清理对应 pacer 会话 →
销毁宿主持有的 `ConversationTranslatorRuntime`。Provider 自动创建的实例随 React root 回收,
不存在跨 root 的可变翻译状态。

## 边界

- **不得**依赖 Desktop 的 renderer 源码、store、IPC 实例或 `react-router`。
- **不得**依赖任何 VelarOS 运行时包(Kernel / Core / Agent / Workspace / Browser / Memory / Model);
  只允许消费 `@velaros-ai/ui` 与 `@velaros-ai/html-artifacts`。
- **不得**依赖 Desktop 的 i18n;宿主在装配点注入自己的实现。
- 跨复用的无状态原语(`CardKit` / `ActionCard`)属于 `@velaros-ai/ui`,**不放进本切片**。
- **不拥有**会话持久化、模型调用、工具执行、权限决策与导航。宿主保留权威状态,
  只把渲染所需的窄投影与操作端口传进来。
- 门面收口:外部只准依赖 `package.json#exports` 显式列出的入口;未导出的 `src` / `dist` 原子
  都是实现细节。

## 错误模型

端口按各自契约返回结构化软失败或抛异常。**会话壳不会把所有错误改包成统一状态**;
宿主应在能力边界记录错误,并经 Render Slot 或现有错误视图展示。
流式 pacer 只保证顺序,**不负责重试模型请求**。

## 欠账

- **两套平行的折叠卡机制**:`ToolDisclosureCard`(`@velaros-ai/ui`)
  vs `RichToolOutputCard`(本切片 tool-render 的富卡壳)。**尚未合并**,登记在此避免行为漂移。

## 兼容策略

根入口与显式子路径遵循语义化版本;`@velaros-ai/ui` 与本切片**一起升级**。
宿主专有字段不会进通用契约;新能力经可选字段、端口或新子路径演进。
新的深路径导入必须先成为一个有意为之的公共导出。
