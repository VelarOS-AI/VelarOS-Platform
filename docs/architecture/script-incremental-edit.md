# 脚本增量编辑与版本发布

`script` 的 observe 和 execute 共用同一份程序编辑与检查路径。增量编辑的目的，是让模型持续维护程序而只提交变化。

## 输入

```json
{
  "observe": {
    "edits": [
      { "oldText": "const limit = 10;", "newText": "const limit = 30;" },
      { "module": "helper.js", "oldText": "export const n = 1;", "newText": "export const n = 2;" }
    ]
  }
}
```

observe 省略 sourceRef 时绑定本轮展示的观察版本；没有当前版本时需要先提供 source。历史、草稿和 execute 的增量编辑显式提供 sourceRef。

`edits` 为 1–32 项。每项的 `oldText` 必须在原始目标中精确匹配一次，各项不能重叠或依赖其他项刚产生的文本。所有目标都定位成功后再一次性形成完整候选。空 `newText` 表示删除；插入通过保留原锚点并追加文字表达。匹配严格保留换行、Unicode、缩进及注释。

`module` 是保存程序的 `modules` 精确键。新增或删除模块使用全文程序。增量提交保留未修改的模块、input 与 blobs，显式提供 input/blobs 时整体覆盖对应值。`source` 与 `edits` 互斥。

需要完整底稿时，在脚本中调用 `programs.read({ref,offset,limit})`。返回的 JSON 包含 source、modules、input 和 blobs，分页读取不执行代码。

## 版本与原子发布

ProgramContext 先通过 ContextStorage.put 保存不可变对象，再通过 ContextStorage.compareAndSwap 原子追加本次全部源码记录、版本谱系、控制回执、执行占位及观察指针。存储版本因无关事件增长时重新加载并合并；观察前提已经变化时返回 `SCRIPT_CONFLICT` 和 currentRef。

主模型请求中的观察版本是隐含提交前提。同一已接受响应内，每次成功观察更新推进后续调用的前提。陈旧模型帧、陈旧编辑底稿和陈旧草稿不能覆盖当前观察版本。

内容无变化的编辑返回 `unchanged` 并保留引用。历史版本切换创建新的提交身份。观察重跑只增加运行回执，不创建编辑版本。一次性执行可以从任意当前会话程序派生，其发布不改变观察版本。

## 检查与修复

定位失败返回 `SCRIPT_EDIT`、零起始 editIndex 和可用版本引用，整组不发布。候选检查失败返回 `OBSERVATION_CHECK` 或 `SCRIPT_CHECK`，保存完整草稿并提供 draftRef、有界 diagnostics。下一次将 draftRef 作为 sourceRef 继续修复。草稿保留观察基线，继续发布时重新核对。

script 返回 status、executed，以及本次涉及的 observe / execute 回执。任一候选检查失败，整次提交返回 rejected，保持当前观察版本且不执行本轮代码；检查失败的候选仍保存为草稿。模型循环停止派发后续调用。宿主 observe/execute 便捷方法调用同一个 script 提交口，并把 rejected 转成带相同诊断的错误。

成功观察回执包含 status、sourceRef、parentRef、changes、effective: next-model-turn 和 executed: false。一次性执行沿用 CodeSurfaceOutcome，并增加 sourceRef、parentRef、executionId、resultRef。

## 幂等与故障恢复

模型调用使用已持久化请求和响应的复合身份。宿主重试使用 `script(input, signal, {callId})`；新执行必须提供新 callId。相同身份不同输入返回 `SCRIPT_CALL_CONFLICT`。

观察发布回执和源码使用同次 CAS 保存，重试直接读取原回执。带 execute 的提交先原子记录 prepared 占位，执行完成后保存 completed 回执；prepared 但缺少 completed 时返回 SCRIPT_UNRESOLVED。业务操作的真实效果由 Kernel journal 和领域核对器确认。相同提交身份在进程重启、响应丢失或多个实例争抢时都不授权重新运行脚本。

两段源码的发布是原子的，外界操作按各自实际回执记录。执行阶段失败时已发布的观察脚本继续用于下一轮诊断。

源码提交成功只证明候选已保存。世界操作是否成功由真实回执记录，二者分别追踪。

## 验证入口

- `packages/velaros/test/script-submission.test.mjs`：合并提交、隐含版本、全量预检、持久占位、并发重试和真实下一轮上下文。
- `packages/velaros/test/incremental-edit.test.mjs`：版本、草稿、编辑、CAS 并发、身份重试和故障注入。
- `packages/velaros/test/program-context.test.mjs`：观察、结果租约、未知效果、命令约束和投影预算。
- `packages/velaros/test/provider.test.ts`：实际 Provider 编译和发送的唯一 script schema。
- `packages/velaros/test/dual-core.test.mjs`：真实项目操作、重启、进程中断和保留的上下文助手。
