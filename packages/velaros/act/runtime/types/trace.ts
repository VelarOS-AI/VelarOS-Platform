import type { ContextRecord } from '@velaros-ai/context'

import type { ModelToolBinding } from './model-tools.js'
import type { ObservationCollection } from './runtime.js'

/** 宿主诊断采样，不含正文、参数或资源路径；阶段可能嵌套，不能相加当作墙钟总耗时。 */
export interface RuntimeMetric {
  /** 会话身份。 */
  readonly sessionId: string
  /** 存储操作或效果等待阶段。 */
  readonly phase: 'storage' | 'effect-wait' | 'effect-run'
  /** 存储方法名或能力操作名。 */
  readonly operation: string
  /** 单调时钟的毫秒差。 */
  readonly durationMs: number
  /** 阶段是否正常返回；不代表外部效果已提交。 */
  readonly succeeded: boolean
  /** 关联到脚本执行，存储采样不推断执行归属。 */
  readonly executionId?: string
}

/** 会话内的原始记录，正文只按总字符预算截取，完整内容可经 context.read 召回。 */
export interface ActTraceRecord {
  readonly ref: { readonly sessionId: string; readonly id: string }
  /** 原始归档时间；旧宿主可省略，消费者不能用重读时刻改写历史时间。 */
  readonly createdAt?: string
  readonly sequence: number
  readonly title: string
  readonly chars: number
  readonly body: Nullable<string>
  readonly truncated: boolean
  readonly sources: ReadonlyArray<{ readonly sessionId: string; readonly id: string }>
}

/** Kernel 调用事实的有界展示；原始回执与外部效果分别表达。 */
export interface ActInvocationSummary {
  /** 实际调用的模块。 */
  readonly moduleId: string
  /** 实际调用的操作。 */
  readonly operation: string
  /** 没有终态回执时保持 pending，不根据会话结束推断成功。 */
  readonly status: 'pending' | 'succeeded' | 'failed' | 'cancelled'
  /** 原始回执中的外部效果；无回执时未知。 */
  readonly effect: 'none' | 'committed' | 'partial' | 'unknown'
  /** 有界参数原文；正文预算不足时可能为空。 */
  readonly input: string
  /** 有界返回值或错误原文；无回执时为空。 */
  readonly output: string
  /** 参数是否被裁剪。 */
  readonly inputTruncated: boolean
  /** 返回值或错误是否被裁剪。 */
  readonly outputTruncated: boolean
}

/** 一次执行没成功的原因。 */
export interface ActExecutionFailure {
  /** 失败类别：SCRIPT_CHECK、NEEDS_MODULES、UNSETTLED、INTERRUPTED，或运行与脚本自己的错误码。 */
  readonly code: string
  /** 一句话原因。 */
  readonly message: string
  /** 出错在源码第几行，从 1 起；换算不出来时为 null。 */
  readonly line: Nullable<number>
}

/** 本回合响应派发的一段 execute；状态由持久结果与调用回执推出，宿主不必解析内部记录。 */
export interface ActExecutionSummary {
  /** 真实归档的源码语言；旧记录省略时为 Node。 */
  readonly language?: 'node' | 'shell'
  /** 原生进程的退出状态、日志路径与有界输出；与 Kernel 调用回执分开。 */
  readonly processOutput?: string
  /** 原生进程输出是否被本页正文预算裁剪。 */
  readonly processOutputTruncated?: boolean
  /** 执行身份，与 invocations[].executionId 对应。 */
  readonly executionId: string
  /** 在本回合响应的 execute 声明里排第几，从 0 起；同一回合的第几个 execute 程序事件与它对应。 */
  readonly position: number
  /** queued 表示等待执行槽；running 表示已开始；unknown 表示有调用的外部效果未知，需要先核对。 */
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  /** 脚本没成功时的原因；运行中、成功，或只是效果未知时为 null。 */
  readonly failure: Nullable<ActExecutionFailure>
  /** 这次执行用了多少毫秒，取自持久结果；还没有结果或没过检查时为 null。 */
  readonly durationMs: Nullable<number>
  /** 实际运行的源码，受本页正文预算约束。 */
  readonly source: string
  /** 源码是否被截断。 */
  readonly sourceTruncated: boolean
}

