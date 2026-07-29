import { toErrorObject } from "./errors.js";

/** 轻量结果封装，适合偏好返回错误数据而不是抛异常的调用方。 */
export type WorkspaceResult<T> =
  | { ok: true; data: T; meta?: Record<string, any> }
  | { ok: false; error: ReturnType<typeof toErrorObject>; meta?: Record<string, any> };

/** 执行回调，并把任意抛出的值转成 WorkspaceResult 错误。 */
export async function asWorkspaceResult<T>(fn: () => Promise<T> | T, meta?: Record<string, any>): Promise<WorkspaceResult<T>> {
  try {
    return { ok: true, data: await fn(), meta };
  } catch (error) {
    return { ok: false, error: toErrorObject(error), meta };
  }
}
