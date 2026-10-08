# 同宿主机制对照

在冻结的正式 Runtime 上比较脚本动作、逐工具动作、模型辅助上下文维护和完成复核。所有尝试保留原始请求、功能判分、生成产物及上游账本，完整交付另作人工核对。

## 使用

先构建并复制 Runtime 及其依赖到独占目录，生成 `manifest.json` 的相对文件路径到 SHA-256 映射；Desktop `WorkspaceCompletionArtifacts` 单独编译为可导入的 ESM 文件。执行器、判分器和源清单必须在正式实验前冻结。凭据文件结构为 `{ "chat": { "apiKey": "…", "baseURL": "…" } }`，保留在公开证据目录之外。

```sh
node --test scripts/agent/mechanism-ab/preflight.test.mjs
node scripts/agent/mechanism-ab/run.mjs /absolute/frozen-runtime /absolute/artifacts.mjs /absolute/new-output /absolute/private-credentials.json development
node scripts/agent/mechanism-ab/run.mjs /absolute/frozen-runtime /absolute/artifacts.mjs /absolute/new-output /absolute/private-credentials.json validation
```

`development` 使用可重复调试的夹具。`validation` 使用两项预先冻结的任务、两次重复和交错顺序。任务一旦曝光，重跑按诊断记录，不能再当作独立未见样本。

## 判读

- 模型、窗口、输出、请求、时间和参考费用预算由 `run.mjs` 的配置冻结。费用是比较参考值，不代表供应方账单；没有 usage 的请求保持未知。
- 逐工具接口仍允许 `runCommand` 执行脚本和批处理。关闭模型辅助维护仍保留确定性引用回退。接口说明和审计历史包装差异必须与结果同时披露。
- 每阶段在任务副本上独立运行功能判分。正常完成且所有阶段通过只是自动条件；原始需求中的文档、示例和行为边界仍须人工检查。
- 客户端取消后先关闭宿主、归档校验并回收执行根，再等待该尝试的上游请求结算。等待失败时停止下一组派发；未知用量不变成零。执行耗时与等待结算时间分别记录。
- 模型辅助维护没有实际触发时，该消融没有机制效果证据。请求未派发、预算拒绝和未知费用都保留，不能删除失败组或只选最好结果。

2026-10-08 首批真实模型数据受到迟到结算和保守预留影响，16 个计划配置只有 10 个实际派发。唯一自动通过结果的 README 含 NUL；没有确认完整交付的结果。该批次对应补充结算等待之前的冻结执行器，详见 `docs/engineering/scriptact-completion-review-20261008.md` 和官网公开证据。
