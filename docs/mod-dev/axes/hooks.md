# 轴：`hooks`

Hook 是 Mod 订阅 Agent 生命周期事件、并在少数明确节点拦截或改写数据的标准轴。
**主键 = `id`；运行态 binding 必需。**

> 本页的 Mod Hook 与 `velar-hooks` 宿主自动化 API 无关。前者是 Loader 管理的 Agent 运行时贡献；
> 后者是外部进程驱动整个应用的控制面。

## 统一声明

```json
{
  "id": "acme.guard.shell",
  "event": "tool-call:before",
  "priority": 50,
  "matcher": { "toolNames": ["system:run_command"] },
  "mode": "blocking",
  "timeoutMs": 3000,
  "reason": "拦截不符合项目规则的命令"
}
```

| 字段 | 语义 |
| --- | --- |
| `id` | Mod 内唯一 Hook id；与 binding 键一致 |
| `event` | 15 个 `AgentModHookEvents` 之一；Mod 不能发明新事件 |
| `priority` | 缺省 100；升序执行 |
| `matcher` | 可选精确匹配；字段间 AND，列表内 OR |
| `mode` | `blocking` 或 `background`；缺省 `blocking` |
| `timeoutMs` | 100–30000ms；缺省 5000ms |
| `reason` | 审计和权限展示用的自然语言理由 |
| `handler` | 外部载体描述；编译期 binding 不写 |

`event` 是标准字段。旧 manifest 的 `seam` 仅作过渡输入别名；解析结果只保留
`event`。同时写两者时必须值相同，否则拒载。

### Matcher

v1 公开三个匹配维度：

- `toolNames`: canonical tool id，如 `system:run_command`；
- `phases`: 事件的 `phase`；
- `statuses`: 事件的 `status`。

事件没有 matcher 所需的字段时匹配失败（fail-closed）。空列表非法，未知 matcher 字段由
`strictObject` 拒绝。匹配只在 dispatcher 实现一次，不由每种载体自行解释。

### Blocking 与 Background

- `blocking`: 按 `priority → modId → hookId` 确定性顺序执行，结果按事件契约折叠。
- `background`: 只观察，不阻塞主链，返回的 block/改写一律忽略。

多个纯通知 blocking Hook 可以并发等待；会改写状态的 Hook 必须顺序折叠，避免多个 writer 产生
不确定结果。

## 载体一：编译期 binding

随包官方 Mod 用同 id 的强类型函数作 binding：

```ts
const bindings: AgentModBindings = {
  hooks: {
    'acme.guard.shell': (event, context) => {
      if (context.signal.aborted) return
      return { block: { reason: '本 Mod 不允许该命令' } }
    },
  },
}
```

```ts
type AgentModHookHandler<TEvent extends AgentModHookEvent = AgentModHookEvent> = (
  event: AgentModHookEventMap[TEvent],
  context: AgentModHookContext
) => AgentModHookOutcomeMap[TEvent] | void |
     Promise<AgentModHookOutcomeMap[TEvent] | void>
```

`context` 包含 `modId` / `hookId` / `event` / `signal`。超时时 `signal` abort；现有单参函数 binding
仍然兼容。

## 载体二：外部 command

Platform 定义同一声明形状；是否实现 command 载体由产品宿主明示。实现该载体的宿主接受：

```json
{
  "id": "acme.guard.shell",
  "event": "tool-call:before",
  "matcher": { "toolNames": ["system:run_command"] },
  "timeoutMs": 3000,
  "handler": {
    "type": "command",
    "entry": "hooks/guard.mjs",
    "permissions": ["network"]
  }
}
```

通用要求：

1. `entry` 必须是包内相对路径，不得通过符号链接越界。
2. `handler.type = "command"` 自己表达受控载体；`module.isolation` 是 Kernel module 装载元数据，
   本 handler 不消费它。外部代码不得 import 进宿主进程。
3. `module.permissions` 是权限上界；handler 的 `permissions` 是本 Hook 实际使用子集。
4. stdin/stdout 使用宿主公布的版本化 JSON 协议；stdout 只写 outcome，日志写 stderr。
5. 宿主必须实施超时、输入/输出上限、权限 broker 与进程约束；任一不可用时 fail-closed。

编译期和外部载体的能力对齐点是：**同一 event / matcher / mode / timeout / context 语义 /
outcome / 排序 / 诊断协议**。外部协议把 `AgentModHookContext` 投影为 JSON `context`；
`AbortSignal` 不跨进程伪造，宿主用超时后终止进程兑现同样的取消语义。不对齐、也不应对齐的
只是信任载体：官方代码可在进程内，外部代码必须经宿主隔离。

## 权限不可旁路

Hook outcome 只能拦下或改写，没有 `allow`。`tool-call:before` 改写后仍走完整策略、
校验和用户审批。Hook 自己的授权也不能被 Hook outcome 改写或绕过。

## 异常与超时隔离

- 单 Hook 抛错：`mod.seam-handler-failed`，主链继续；
- 超时：`mod.hook-timeout`，abort signal，主链继续；
- 同步事件返回 Promise：`mod.seam-sync-contract-violation`，本次结果忽略；
- 未接线事件：`mod.seam-not-wired`，注册态可见。

已接线事件、事件/结果形状和折叠语义见 [seams.md](../seams.md)。
