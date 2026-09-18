# 工具契约公共件不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；新增一条同样要点名。
检验方式与 `packages/agent/spec/invariants.md` 相同：测试 / 类型 / 门禁 / 运行时 / 文字，`check:module-ownership` 核对每一行的检验器是否存在。

编号只增不重排。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 工具名必须是 canonical 工具 id（`namespace:tool`，两段都以小写字母开头）；不合法的名字在定义期就抛，进不了注册表 | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 契约里写的每条示例都按「模型实际会发的那份 JSON」序列化再解析，然后过工具自己的 schema；有一条不过就在定义期抛 `VALIDATION`，message 点名工具、原示例与逐条路径 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 模型面说明只在定义期被写下来，硬上限与软预算两道闸也只在那时拦：超硬上限一律抛且不可豁免；超软预算抛，除非带上理由为 `safety-protocol` / `meta-tool` 且 `note` 非空白的豁免 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 说明的分节语法固定：`描述` 开头且正文非空，其余分节按 `适合`→`禁止`→`强制流程`→`用法`→`示例`→`注意` 的顺序出现、不重复、每行都是 `- ` 条目，`适合` 必填；渲染与判定同一部语法，渲染出来的说明一定判为结构化 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | `readOnly` 的判据顺序是 `capabilities.effectKind === 'read'` → 显式 `readOnly` → `role === 'inspect'`，前一档有值就不看后一档 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | 内核可调用操作每次调用固定四步：按工具 schema 严格解析入参（对象 schema 拒收未知字段）→ 解析上下文并换上内核给的 abortSignal → 不可用报 `UNAVAILABLE` → 执行；宿主没给上下文解析器时一个操作都不登记 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 失败回执的结论只有三种，写在 `context.executionOutcome`：给了 `notApplied` 是 `not-applied`，给了 `applied` 是 `failed`（清单截到 `ToolFailureLimits.listItems`），都没给是 `skipped` | 测试 | `spec/acceptance.test.ts` |
| INV-8 | `./contracts` 的整条引用链不碰 Node 内置模块，渲染进程可以直接加载 | 门禁 | `check:module-ownership` |
