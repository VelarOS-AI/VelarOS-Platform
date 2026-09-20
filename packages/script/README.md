# @velaros-ai/script

JavaScript 脚本的检查、精确编辑与隔离执行引擎。正式装配通过 `createKernelScriptSession` 接入同一 Kernel：生成声明用于类型检查，能力调用经过 Kernel 权限、效果分类与持久回执。

- `edit(program, edits)` 在同一底稿上原子替换主源码或附属模块，返回完整候选，保留 `input` 与 `blobs`。
- `check(program)` 校验源码、附属模块与当前能力声明，诊断包含行列和有界代码帧。
- `run(program, signal)` 按该次执行身份运行一次；调用期间暂停计算时钟，停止时报告已完成及未落定调用。

模型通过 Velaros 的统一 `script({observe?, execute?})` 入口 使用引擎。不可变源码版本、结果租约与下一轮投影由 Velaros 在 ContextStorage 中维护；模型请求由 Agent 的 ProviderRequestCompiler 编译。

脚本使用标准 ES 模块语法：`import` 获取能力，顶层 `await` 执行，`export` 或 `output` 交出结果。参数走 `input`，大字符串走 `blobs`，附属模块以 `modules` 随程序提交。模板按需读取，能力声明由宿主当前注册表提供。

`nodeSubprocessCodeRunner` 在子进程内使用 QuickJS WASM，guest 只通过显式能力桥访问外部。`NodeSubprocessRunnerIsReleaseReady` 仍为 `false`；宿主须完成部署隔离认证。执行前检查、取消、超时、结果预算和权限拒绝均有自动化验收。

详细责任、公开面与测试见 [模块卡片](MODULE.md) 和 [不变量](spec/invariants.md)。
