/**
 * 代码面 `code` 命名空间的两个操作：`ProjectCodeOperations` 与整个进程唯一的 `projectCodeOperations`。接口 `ProjectCodeOperationsApi` 在本文件的类上方。
 * 两个方法都只做三件事：进项目的读门、把 intent 翻译成宿主的代码查询（主体在 `utils/agent/code-query.ts`）、把结果装进带来源与覆盖范围的信封。
 */

import type { ProjectOperationContext } from '../../contract/requires.js'
import type { CodeAnalysisInput, CodeQueryInput, CodeResult } from '../../types/code.js'
import { codeAnalysisInput, codeQueryInput } from '../../utils/agent/code-input.js'
import { analyzeProjectCode, queryProjectCode } from '../../utils/agent/code-query.js'
import { projectFailure } from '../../utils/agent/ports.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'

/**
 * 代码理解：符号、引用候选、依赖、调用与类型关系、影响面、诊断，以及要图后端才答得了的四类分析。
 * 都经宿主的代码查询接口，结果带来源（哪个后端）与覆盖范围；能力或覆盖有限时在 `degraded` 里如实说明，不把文本命中伪装成精确结果。
 * 实现是 `ProjectCodeOperations`，整个进程只有一份（`projectCodeOperations`）。
 *
 * @AgentView
 * 问代码，而不是自己读文件猜：定义在哪、谁在用它、改了波及谁、这个文件报什么错。
 * 路径都相对项目根。结果里 `degraded` 不为空时只是候选——按名字找到的符号与引用不等于精确绑定，空诊断也不等于没问题。
 * 找文本用 `velaros:project` 的 search，读正文用它的 read；这里只回答「代码之间的关系」。
 */
export interface ProjectCodeOperationsApi {
  /**
   * @AgentView
   * 按一个 intent 问：outline / definition / references / callers / callees / imports / importers / impact / diagnostics。
   * 语言服务没装或这个文件它不认时，结果会降级成按名字找到的候选，`degraded` 里说清楚。
   * @OperationEffect none
   */
  query(input: CodeQueryInput, ctx: ProjectOperationContext): Promise<CodeResult>
  /**
   * @AgentView
   * 要代码图谱后端才答得了的四类：trace（两个符号之间的调用路径）、cycles（依赖环）、deadcode（没用到的代码候选）、routing（框架路由）。
   * 宿主没接图后端时整个调用失败，报 `UNAVAILABLE`——这时改用 query 的 references、impact 凑合看。
   * @OperationEffect none
   */
  analyze(input: CodeAnalysisInput, ctx: ProjectOperationContext): Promise<CodeResult>
}

export class ProjectCodeOperations implements ProjectCodeOperationsApi {
  constructor(private readonly gate: ProjectExecutionGateApi) {}

  public async query(input: CodeQueryInput, ctx: ProjectOperationContext): Promise<CodeResult> {
    try {
      const checked = codeQueryInput(input)
      return await this.gate.run(ctx.project.getRootPath(), false, ctx.abortSignal, () =>
        queryProjectCode(checked, ctx)
      )
    } catch (error) {
      throw projectFailure(error)
    }
  }

  public async analyze(
    input: CodeAnalysisInput,
    ctx: ProjectOperationContext
  ): Promise<CodeResult> {
    try {
      const checked = codeAnalysisInput(input)
      return await this.gate.run(ctx.project.getRootPath(), false, ctx.abortSignal, () =>
        analyzeProjectCode(checked, ctx)
      )
    } catch (error) {
      throw projectFailure(error)
    }
  }
}

/** 整个进程只有一份的代码理解操作；项目空间把它挂在代码面的 `code` 命名空间上。 */
export const projectCodeOperations: ProjectCodeOperationsApi = new ProjectCodeOperations(
  projectExecutionGate
)