/** 本回合响应里 observe 声明的登记结果；登记本身不运行程序，新版本从下一回合起每帧运行。 */
export interface ActObservationRegistration {
  /** updated 登记了新版本，unchanged 与当前版本一样，cleared 清掉了观察，rejected 没登记上。 */
  readonly status: 'updated' | 'unchanged' | 'cleared' | 'rejected'
  /** 没登记上的原因；登记上了为 null。 */
  readonly failure: Nullable<ActExecutionFailure>
  /** 登记的源码，受本页正文预算约束；清除时为空。 */
  readonly source: string
  /** 源码是否被截断。 */
  readonly sourceTruncated: boolean
}

/** 本回合所用的观察；复用与暂停保留原执行身份和原采集时刻。 */
export interface ActObservationRun {
  /** collected 才是本轮真实执行；旧记录省略时保持原来的采集语义。 */
  readonly collection?: ObservationCollection
  /** 运行身份，与 invocations[].executionId 对应。 */
  readonly executionId: string
  /** 还没有结果时是 running；unknown 表示有调用的外部效果未知，需要先核对。 */
  readonly status: ActExecutionSummary['status']
  /** 观察没成功时的原因；运行中、成功，或只是效果未知时为 null。 */
  readonly failure: Nullable<ActExecutionFailure>
  /** 这次观察用了多少毫秒，取自持久结果；还没有结果时为 null。 */
  readonly durationMs: Nullable<number>
  /** 实际运行的源码，受本页正文预算约束。 */
  readonly source: string
  /** 源码是否被截断。 */
  readonly sourceTruncated: boolean
}

/** 本回合与持续观察有关的两件事，宿主据此展示观察，不必解析内部记录。 */
export interface ActObservationSummary {
  /** 这一回合响应登记的观察；这一回合没有 observe 声明时为 null。 */
  readonly registration: Nullable<ActObservationRegistration>
  /** 喂进这一回合请求的观察运行；当时没有观察时为 null。 */
  readonly run: Nullable<ActObservationRun>
}

/**
 * 本回合执行里的一次派发或续跑；同一个子任务续跑时每一段各一份，状态、回答与耗时都只取这一段的持久记录。
 * 宿主据此展示子任务，不必解析内部记录。
 */
export interface ActAgentSummary {
  /** 本次派发或续跑阶段的原始开始时刻（毫秒）；没有持久事实时省略。 */
  readonly startedAt?: number
  /** 子任务身份，即 job.id。 */
  readonly id: string
  /** 子任务自己的会话，按它读支线的追踪。 */
  readonly sessionId: string
  /** 派发或续跑它的那段执行，与 executions[].executionId 对应。 */
  readonly executionId: string
  /** 选用的配置名。 */
  readonly profile: string
  /** 派发时交代的任务（续跑时是这一阶段的说明），受本页正文预算约束。 */
  readonly task: string
  /** 这一段现在的状态。 */
  readonly status: 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
  /** 没有完成时的原因；没有原因时为 null。 */
  readonly error: Nullable<string>
  /** 这一段最后接纳的一段回答，受本页正文预算约束；还没收束或没有回答时为空。 */
  readonly answer: string
  /** 回答是否被截断。 */
  readonly answerTruncated: boolean
  /** 从这一段开始（派发或续跑）到收束用了多少毫秒；还没收束时为 null。 */
  readonly durationMs: Nullable<number>
}

/** 追踪里子任务的一段：从派发或续跑写下的那份记录起，到这一段最新的那份；job 是最新那份的内容。 */
export interface TraceChildPhase {
  readonly first: ContextRecord
  readonly last: ContextRecord
  readonly job: Record<string, unknown>
}

/** 封存请求的只读展示；不证明供应商已收到请求，图像数据只保留占位。 */
export interface ActRequestSummary {
  /** 编译器封存的模型身份。 */
  readonly model: string
  /** 原始完整请求的内容指纹，展示截断不改变它。 */
  readonly fingerprint: string
  /** 发送准入时的输入 token 计量，历史缺失为 null。 */
  readonly inputTokens: Nullable<number>
  /** 输入计量精度，历史缺失为 null。 */
  readonly precision: Nullable<'exact' | 'estimate'>
  /** 输入计量依据，历史缺失为 null。 */
  readonly basis: Nullable<string>
  /** 为输出保留的 token 数。 */
  readonly outputTokens: number
  /** 系统指令；正文预算模式下可能截断。 */
  readonly system: string
  /** 消息 JSON 文本；正文预算模式下截断后不保证可解析。 */
  readonly messages: string
  /** 系统指令是否被截断。 */
  readonly systemTruncated: boolean
  /** 消息文本是否被截断。 */
  readonly messagesTruncated: boolean
  /** 消息中的图像或字节数据是否以占位代替。 */
  readonly mediaOmitted: boolean
}

