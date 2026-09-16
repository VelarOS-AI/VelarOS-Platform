import { AgentErrorCodes } from '../../contract/constants.js'

export class KernelSessionRunInterruptedError extends Error {
  public readonly code = AgentErrorCodes.sessionRunInterrupted

  public constructor() {
    super('内核会话运行在取得会话所有权之前就被中断，本次运行未开始执行，也没有留下任何执行记录。')
    this.name = 'KernelSessionRunInterruptedError'
  }
}
