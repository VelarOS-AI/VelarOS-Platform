# ScriptAct foundation context fixes (F02 / F08 / F09)

本轮只修改 Context、Act 上下文运行与整理合同；保留并行 WIP。离线证据位于 `.velaros-workspace/bench/foundation-fixes-53/context/`。没有调用付费模型、下载资源或提交 Git。

## F02：持久段正文的标准强引用

段底座与冻结历史正文现在先追加正式 `ContextRecord`（`context:segment-body` / `context:history-body`），再让段引用该记录的 `objectId`。SQLite 回收只认正式记录目录，不扫描任意业务 JSON。原始输入、摘要、active 状态与变更日志本身也都是正式记录，因此内部 `ContextRef` 不需要变成额外的裸对象根。

新会话声明 `objectReferencesVersion: 1`。旧会话缺少标记时，实际回收与预演都会以 `CONTEXT_REFERENCES_UNVERIFIED` 拒绝，避免误导为安全可删。Runtime 只识别自己拥有的旧 segment/delivered/frame schema，把嵌套对象的精确、不透明 ID 补成正式记录；验证正文存在后，引用记录和完备标记在同一 CAS 内提交。迁移中断、缺失正文和冲突均不会先放开回收。没有增加通用 JSON 猜测规则。

验证包括：将真实已接收段的对象时间推到宽限期之外，回收只删真实 orphan；关闭并重新打开 SQLite 后，历史消息逐字一致。旧会话先拒绝回收、完成 Runtime 迁移后可以安全回收。

## F08：活动范围与增量查询

`ContextRecordSelection` 增加 `after`、`through`、`first`，分别为排他下界、包含上界、有界正序页。范围先与 kind/title/ref 条件相交，再施加 latest/last/first/latestPerTitle。非法范围和互斥组合在存储边界拒绝。

RecentContext 投影直接选择段起点后的 assistant/result，以及明确 carried 的引用。continuation 从实际 assistant 的 sources 按 ref 查询，兼容 continuation 刚好在段边界前的合法协议状态。封段和目录读取使用相同序号范围。当前程序租约按活跃 ref 查正文，child 只取每个标题的最新状态，用户图片从本帧目标的最早原文序号起查询。

卷目录与长期 negative ledger 存储在 `context:history-index` 中，首次建立之后只读新卷、新叙事及一个索引头；正常帧不再扫描所有历史卷。当前状态只导入新输入摘要、新叙事；已经核对的用户输入不会每帧重新加载，pending 用户只查 `reviewedThrough` 之后，最新输入通过精确 ref 保留。整理会话缓存一次材料快照，后续 list/read 使用增量变更检测与范围分页；真正发布前仍完整重读核验版本，不把部分目录写回完整 CAS。

这不是“所有存储操作恒定时间”的承诺。首次旧会话迁移、首次构建卷索引、整理初始快照与最终发布、没有选择/元数据扩展的兼容端口仍可完整读取。当前尚未核对的输入、真实活动项和当前笔记数量仍是必要输入规模。任务 metadata.goals 的序列化、最新标题聚合的数据库扫描成本没有变成独立索引表；本轮修复的是已封存历史反复进入活动帧与分页链路的问题。

## F09：历史摘要与当前认识独立

新增内部 `ActiveContext`，把原文和历史摘要保留为不可变事实，另存带 revision 的当前约束/未解事项投影。约束来源为原用户输入及相应摘要；未解事项来源为卷叙事。每项都有稳定 ID、来源和 `origin: model-interpretation`，新叙事省略旧问题不会自动把它解决。

整理合同增加 `snapshot.active` 与 `patch.active`。逐项变更只能操作现有 ID，明确 superseded / retracted / resolved；版本过期拒绝。核对前必须证明最新用户原文全文实际进入本整理模型请求，不能只读 ref 或摘要。用户约束只能依据完整读过、序号更晚的用户原文撤销/取代；未解事项关闭只能引用用户原文或真实 script result。每段 evidence 的 session、授权范围、offset 与逐字 quote 都会核对。每次变更保存前项、后项、证据和墓碑；重启、旧摘要刷新不会复活已退休的同一项；某原输入发生逐项退休之后，后续历史摘要只更新历史，不自动引入同义改写的活动项，同来源尚活动的其他约束仍保留。模型可用 additions 在明确核对与原文全文送达后按真实证据补充遗漏项或重开问题，避免将来源屏蔽变成永久信息损失。独立任务与历史权限 reset 开始新的状态范围。超过 256 项时，完整待处理来源继续列在 pendingSources，导入游标保留在其之前；允许先逐项关闭已驻留项，再恢复导入，不靠抛错把维护入口卡死。

引文存在仅证明来源存在，不证明模型解释的语义正确。所有当前项、替代项和转换均继续标为模型解释；最新用户输入独立按原文进入主模型历史，优先于历史摘要与当前解释。超长且已有摘要的最新输入用明确 partial 的原文首尾短摘录加历史解释投递，全文仍按原引用召回；这不进入整理工具的全文已送达清单。没有把任意原文子串变成用户授权或平台允许清空约束的指令。

