# Platform 运行主链

宿主从 `@velaros-ai/velaros` 导入 `createRuntime`，打开会话后用 `session.submit` 提交当前用户输入，消费运行事件。可直接使用的装配示例和完整注入面见 [Runtime README](../../packages/velaros/act/runtime/README.md)。

## 执行与协议

标准 Node 环境由 `createNodeExecutionEnvironment` 装配，宿主提供工作目录、进程资源和授权策略。普通代码使用 Node.js ESM、标准库、工作区依赖和环境中安装的 npm 包；应用能力从 `$VELAROS_HOST_DIR/index.json` 发现，通过包名与按操作生成的声明使用。

`protocol.transport` 支持 `tools` 与 `text`，默认值为公开常量 `DefaultScriptProtocolTransport`，当前为 `tools`。默认选择遇到不支持工具的驱动时使用文本；显式要求工具而驱动不支持时返回错误。两种传输共用程序检查、参数绑定、观察、结果租约、异步调度和完成判定。

| 控制动作 | 原生 JSON 工具                    | 文本协议                                   |
| -------- | --------------------------------- | ------------------------------------------ |
| 执行程序 | `exec({ code, options? })`        | 本帧标记与 `execute(options?)`，段内为源码 |
| 维护观察 | `observe({ code, options? })`     | 本帧标记与 `observe(options?)`             |
| 绑定原文 | `blobs({ name, text })`           | `blobs("名称")` 原文段                     |
| 申请完成 | `done({ message?, completion? })` | `done("完成依据")`                         |

宿主可用 `allowed` 裁剪控制面，用 `names` 配置名称。系统说明、工具 Schema 和当前帧示例都随所选传输生成。文本控制段的边界规则见 [文本协议](scriptact-text-protocol.md)。

## 一次运行

1. Agent 的 `ActRunService` 与 `ActLoop` 接纳并保存输入，维护运行身份、预算、取消和事件序号。
2. Runtime 采集当前观察，按当前授权组装任务、工作区、观察、近期历史与运行状态；原始输入、派生说明和程序结果分别保留来源。
3. Model 编译真实请求，保留模型、图片、缓存设置和请求身份；所选解码器接收文本或原生工具调用。
4. 完整响应校验通过后才接纳正文并派发程序。流预览和代码预览只表示正在生成；取消、截断和不完整响应不能授权执行。
5. 一批独立程序默认顺序执行，`async:true` 进入有界后台队列。已经完整收束的非零进程退出保存为失败回执；取消、超时、宿主故障及未知效果停止后续派发。依赖步骤在同一程序中顺序 `await`。
6. Node 执行使用宿主进程授权；应用能力调用继续经过 Kernel 的固定绑定、操作模式、参数与授权检查。真实执行回执保存源码、输出、退出状态和效果事实。
7. 下一帧读取新结果、后台任务、子任务和待处理交互。结果的展示寿命见 [结果租约](script-context-leases.md)，历史容量与整理见 [长程上下文](long-running-context.md)。
8. 完成申请等待必要工作收束，再执行配置的领域验收或独立模型复核。运行终态、模型复核、测试通过和发布完成各有自己的证据。

## 完成与计量

宿主通过 `context.completion` 注入确定性领域验收，或使用 `{ kind: 'model-review', artifacts }`。独立模型复核读取当前完整用户要求、真实最终回复及宿主授权的产物快照；缺失、截断和版本未知保持为缺口。复核只读，不执行程序。

每次真实模型请求都有独立身份和用量记录，包括业务调用、整理、核查、纠正与失败响应。未报告的用量保持未知。复核走共同任务预算，取消后先收束请求和计量，再关闭存储；具体限额由 [Runtime 合同](../../packages/velaros/act/runtime/README.md) 与常量定义。

## 状态、交互与恢复

`session.answer` 回答当前运行的交互身份；取消和关闭传播到在途模型、进程、后台任务与子任务。宿主用 `createActEventProjector` 将有序事件投影成界面状态，持久 trace 保存真实执行及模型请求。

存储通过 `ContextStorage` 和 `StoreStorage` 注入，默认 SQLite 在创建适配器时加载，见 [存储适配规范](storage.md)。恢复依据持久记录和回执重建事实；未知外部效果继续明确呈现，不能据此自动重放执行。

同一 Runtime 实例的写操作按效果资源协调；跨进程并发仍依赖领域锁、资源版本与宿主约束。搜索和业务子任务使用同一运行链，实际模型调用计入共同预算，见 [高级搜索](advanced-search.md) 与 [子任务合同](../../packages/velaros/act/agents/README.md)。

## 验证入口

`bun run eval:act --model-config /absolute/model.json --output /absolute/results` 通过 Agent Lab 驱动正式 Runtime，保存原始回合并独立核验文件和操作回执。模型配置使用环境变量引用凭据。方法与运行入口见 [评测规范](../engineering/scriptact-acceptance-criteria.md)。
