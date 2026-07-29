import { isEmpty } from '@velaros-ai/core'

import { id } from "../utils/id.js";

/** 覆盖事务将要修改的相对路径的内存锁。 */
export interface WorkspaceLock {
  lockId: string;
  owner: string;
  paths: string[];
  createdAt: number;
}

interface PendingWorkspaceLock {
  lock: WorkspaceLock;
  resolve: (lock: WorkspaceLock) => void;
}

/** 公平路径锁队列，用于串行化重叠写入和回滚。 */
export class LockManager {
  private readonly locks = new Map<string, WorkspaceLock>();
  private readonly queue: PendingWorkspaceLock[] = [];

  /** 为一组路径申请写锁；与已有锁重叠时会排队等待。 */
  public async lock(paths: string[], owner: string): Promise<WorkspaceLock> {
    const normalized = [...new Set(paths)].sort();
    const lock: WorkspaceLock = { lockId: id("lock"), owner, paths: normalized, createdAt: Date.now() };
    if (isEmpty(normalized)) return lock;

    return new Promise<WorkspaceLock>((resolve) => {
      this.queue.push({ lock, resolve });
      this.drainQueue();
    });
  }

  /** 释放指定锁，并尝试推进后续等待队列。 */
  public async unlock(lockId: string): Promise<void> {
    for (const [path, lock] of [...this.locks.entries()]) {
      if (lock.lockId === lockId) this.locks.delete(path);
    }
    this.drainQueue();
  }

  /** 判断指定路径当前是否被锁定。 */
  public isLocked(path: string): boolean {
    return this.locks.has(path);
  }

  /** 返回当前所有已锁定路径。 */
  public list(): string[] {
    return [...this.locks.keys()];
  }

  /** 返回等待队列中涉及的路径集合。 */
  public queued(): string[] {
    return [...new Set(this.queue.flatMap((entry) => entry.lock.paths))];
  }

  private drainQueue(): void {
    // 按队列顺序放行；授予锁后也允许后续不重叠请求继续推进。
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let index = 0; index < this.queue.length; index += 1) {
        const entry = this.queue[index];
        if (!this.canGrant(entry, index)) continue;

        this.queue.splice(index, 1);
        for (const path of entry.lock.paths) this.locks.set(path, entry.lock);
        entry.resolve(entry.lock);
        progressed = true;
        break;
      }
    }
  }

  private canGrant(entry: PendingWorkspaceLock, queueIndex: number): boolean {
    for (const path of entry.lock.paths) {
      if (this.locks.has(path)) return false;
    }

    for (let index = 0; index < queueIndex; index += 1) {
      // 前面排队的重叠请求即使尚未授锁，也保留优先级。
      if (hasPathOverlap(this.queue[index].lock.paths, entry.lock.paths)) return false;
    }

    return true;
  }
}

function hasPathOverlap(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((path) => rightSet.has(path));
}
