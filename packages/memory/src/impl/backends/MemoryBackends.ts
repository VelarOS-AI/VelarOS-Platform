import type { MemoryBackendVerb } from '../../contract/constants'
import type {
  MemoryAuthorityEnumeration,
  MemoryDerivedIndexBackend,
  MemoryStoreBackend,
} from '../../contract/requires'
import {
  isMemoryDerivedIndexBackend,
  listMissingAuthorityMemoryVerbs,
  resolveAuthorityEnumeration,
  supportsMemoryBackendVerb,
} from '../../utils/backends'

/**
 * 后端动词与角色的判定面：宿主要判「这个后端能不能归档」「它是不是派生索引」时问它。
 *
 * 判据本身住 `utils/backends.ts`（包内各处共用），这里只是把它们收成一个对外实例——
 * 工具函数不出包，宿主拿到的是整件能力。整个进程共用 `memoryBackends` 这一份。
 */
export interface MemoryBackendsApi {
  /** 这个后端是否声明并实现了某个动词（声明与实现必须一致，否则视为未实现）。 */
  supports(backend: MemoryStoreBackend, verb: MemoryBackendVerb): boolean
  /** 这个权威层后端缺了哪些必备动词（空数组 = 合格），用于启动期诊断。 */
  missingAuthorityVerbs(backend: MemoryStoreBackend): readonly MemoryBackendVerb[]
  /** 这个后端是不是派生索引（角色是唯一判据，不做实现探测）。 */
  isDerivedIndex(backend: MemoryStoreBackend): backend is MemoryDerivedIndexBackend
  /** 这个后端自不自带全量枚举；没有则派生索引无法重建，宿主必须显式注入一个源。 */
  authorityEnumeration(backend: MemoryStoreBackend): MemoryAuthorityEnumeration | undefined
}

/** 后端动词与角色判定的对外实例实现。 */
export class MemoryBackends implements MemoryBackendsApi {
  public supports(backend: MemoryStoreBackend, verb: MemoryBackendVerb): boolean {
    return supportsMemoryBackendVerb(backend, verb)
  }

  public missingAuthorityVerbs(backend: MemoryStoreBackend): readonly MemoryBackendVerb[] {
    return listMissingAuthorityMemoryVerbs(backend)
  }

  public isDerivedIndex(backend: MemoryStoreBackend): backend is MemoryDerivedIndexBackend {
    return isMemoryDerivedIndexBackend(backend)
  }

  public authorityEnumeration(backend: MemoryStoreBackend): MemoryAuthorityEnumeration | undefined {
    return resolveAuthorityEnumeration(backend)
  }
}

/** 整个进程共用的后端判定实例。 */
export const memoryBackends: MemoryBackendsApi = new MemoryBackends()
