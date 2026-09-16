import { AppError } from '@velaros-ai/core'
import type { ProjectToolContext } from '@velaros-ai/project'
import type { ProjectCodeQuery as ProjectCodeQueryInput } from '@velaros-ai/project/contracts'

import { CodeQuerySources } from '../contract/constants.js'
import type { ProjectCodeIndexApi } from '../contract/requires.js'
import { isProjectCodeLanguageQuery, withCodeQuerySource } from '../utils/language-queries.js'

import { languageQueries } from './LanguageQueries.js'

/**
 * project 注入面里 `queryCode` 的实现：把一次代码查询分给内置语言服务或宿主的代码图谱。
 *
 * 实例由 `createProjectCodeQuery` 按宿主给的图谱后端各造一份，所以这里不给单例。
 */
export interface ProjectCodeQueryApi {
  /**
   * 跑一次代码查询。
   *
   * 语言服务类的七个动作交给内置语言服务；其余（代码图谱类）交给宿主后端，后端不可用时抛
   * code 为 `UNAVAILABLE` 的错误——project 据此把它写成降级说明，而不是当成查询失败。
   */
  run(input: ProjectCodeQueryInput, context: ProjectToolContext): Promise<unknown>
}

/** 代码查询的两路分派，见接口说明。 */
class ProjectCodeQuery implements ProjectCodeQueryApi {
  public constructor(private readonly codeIndex: ProjectCodeIndexApi) {}

  public async run(input: ProjectCodeQueryInput, context: ProjectToolContext): Promise<unknown> {
    if (isProjectCodeLanguageQuery(input)) return languageQueries.run(input, context)
    if (!this.codeIndex.isAvailable()) {
      throw new AppError(
        'UNAVAILABLE',
        '此代码图谱查询需要安装并启用 CodeGraph；内置符号、引用和诊断 action 仍可使用。'
      )
    }
    const result = await this.codeIndex.query(input, context)
    return withCodeQuerySource(CodeQuerySources.codeGraph, result)
  }
}

/**
 * 造一份 project 注入面要的 `queryCode`：语言服务类动作走内置实现，代码图谱类动作交给宿主后端。
 *
 * 返回的是函数而不是对象，宿主照旧把它直接塞进 `ProjectToolApi.queryCode`。
 */
export function createProjectCodeQuery(
  codeIndex: ProjectCodeIndexApi
): (input: ProjectCodeQueryInput, context: ProjectToolContext) => Promise<unknown> {
  const query = new ProjectCodeQuery(codeIndex)
  return (input, context) => query.run(input, context)
}
