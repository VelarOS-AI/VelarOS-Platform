# 观察脚本与结果租期

模型通过稳定观察脚本维护每轮需要看到的信息，通过一次性执行脚本完成试探与操作。代码和结果都保存到原有会话存储，结果的可见寿命单独计数。

## 一次提交中的两个生命周期

`script` 的 `observe` 字段接受源码、源码引用或当前观察的增量 edits，检查通过后发布观察版本，每个新业务回合重新运行。程序只读取、计算并选择 `output`，代码中应注明持续观察的目的。安装和编辑观察版本本身不运行脚本。

`script` 的 `execute` 字段提交一次性程序，显式执行一次。返回 sourceRef、executionId、resultRef 及实际 ScriptAct 结果。`retainTurns` 默认 2，范围 1–32，表示结果在接下来多少个成功业务回合中自动可见。

两个字段共用增量编辑合同，详见 `script-incremental-edit.md`。

## 租期

- 模型完整成功返回后，消费已发送帧的一次租期。
- 截断响应、传输失败、取消和未发出的超预算请求不消费租期。
- 结果到期退出自动投影，源码、操作回执和原始输出仍可以按引用读取。
- `results.read` 只读取，不重跑、不续租，也不刷新结果对应的时间和世界版本。
- `results.retain` 将剩余可见回合重设为 turns，不累加。
- 若需要持续观察某个历史结果，观察脚本可以显式读取并选出需要的部分。

租期以成功业务回合计数，不是墙钟 TTL。

## 每轮上下文

Runtime 输出当前观察代码、实际观察结果、可见租约、用户目标和必要的未知效果信息。每个结果保留生产它的 sourceRef。源码 diff 与观察正文 diff 分别计算，仅作为变化说明；当前正文和截断标记独立提供。

`programs.read` 可分页召回完整程序包，`results.read` 可分页召回执行结果。材料大于当前预算时保留原始引用和 truncated 标记。图像使用独立附件通道，并随结果租期展示。

## 观察约束

Kernel 在准备与派发前检查观察模式，阻止已知写操作、结果续租、材料写入。外层 script 控制口由宿主直接接收，脚本导入目录只包含内部能力。脚本捕获了这些错误也不能抹除 Runtime 的观察安全反馈。

命令能力可以提供宿主受限观察实现，允许用任意命令收集信息。宿主必须如实报告实际 protection/confinement；partial 表示覆盖有限，不能承诺绝对无副作用。受限实现不可用时返回明确失败。

一次性执行仍遵守领域权限、审批、版本前提和调用回执。未知世界效果不会随着普通结果正文过期而消失，恢复依赖真实核对证据。

## 负责实现的文件

- `RuntimeSession.ts`：观察准备、一次性执行、控制调用和结果保存。
- `ProgramContext.ts`：版本发布、结果租期、帧确认和投影。
- `FoundationAgent.ts`：完整响应校验、有序调用和实际发送。
- `ProviderRequestCompiler.ts`：同一份最终请求与 schema 的编码和预算。
- `OperationRuntime.ts`：权限、观察模式限制和操作回执。
- `script/bin/script-child.mjs`：隔离执行与标准模块桥接。

主链回归覆盖 `script-submission.test.mjs`、`program-context.test.mjs`、`incremental-edit.test.mjs`、`runtime.test.mjs`、`platform.test.mjs` 和 `provider.test.ts`。
