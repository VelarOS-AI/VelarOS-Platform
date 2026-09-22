# @velaros-ai/agent

Act 执行核心：持久运行控制、单一模型循环、有界子运行调度。

正式宿主从 `@velaros-ai/velaros.createRuntime` 装配存储、模型、Script runner 与领域模块，再通过 session 的 `submit / steer / answer / inspect / events / cancel / close` 工作。需要自定义宿主时，根入口提供 `createActRunService` 和 `createAgentSupervisor`；纯数据使用 `@velaros-ai/agent/contracts`。

主任务与高级搜索共享同一个循环和 ScriptAct 执行链。上下文使用 task/workspace/observation/recent/runtime 五分区，通过驻留材料和近期窗口策略控制各类任务的可见内容；模型调用由 Model 编译发送；世界操作由 Kernel 校验、派发和记录回执。

`submit({text,task:'continue'})` 沿用逻辑任务与总预算，`task:'new'` 创建新任务。`needs_reconcile` 必须通过宿主核对真实效果后推进。

子运行的请求保存在 `AgentJob.pending`；`wait/waitAny` 可因提问返回，`reply` 绑定原运行回答。`resume` 使用结构化 `AgentResume`，只在收束后更换 profile/writes/stores/materials，保持同一会话与预算。当前接口变更和验收见仓库的 `docs/engineering/act-cooperation-delta.md`。

验证：`bun run build`、`bun test spec/acceptance.test.ts`、`bun run check:browser`。完整链路验收在 Velaros 的 `act/runtime/test/act-run.test.mjs` 与 `act/runtime/test/act-children.test.mjs`。

源码统一使用 `contract/types/impl/utils`：`contract/provides.ts` 登记公开类接口，`contract/requires.ts` 声明注入端口，`types/` 保存数据和内部工作类型，类接口与实现同文件。入口和运行环境边界见 MODULE.md。
