# 地基重构的方案与评审（快照，非长期文档）

这一目录是 2026-09-15 起那轮地基重构（流水账见 `../foundation-refactor-log.md`）留下的工作底稿：每个包一份「按仓库标准改造」的方案，外加几份评审报告。

**怎么读**

- 它们是**写作当时**对磁盘的记录，不随代码更新；里面的行号、文件路径、统计数字都以各自开头写明的快照为准。代码改了就以代码为准。
- 每份方案的结构一样：结论先行 → 现状 → 目标布局 → 合同草案 → 工具面 → 实现层缺陷 → 步骤与风险 → 需要拍板的项 → 附录（逐个文件的去处）。
- 「需要拍板的项」汇总在 `../foundation-pending-decisions.md`。
- 缺陷一节里标「已复现」的，当时都有脚本能跑出来；已经修掉的见流水账与提交记录。

| 文件 | 内容 |
| --- | --- |
| `agent.md` | agent 包的八步改造方案（含 431 个源文件逐个分类） |
| `agent-toolface-review.md` | agent 的工具面、简化候选与提示词评审 |
| `agent-coupling-audit.md` | agent 与其它包的耦合审计 |
| `browser.md` / `memory.md` / `kernel.md` | 三个大包的改造方案 |
| `model.md` / `office.md` / `computer.md` / `model-office-computer-summary.md` | 三个能力包的方案与汇总（含可抽公共件的清单） |
| `small-*.md` | 七个小包（agent-lab、development、html-artifacts、core、cli、document-renderer、surface-protocol）的方案与汇总 |
| `shared-logic.md` | system 与 project 的公共逻辑抽取方案（shell-command、rehearsal-sandbox、text-files、path-rules 由它而来） |
| `project-review-impl.md` | project 实现层评审（14 条缺陷，已全部修复） |
| `project-review-contract.md` | project 产品层评审（契约、提示词、易用、表达共 49 条） |
