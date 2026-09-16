/**
 * 注入面：宿主（Desktop、VelarOS Terminal、第三方执行体的套件）必须或可以塞进来的东西。
 * 本包是 host 无关的测量基础设施：它不认识任何具体执行体，也不认识任何宿主的 hooks 协议、凭据文件或数据目录；
 * 「怎么驱动一个执行体」「什么算通过」「探测器是哪几个」「套件运行时从哪来」全部由宿主从这里塞进来。
 * 这里的每个接口都必须从根入口导出。
 */
import type { ObservationPhase } from '../contract/constants.js'
import type { DetectorRegistryApi } from '../impl/DetectorRegistry.js'
import type { VerifierRegistryApi } from '../impl/VerifierRegistry.js'
import type {
  Budget,
  DetectorContext,
  DetectorDefinition,
  DriverCapabilities,
  ExecutorIdentity,
  Finding,
  JourneySetup,
  JourneySpec,
  LegSpec,
  NativeExecutionState,
  Observation,
  RunArchive,
  SessionHandle,
  SessionSpec,
  SettleOutcome,
  TrialSpec,
  VerificationContext,
  VerificationOutcome,
  WatchDecision,
  WatchSample,
} from '../types/agent-lab.js'

/**
 * 探测器：看一次观测，给出零条或多条判词。必须是纯函数——同样的观测给同样的判词，不读磁盘、不发请求。
 * 由宿主或本包的内置探测器提供，注册进 `DetectorRegistryApi`。
 */
export type Detector = (observation: Observation, context: DetectorContext) => readonly Finding[]

/**
 * 验证器：判一条判据成不成立。它是结果的唯一来源——没有验证器判过的事一律是 `unknown`，不拿总分掩盖。
 * 由宿主提供并注册进 `VerifierRegistryApi`；允许读磁盘、跑命令，但不该去改被测工作区。
 */
export type Verifier = (context: VerificationContext) => Promise<VerificationOutcome> | VerificationOutcome

/** 注册进来的一个探测器：它的自述加上它的实现。 */
export interface RegisteredDetector {
  /** 这个探测器的自述：id、看哪一面、在哪些阶段跑、命中后是不是要中止。 */
  readonly definition: DetectorDefinition
  /** 探测本身。 */
  readonly detect: Detector
}

/** 等一段跑完时交给驱动的请求：这一段的预算、中断信号，以及每采样一次要回调的裁决口。 */
export interface SettleRequest {
  /** 这一段的预算（整程预算被段预算覆盖之后的结果）。 */
  readonly budget: Budget
  /** 调用方的中断信号；收到就尽快收尾并报 `unavailable`。 */
  readonly signal: AbortSignal
  /** 每采样一次就回调一次；返回 `abort` 时驱动要停下来并报 `aborted`。 */
  readonly onSample: (sample: WatchSample) => Promise<WatchDecision>
}

/**
 * 执行体驱动：本包与被测执行体之间唯一的那层。会话生命周期与「什么算跑完了」都归驱动，
 * 运行器绝不拿一个执行体的事件去猜另一个执行体的状态。
 * 内置只有一个通用的轮询驱动；认某个宿主协议的驱动（例如 Desktop 的 Velar Hooks）由宿主自己实现并注册进来。
 */
export interface LabDriver {
  /** 驱动 id，与执行体一一对应。 */
  readonly id: string
  /** 声明自己能看到哪几面、靠什么判收敛、能不能就地批准或中途中止。 */
  capabilities: () => Promise<DriverCapabilities>
  /** 报出被测执行体的身份：版本、provider、模型、上下文窗口。 */
  identity: () => Promise<ExecutorIdentity>
  /** 开一个会话。 */
  openSession: (spec: SessionSpec) => Promise<SessionHandle>
  /** 按旅程的 setup 把工作区准备好；`null` 表示不用准备。 */
  prepare: (session: SessionHandle, setup: JourneySetup | null) => Promise<void>
  /** 把这一段的提示词发给执行体。 */
  send: (session: SessionHandle, leg: LegSpec) => Promise<void>
  /** 等这一段跑完，期间按 `onSample` 的裁决决定继不继续。 */
  waitSettled: (session: SessionHandle, request: SettleRequest) => Promise<SettleOutcome>
  /** 采一次观测。 */
  collect: (session: SessionHandle, phase: ObservationPhase) => Promise<Observation>
  /** 中止当前这一段，理由原样传给执行体。 */
  abort: (session: SessionHandle, reason: string) => Promise<void>
  /** 关会话，释放它占的东西。 */
  closeSession: (session: SessionHandle) => Promise<void>
}

