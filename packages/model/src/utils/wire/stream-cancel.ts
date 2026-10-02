import { createAbortError } from '@velaros-ai/core/error'

/** 取消只等待当前已到达的结果；供应商不结束流时及时退出，并消费迟到的拒绝。 */
export async function awaitModelStreamValue<T>(
  pending: PromiseLike<T>,
  signal: AbortSignal
): Promise<T> {
  let cancel: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? createAbortError('模型响应已取消'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
