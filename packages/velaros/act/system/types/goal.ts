/**
 * @AgentView
 * 目标状态：active 推进中、paused 暂停、complete 完成、blocked 受阻、cancelled 取消；removed 是用户删掉目标后留下的墓碑，模型不能设成它。
 */
export type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled' | 'removed'

/** @AgentView 当前会话的目标。revision 是版本号，改的时候作为 baseRevision 交回；删掉之后也不归零。createdAt、updatedAt 是毫秒时间戳。 */
export interface GoalState {
  /** 这一个目标的身份；建立新目标就换一个。 */
  readonly id: string
  readonly revision: number
  /** 用户要完成的事。 */
  readonly objective: string
  readonly status: GoalStatus
  /** 完成依据、受阻原因或最近的进展。 */
  readonly reason: string
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * @AgentView
 * 改目标：baseRevision 是刚读到的 revision，从未建立过时为 0。
 * objective 最多 8000 个字符，只在建立新目标时给（当前目标还在 active 或 paused 时不能换）；reason 最多 4000 个字符，status 为 complete 或 blocked 时必须写实际依据。
 */
export interface GoalUpdate {
  readonly baseRevision: number
  readonly objective?: string
  readonly status?: 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled'
  readonly reason?: string
}

/** 宿主专属的生命周期控制：用户在界面上暂停、恢复、结束或删除目标。 */
export interface GoalControl {
  /** 用户操作所针对的目标版本。 */
  readonly baseRevision: number
  /** 删除只产生墓碑，保留审计历史。 */
  readonly action: 'resume' | 'pause' | 'complete' | 'block' | 'cancel' | 'remove'
}
