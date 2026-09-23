import type { CodeRunnerApi } from '../contract/requires.js'
import type { CodeRunDispatch, CodeRunOutcome, CodeRunRequest } from '../types/runner.js'

import { NodeScriptProcess } from './NodeScriptProcess.js'
import { createSubprocessCodeRunner } from './SubprocessCodeRunner.js'

/** Node 宿主使用同一共享运行器，仅提供子进程通信与回收。 */
class NodeSubprocessCodeRunner implements CodeRunnerApi {
  private readonly runner = createSubprocessCodeRunner({
    launch: (events) => new NodeScriptProcess(events),
  })

  public run(
    request: CodeRunRequest,
    dispatch: CodeRunDispatch,
    onLog: (line: string) => void,
    signal?: AbortSignal
  ): Promise<CodeRunOutcome> {
    return this.runner.run(request, dispatch, onLog, signal)
  }
}

/** Node 宿主的默认隔离运行器；部署认证由宿主完成。 */
export const nodeSubprocessCodeRunner: CodeRunnerApi = new NodeSubprocessCodeRunner()
/** 默认运行器不代表宿主已完成正式部署验收。 */
export const NodeSubprocessRunnerIsReleaseReady: false = false
