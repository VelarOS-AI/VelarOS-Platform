// 用途：通过正式 Desktop Hook 与调试追踪入口驱动本机评测，保留任务身份和完整记录。
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'

import { connectDebugger, readDebuggerSnapshot } from './debugger.mjs'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export async function privateJson(path, value) {
  const temporary = path + '.' + randomUUID() + '.writing'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}

export async function desktopClient(endpointFile) {
  const endpoint = JSON.parse(await readFile(endpointFile, 'utf8'))
  const url = new URL(endpoint.url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:')
    throw new Error('Desktop endpoint must be a local HTTP endpoint')
  if (typeof endpoint.token !== 'string' || !endpoint.token) throw new Error('Missing Hook token')
  return async (command, timeoutMs = 45_000) => {
    const response = await fetch(new URL('/v1/hooks/commands', url), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'native-evaluation', ...command }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const result = await response.json()
    if (!response.ok || !result.ok)
      throw new Error('Hook ' + command.kind + ' failed: ' + JSON.stringify(result.error))
    return result.data
  }
}

/** 设置走产品控制面，密钥只用于配置写入，不进入回执与报告。 */
export async function configureModel(hook, settingsFile, { baseURL, apiKey, model }) {
  const current = JSON.parse(await readFile(settingsFile, 'utf8'))
  const provider = 'openai'
  const configs = current.system.providerRuntimeConfigs ?? []
  const selected = configs.find((item) => item.provider === provider) ?? { provider }
  const replacement = {
    ...selected,
    enabled: true,
    baseURL,
    apiKey,
    defaultModel: model,
    openaiExplicitCacheBreakpoints: false,
  }
  const providerRuntimeConfigs = [
    ...configs.filter((item) => item.provider !== provider),
    replacement,
  ]
  await hook({
    kind: 'config_op',
    key: 'system',
    op: 'patch',
    patch: {
      providerRuntimeConfigs,
      advancedRuntime: { workspaceSandboxEnabled: false, permissionConfirmationMode: 'never-ask' },
    },
  })
  const saved = JSON.parse(
    await readFile(settingsFile, 'utf8')
  ).system.providerRuntimeConfigs?.find((item) => item.provider === provider)
  if (
    saved?.apiKey !== apiKey ||
    saved?.baseURL !== baseURL ||
    saved?.openaiExplicitCacheBreakpoints !== false
  )
    throw new Error(
      'Desktop did not preserve the configured provider identity and cache capability'
    )
  return provider
}

/** 只恢复本次临时厂商配置；运行中用户自行改过的配置保持用户当前值。 */
export async function restoreModel(hook, settingsFile, priorConfigs, expectedKey) {
  const current = JSON.parse(await readFile(settingsFile, 'utf8'))
  const configs = current.system.providerRuntimeConfigs ?? []
  const selected = configs.find((item) => item.provider === 'openai')
  if (selected?.apiKey !== expectedKey) return 'user_configuration_preserved'
  const prior = priorConfigs.find((item) => item.provider === 'openai')
  await hook({
    kind: 'config_op',
    key: 'system',
    op: 'patch',
    patch: {
      providerRuntimeConfigs: [
        ...configs.filter((item) => item.provider !== 'openai'),
        ...(prior ? [prior] : []),
      ],
    },
  })
  return 'restored'
}

/** 控制器只读真实页面，调用与调试面板相同的 IPC，不构造另一套 Runtime。 */
export async function cdpClient(origin) {
  const wire = await connectDebugger(origin)
  return {
    close: () => wire.close(),
    async evaluate(expression) {
      return wire.evaluate(expression)
    },
    async trace(sessionId, branch) {
      const reader = await connectDebugger(origin)
      const key = '__nativeDebugSnapshot_' + randomUUID()
      const request = JSON.stringify({ sessionId, branch })
      const expression =
        '(async()=>{const r=await window.electron.ipcRenderer.invoke("chat:get-debug-trace",' +
        request +
        ');if(!r.ok)throw Error(r.error.message);const text=JSON.stringify(r.data);globalThis[' +
        JSON.stringify(key) +
        ']=text;const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));return {chars:text.length,sha256:[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,"0")).join("")}})()'
      try {
        return await readDebuggerSnapshot(reader, expression, key)
      } finally {
        reader.close()
      }
    },
    async selection() {
      return this.evaluate(
        '(async()=>{const {getChatState}=await import("/src/hooks/chat/runtime/models/chatStore.ts");const s=getChatState();return {activeFolderId:s.activeFolderId,folders:s.folders.map(f=>({id:f.id,memberSessionIds:f.memberSessionIds,activeMemberSessionId:f.activeMemberSessionId}))}})()'
      )
    },
    async deleteFixtures(fixtures) {
      for (const fixture of fixtures)
        if (
          !/^native_fixture_(?:A|B|cancel)_\d+$/.test(fixture.id) ||
          typeof fixture.root !== 'string'
        )
          throw new Error('Cleanup requires explicit owned fixture identities and roots')
      return this.evaluate(`(async()=>{
        const fixtures=${JSON.stringify(fixtures)};
        const {chatStore,getChatState,setChatState,bumpChatConversationVersion}=await import('/src/hooks/chat/runtime/models/chatStore.ts');
        const {isChatSessionBusy}=await import('/src/hooks/chat/runtime/models/chatRuntimeLifecycle.ts');
        const {chatSessionLifecycleOperations}=await import('/src/hooks/chat/runtime/models/chatSessionLifecycleOperations.ts');
        const {deletePersistedChatSession}=await import('/src/hooks/chat/runtime/ipc/chatSessionIpcEffects.ts');
        const {deleteFolderMemberFromChatState}=await import('/src/hooks/chat/state/session/chatSessionPersistence.ts');
        const {saveFolderRegistryToDiskSync}=await import('/src/hooks/chat/state/session/chatSessionDiskIO.ts');
        const {clearPersistedSessionWorkspace}=await import('/src/hooks/workspace/sessionWorkspacePersistence.ts');
        const {queuedComposerDraftStore}=await import('/src/hooks/chat/composer/QueuedComposerDraftStore.ts');
        if(!chatStore.getState().diskSessionHydrated)throw Error('Session restore is still running');
        const removed=[];
        const release=chatSessionLifecycleOperations.begin('native-fixture-cleanup','Another session lifecycle operation is running');
        try{
          for(const fixture of fixtures){
            const member=getChatState().sessions.find(x=>x.id===fixture.id);
            if(!member)continue;
            if(member.rootPath!==fixture.root || isChatSessionBusy(member))throw Error('Fixture ownership or idle state changed: '+fixture.id);
            await deletePersistedChatSession(member.id);
            const current=getChatState();
            const next=deleteFolderMemberFromChatState(current,member.id);
            saveFolderRegistryToDiskSync(next);
            setChatState(next);
            clearPersistedSessionWorkspace(member.id);
            queuedComposerDraftStore.discardScope(member.id);
            if(current.activeFolderId===member.folderId)bumpChatConversationVersion();
            removed.push(member.id);
          }
        }finally{release()}
        return {removed,remaining:getChatState().sessions.filter(x=>fixtures.some(f=>f.id===x.id)).map(x=>x.id)};
      })()`)
    },
    async capture(path) {
      const reader = await connectDebugger(origin)
      try {
        const result = await reader.call(
          'Page.captureScreenshot',
          { format: 'png', captureBeyondViewport: false },
          10000
        )
        await writeFile(path, Buffer.from(result.data, 'base64'), { mode: 0o600 })
      } finally {
        reader.close()
      }
    },
  }
}

export async function dispatch(
  hook,
  { sessionId, workspace, problem, model, activate = false, commandId = randomUUID() }
) {
  return hook({
    kind: 'send_task',
    id: commandId,
    sessionId,
    space: 'project',
    workspaceRoot: workspace,
    activate,
    message: problem,
    config: {
      provider: 'openai',
      model,
      reasoningLevel: 'high',
      requireExactModel: true,
      executionModes: [],
    },
  })
}

/** 每次等待短于一分钟；准入之后必须等真实空闲回执，等待超时不是完成。 */
export async function waitForSettlement(hook, sessionId, timeoutMs, onSample = () => {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await hook(
      {
        kind: 'wait_for_idle',
        sessionId,
        timeoutMs: Math.min(25_000, Math.max(1000, deadline - Date.now())),
        startupGraceMs: 0,
      },
      35_000
    )
    await onSample(status)
    if (status.hasPendingConfirmation || status.hasPendingInput)
      throw new Error('Unexpected interaction requires a human answer')
    if (!status.found) throw new Error('Desktop task session disappeared')
    if (['never-ran', 'unknown'].includes(status.settleReason))
      throw new Error('Desktop has no execution evidence for the admitted task')
    if (
      !status.running &&
      !status.pendingPrompt &&
      !status.queuedInputs &&
      !status.backgroundJobs &&
      !status.timedOut
    )
      return status
  }
  throw new Error('Desktop source deadline exceeded')
}
