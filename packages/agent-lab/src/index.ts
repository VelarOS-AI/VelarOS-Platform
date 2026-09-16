/**
 * 根入口（`@velaros-ai/agent-lab`）：九件整件能力、两个注册处的工厂、注入面，以及它们签名里流过的数据。
 * 要跑命令行走包根 `bin/velaros-agent-lab.mjs`；这里不带任何副作用。
 * 另一个入口 `./contracts` 是它的子集，只有可移植数据。
 */

// ── 子集入口：常量表与可移植数据 ───────────────────────────────
export * from './contracts.js'

// ── 产品面：每件能力的接口在类上方，由 contract/provides.ts 登记 ─
export type { AdaptiveCampaignApi } from './impl/AdaptiveCampaign.js'
export { adaptiveCampaign } from './impl/AdaptiveCampaign.js'
export type { AgentLabCliApi } from './impl/AgentLabCli.js'
export { agentLabCli } from './impl/AgentLabCli.js'
export type { JourneyRunnerApi } from './impl/JourneyRunner.js'
export { journeyRunner } from './impl/JourneyRunner.js'
export type { LabArchivesApi } from './impl/LabArchives.js'
export { labArchives } from './impl/LabArchives.js'
export type { LabCertificationApi } from './impl/LabCertification.js'
export { labCertification } from './impl/LabCertification.js'
export type { LabDriversApi } from './impl/LabDrivers.js'
export { labDrivers } from './impl/LabDrivers.js'
export type { LabReportsApi } from './impl/LabReports.js'
export { labReports } from './impl/LabReports.js'
export type { LabStatisticsApi } from './impl/LabStatistics.js'
export { labStatistics } from './impl/LabStatistics.js'
export type { LabWireApi } from './impl/LabWire.js'
export { labWire } from './impl/LabWire.js'
export type { RealTaskWorkloadApi } from './impl/RealTaskWorkload.js'
export { realTaskWorkload } from './impl/RealTaskWorkload.js'

// ── 两个注册处：一套评测一份，由工厂新建 ───────────────────────
export type { DetectorRegistryApi } from './impl/DetectorRegistry.js'
export { createDetectorRegistry } from './impl/DetectorRegistry.js'
export type { VerifierRegistryApi } from './impl/VerifierRegistry.js'
export { createVerifierRegistry } from './impl/VerifierRegistry.js'

// ── 注入面：宿主要塞进来的东西 ─────────────────────────────────
export type {
  AgentLabRuntime,
  AgentLabRuntimeLoader,
  Detector,
  JobRuntime,
  LabDriver,
  LabDriverProvider,
  PollingDriverAdapter,
  RegisteredDetector,
  SettleRequest,
  Verifier,
} from './contract/requires.js'

// ── 公开签名里流过的带行为的选项 ───────────────────────────────
export type { AgentLabCliOptions, CertificationInput, RunJourneyOptions } from './types/options.js'
