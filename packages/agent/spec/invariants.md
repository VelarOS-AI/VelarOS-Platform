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
