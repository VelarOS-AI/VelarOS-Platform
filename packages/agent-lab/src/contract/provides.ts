/**
 * 产品面：本包交给外面的整件能力。每件的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发。
 * 这里的每个接口都必须从根入口导出。
 */

// ── 命令行 ─────────────────────────────────────────────────────
export type { AgentLabCliApi } from '../impl/AgentLabCli.js'

// ── 旅程运行 ───────────────────────────────────────────────────
export type { JourneyRunnerApi } from '../impl/JourneyRunner.js'

// ── 归档读写 ───────────────────────────────────────────────────
export type { LabArchivesApi } from '../impl/LabArchives.js'

// ── 驱动装配与登记 ─────────────────────────────────────────────
export type { LabDriversApi } from '../impl/LabDrivers.js'

// ── 线格式校验 ─────────────────────────────────────────────────
export type { LabWireApi } from '../impl/LabWire.js'

// ── 报告 ───────────────────────────────────────────────────────
export type { LabReportsApi } from '../impl/LabReports.js'

// ── 统计与认证 ─────────────────────────────────────────────────
export type { LabCertificationApi } from '../impl/LabCertification.js'
export type { LabStatisticsApi } from '../impl/LabStatistics.js'

// ── 真实任务工作负载与自适应战役 ───────────────────────────────
export type { AdaptiveCampaignApi } from '../impl/AdaptiveCampaign.js'
export type { RealTaskWorkloadApi } from '../impl/RealTaskWorkload.js'

// ── 两个注册处（一套评测一份，由工厂新建） ─────────────────────
export type { DetectorRegistryApi } from '../impl/DetectorRegistry.js'
export type { VerifierRegistryApi } from '../impl/VerifierRegistry.js'
