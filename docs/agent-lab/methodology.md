# Agent Lab 测量方法与 2026 调研判决

## 公开评测带来的原则

- [Terminal-Bench 2](https://github.com/harbor-framework/terminal-bench-2) 与 Harbor 把任务环境、agent adapter、
  verifier 和结果制品分开：VelarOS 因此把生产事实、宿主验收和纯审计分层。
- [WebArena-Verified](https://github.com/ServiceNow/webarena-verified) 强调可复现状态与确定性验证：结果优先由
  文件、命令、JSON、browser state 或用户确认判定，不用关键词和 LLM judge 冒充真值。
- [OSWorld V2](https://github.com/xlang-ai/OSWorld-V2) 与 [tau-bench](https://github.com/sierra-research/tau2-bench)
  说明真实计算机/状态化多轮任务的重要性：任务样本来自实际产品流量，而不是工具清单排列组合。
- [BrowseComp](https://openai.com/index/browsecomp/) 提供高难度检索任务的设计参考，但公开题只作一次性外部
  对照，不直接复制成 VelarOS 默认题库。
- OpenAI 对 [SWE-bench Verified 污染](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
  的说明表明固定公开题会随时间失真；真实任务和私有案例能降低污染与针对性优化。
- [可信第三方评测基础](https://openai.com/index/trustworthy-third-party-evaluations-foundations/) 强调披露
  system、harness、预算和有效性检查；这些信息在显式研究矩阵中继续进入归档和可比性门。

## 现行判决

产品改动不再默认运行 `quick/friction/full` 等固定 suite。它们覆盖的是设计者想象的工具面，成本持续，
却不能代表用户真实任务分布。日常方法是：

1. 从一个已经完成且未重复审计的真实任务采集记录。
2. 用任务自身的验收条件判断 `outcome`，用 spans 判断 `health`。
3. 发现工具/系统问题时先修 owner seam，再选择一个不同的新任务验证。
4. 只有高价值问题补齐 acceptance 与 workspace snapshot，固化成 `RealTaskCase`。
5. 复跑默认一次。只有研究问题确实需要方差时才声明 replicates 与比较矩阵。

## 解释规则

- `verified-pass`：明确验收通过，过程健康。
- `verified-pass-with-issues`：验收通过，但过程出现可行动问题。
- `verified-fail`：验收或用户确认明确失败。
- `needs-review`：执行已坏但缺少足够结果验收。
- `unknown`：证据不足；不是 0 分，也不是失败。

工具错误至少区分预期不可用、并行冗余和反馈后的顺序重试。只有后一类说明执行没有根据反馈换路；
并行 fan-out 是不同的效率/规划问题。成本、token 和调用数只来自供应商或执行账本真实字段，不估算。

## 何时仍使用 Journey/统计

Journey 是 `RealTaskCase` 的执行容器，也可用于明确批准的上下文治理或跨执行体研究。跨执行体比较仍要求
共享任务快照、验收、预算与 consumer commit；环境 attrition 单列，未知 coverage 不补零。少于两个独立
任务簇时不宣称显著性。
