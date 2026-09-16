/**
 * 代码查询操作：`ProjectCodeOperations` 与整个进程唯一的 `projectCodeOperations`。接口 `ProjectCodeOperationsApi` 在本文件的类上方。
 * `project:code` 与 `project:code-analysis` 各调一个方法，主体在 utils/agent/code-query.ts；这里只套项目资源门的读门。
 */

import type { ProjectToolContext } from '../../contract/requires.js'
import type { ProjectCodeAnalysisInput, ProjectCodeInput } from '../../types/tools.js'
import { analyzeProjectCode, queryProjectCode } from '../../utils/agent/code-query.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'

/**
 * 代码查询操作：符号、引用候选、依赖、调用与类型关系、影响范围、诊断，以及可选的图分析。都经宿主的代码查询接口，结果带来源（哪个后端）和覆盖范围；
 * 能力或覆盖有限时在 degraded 里如实说明，不把文本命中伪装成精确结果。
 */
export interface ProjectCodeOperationsApi {
  /** project:code 的六类动作；在当前项目根的读门里执行。 */
  code(input: ProjectCodeInput, ctx: ProjectToolContext): Promise<Awaited<ReturnType<typeof queryProjectCode>>>
  /** project:code-analysis 的四类图分析；在读门里执行。 */
  codeAnalysis(input: ProjectCodeAnalysisInput, ctx: ProjectToolContext): Promise<Awaited<ReturnType<typeof analyzeProjectCode>>>
}

export class ProjectCodeOperations implements ProjectCodeOperationsApi {
  constructor(private readonly gate: ProjectExecutionGateApi) {}

  public code(input: ProjectCodeInput, ctx: ProjectToolContext) {
    return this.gate.run(ctx.project.getRootPath(), false, ctx.abortSignal, () => queryProjectCode(input, ctx))
  }

  public codeAnalysis(input: ProjectCodeAnalysisInput, ctx: ProjectToolContext) {
    return this.gate.run(ctx.project.getRootPath(), false, ctx.abortSignal, () => analyzeProjectCode(input, ctx))
  }
}

/** 整个进程唯一的代码查询操作；project:code 与 project:code-analysis 的 execute 交给它。 */
export const projectCodeOperations: ProjectCodeOperationsApi = new ProjectCodeOperations(projectExecutionGate)
