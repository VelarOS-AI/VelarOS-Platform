/** 浏览器级 CDP 连接里用不着实例状态的那部分：Target 域回包的归一。 */

import { isArray, isNonBlankString, isPlainObject, isString } from '@velaros-ai/core'

import type { CdpPageTarget, CdpTargetInfoEntry } from '../../types/cdp.js'

/** 把 Target.getTargets 的 targetInfos 归一成标签页表：只要 type 为 page、带 targetId 的；给了 browserContextId 就只要这个上下文里的。 */
export function normalizePageTargets(
  targetInfos: unknown,
  browserContextId?: LooseOptional<string>
): CdpPageTarget[] {
  if (!isArray(targetInfos)) return []

  const pages: CdpPageTarget[] = []
  for (const entry of targetInfos) {
    if (!isPlainObject(entry)) continue
    const target = entry as CdpTargetInfoEntry
    if (target.type !== 'page' || !isNonBlankString(target.targetId)) continue
    const contextId = isString(target.browserContextId) ? target.browserContextId : ''
    if (browserContextId && contextId !== browserContextId) continue
    pages.push({
      targetId: target.targetId,
      url: isString(target.url) ? target.url : '',
      title: isString(target.title) ? target.title : '',
      browserContextId: contextId,
    })
  }
  return pages
}
