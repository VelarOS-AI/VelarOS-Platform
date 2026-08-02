// 域：进程内路径写锁——串行化「路径集合重叠」的事务写入与回滚。
//
// ## 并发模型与不变量（改这里会破什么）
//  - **锁是进程内的，粒度是相对路径**：它防的是同一个 Project 内核上并发跑的两个事务互相
//    覆盖；**不防**外部编辑器/其它进程——那一层由 base revision 检查兜。指望它做跨进程互斥会
//    得到一个假的安全感。
//  - **公平（FIFO），不是抢占**：`canGrant` 除了看路径是否已被占，还要看**排在自己前面的等待者
//    有没有路径重叠**。少了这一步，一个反复申请小路径集的事务能无限插队，让改大范围的事务饿死。
//  - **`drainQueue` 一轮里授一个就重扫**：授锁会改变后续项的可授状态（前驱出队后原本被前驱
//    挡住的项可能变得可授），所以是 `while(progressed)` 而不是一次线性扫。
//  - **空路径集直接返回一个未登记的锁**：它不进 `locks`，`unlock` 对它是 no-op。这样调用方
//    （applyEdit/rollback）不必为"事务没改任何文件"写分支。
//  - **没有超时**：`lock()` 的 Promise 只在被授予时 resolve。调用方**必须** try/finally 解锁，
//    否则同路径的后续事务永久挂起。刻意不加超时——超时释放意味着两个事务同时写同一文件，
//    那是比挂起更坏的失败方向（静默数据损坏 vs 可观测的卡住）。
import { isEmpty } from '@velaros-ai/core'

import { id } from "../utils/id.js";

/** 覆盖事务将要修改的相对路径的内存锁。 */
export interface ProjectLock {
  lockId: string;
  owner: string;
  paths: string[];
  createdAt: number;
}

interface PendingProjectLock {
  lock: ProjectLock;
  resolve: (lock: ProjectLock) => void;
}

/** 公平路径锁队列，用于串行化重叠写入和回滚。 */
export class LockManager {
  private readonly locks = new Map<string, ProjectLock>();
  private readonly queue: PendingProjectLock[] = [];

  /** 为一组路径申请写锁；与已有锁重叠时会排队等待。 */
  public async lock(paths: string[], owner: string): Promise<ProjectLock> {
    const normalized = [...new Set(paths)].sort();
    const lock: ProjectLock = { lockId: id("lock"), owner, paths: normalized, createdAt: Date.now() };
    if (isEmpty(normalized)) return lock;

    return new Promise<ProjectLock>((resolve) => {
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

  private canGrant(entry: PendingProjectLock, queueIndex: number): boolean {
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
