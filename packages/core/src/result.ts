/**
 * Result<T> — 函数式错误处理
 *
 * 主进程 IPC handler 统一返回 Result，不抛异常穿透边界。
 * 渲染层用 Result.unwrap() 或 Result.match() 消费。
 *
 * 使用方式：
 *   / 主进程
 *   return Result.ok(data)
 *   return Result.fail(new AppError('NETWORK', '超时'))
 *
 *   / 渲染层
 *   const result = await rendererIpc.someDomain.xxx()
 *   Result.match(result, { ok: (data) => ..., fail: (err) => ... })
 */

import { AppError, type SerializedError } from './error'

export type Result<T> = { ok: true; data: T } | { ok: false; error: SerializedError }

export const Result = {
  ok<T>(data: T): Result<T> {
    return { ok: true, data }
  },

  fail<T>(err: unknown): Result<T> {
    const appErr = AppError.from(err)
    return { ok: false, error: appErr.toJSON() }
  },

  /** 成功时取值，失败时抛出 AppError */
  unwrap<T>(result: Result<T>): T {
    if (result.ok) return result.data
    throw AppError.fromJSON(result.error)
  },

  /** 分支处理，两个分支都必须有返回值 */
  match<T, U>(result: Result<T>, handlers: { ok: (data: T) => U; fail: (err: AppError) => U }): U {
    if (result.ok) return handlers.ok(result.data)
    return handlers.fail(AppError.fromJSON(result.error))
  },

  /** 包裹 async 函数，自动捕获异常转为 Result */
  async wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
    try {
      return Result.ok(await fn())
    } catch (err) {
      return Result.fail(err)
    }
  },

  /** 同步版本，供 sendSync / beforeunload 等必须阻塞完成的路径使用。 */
  wrapSync<T>(fn: () => T): Result<T> {
    try {
      return Result.ok(fn())
    } catch (err) {
      return Result.fail(err)
    }
  },
}
