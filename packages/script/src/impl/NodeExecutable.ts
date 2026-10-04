import { resolveNodeExecutable } from '../utils/node-executable.js'

/** 宿主解析原生 Node 的统一入口。 */
export interface NodeExecutableApi {
  /** 使用当前 Node 或 PATH 中的 Node；Electron 必须由宿主提供随包执行文件。 */
  resolve(): Nullable<string>
}

class NodeExecutable implements NodeExecutableApi {
  public resolve(): Nullable<string> {
    return resolveNodeExecutable()
  }
}

/** 供命令宿主与直接进程驱动共用原生执行文件规则。 */
export const nodeExecutable: NodeExecutableApi = new NodeExecutable()
