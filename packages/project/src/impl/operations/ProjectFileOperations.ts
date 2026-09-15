/**
 * 三个只读操作：`ProjectFileOperations` 与整个进程唯一的 `projectFileOperations`。接口 `ProjectFileOperationsApi` 在本文件的类上方。
 * `project:read`、`project:list`、`project:search` 各调一个方法；主体在 utils/agent/project-files.ts，这里只套项目资源门（读取之间共享，与写入互斥）。
 */

import type { ProjectToolContext } from '../../contract/requires.js'
import type { ProjectListInput, ProjectReadInput, ProjectSearchInput } from '../../types/tools.js'
import { listProjectEntries, readProjectSource, searchProjectSource } from '../../utils/agent/project-files.js'

import type { ProjectExecutionGateApi } from './ProjectExecutionGate.js'
import { projectExecutionGate } from './ProjectExecutionGate.js'

/**
 * 三个只读操作：读源码、列文件、搜源码。都在当前项目根的读门里执行，和同一进程里别的读取并行、和写入互斥；读到的内容登记进当前文件视图，编辑时凭 fileRef 定位。
 */
export interface ProjectFileOperationsApi {
  /**
   * 读项目文件：path（可带行范围）、files（每项各自的范围）、continuation 三选一，maxChars 是这次调用共用的字符预算。
   * 返回每个文件的源码窗口；批量里单个文件读不了只进 issues，只读一个文件时直接抛。
   */
  read(input: ProjectReadInput, ctx: ProjectToolContext): Promise<Awaited<ReturnType<typeof readProjectSource>>>
  /** 列项目文件和目录：按 path、glob、深度扫描并分页；续页只传 cursor，目录变了就让调用方重新列。 */
  list(input: ProjectListInput, ctx: ProjectToolContext): Promise<Awaited<ReturnType<typeof listProjectEntries>>>
  /** 搜项目源码：字面文本或正则，命中合成可编辑的源码窗口（有总量上限，装不下的只留定位，要编辑先 read）。 */
  search(input: ProjectSearchInput, ctx: ProjectToolContext): Promise<Awaited<ReturnType<typeof searchProjectSource>>>
}

export class ProjectFileOperations implements ProjectFileOperationsApi {
  constructor(private readonly gate: ProjectExecutionGateApi) {}

  public read(input: ProjectReadInput, ctx: ProjectToolContext) {
    return this.gate.run(ctx.project.getRootPath(), false, ctx.abortSignal, () => readProjectSource(input, ctx))
  }

  public list(input: ProjectListInput, ctx: ProjectToolContext) {
    return this.gate.run(ctx.project.getRootPath(), false, ctx.abortSignal, () => listProjectEntries(input, ctx))
  }

  public search(input: ProjectSearchInput, ctx: ProjectToolContext) {
    return this.gate.run(ctx.project.getRootPath(), false, ctx.abortSignal, () => searchProjectSource(input, ctx))
  }
}

/** 整个进程唯一的只读操作；三个只读工具的 execute 交给它。 */
export const projectFileOperations: ProjectFileOperationsApi = new ProjectFileOperations(projectExecutionGate)
