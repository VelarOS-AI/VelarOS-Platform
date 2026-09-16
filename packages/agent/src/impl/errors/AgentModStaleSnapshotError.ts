import { AgentErrorCodes } from '../../contract/constants.js'

/** 快照失效（generation 已推进）；stale-reject 走它，绝不静默回退到旧值。 */
class AgentModStaleSnapshotError extends Error {
  public readonly code = AgentErrorCodes.modStaleSnapshot

  constructor(
    public readonly snapshotGeneration: number,
    public readonly currentGeneration: number
  ) {
    super(
      `Agent mod 注册表快照已失效：快照 generation=${snapshotGeneration}，当前 generation=${currentGeneration}。`
    )
    this.name = 'AgentModStaleSnapshotError'
  }
}

export { AgentModStaleSnapshotError }
