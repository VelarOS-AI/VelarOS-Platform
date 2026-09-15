/**
 * 文件上下文登记：`ProjectFileContext` 与整个进程唯一的 `projectFileContext`。接口 `ProjectFileContextApi` 在本文件的类上方。
 */

import { isNotUndefined } from '@velaros-ai/core'

import type { ProjectFileContextCarrier } from '../../types/agent.js'
import { registerProjectFileContext } from '../../utils/agent/file-context.js'

/**
 * 把当前项目登记成 agent 文件上下文的来源：模型读过、改过的源码进「当前项目文件」视图，会话重启后按登记的来源重新读取恢复。
 * 读取仍然经过项目的授权与脱敏。宿主在发送模型首轮之前调用一次；项目根换了要重新登记。
 */
export interface ProjectFileContextApi {
  /** 登记当前工具上下文里的项目；上下文没有文件上下文协调器时什么都不做，返回 false。 */
  register(context: ProjectFileContextCarrier): boolean
}

export class ProjectFileContext implements ProjectFileContextApi {
  public register(context: ProjectFileContextCarrier): boolean {
    return isNotUndefined(registerProjectFileContext(context))
  }
}

/** 整个进程唯一的文件上下文登记入口。 */
export const projectFileContext: ProjectFileContextApi = new ProjectFileContext()
