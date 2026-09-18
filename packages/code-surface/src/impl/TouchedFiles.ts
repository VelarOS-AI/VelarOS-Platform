/**
 * 一步里经能力改过的本机文件：`TouchedFiles`，接口 `TouchedFilesApi` 在本文件的类上方；没有工作区标记的空间（系统空间）每一步建一个。
 *
 * 能力在动手之前报出要改的文件（`touching`），这里记下每个文件改前的内容哈希；这一步跑完再算一次改后的，两边不一样的就是这一步改了的。
 * 只有哈希，不存内容；同一个文件报几次只记第一次（改前就是这一步开始之前的样子）。
 */

import { isUndefined } from '@velaros-ai/core'

import type { CodeCallFileWatch } from '../contract/requires.js'
import type { ScriptFileChange } from '../types/code-surface.js'
import { hashPath } from '../utils/markers.js'

/** 一步里经能力改过的文件：接能力报来的路径，跑完交出改了哪些。 */
export interface TouchedFilesApi extends CodeCallFileWatch {
  /** 报过的文件里，改前改后内容不一样的那些（绝对路径、前后哈希），按路径排。 */
  changes(): Promise<ScriptFileChange[]>
}

export class TouchedFiles implements TouchedFilesApi {
  /** 报过的文件 → 改前的内容哈希（不存在时是 undefined）。 */
  private readonly before = new Map<string, Optional<string>>()

  public async touching(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      if (!this.before.has(path)) this.before.set(path, await hashPath(path))
    }
  }

  public async changes(): Promise<ScriptFileChange[]> {
    const changes: ScriptFileChange[] = []
    for (const [path, before] of this.before) {
      const after = await hashPath(path)
      if (before === after) continue
      const change: ScriptFileChange = { path }
      if (!isUndefined(before)) change.before = before
      if (!isUndefined(after)) change.after = after
      changes.push(change)
    }
    return changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  }
}
