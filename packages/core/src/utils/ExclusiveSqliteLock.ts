import { isNumber, isObject } from '../typeGuards'

/** 宿主提供的独立 SQLite 连接；必须以零等待打开，不能和业务事务共用。 */
export interface ExclusiveSqliteLockConnection {
  exec(sql: string): void
  close(): void
}

/** SQLite 排他事务的生命周期；宿主负责稳定的锁库路径，不能删除或替换锁库。 */
export interface ExclusiveSqliteLockApi {
  /** 重复获取保持当前所有权；忙锁返回 false，其余错误抛出。 */
  acquire(): boolean
  /** 幂等释放；关闭失败保留连接，调用方可以再次释放。 */
  release(): void
}

class ExclusiveSqliteLock implements ExclusiveSqliteLockApi {
  private connection?: ExclusiveSqliteLockConnection
  private acquired = false

  public constructor(private readonly openConnection: () => ExclusiveSqliteLockConnection) {}

  public acquire(): boolean {
    if (this.acquired) return true
    // 前一次初始化失败且关闭失败的连接，必须收尾后才能重试。
    this.release()
    try {
      this.connection = this.openConnection()
      this.connection.exec('PRAGMA journal_mode = DELETE')
      this.connection.exec('BEGIN EXCLUSIVE')
      this.acquired = true
      return true
    } catch (error) {
      try {
        this.release()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'SQLite lock acquisition and cleanup failed'
        )
      }
      const code = isObject(error) && 'code' in error ? error.code : undefined
      const errcode = isObject(error) && 'errcode' in error ? error.errcode : undefined
      const primaryCode = isNumber(errcode) ? errcode & 0xff : undefined
      if (
        code === 'SQLITE_BUSY' ||
        code === 'SQLITE_LOCKED' ||
        primaryCode === 5 ||
        primaryCode === 6
      )
        return false
      throw error
    }
  }

  public release(): void {
    this.connection?.close()
    this.connection = undefined
    this.acquired = false
  }
}

/** 创建由宿主 SQLite 驱动支持的进程互斥；不依赖 Electron 或原生驱动包。 */
export function createExclusiveSqliteLock(
  openConnection: () => ExclusiveSqliteLockConnection
): ExclusiveSqliteLockApi {
  return new ExclusiveSqliteLock(openConnection)
}
