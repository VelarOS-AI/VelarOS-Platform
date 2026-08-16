# 拦截 seam

**用途判据**：需要**改变运行时行为**的东西走 seam；
需要平台**索引 / 展示 / 惰性加载**的东西走[声明贡献点](./axes/README.md)；
平台**还没想到、无法预先枚举**的东西走开放数据面。

manifest 侧的声明形状见 [axes/hooks.md](./axes/hooks.md)。
本页写机制、闭集与接线现状。

实现：`packages/agent/src/mods/AgentModSeams.ts`；闭集契约：`@velaros-ai/agent/protocol/mods`。

---

## 一、三条不可协商的性质

### ① 两阶段

注册只发生在 registration 阶段：`beginRegistration()` → `register()` → `seal()`。
**`seal()` 之后写入即抛**（注册与摘除都抛），防运行中改注册表。

### ② 权限不可旁路

钩子的结果面**只有「拦下」和「改写入参 / 结果」，没有放行字段**。

- 被策略门拒绝的调用，**任何钩子都无法把它变成允许**；
- `tool-call:before` 的入参改写发生在策略门**之前**，
  改写后的入参照样走完整策略 / 校验 / 审批管线；
- 会话生命周期钩子是**纯通知**，不能否决执行——准入单源仍是 `authGate` 与策略门。

这条是设计出来的，不是碰巧：结果面里没有 `allow` 这种字段，**所以旁路无从写起**。

### ③ 异常隔离

单个钩子抛错只记诊断 `mod.seam-handler-failed` 并跳过该钩子，**绝不冒泡打断主链**。
诊断环形缓冲上限 `MaxSeamDiagnostics = 200`。
同步 seam 的钩子返回 thenable → `mod.seam-sync-contract-violation`，本次结果被忽略。

> **零钩子零开销**：缺省实例零钩子——所有 `dispatch*` 走空数组快路径返回空结果，
> 主链行为逐字节不变。

---

## 二、闭集 15 个 kind

`AgentModSeamKinds`：

```
session:start          session:end            turn:start
turn:end               turn-context:assemble  prompt:compose
tool-call:before       tool-call:after        tool-result:after
model-request:before   model-response:after   sub-agent:dispatch
compaction:before      skill:select           diagnostic:publish
```

**mod 只能挂接，不能发明新钩子。**

### 已真接线的四个派发点（覆盖 5 个 kind）

**这张表在代码里有对应物**：`WiredSeamKindsByDispatcher`（`packages/agent/src/mods/AgentModSeams.ts`）
按派发方法名登记它读取的 kind，对「类上所有 `dispatch*` 方法」保持类型层穷举——新增一个派发方法
却忘了登记就编译红。`WiredSeamKinds` 由它派生，是「今天哪些钩子真会被调用」的唯一事实面。

| seam | 调用点 | 语义 |
| --- | --- | --- |
| `tool-call:before` | `packages/agent/src/tools/Executor.ts` `runOne()`（策略门之前） | 可拦下（结构化失败结果 `tool_blocked`）或改写入参 |
| `tool-result:after` | `packages/agent/src/tools/Executor.ts` `finalizeResult()`（物化之前） | 可改写 result / error；放在物化前保证模型面与 UI 面同源 |
| `turn-context:assemble` | `packages/agent/src/agent/ContextBuilder.ts` `build()`（段排序后、预算裁剪前） | **同步**派发；可追加 dynamic 段，追加段同样计入 prompt 预算 |
| `session:start` / `session:end` | `packages/agent/src/kernel/execution/ExecutionService.ts` `runManagedExecution()` | 纯通知；`end` 在 `finally`，异常路径也发 |

四个调用点全部走 `seams?.has(kind)` 快路径。

### 未接线的十个

`turn:start`、`turn:end`、`prompt:compose`、`tool-call:after`、`model-request:before`、
`model-response:after`、`sub-agent:dispatch`、`compaction:before`、`skill:select`、
`diagnostic:publish`。

**它们只有注册面与类型，`dispatch` 没有调用点。** manifest 里挂这些 kind 注册照常成功
（闭集里都是合法挂点，接线即生效），但 handler 今天收不到事件——所以 `register()` 会**当场**记一条
`mod.seam-not-wired` 诊断，沿 `getReport().diagnostics` 回到宿主的 mod 注册表页。作者不必再靠
「钩子一辈子不响」去发现这件事。接线时的已知落点：
`turn:*` 需要给 `AgentLoopSurface` 加派发器字段并由 Solo / Query 两面装配；
`sub-agent:dispatch` 落 `kernel/dispatch/SubAgentDispatcher.ts`；
`compaction:before` 落上下文治理链。

