# Agent Lab 测量方法与 2026 调研判决

## 调研结论

本方案在 2026-08 重新核对了业界当前形态，没有把旧 Desktop 实现或上一版 blueprint 当设计稿：

- Harness-Bench 说明 harness 配置本身会显著影响结果，比较前必须共享任务环境、预算与评测协议，同时保留
  原生 harness 行为；本包把这四项做成 manifest 与 comparability 机械条件。
  见 [Harness-Bench](https://arxiv.org/abs/2605.27922)。
- Terminal-Bench 2 / Harbor 把真实任务、唯一环境、测试验证器、agent adapter 和结果制品分离；Harbor 的
  verifier sidecar 也证明验证证据应与 agent 环境分开。
  见 [Terminal-Bench 2](https://arxiv.org/abs/2601.11868)、
  [Harbor agents](https://www.harborframework.com/docs/agents)、
  [Harbor artifacts](https://www.harborframework.com/docs/run-jobs/results-and-artifacts)。
- Inspect 用 epochs 与 reducer 显式表达重复试验；本包保留 replicate 身份，并把单次成败与可靠性估计分开。
  见 [Inspect metrics](https://inspect.aisi.org.uk/metrics.html)。
- OpenAI 的第三方评测建议披露 system、harness、预算与有效性检查；这些字段进入 v3 manifest 和认证前置门。
  见 [可信第三方评测基础](https://openai.com/index/trustworthy-third-party-evaluations-foundations/)。
- BenchJack 展示验证器和 benchmark 完整性缺陷能让系统“不解题也高分”；因此完整性失败会直接让认证拒绝，
  verifier isolation 不足则给未知而非通过。见 [BenchJack](https://arxiv.org/abs/2605.12673)。
- METR 的长任务研究使用层级 bootstrap 处理任务簇与随机性；本包按 Journey 簇做确定性配对 bootstrap，避免
  把同一长旅程的 leg 当独立样本。见 [METR 长任务方法](https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/)。

## 与业界主流不同的判决

VelarOS 的真实产品单位是长会话连续旅程，所以不采用“一案例一新会话”作为默认原语。抽象上没有分叉：独立
案例是单 leg Journey；连续旅程是多 leg Journey。统计聚类按 Journey，而不是把 leg 数量错误当成样本量。

旧 blueprint 的“先只做 P0 harness，再把统计与认证留空”没有采用。原因是第三方生态认证若没有可比性门、
attrition、重复试验和不确定性表达，归档格式会先被错误总分固化。当前版本先交付保守的统计与认证基础：证据
不足就 `inconclusive`，不承诺排行榜。

## 回归门

回归比较优先使用相同 Journey 版本、fixture digest、consumer commit、预算和 replicate seed 的配对结果。
环境漂移进入 drops，不能算 agent 失败；任务摘要或判据摘要不同则判不可比。正式回归阈值至少包含最小实际
效应，避免“统计可见但产品无意义”的变化触发门。

## 跨执行体

内部 agent、Codex、Claude Code 各自保留原生提示、工具和协调器。共享的是任务环境、预算上限、验证器和
归档协议。报告以失败分类分布、attrition、观测缺口和完成度区间为主；总分只是派生量，不能代替根因矩阵。

Token 口径若供应商不能等价提供，coverage 必须是 partial/none，比较时展示未知。墙钟上限相同不代表工作量
相同，因此能提供 working time 的 Driver 应同时记账。

## 上下文治理实验

每个 context residency event 保留 epoch、触发原因、压缩前后 token、下一请求 cache-read 变化与 distill 成本。
分析时至少按 Journey turn/epoch 分层，报告压缩收益随轮次的变化、完成度变化和召回是否补回信息。事件只能由
现有 residency ledger 投影；Agent Lab 不写回、不补字段、不另算第二账本。
