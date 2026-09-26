declare module 'velaros:system-goal' {
  /**
   * 会话目标：只在用户要求持续推进一件事时建立，objective 写用户授权的具体工作。
   * 目标跨回合保留：结束一轮回复、停止执行都不会完成它；暂停只在用户要求时做，完成或受阻要有实际验收依据。
   */

  /** 读当前目标：从未建立过时是 null，用户删掉的目标以 removed 状态的墓碑返回。
   */
  export function get(): Promise<GoalState | null>

  /** 建立、暂停、恢复或结束目标；先 get 拿到 revision，版本变了就重新读取再改。
   */
  export function update(input: GoalUpdate): Promise<GoalState>

  /** 当前会话的目标。revision 是版本号，改的时候作为 baseRevision 交回；删掉之后也不归零。createdAt、updatedAt 是毫秒时间戳。 */
  interface GoalState {
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
   * 改目标：baseRevision 是刚读到的 revision，从未建立过时为 0。
   * objective 最多 8000 个字符，只在建立新目标时给（当前目标还在 active 或 paused 时不能换）；reason 最多 4000 个字符，status 为 complete 或 blocked 时必须写实际依据。
   */
  interface GoalUpdate {
    readonly baseRevision: number
    readonly objective?: string
    readonly status?: 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled'
    readonly reason?: string
  }

  /**
   * 目标状态：active 推进中、paused 暂停、complete 完成、blocked 受阻、cancelled 取消；removed 是用户删掉目标后留下的墓碑，模型不能设成它。
   */
  type GoalStatus = 'active' | 'paused' | 'complete' | 'blocked' | 'cancelled' | 'removed'
}
