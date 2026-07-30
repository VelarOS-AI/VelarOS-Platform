/**
 * 驻留账本 + 治理器（上下文治理 v2 · B0 机器 + B1 决策）的目录出口。
 *
 * 分工没有第三层：
 *  - **机器**（B0）：记录模型、只追加账本、准入钩子、确定性投影、摄入适配器、迁移事件、配置面。
 *  - **决策**（B1）：`GovernanceEpoch` 状态机（I0 逐出 / I1 规则骨架）、`ContextGovernanceSession`
 *    的跨回合状态与 fault / 转交信号、`dashboard` 尾块。
 *  - **花钱的那一档**（B2）：`distill` 的选段/判据/验证（纯）+ `distillRunner` 的异步调度（并发 1、
 *    超时、回落骨架）。蒸馏永不内联阻塞回合，产物在下一个 epoch 边界落地。
 *
 * B1 起本目录是 `ProviderRequestCompiler` 的**历史组装单口**：会话历史摄入账本、投影出 provider
 * 消息，v1 的注意力路由 / microCompaction / 聚合预算 / 语义摘要器四条旁路已随本批下线。
 */
export * from './admission'
export * from './anchors'
export * from './ContextGovernanceSession'
export * from './ContextRecord'
export * from './dashboard'
export * from './determinism'
export * from './distill'
export * from './distillRunner'
export * from './governanceConfig'
export * from './GovernanceEpoch'
export * from './ingest'
export * from './messageFacts'
export * from './migrationLog'
export * from './projection'
export * from './ResidencyLedger'
export * from './skeleton'
