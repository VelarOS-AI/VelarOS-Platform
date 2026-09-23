import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ContextRecord, ContextStorage } from '@velaros-ai/context'
import { isEmpty, isObject, isUndefined, toNullable } from '@velaros-ai/core'

/** 会话范围绑定只通过已有 ContextStorage 的原子提交维护。 */
export interface RuntimeWorkspaceBindingApi {
  /** 首次固定已解析的工作区，重开与并发打开必须匹配同一绑定。 */
  bind(sessionId: string): Promise<void>
}

/** 固定会话的资源身份；能力开关可以变化，历史不能换到另一工作区执行。 */
export class RuntimeWorkspaceBinding implements RuntimeWorkspaceBindingApi {
  public constructor(
    private readonly storage: ContextStorage,
    private readonly workspace: Optional<string>,
    private readonly dataDir: Optional<string>
  ) {}
  public async bind(sessionId: string): Promise<void> {
    // 兼容先前宿主在状态目录写下的绑定；读取失败或损坏不能解释为未绑定。
    if (this.dataDir) {
      let legacy: Optional<string>
      try {
        legacy = await readFile(join(this.dataDir, 'workspace.json'), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (!isUndefined(legacy)) {
        const binding: unknown = JSON.parse(legacy)
        if (
          !isObject(binding) ||
          !('workspace' in binding) ||
          binding.workspace !== (this.workspace ?? '')
        )
          throw Object.assign(
            new Error('会话工作区已经变化或旧绑定损坏，请为新的工作区建立会话。'),
            { code: 'WORKSPACE_BINDING_MISMATCH' }
          )
      }
    }
    const body = JSON.stringify({ version: 1, workspace: toNullable(this.workspace) })
    let objectId: Optional<string>
    for (;;) {
      const state = (await this.storage.load(sessionId)) ?? {
        version: 0,
        records: [],
        workingSet: { revision: 0, cursor: 0, items: [] },
      }
      const records = state.records.filter((record) => record.title === 'runtime:workspace')
      if (!isEmpty(records)) {
        if (
          records.length !== 1 ||
          (await this.storage.get(sessionId, records[0]!.objectId)) !== body
        )
          throw Object.assign(new Error('会话工作区已经变化或绑定损坏，请为新的工作区建立会话。'), {
            code: 'WORKSPACE_BINDING_MISMATCH',
          })
        return
      }
      objectId ??= await this.storage.put(sessionId, body)
      const record: ContextRecord = {
        ref: { sessionId, id: crypto.randomUUID() },
        sequence: state.records.length + 1,
        kind: 'audit',
        title: 'runtime:workspace',
        objectId,
        chars: body.length,
        sources: [],
        createdAt: new Date().toISOString(),
      }
      if (
        await this.storage.compareAndSwap(sessionId, state.version, {
          ...state,
          version: state.version + 1,
          records: [...state.records, record],
        })
      )
        return
    }
  }
}
