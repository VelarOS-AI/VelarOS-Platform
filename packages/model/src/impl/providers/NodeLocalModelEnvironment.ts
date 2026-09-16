import { LocalModelEnvironment, type LocalModelEnvironmentApi } from './LocalModelEnvironment'

/**
 * Node 宿主的环境快照。
 *
 * 这是本包唯一读 `process.env` 的环境实现，只从 `/node` 与根入口的装配链出去；
 * 读到的值当场冻结成快照，之后进程里再改环境变量也不影响已经装好的运行时。
 */
export interface NodeLocalModelEnvironmentApi extends LocalModelEnvironmentApi {
  /** 构造时冻结下来的那份环境变量；provider 集合按它回落 API Key。 */
  readonly variables: Readonly<Record<string, string | undefined>>
}

export class NodeLocalModelEnvironment
  extends LocalModelEnvironment
  implements NodeLocalModelEnvironmentApi
{
  public readonly variables: Readonly<Record<string, string | undefined>>

  constructor(variables: Readonly<Record<string, string | undefined>> = process.env) {
    const snapshot = Object.freeze({ ...variables })
    super(snapshot)
    this.variables = snapshot
  }
}
