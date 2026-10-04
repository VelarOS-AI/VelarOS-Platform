import type { ContextRecord, ContextStorage } from '@velaros-ai/context'
import { createContextReference } from '@velaros-ai/context'
import { isEmpty, toNullable } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

/** 会话范围绑定只通过已有 ContextStorage 的原子提交维护。 */
export interface RuntimeWorkspaceBindingApi {
  /** 首次固定已解析的工作区，重开与并发打开必须匹配同一绑定。 */
  bind(sessionId: string): Promise<void>
}

/** 固定会话的资源身份；能力开关可以变化，历史不能换到另一工作区执行。 */
export class RuntimeWorkspaceBinding implements RuntimeWorkspaceBindingApi {
  public constructor(
    private readonly storage: ContextStorage,
    private readonly workspace: Optional<string>
  ) {}
  public async bind(sessionId: string): Promise<void> {
    const body = JSON.stringify({ version: 1, workspace: toNullable(this.workspace) })
    let objectId: Optional<string>
    for (;;) {
      const state = (await this.storage.load(sessionId)) ?? {
        version: 0,
        objectReferencesVersion: 1,
        records: [],
        workingSet: { revision: 0, cursor: 0, items: [] },
      }
      const records = state.records.filter((record) => record.title === 'runtime:workspace')
      if (!isEmpty(records)) {
        if (
          records.length !== 1 ||
          (await this.storage.get(sessionId, records[0]!.objectId)) !== body
        )
          throw new AppError(
            'WORKSPACE_BINDING_MISMATCH',
            '会话工作区已经变化或绑定损坏，请为新的工作区建立会话。'
          )
        return
      }
      objectId ??= await this.storage.put(sessionId, body)
      const record: ContextRecord = {
        ref: await createContextReference(this.storage, sessionId),
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