/**
 * 轮询适配器：只懂某个执行体的原生状态，别的一概不管。
 * 预算、审批策略、稳定空闲判定与看门狗都在本包的轮询驱动里，适配器只回答「它现在怎么样」。
 */
export interface PollingDriverAdapter {
  /** 适配器 id，会成为驱动 id。 */
  readonly id: string
  /** 声明能看到哪几面。 */
  capabilities: () => Promise<DriverCapabilities>
  /** 报出被测执行体的身份。 */
  identity: () => Promise<ExecutorIdentity>
  /** 开一个会话。 */
  openSession: (spec: SessionSpec) => Promise<SessionHandle>
  /** 按旅程的 setup 把工作区准备好。 */
  prepare: (session: SessionHandle, setup: JourneySetup | null) => Promise<void>
  /** 把这一段的提示词发给执行体。 */
  send: (session: SessionHandle, leg: LegSpec) => Promise<void>
  /** 读一次原生执行态：在不在跑、等不等审批、用量多少。 */
  readState: (session: SessionHandle) => Promise<NativeExecutionState>
  /** 采一次观测。 */
  collect: (session: SessionHandle, phase: ObservationPhase) => Promise<Observation>
  /** 回一条审批；`confirmationId` 用采样当时看到的那个，不重查代填。执行体不支持就不实现。 */
  resolveConfirmation?: (
    session: SessionHandle,
    approved: boolean,
    rejectionMessage: string | null,
    confirmationId?: string | null,
  ) => Promise<void>
  /** 中止当前这一段。 */
  abort: (session: SessionHandle, reason: string) => Promise<void>
  /** 关会话。 */
  closeSession: (session: SessionHandle) => Promise<void>
}

/**
 * 宿主自带驱动的注入点：宿主把「认自己协议的那种驱动」按 id 注册进 `LabDriversApi`，
 * 套件运行时再按 id 取。本包自己只有通用的轮询驱动，不认任何宿主协议；
 * Desktop 的 Velar Hooks 驱动、连同它的地址与凭据约定（`VELAR_HOOKS_*`）都在 Desktop 一侧，经这个口子接进来。
 */
export interface LabDriverProvider {
  /** 驱动 id；同一个 id 只许注册一次。 */
  readonly id: string
  /** 造一份驱动；`parameters` 是套件自己约定的形状，本包只原样转交。 */
  readonly create: (parameters: Readonly<Record<string, unknown>>) => Promise<LabDriver> | LabDriver
}

/**
 * 套件运行时：一套具体产品的评测套件交给 CLI 的东西——探测器与验证器都已注册好，
 * 按试验能取到旅程定义、能给出驱动。CLI 的 `run` 子命令只认这一个接口。
 */
export interface AgentLabRuntime {
  /** 这套套件注册好的探测器。 */
  readonly detectors: DetectorRegistryApi
  /** 这套套件注册好的验证器。 */
  readonly verifiers: VerifierRegistryApi
  /** 工作区根目录；驱动给了会话级的就以会话的为准。 */
  readonly workspaceRoot: string | null
  /** 本包源码的提交号，写进归档供复跑比对。 */
  readonly sourceCommit: string | null
  /** 套件自己源码的提交号，写进归档供复跑比对。 */
  readonly consumerCommit: string | null
  /** 按试验取旅程定义。 */
  getJourney: (trial: TrialSpec) => Promise<JourneySpec> | JourneySpec
  /** 按试验取驱动。 */
  resolveDriver: (trial: TrialSpec) => Promise<LabDriver> | LabDriver
}

/**
 * 套件运行时的加载器：`run --runtime <模块>` 要按路径加载一份运行时。
 * 动态 import 只许写在包根 `bin/` 的可执行壳里，`src` 下一律静态 import，所以这一步由壳注入。
 */
export interface AgentLabRuntimeLoader {
  /** 按模块路径加载并建好一份套件运行时；模块没有导出工厂时抛错。 */
  readonly load: (modulePath: string) => Promise<AgentLabRuntime>
}

/** 跑一个 job 时的回调面：怎么取驱动、怎么跑一次试验、每出一份归档做什么。 */
export interface JobRuntime {
  /** 跑一次试验，返回它的归档。 */
  readonly runTrial: (trial: TrialSpec, driver: LabDriver) => Promise<RunArchive>
  /** 按试验取驱动。 */
  readonly resolveDriver: (trial: TrialSpec) => Promise<LabDriver> | LabDriver
  /** 每跑完一次试验就把归档交给它，通常是写盘；不给就不写。 */
  readonly onArchive?: (archive: RunArchive) => Promise<void> | void
}
