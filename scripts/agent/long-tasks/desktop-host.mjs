// 用途：将冻结长任务交给真实 Desktop 项目会话，并从正式 IPC 保存完整主线与支线轨迹。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  cdpClient,
  configureModel,
  desktopClient,
  privateJson,
  restoreModel,
  waitForSettlement,
} from '../native-desktop/client.mjs'
import { scriptMetrics } from '../native-desktop/controller.mjs'

export async function runDesktopTask({
  manifest,
  workspace,
  output,
  apiKey,
  baseURL,
  signal,
  prompt,
}) {
  const configuration = manifest.desktop
  const hook = await desktopClient(configuration.endpointFile)
  const cdp = await cdpClient(configuration.cdp)
  const prior = JSON.parse(await readFile(configuration.settingsFile, 'utf8'))
  const sessionId = manifest.scriptactSessionId
  const pages = []
  let admission, terminal, failure, metrics, abortFailure
  let cancelled = false
  const evidenceErrors = []
  let abortPromise
  const abort = () => {
    abortPromise ??= hook({ kind: 'abort_session', sessionId }).catch((error) => {
      abortFailure = String(error)
    })
  }
  try {
    signal.throwIfAborted()
    await configureModel(hook, configuration.settingsFile, {
      baseURL,
      apiKey,
      model: manifest.model,
    })
    await hook({
      kind: 'config_op',
      key: 'system',
      op: 'patch',
      patch: {
        memory: { enabled: false },
        advancedRuntime: { toolProtocol: 'tools' },
      },
    })
    signal.addEventListener('abort', abort, { once: true })
    signal.throwIfAborted()
    admission = await hook({
      kind: 'send_task',
      id: manifest.attemptId + '-desktop-source',
      sessionId,
      space: 'project',
      workspaceRoot: workspace,
      activate: false,
      message: prompt,
      config: {
        provider: 'openai',
        model: manifest.model,
        reasoningLevel: 'high',
        requireExactModel: true,
        executionModes: manifest.scriptactTaskMode === 'goal' ? ['goal'] : [],
      },
    })
    await privateJson(join(output, 'admission.json'), admission)
    if (signal.aborted) abort()
    terminal = await waitForSettlement(hook, sessionId, manifest.timeoutMs, async (status) => {
      await privateJson(join(output, 'desktop-status.json'), status)
    })
    cancelled = signal.aborted
  } catch (error) {
    failure = String(error)
    cancelled = signal.aborted
    if (admission) {
      abort()
      await abortPromise
      terminal = await waitForSettlement(hook, sessionId, 35000).catch((error) => {
        abortFailure = String(error)
        return null
      })
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await abortPromise
    try {
      const queue = [undefined],
        seen = new Set()
      while (queue.length) {
        const branch = queue.shift(),
          id = branch ?? sessionId
        if (seen.has(id)) continue
        seen.add(id)
        const page = await cdp.trace(sessionId, branch)
        await privateJson(join(output, `trace-${pages.length}.json`), page)
        pages.push(page)
        for (const child of page.branches)
          if (child.sessionId !== sessionId) queue.push(child.sessionId)
      }
    } catch (error) {
      evidenceErrors.push('trace: ' + String(error))
    } finally {
      metrics = scriptMetrics(pages)
      metrics.fullTrace &&=
        pages.length > 0 && metrics.modelTurns > 0 && evidenceErrors.length === 0
      await privateJson(join(output, 'desktop-trace-summary.json'), metrics)
      for (const [name, kind] of [
        ['transcript', 'get_transcript'],
        ['runtime', 'get_runtime_status'],
        ['debug', 'get_debug'],
      ]) {
        try {
          await privateJson(join(output, `desktop-${name}.json`), await hook({ kind, sessionId }))
        } catch (error) {
          evidenceErrors.push(name + ': ' + String(error))
        }
      }
      await privateJson(join(output, 'desktop-evidence-errors.json'), evidenceErrors)
      cdp.close()
      await restoreModel(
        hook,
        configuration.settingsFile,
        prior.system.providerRuntimeConfigs ?? [],
        apiKey
      )
    }
  }
  assert(!abortFailure, 'Desktop execution could not be settled: ' + abortFailure)
  // 空闲回执只证明执行收尾；正确性由独立评分给出，不伪造产品没有返回的终态字段。
  return {
    host: 'desktop',
    status: cancelled ? 'cancelled' : failure ? 'failed' : 'settled',
    failure: failure ?? (cancelled ? String(signal.reason) : null),
    admission,
    terminal,
    sessionId,
    metrics,
    modelTurnCount: metrics.modelTurns,
    evidenceComplete: metrics.fullTrace && evidenceErrors.length === 0,
    evidenceErrors,
  }
}
