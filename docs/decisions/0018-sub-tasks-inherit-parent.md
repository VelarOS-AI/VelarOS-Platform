# 0018: 子任务直接继承父任务的权限，不用声明

- Status: accepted
- Date: 2026-09-25
- Owners: `@velaros-ai/agent`（子任务调度）、`@velaros-ai/velaros`（act/agents、act/runtime、act/system）

## Context

Desktop 接上子任务（`velaros:agents`）后第一次真跑：父任务照着声明写 `start({ task, profile })`，子任务一条 `shell.run`
都跑不了——`shell.run` 算写操作，子任务必须在 `writes` 里「占用」`velaros:shell` 才能调，父任务没写就一律 `PERMISSION`。
子任务只好回头向父任务要能力，最后拿父任务手上的观察结果交差，绕了 77 秒。补上 `writes: ['velaros:shell']` 就 13 秒跑完。

这套写入范围同时是独占锁：占着 `velaros:shell` 的子任务在跑时，别的子任务不能再占它，父任务自己也不能再跑 shell
（`WRITE_DELEGATED`）。shell 是万能工具，按模块独占等于把父子全部串行。共享空间也要逐项声明 `stores`，前缀还要层层核对。

用户看完的裁决：「子任务别设置那么一堆限制，直接继承父的权限」「尽量不设置那么多弯弯绕绕的仪式感」。这与 ADR 0009
（能力不设权限闸）是同一条道理：父任务手里本来就有这些能力，子任务是它派出去干活的，挡住子任务什么也没保护。

## Decision

- 子任务能做的与父任务一样：`start` 只要 `task`。删掉 `writes`（派发、续跑与 job 上都没有了）、写入闸、「后代占用」检查与
  子任务之间的写入冲突检查。写同一处的先后照旧由 Kernel 的效果队列与各领域的版本核对把关。
- 共享空间直接继承：子任务每次运行（派发与续跑）拿到父任务此刻能用的全部空间与同样的读写范围；父任务能建空间，
  子任务也能建（归它自己）。删掉 `start.stores`、`resume.stores`、`AgentStoreGrant`、配置里的 `stores` 开关与
  `StoreSession.delegate`，换成 `StoreSession.inherit`。
- `profile` 可省：不给就用宿主给的第一个配置。配置仍由宿主定，`modules` 不能超过父任务实际有的能力。
- 留下的只有防失控的边界：同时在跑的子任务数、一个任务里派的子任务总数、每个子任务的轮数/墙钟/模型预算，
  以及子任务不能再派孙任务。

## Alternatives

- **缺省把全部模块写进 `writes`**：子任务能写了，但所有子任务互相独占、父任务也被挡住，并行全没了。否决。
- **只给 shell 开例外**：规则更绕，其他写模块照样要声明。否决。
- **保留显式共享空间，只把 `writes` 删掉**：模型仍要先想清楚前缀再派发，和用户要的「直接继承」不符。否决。

## Security and privacy

子任务拿到的正是父任务已有的能力与空间，没有多出任何东西；被提示注入的子任务能做的，父任务本来就能做。
危险命令确认、空间边界与各领域的正确性核对都不变，子任务的调用照样经过它们。

## Compatibility and migration

破坏性改动：`@velaros-ai/agent` 升到 8.0.0（`AgentStart` / `AgentResume` / `AgentJob` 去掉 `writes`、`stores`，
`AgentStoreGrant` 删除，`AgentStart.profile` 变成可选）；`AgentProfile.stores` 删除；`StoreSessionApi.delegate` 换成 `inherit`。
持久化的旧 job 记录里多出的 `writes`、`stores` 字段不再读取。宿主要改的只是不再传这些字段。

## Validation

`agent` INV-30（并发额度在派发前占位；子任务不占写入范围）、`act/system` INV-15、INV-16（子任务继承父空间与读写范围，
每次运行重新继承）按新语义改写；`act-children` 用例钉住「不声明也能写、续跑换配置后照样写父任务的空间」。

## Consequences

模型派子任务只写要它做什么；几个子任务可以同时做同一类事。`docs/engineering/act-store-delta.md` 记下的「子任务由隐式继承父空间改为
`start.stores` 显式共享」，由本决定改回继承。
