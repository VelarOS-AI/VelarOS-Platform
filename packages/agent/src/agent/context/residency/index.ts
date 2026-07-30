/**
 * 驻留账本（上下文治理 v2 · V2-B0）的目录出口。
 *
 * 本批只提供**机器**：记录模型、只追加账本、准入钩子、确定性投影、摄入适配器、迁移事件日志、
 * 配置面。治理决策（epoch 状态机 / I0 逐出 / I1 骨架 / I2 蒸馏）归 V2-B1 的 Governor——它挂在
 * `ContextResidencyLedger.migrate` 与 `projectContextLedger` 之间，B0 不预埋任何触发逻辑。
 *
 * 现役链路（`ProviderRequestCompiler` 六 stage + `history/*` 压缩族）**未被本批改动一行**：
 * B0 是纯新增模块，运行时行为零变化。
 */
export * from './admission'
export * from './anchors'
export * from './ContextRecord'
export * from './determinism'
export * from './governanceConfig'
export * from './ingest'
export * from './messageFacts'
export * from './migrationLog'
export * from './projection'
export * from './ResidencyLedger'
