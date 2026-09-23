// 原始事件逐条追加；完整证据快照按时间合并，收尾必须在在途快照之后重新读取。
export function createEvidenceCheckpoints(
  write,
  { intervalMs = 2000, now = () => performance.now() } = {}
) {
  let pending = null,
    finalizing = null,
    lastSaved = -Infinity
  const stats = { writes: 0, coalesced: 0, skipped: 0, durationMs: 0 }
  const start = () => {
    const started = performance.now()
    const operation = Promise.resolve()
      .then(write)
      .then(() => {
        lastSaved = now()
        stats.writes++
      })
      .finally(() => {
        stats.durationMs += performance.now() - started
        if (pending === operation) pending = null
      })
    pending = operation
    return operation
  }
  return {
    stats,
    request() {
      if (finalizing || pending) {
        stats.coalesced++
        return finalizing ?? pending
      }
      if (now() - lastSaved < intervalMs) {
        stats.skipped++
        return Promise.resolve()
      }
      return start()
    },
    flush() {
      if (finalizing) return finalizing
      const prior = pending
      const operation = (async () => {
        let failure,
          failed = false
        try {
          await prior
        } catch (error) {
          failure = error
          failed = true
        }
        await start()
        if (failed) throw failure
      })().finally(() => {
        if (finalizing === operation) finalizing = null
      })
      finalizing = operation
      return operation
    },
  }
}
