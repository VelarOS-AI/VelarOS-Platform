/** 等宿主的时候随时能撒手：ask 可能要等对方跑好几分钟，模型的程序一取消就不再等。 */

/**
 * 等一件事做完；signal 先触发就不等了，以它的原因失败。
 * 被撒手的那件事之后再成功或失败都没人等了，它的拒绝已经在这里接住，不会变成没人处理的拒绝。
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abandon = (): void => reject(signal.reason)
    if (signal.aborted) abandon()
    else signal.addEventListener('abort', abandon, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', abandon)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abandon)
        reject(error)
      }
    )
  })
}
