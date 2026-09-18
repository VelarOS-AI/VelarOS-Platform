/**
 * 整类工具说明的结构化断言：写工具的一方把一个类别的工具交进来，有一条说明不是完全结构化就当场抛。
 * 说明的分节语法、渲染、解析与两道长度闸在 `utils/toolkit/tool-description.ts`。
 * 接口 `ToolDescriptionsApi` 在本文件的类上方；整个进程一份 `toolDescriptions`。
 */

import { AppError } from '@velaros-ai/core/error'

import type { ToolCategoryId } from '../../types/agent.js'
import type { ToolDescriptionLike } from '../../types/toolkit.js'
import { isStructuredToolDescription } from '../../utils/toolkit/tool-description'

/**
 * 工具说明的对外判定处，实例是 `toolDescriptions`。
 *
 * 模型面说明只认七节语法（描述 / 适合 / 禁止 / 强制流程 / 用法 / 示例 / 注意，`适合` 必填），
 * 这里只校验不改写：不替写工具的一方补结构，坏说明进不了工具集合。
 */
export interface ToolDescriptionsApi {
  /** 整类工具说明的结构化断言：有一个不是完全结构化就抛 VALIDATION（点名 `类别/工具`）；只 trim，不改写。 */
  forCategory<TTool extends ToolDescriptionLike, TMap extends Record<string, TTool>>(
    tools: TMap,
    categoryId: ToolCategoryId
  ): TMap
}

class ToolDescriptions implements ToolDescriptionsApi {
  public forCategory<TTool extends ToolDescriptionLike, TMap extends Record<string, TTool>>(
    tools: TMap,
    categoryId: ToolCategoryId
  ): TMap {
    return Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => {
        const description = tool.description.trim()
        if (!isStructuredToolDescription(description)) {
          throw new AppError(
            'VALIDATION',
            `工具 ${categoryId}/${name} 的描述不是完全结构化的：必须按「描述：」「适合：」「禁止：」这套分节语法写，分节之间用空行隔开。这里只校验不自动补结构。`
          )
        }

        return [
          name,
          {
            ...tool,
            description,
          },
        ]
      })
    ) as TMap
  }
}

/** 整个进程只有一份的工具说明判定处。 */
export const toolDescriptions: ToolDescriptionsApi = new ToolDescriptions()
