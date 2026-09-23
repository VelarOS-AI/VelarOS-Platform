/** 单次运行的事件展示状态；只反映已收到的事实，不授予执行或交互权限。 */
export interface ActRunPresentation {
  /** 最近收到的运行状态；收到第一个状态事件前为 idle。 */
  readonly status: string
  /** 按唯一 turnId 计数的回合序号。 */
  readonly turn: number
  /** 当前回合的持久请求身份。 */
  readonly turnId?: string
  /** 当前尚未接纳的正文预览。 */
  readonly preview: string
  /** 已通过协议接纳的正文，按回合身份去重。 */
  readonly messages: ReadonlyArray<{
    readonly turnId: string
    readonly text: string
    readonly ref: { readonly sessionId: string; readonly id: string }
  }>
  /** 协议拒绝和运行错误的展示记录；协议拒绝不等于运行失败。 */
  readonly errors: readonly string[]
  /** 最近一次 error 事件给出的运行失败原因。 */
  readonly failure?: string
  /** 已接纳且未消费的引导，以及明确保留的输入身份；按宿主关联身份去重。 */
  readonly queuedInputIds: readonly string[]
  /** input-retained 明确确认的保留身份；结束或断流不自行推断保留。 */
  readonly retainedInputIds: readonly string[]
}

/** 实时与持久事件共用的宿主展示；游标仅由持久事件推进。 */
export interface ActPresentation {
  /** 最后处理的持久事件序号。 */
  readonly cursor: number
  /** 按运行身份隔离的展示。 */
  readonly runs: Readonly<Record<string, ActRunPresentation>>
}
