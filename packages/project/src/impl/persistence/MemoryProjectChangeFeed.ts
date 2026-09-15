/** 只在内存里的变更记录：`MemoryProjectChangeFeed`，内核没拿到宿主给的变更记录时用它，进程退出就没了。 */

import type { ProjectChangeFeedWriter } from '../../contract/requires.js'
import type { ProjectChangeRecord } from '../../types/change-feed.js'

import { BaseProjectChangeFeed } from './BaseProjectChangeFeed.js'

export class MemoryProjectChangeFeed extends BaseProjectChangeFeed implements ProjectChangeFeedWriter {
  protected persist(_change: ProjectChangeRecord): void {}
}
