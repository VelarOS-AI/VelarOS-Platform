/**
 * 带回调或带实例的选项：这些形状会流过公开签名，但它们带行为，进不了可移植数据文件。
 */
import type { DetectorRegistryApi, VerifierRegistryApi } from '../contract/provides.js'
import type { AgentLabRuntimeLoader, LabDriver } from '../contract/requires.js'

import type {
  CertificationPolicy,
  CertificationSubject,
  RunArchive,
  TrialSpec,
} from './agent-lab.js'

/** 跑一条旅程要给的全部东西：身份、旅程定义、驱动、两个注册表，以及可替换的时钟与 run id 生成器。 */
export interface RunJourneyOptions {
  /** 这次运行属于哪个 job。 */
  readonly jobId: string
  /** 这次运行属于哪个套件。 */
  readonly suiteId: string
  /** 哪次试验。 */
  readonly trial: TrialSpec
  /** 旅程定义；跑之前先严格校验，校验不过当场抛错。 */
  readonly journey: unknown
  /** 被测执行体的驱动。 */
  readonly driver: LabDriver
  /** 探测器注册表；旅程里的门探测器必须都在里面。 */
  readonly detectors: DetectorRegistryApi
  /** 验证器注册表；判据引用的验证器必须都在里面。 */
  readonly verifiers: VerifierRegistryApi
  /** 工作区根目录；驱动给了会话级的就以会话的为准。 */
  readonly workspaceRoot: string | null
  /** 本包源码的提交号，写进归档供复跑比对。 */
  readonly sourceCommit: string | null
  /** 调用方源码的提交号，写进归档供复跑比对。 */
  readonly consumerCommit: string | null
  /** 写进归档的 harness 版本；不给取常量表里的本包版本。 */
  readonly packageVersion?: string
  /** 取当前时间；测试里换成可控时钟。 */
  readonly now?: () => number
  /** 生成 run id；测试里换成固定值。 */
  readonly createRunId?: () => string
}

/** 认证一个对象要给的全部东西：策略、对象、被测与基线两组归档。 */
export interface CertificationInput {
  /** 被认证的对象。 */
  readonly subject: CertificationSubject
  /** 按哪份策略判。 */
  readonly policy: CertificationPolicy
  /** 被测对象的归档。 */
  readonly archives: readonly RunArchive[]
  /** 基线对照的归档；策略不要求基线时可以不给。 */
  readonly baselineArchives?: readonly RunArchive[]
  /** 被测执行体的 id。 */
  readonly subjectExecutorId: string
  /** 基线执行体的 id；不给就判不了回归，记 `unknown`。 */
  readonly baselineExecutorId?: string
  /** 取当前时间；测试里换成可控时钟。 */
  readonly now?: () => number
}

/** 跑一条命令要给的注入：套件运行时的加载器，以及可替换的时钟。 */
export interface AgentLabCliOptions {
  /** `run` 子命令按 `--runtime` 指的模块路径取套件运行时；本包不做动态 import，由可执行壳注入。 */
  readonly loadRuntime: AgentLabRuntimeLoader
  /** 取当前时间；报告里的生成时间用它。 */
  readonly now?: () => number
}
