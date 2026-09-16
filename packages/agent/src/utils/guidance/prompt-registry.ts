// PromptRegistry 用到的纯函数（不碰实例状态）。
import { AppError } from '@velaros-ai/core/error'

import type { PromptSegmentDefinition } from '../../types/guidance.js'

/**
 * Tier0 不许带激活谓词——注册面机械拦截，不靠「用 createCorePromptSegment 构造」这条约定。
 *
 * `createCorePromptSegment` 不暴露 `when` 只是把这件事做成了**工厂的**不变量：注册面收的是
 * 裸 `PromptSegmentDefinition`，`{ tier: 'core', when }` 在类型上完全可表达，任何绕过工厂的
 * 注册（宿主自己拼一份、mod 投影、provider 动态生成）都能把一个逐轮开关的段塞进稳定前缀。
 * 后果不是「多一段」而是**前缀缓存整体失效**——它后面的全部历史一起作废，且症状只表现为
 * 「有时候贵」，几乎没人会往提示词分层上想（§② 的历史病灶就是这么来的）。
 */
export function assertCorePromptSegmentHasNoPredicate(definition: PromptSegmentDefinition): void {
  if (definition.tier === 'core' && definition.when) {
    throw new AppError(
      'VALIDATION',
      `Tier0 段「${definition.id}」不许带激活谓词：core 段进稳定前缀且必须逐轮字节不变，按 facts 开关的内容请落 tier:'runtime'。`
    )
  }
}