现有 INV-52 改为当前约束、问题按独立状态呈现；段底座保留历史快照、negative ledger 与引用，不再把历史约束的并集冻结为当前有效约束。模型模板与合同说明同步强调该区分。

## 验证与证据

- `red.log`：最初两个 GC/活动查询回归用原实现失败。
- `context-build.log`：Context 包构建通过。
- `initial-green.log`：最初修复与存储索引测试通过。
- `regression-1.log`：旧 INV-52 的历史等同当前状态断言失败，随后按新合同更新。
- `regression-2.log`：120 tests，116 pass，4 skip，0 fail。
- `red-user-range.log`：新增用户历史压力测试的首次运行遇到并行统一 build 正在清理 dist，属于环境未就绪，不能计作有效红灯证据。
- `regression-3.log`：159 tests，153 pass，4 skip，2 fail；新增真实用户规模测试已通过，失败的长输入投影和旧底座语义断言随后修复。
- `regression-4.log`：foundation-context 与 context-management 共 27 tests，27 pass，0 fail；验证超长输入维护、跨段 continuation、任务切换/权限 reset、容量满的可恢复维护，以及 100/1000 个已核对用户输入。
- `regression-final.log`：7 文件完整回归 160 tests，156 pass，4 skip，0 fail。
- `red-rephrasing.log`：真实复现已退休约束被旧摘要的同义改写重新引入。
- `regression-rephrasing.log`：来源退休水位与显式补充修复后，foundation-context 和 context-maintenance 共 46 tests，46 pass，0 fail。
- `typecheck-final.log`：本组无类型错误；并行 files/utils/fs.ts 的 signal 参数口不一致由领域组处理，未把该命令宣称通过。

聚焦命令：

```sh
bun run --cwd packages/context build
node --test packages/context/test/storage-contract.test.mjs packages/velaros/act/runtime/test/foundation-context.test.mjs packages/velaros/act/runtime/test/context-memory.test.mjs packages/velaros/act/runtime/test/context-maintenance.test.mjs packages/velaros/act/runtime/test/context-index.test.mjs packages/velaros/act/runtime/test/context-management.test.mjs packages/velaros/act/runtime/test/program-context.test.mjs
```

跨组统一构建、生成的模型合同、ownership 与全量验收由主线程负责。新实现和测试登记已通知主线程，未直接修改共享 governed-modules。

## 独立交叉复核

完成对主线程 F11–F13 的只读复核。查明并上报两项 Model 量测边界：缺缓存详情被当成零而误报完整费用；严格未知修复后已知 cacheRead 分项被未知 cacheWrite 连带丢出 knownCost。主线程负责修复。签名尝试身份的晚到归属和跨会话调用去重暂未发现新增确定缺陷。39 项既有 Harbor 身份、工具统计、量测单元测试独立通过；详情见同目录 `cross-review.md` / `cross-review-tests.log`。

## Runtime 风格门收束

按主线程追加分工，对 act/runtime 的既有 WIP 机械写法一并使用项目 helpers 收束（context-memory、materials、RuntimeBootstrap、ProgramContext、ContextMemory、RecentContext）。严格 true 判断保留严格语义；可选 pointer/feedback/continuation 用构造后条件附加，保持键缺席与继承字段语义，序列化的既有字段顺序保持。没有新增 baseline/suspend。`context/style-pass.json` 中 act/runtime 为零违规；全库仍有其他组的 memory 类型合同项。未为风格改动重复全场景运行，最终统一门禁由主线程执行。

## 最终合同复核与隔离验收

`ActiveContextItem/State` 是内部快照数据，不再带生成用的 AgentView 或入口导出；公开 `ActiveContextEvidence/Patch` 与生成模型声明保持一致，包括 additions 和证据限制。自动问题导入只消费卷叙事的 unresolved；用户输入摘要的 unresolved 保留在原文/摘要，可经显式 additions 加入当前状态。整理补丁 unresolved 描述整理缺口，不自动混入业务问题。本轮保留这一明确来源边界。

追加 lint 仅修已分配文件的 import/export 排序、readonly 数组写法、未用导入，并在旧会话迁移测试核对被移除的标记确为 1；`lint-final.log` 记录这些文件 lint 通过。未修改 execution 组负责的 context.test.mjs。

隔离集成中发现两项测试合同差异：有限曝光场景现在显式指定 retainTurns:2，并继续严格断言剩余 2 轮；文本默认 segment 期限另有专测。系统包与 memory 成员均为原生 ESM namespace：只读、不可扩展而非 frozen。测试核对包成员与 update 绑定赋值被拒绝、原引用保持、两层对象不可扩展，以及包成员与直接 import 同一能力模块具有严格相同的 namespace 身份。更强断言暴露 QuickJS 的 `export * as namespace` 写绑定缺陷（`namespace-probe.mjs` / `namespace-probe.jsonl` / `namespace-failure.log`）；等价 namespace import 加具名再导出保持只读。主线程已接手通用 Script 修复，测试维持强断言，最终统一构建与验收以主线程最新日志为准。
