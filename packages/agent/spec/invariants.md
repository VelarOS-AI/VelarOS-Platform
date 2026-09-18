# Agent 运行时不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；
新增一条同样要点名。

检验方式分五档，`check:module-ownership` 门会核对每一行的检验器是否真的存在：

| 检验方式 | 含义 | 检验器写法 |
| --- | --- | --- |
| 测试 | `spec/acceptance.test.ts` 里有以该编号开头的用例 | `spec/acceptance.test.ts` |
| 类型 | 由类型定义钉死，改不了 | `src/<文件路径>.ts::<类型名>` |
| 门禁 | 由仓库门禁脚本机械核对 | `check:<门名>` |
| 运行时 | 实现里有断言，违反即抛 | `src/impl/<文件>.ts` |
| 文字 | 目前只有文字描述，没有机器检验 | 留空 |

编号只增不重排。本表随 1.0.0 的入口收口落成。

INV-23 起是工具契约并回本包（ADR 0014）时从 `@velaros-ai/tool-contract` 搬来的承诺，原编号对照：
tool-contract INV-1 → INV-23，INV-2 → INV-24，INV-3 → INV-25，INV-4 → INV-26，INV-5 → INV-27，INV-6 → INV-28。
另外两条不再单列：原 INV-7（失败回执的三种结论写在 `context.executionOutcome`）随 `toolFailures` 一起作废——
仓里没有任何一处调它，结论这一格由各能力自己写、执行门照 `executionOutcome === 'not-applied'` 读，本包不再代造信封；
原 INV-8（`./contracts` 的引用链不碰 Node 内置模块）并进 INV-16：工具契约现在住在 `./tool-contract`，同一道 `check:agent-browser` 管着。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-1 | 没注入审批端口时，任何要审批的工具一律拒绝（默认端口抛，不放行） | 测试 | `spec/acceptance.test.ts` |
| INV-2 | 无人值守宿主的审批端口只能按显式升级钩子放行，钩子缺席就拒 | 测试 | `spec/acceptance.test.ts` |
| INV-3 | 没注入交互端口时，要用户参与的动作一律失败关闭，不静默跳过 | 测试 | `spec/acceptance.test.ts` |
| INV-4 | 内置工具名是闭集：每个工具都在 `AgentToolNames` 里，且都有唯一类别 | 测试 | `spec/acceptance.test.ts` |
| INV-5 | 内置 mod 的工具清单由 `agentTools` 派生，不另立一份名单 | 测试 | `spec/acceptance.test.ts` |
| INV-6 | mod 贡献轴是闭集：清单里出现集合外的轴一律拒载并留诊断 | 测试 | `spec/acceptance.test.ts` |
| INV-7 | 工具名冲突一律拒载并留诊断，不存在后者覆盖前者的加载顺序语义 | 测试 | `spec/acceptance.test.ts` |
| INV-8 | 执行事件总线：空总线不往外发；旁路监听不吞事件 | 测试 | `spec/acceptance.test.ts` |
| INV-9 | 入参复用只在同一上下文的上一次尝试之间成立，跨上下文不复用 | 测试 | `spec/acceptance.test.ts` |
| INV-10 | 投给模型的工具结果有硬上限，超限截断但原文仍可召回 | 测试 | `spec/acceptance.test.ts` |
| INV-11 | 界面提醒线只提示、不压缩；治理只在超过可用输入容量后才动手 | 测试 | `spec/acceptance.test.ts` |
| INV-12 | 回合上下文账本换代后，消费方整段替换 cursor，旧 delta 不被静默吞掉 | 测试 | `spec/acceptance.test.ts` |
| INV-13 | 工具传输名双向可还原，同一批工具的传输名互不相撞 | 测试 | `spec/acceptance.test.ts` |
| INV-14 | 会话租约：持有者进程还活着时不许抢占；进程已死才允许恢复 | 测试 | `spec/acceptance.test.ts` |
| INV-15 | 归档信封的格式与 schema 版本不符时拒绝解析，不做宽容降级 | 测试 | `spec/acceptance.test.ts` |
| INV-16 | `./contracts`、`./chat`、`./tool-contract` 的引用链不碰 Node 内置模块 | 门禁 | `check:agent-browser` |
| INV-17 | 工具定义一个不漏在 `impl/AgentTools.ts`，`defineVelaTool` 只在那里被调用 | 门禁 | `check:module-ownership` |
| INV-18 | 对外的值只有 impl 里按公开接口标注的实例与工厂，以及合同里的常量表 | 门禁 | `check:module-ownership` |
| INV-19 | 公开 API 的破坏性变更必须提主版本，并过基线复核 | 门禁 | `check:agent-public-api` |
| INV-20 | 模型面工具的 schema 与已审基线逐字节一致 | 门禁 | `check:agent-schemas` |
| INV-21 | Agent 运行时不认识任何具体空间与能力：代码、文案、注释里不出现域词 | 门禁 | `check:agent-arch` |
| INV-22 | 工具名类型由常量表派生，不许另写一份字符串联合 | 类型 | `src/contract/constants.ts::AgentToolName` |
| INV-23 | 工具名必须是 canonical 工具 id（`namespace:tool`，两段都以小写字母开头）；不合法的名字在定义期就抛，进不了注册表 | 测试 | `spec/acceptance.test.ts` |
| INV-24 | 契约里写的每条示例都按「模型实际会发的那份 JSON」序列化再解析，然后过工具自己的 schema；有一条不过就在定义期抛 `VALIDATION`，message 点名工具、原示例与逐条路径 | 测试 | `spec/acceptance.test.ts` |
| INV-25 | 模型面说明只在定义期被写下来，硬上限与软预算两道闸也只在那时拦：超硬上限一律抛且不可豁免；超软预算抛，除非带上理由为 `safety-protocol` / `meta-tool` 且 `note` 非空白的豁免 | 测试 | `spec/acceptance.test.ts` |
| INV-26 | 说明的分节语法固定：`描述` 开头且正文非空，其余分节按 `适合`→`禁止`→`强制流程`→`用法`→`示例`→`注意` 的顺序出现、不重复、每行都是 `- ` 条目，`适合` 必填；渲染与判定同一部语法，渲染出来的说明一定判为结构化 | 测试 | `spec/acceptance.test.ts` |
| INV-27 | `readOnly` 的判据顺序是 `capabilities.effectKind === 'read'` → 显式 `readOnly` → `role === 'inspect'`，前一档有值就不看后一档 | 测试 | `spec/acceptance.test.ts` |
| INV-28 | 内核可调用操作每次调用固定四步：按工具 schema 严格解析入参（对象 schema 拒收未知字段）→ 解析上下文并换上内核给的 abortSignal → 不可用报 `UNAVAILABLE` → 执行；宿主没给上下文解析器时一个操作都不登记 | 测试 | `spec/acceptance.test.ts` |
