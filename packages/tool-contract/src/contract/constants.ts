/**
 * 常量表：工具契约对外约定的那几样——canonical 工具 id 的写法、失败回执的三种结论与列表上限、
 * 各空间工具说明共用的约束句。不 import 任何东西，浏览器和渲染进程都能用
 * （从 `@velaros-ai/tool-contract/contracts` 取）。
 */

/**
 * canonical 工具 id 的正则源文本：形如 `namespace:tool`，两段都必须以小写字母开头，
 * 命名空间段只允许小写字母、数字、`.`、`-`，工具段只允许小写字母、数字、`_`、`-`。
 * 模型、清单、传输三方靠它对齐同一套工具身份。
 */
export const CanonicalToolIdPatternSource = '^[a-z][a-z0-9.-]*:[a-z][a-z0-9_-]*$' as const

/**
 * 一个空间的领域错误镜像进 `AppError.context` 的键名。
 *
 * 跨内核与 IPC 一趟 `toJSON` → `fromJSON` 会丢掉 cause（context 不丢），镜像就是那时唯一还在的
 * 结构化诊断来源。各空间在挂进内核的错误翻译里写这一格，Agent 的失败提取端按这一格回退读取，
 * 两边都不认识对方的名字。
 */
export const ToolDomainErrorContextKey = 'toolDomainError' as const

/** 工具失败回执的上限：各空间的失败清单都按它截，不再各抄一个数。 */
export const ToolFailureLimits = Object.freeze({
  /** 失败回执里每个列表最多列几项：问题清单、冲突清单、多处匹配的锚点都按它截。 */
  listItems: 10,
})

/**
 * 工具失败回执的三种结论：改动一个字节都没落地、这一步整步跳过、做到一半才失败。
 * 外面按它判断能不能原样重试，不按失败文字猜。
 */
export const ToolExecutionOutcomes = Object.freeze({
  /** 什么都没写，入参可以原样复用后重发。 */
  notApplied: 'not-applied',
  /** 这一步按策略整步跳过，没有产生任何副作用。 */
  skipped: 'skipped',
  /** 做了一部分才失败，已经落地的部分在 `applied` 里点名。 */
  failed: 'failed',
})

/**
 * 各空间工具说明共用的约束句（概念 id → 写给模型看的中文约束）。
 * 同一条规则只写一遍，工具说明引这里的句子，不各自另写一版措辞。
 */
export const GlobalToolConcepts = Object.freeze({
  boundedRead: '读取必须有界：提供范围、字节数、字符数上限，或显式选择无界读取。',
  pathSafety: '路径必须在已授权的资源根或宿主允许的文件系统边界内。',
  approvalRequired: '高风险或有副作用操作必须经过运行时审批策略。',
  destructiveAction: '删除、覆盖、执行命令或控制输入前必须确认作用范围。',
  artifactOutput: '产物应返回可追踪路径、格式和生成状态。',
  pagination: '列表型结果必须提供数量上限或分页参数。',
  schemaBoundExamples: '示例必须是可被工具 schema 解析的参数对象。',
})

/** 工具失败回执的结论取值，由 `ToolExecutionOutcomes` 派生。 */
export type ToolExecutionOutcome = (typeof ToolExecutionOutcomes)[keyof typeof ToolExecutionOutcomes]
