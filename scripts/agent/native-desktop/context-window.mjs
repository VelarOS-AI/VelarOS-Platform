// 用途：从冻结的实际 Agent 产物取得工作窗口，配对按相同整理阈值运行并核对真实帧。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export function pairedInputWindow(contextTokens, policyTokens) {
  if (
    !Number.isSafeInteger(contextTokens) ||
    contextTokens <= 12000 + 4096 ||
    !Number.isSafeInteger(policyTokens) ||
    policyTokens < 1024
  )
    throw new Error('Invalid native context window policy')
  const window = Math.min(contextTokens - 12000 - 4096, policyTokens)
  if (window < 1024) throw new Error('Invalid native context window policy')
  return window
}

/** 多份装配产物必须采用同一策略；不从已过期的模板或模型总容量猜工作窗口。 */
export async function nativeContextPolicy(candidate, contextTokens) {
  const sources = candidate.files.filter((file) =>
    file.path.endsWith('/agent/dist/utils/tuning.js')
  )
  if (!sources.length) throw new Error('Frozen Agent context policy is missing')
  const windows = []
  for (const source of sources) {
    const hash = createHash('sha256')
      .update(await readFile(source.path))
      .digest('hex')
    if (hash !== source.sha256) throw new Error('Frozen Agent context policy changed')
    const url = pathToFileURL(source.path)
    url.searchParams.set('sha256', hash)
    const { ContextPlanTuning } = await import(url.href)
    pairedInputWindow(contextTokens, ContextPlanTuning?.windowTokens)
    windows.push(ContextPlanTuning.windowTokens)
  }
  if (new Set(windows).size !== 1) throw new Error('Frozen Agent context policies disagree')
  return {
    policyWindowTokens: windows[0],
    inputWindowTokens: pairedInputWindow(contextTokens, windows[0]),
    sources: sources.map(({ path, sha256 }) => ({ path, sha256 })),
  }
}

/** 只读宿主帧末的容量报告；工具、源码或用户材料中的类似文本不能充当实际上限。 */
export function observedInputWindows(pages) {
  const windows = new Set()
  const seen = new Set()
  for (const page of pages)
    for (const turn of page.turns) {
      if (seen.has(turn.turnId)) continue
      seen.add(turn.turnId)
      try {
        const messages = JSON.parse(turn.detail.messages)
        const frame = messages.at(-1)
        if (
          frame?.role !== 'user' ||
          typeof frame.content !== 'string' ||
          !frame.content.startsWith('Runtime 本帧工作内存（origin=runtime-view）')
        )
          return []
        const status = JSON.parse(frame.content.split('\n').at(-1))
        if (
          status.mode !== 'partitioned' ||
          !status.frameId ||
          !Number.isSafeInteger(status.inputLimit) ||
          status.inputLimit < 1024
        )
          return []
        windows.add(status.inputLimit)
      } catch {
        return []
      }
    }
  return [...windows].sort((a, b) => a - b)
}