---

## 三、事件与结果契约（已接线的四缝）

```ts
interface AgentModToolCallBeforeEvent {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
  readonly sessionId: Nullable<string>
}
interface AgentModToolCallBeforeOutcome {
  block?: { reason: string }              // 只能减少可执行面
  args?: Record<string, unknown>          // 改写后仍过完整策略门与参数校验
}

interface AgentModToolResultAfterEvent {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: Readonly<Record<string, unknown>>
  readonly result: unknown
  readonly error: Nullable<string>
  readonly sessionId: Nullable<string>
}
interface AgentModToolResultAfterOutcome { result?: unknown; error?: string }

interface AgentModTurnContextAssembleEvent {
  readonly stableSegments:  readonly AgentModTurnContextSegmentView[]
  readonly dynamicSegments: readonly AgentModTurnContextSegmentView[]
}
interface AgentModTurnContextAppendage { id: string; text: string; label?: string; priority?: number }
interface AgentModTurnContextAssembleOutcome { append?: readonly AgentModTurnContextAppendage[] }

interface AgentModSessionLifecycleEvent {
  readonly phase: 'start' | 'end'
  readonly executionId: Nullable<string>
  readonly sessionId: Nullable<string>
  readonly status: Nullable<string>
}
```

`AgentModTurnContextSegmentView` = `{ id, stability: 'stable' | 'dynamic', source, priority }`
（只读视图，看得见排序结果，改不了别人的段）。

未接线的十个 kind 的事件类型统一是 `AgentModSeamGenericEvent { payload: unknown }`，
结果面 `void`——接线时会各自定型。

---

## 四、折叠语义（多个 mod 挂同一缝时）

| seam | 派发方式 | 折叠规则 |
| --- | --- | --- |
| `tool-call:before` | 异步，按优先级顺序 | **第一个给出 `block` 的钩子即短路**（拦下只减不增）；`args` 沿优先级顺序**逐个折叠**，后一个钩子看到的是前一个改写后的入参 |
| `tool-result:after` | 异步，按优先级顺序 | `result` / `error` 逐个折叠；无人改动则返回空结果（原值原样） |
| `turn-context:assemble` | **同步** | 各钩子追加的段取**并集**；每条追加段的 id 被强制加前缀 `` `${modId}.${item.id}` `` |
| `session:start` / `session:end` | 异步，顺序 await | 纯通知，无结果面 |

`turn-context:assemble` 的 id 前缀不是装饰：没有它，两个 mod 追加同名段就会在下游互相覆盖。

---

## 五、装配纪律：派发点 ≠ 接线

`tool-call:before` / `tool-result:after` 住在 `ToolExecutor` 里，而 **`ToolExecutor` 是每轮新建的**：
派发器不是全局单例，只能沿装配链一路传下去。

透传路径（可选参，缺省 `null` → 全链 no-op）：

| 装配点 | 落点 | 透传形态 |
| --- | --- | --- |
| `SoloStreamLoop`（主面） | `packages/agent/src/agent/SoloLoop.ts` | 构造参 `seams: LooseOptional<AgentModSeamDispatcher> = null`；每轮 `ToolExecutor` 与缺页重放重建的那个都带上 |
| `QueryLoop`（子面） | `packages/agent/src/agent/QueryLoop.ts` | 同形构造参 → 逐轮进 `ExecuteQueryTurnArgs.seams` |
| `QueryTurn` | `packages/agent/src/agent/QueryTurn.ts` | 从 `args.seams` 传入 `ToolExecutor` options |

**子面与主面共用同一派发器**——否则钩子的「拦下 / 改写」会在委派边界上出现盲区。

**判据：新增任何 `new ToolExecutor(...)` 的地方都必须带 `seams`。**
否则该条执行路径就是钩子的盲区——而钩子只能减不能增，
**盲区意味着 mod 的「拦下」在这条路径上静默失效**。

这是真踩过的坑：曾经只接了派发点、没接装配链，会话缝与回合上下文缝正常工作，
工具缝却永远收不到派发，极易被误判成「已接通」。

---

## 六、明确不吸收的东西

从 pi 蒸馏来的贡献机制里，有四样**刻意不抄**：

- giant `ExtensionContext`（一个 context 对象塞进所有能力）；
- 同进程无沙箱的任意代码执行；
- **加载顺序覆盖**（同 id 一律拒载，不做「后者胜」）；
- **全局 registry 即时修改**（写入只在 registration 阶段）。