/** 请求的真实收束与供应商计数；估算和缺项都不能代替已报告用量。 */
export interface ActModelAccounting {
  readonly status: 'settled' | 'inflight' | 'unknown'
  readonly outcome: Nullable<'accepted' | 'rejected'>
  readonly finishReason: Nullable<'stop' | 'length'>
  readonly error: Nullable<{ readonly code: Nullable<string>; readonly message: Nullable<string> }>
  readonly usage: {
    readonly coverage: 'known' | 'unknown' | 'inflight'
    readonly inputTokens: Nullable<number>
    readonly outputTokens: Nullable<number>
    readonly cacheReadTokens: Nullable<number>
    readonly cacheWriteTokens: Nullable<number>
  }
}

/** 按 charge ID 去重的费用事实；不同币种、实际费用与参考报价分别累计。 */
export interface ActVerificationCostSummary {
  readonly coverage: 'complete' | 'partial' | 'unknown'
  readonly charges: ReadonlyArray<{
    readonly id: string
    readonly kind: 'model' | 'external'
    readonly currency: string
    readonly basis: 'actual' | 'reference'
    readonly amount: Nullable<number>
  }>
  readonly totals: ReadonlyArray<{
    readonly kind: 'model' | 'external'
    readonly currency: string
    readonly basis: 'actual' | 'reference'
    readonly amount: number
  }>
  /** 同 ID 费用依据互相冲突时，不任选一份作为完整账单。 */
  readonly conflictingChargeIds: readonly string[]
}

/** 一次可信核查的阶段折叠；阶段时间是累计事实，不能相加。 */
export interface ActVerificationAttemptSummary {
  readonly attemptId: string
  readonly taskId: string
  readonly checkId: string
  readonly scope: string
  readonly verifierId: string
  readonly verifierVersion: string
  readonly mode: 'executed' | 'reused' | 'probed'
  readonly status: 'pending' | 'passed' | 'failed' | 'unknown' | 'cancelled'
  readonly applicability: 'current' | 'historical' | 'unknown'
  readonly phases: ReadonlyArray<'started' | 'settled' | 'late-result'>
  readonly startedAt: string
  readonly settledAt: Nullable<string>
  readonly durationMs: Nullable<number>
  readonly probeMs: Nullable<number>
  readonly runMs: Nullable<number>
  readonly records: ReadonlyArray<{ readonly sessionId: string; readonly id: string }>
  readonly cost: ActVerificationCostSummary
}

/** 一次实际模型请求及其执行证据；缺失部分明确列入 gaps。 */
export interface ActTurnTrace {
  readonly sessionId: string
  readonly turnId: string
  readonly runId: string
  readonly turn: number
  readonly repair: number
  /** 单调时钟测量；缺失保留 null。准备耗时仅记在首个尝试；模型耗时包含流消费者处理，不等于供应商服务时间。 */
  readonly timing: {
    readonly observationMs: Nullable<number>
    readonly contextMs: Nullable<number>
    readonly modelMs: Nullable<number>
    readonly firstTextMs: Nullable<number>
  }
  /** usage 的覆盖独立于协议接受状态；已拒绝请求仍可能有实际计数。 */
  readonly modelAccounting: ActModelAccounting
  /** started 所在请求序号窗口归属此回合；后来的 settled/late-result 仍连接原 attempt。 */
  readonly verification: {
    readonly attempts: readonly ActVerificationAttemptSummary[]
    readonly cost: ActVerificationCostSummary
  }
  /** 请求审计包含 ProviderRequestCompiler 封存的消息与指纹。 */
  readonly request: ActTraceRecord
  /** 从完整封存请求生成的有界展示；历史没有封存请求时为 null。 */
  readonly requestSummary: Nullable<ActRequestSummary>
  /** 已接受或部分收到的模型原文。 */
  readonly response: Nullable<ActTraceRecord>
  /** 完整协议判定、解析结果或拒绝原因。 */
  readonly decision: Nullable<ActTraceRecord>
  /** 调度身份及对应源码、控制回执、结果、租约变化。 */
  readonly records: readonly ActTraceRecord[]
  /** 本回合响应派发的一次性执行，按声明顺序；租约带进本帧的旧结果不在这里。 */
  readonly executions: readonly ActExecutionSummary[]
  /** 本回合登记的观察与喂进这一回合请求的观察运行；观察运行的调用也在 invocations 里。 */
  readonly observation: ActObservationSummary
  /** 本回合执行里派发或续跑的子任务，按调用顺序。 */
  readonly agents: readonly ActAgentSummary[]
  /** Kernel 权威调用记录的有界 JSON；空数组不证明世界没有发生效果。 */
  readonly invocations: ReadonlyArray<{
    readonly id: string
    readonly executionId: string
    readonly chars: number
    readonly body: string
    readonly truncated: boolean
    readonly summary: ActInvocationSummary
  }>
  /** 同一 run 的下一请求，可继续查询其真实视图和差量。 */
  readonly nextTurnId: Nullable<string>
  /** 元数据快照版本；追踪期间执行可能仍在推进。 */
  readonly snapshotVersion: number
  readonly gaps: readonly string[]
}

