import type { ContextRecord, ContextStorage } from '@velaros-ai/context'
import { createContextReference } from '@velaros-ai/context'
import { isEmpty } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModuleBinding } from '@velaros-ai/kernel'

import type { RuntimeSessionBinding } from '../contract/requires.js'
import { readSessionBinding, sessionBindingBody } from '../utils/session-binding.js'

/** 会话范围绑定只通过已有 ContextStorage 的原子提交维护。 */
export interface SessionExecutionBindingApi {
  /** 首次固定已核验的执行身份、授权与模块，重开与并发打开必须匹配同一绑定。 */
  bind(sessionId: string): Promise<void>
  /** 核对既有存储控制范围；不存在返回 false，绝不创建绑定或要求重建执行模块。 */
  assertControl(sessionId: string): Promise<boolean>
}

/** 固定会话的通用执行边界；产品选择、路径与组织语义不进入核心。 */
export class SessionExecutionBinding implements SessionExecutionBindingApi {
  private readonly body: string
  public constructor(
    private readonly storage: ContextStorage,
    private readonly binding: RuntimeSessionBinding,
    modules: readonly ModuleBinding[]
  ) {
    this.body = sessionBindingBody(binding, modules)
  }
  public async assertControl(sessionId: string): Promise<boolean> {
    const snapshot = await this.storage.selectSnapshot(sessionId, [
      { title: 'runtime:binding' },
      { title: 'runtime:workspace' },
    ])
    if (!snapshot) return false
    if (snapshot.records.length !== 1 || snapshot.records[0]!.title !== 'runtime:binding')
      throw new AppError('CONFLICT', '会话缺少有效的执行绑定，需要宿主核验迁移')
    const body = await this.storage.get(sessionId, snapshot.records[0]!.objectId)
    if (body === null) throw new AppError('CONFLICT', '会话执行绑定原文缺失')
    const document = readSessionBinding(body)
    if (
      document.executionIdentity !== this.binding.executionIdentity ||
      document.authorizationScope !== this.binding.authorizationScope
    )
      throw new AppError('CONFLICT', '会话执行身份或授权范围已经变化')
    return true
  }
  public async bind(sessionId: string): Promise<void> {
    const body = this.body
    let objectId: Optional<string>
    for (;;) {
      const state = (await this.storage.load(sessionId)) ?? {
        version: 0,
        objectReferencesVersion: 1,
        records: [],
        workingSet: { revision: 0, cursor: 0, items: [] },
      }
      if (state.records.some((record) => record.title === 'runtime:workspace'))
        throw new AppError('CONFLICT', '旧产品绑定需要宿主显式迁移后再恢复')
      const records = state.records.filter((record) => record.title === 'runtime:binding')
      if (!isEmpty(records)) {
        if (
          records.length !== 1 ||
          (await this.storage.get(sessionId, records[0]!.objectId)) !== body
        )
          throw new AppError(
            'CONFLICT',
            '会话执行身份、授权范围或能力绑定已经变化或损坏，请核验后建立新会话。'
          )
        return
      }
      if (state.records.length > 0)
        throw new AppError('CONFLICT', '会话历史缺少执行绑定，需要宿主核验迁移')
      objectId ??= await this.storage.put(sessionId, body)
      const record: ContextRecord = {
        ref: await createContextReference(this.storage, sessionId),
        sequence: state.records.length + 1,
        kind: 'audit',
        title: 'runtime:binding',
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