/** 宿主分页读取某个根任务及其支线，正文预算为本页共用。 */
export interface ActTraceQuery {
  /** 省略时读取根会话；支线必须有该根的持久归属记录。 */
  readonly sessionId?: string
  /** 仅列出此记录序号之后的模型请求。 */
  readonly after?: number
  /** 一页最多请求数，默认 8，上限 32。 */
  readonly limit?: number
  /** 会话活动独立按 script:execution 起始记录序号分页，不依赖是否发出了模型请求。 */
  readonly activityAfter?: number
  /** 一页最多活动数，默认 8，上限 32；与模型请求分页共用正文预算。 */
  readonly activityLimit?: number
  /** 宿主调试展示完整正文；仍按 limit 分页，忽略 maxChars，完整保留文本，图片和字节数据使用占位。 */
  readonly fullContent?: boolean
  /** 一页正文字符上限，默认一百万，上限八百万。fullContent 为 true 时不使用。 */
  readonly maxChars?: number
}

/** 宿主实际开始的一次脚本阶段；原始失败与当前 Kernel 回执分别保留，不互相覆盖。 */
export interface ActSessionActivityEntry {
  readonly executionId: string
  readonly taskId: Nullable<string>
  readonly mode: Nullable<'execute' | 'observe'>
  readonly kind: 'snapshot-capture' | 'script-execution' | 'unknown'
  readonly startedSequence: number
  readonly startRef: { readonly sessionId: string; readonly id: string }
  readonly resultRef: Nullable<{ readonly sessionId: string; readonly id: string }>
  readonly records: readonly ActTraceRecord[]
  readonly invocations: ActTurnTrace['invocations']
  readonly gaps: readonly string[]
}

/** 会话活动不归入尚未发送的模型帧；旧页重读才能取得已开始活动的迟到回执。 */
export interface ActSessionActivityPage {
  readonly scope: 'session'
  readonly sessionId: string
  readonly entries: readonly ActSessionActivityEntry[]
  /** 下一页起始记录游标，与模型请求的 nextAfter 分开；无后续起始记录时为 null。 */
  readonly nextAfter: Nullable<number>
  /** 仅是 Context 目录快照版本；Kernel journal 逐执行读取，二者不是跨库原子快照。 */
  readonly snapshotVersion: Nullable<number>
}

/** 持久追踪可在支线关闭后读取，活动回合需重读以取得后续回执。 */
export interface ActTracePage {
  /** 宿主请求的根会话。 */
  readonly rootSessionId: string
  /** 本页实际读取的会话。 */
  readonly sessionId: string
  /** 根当前任务的已登记支线，用于后续按 sessionId 读取。 */
  readonly branches: readonly ModelToolBinding[]
  /** 按请求记录顺序返回。 */
  readonly turns: readonly ActTurnTrace[]
  /** 首请求前、请求间和无请求的真实执行阶段；独立游标，不增加模型回合数。 */
  readonly sessionActivity: ActSessionActivityPage
  /** 模型请求只统计本页；核查费用是指定会话快照的累计总账，同会话各页不可相加。 */
  readonly accounting: {
    /** 本页实际返回请求的用量覆盖数量。 */
    readonly modelRequests: {
      readonly known: number
      readonly unknown: number
      readonly inflight: number
    }
    /** 核查总账独立于请求窗口，包含首请求前、终态后及无模型请求的持久事实。 */
    readonly verificationScope: 'session'
    /** 同会话按 charge ID 去重；跨快照应取最新总账或继续按 ID 去重，未知保持未知。 */
    readonly verificationCost: ActVerificationCostSummary
  }
  /** 有后续请求时的分页游标，否则为 null。 */
  readonly nextAfter: Nullable<number>
  /** 读取开始时的会话快照代次。 */
  readonly snapshotVersion: Nullable<number>
}
