import type {
  MemoryScopeId,
  MemoryScopeSelectorInput,
  MemoryScopeTarget,
  MemoryScopeType,
  MemoryScopeVisibilityInput,
} from '../../types/memory'
import {
  buildProjectMemoryScope,
  buildSiteMemoryScope,
  isMemoryVisibleInScope,
  resolveMemoryScopeSelector,
  scopeTypeForScopeId,
} from '../../utils/scope'

/**
 * 作用域规则的对外面：怎么由工作区根或站点源拼出作用域 id、怎么判一条记忆在当前两轴下可不可见。
 *
 * 判据本身住 `utils/scope.ts`（全仓唯一一份，文件后端、向量索引、工具读门都经它），
 * 这里只是把它们收成一个对外实例。整个进程共用 `memoryScopes` 这一份。
 */
export interface MemoryScopesApi {
  /** 工作区根 → 项目作用域 id；根为空时回落到系统池。 */
  projectScope(root: LooseOptional<string>): MemoryScopeId
  /** 站点源 → 站点作用域 id；源为空时回落到系统池。 */
  siteScope(origin: LooseOptional<string>): MemoryScopeId
  /** 一个作用域 id 属于哪一种作用域；认不出的前缀按独立池处理。 */
  scopeTypeOf(scopeId: LooseOptional<string>): MemoryScopeType
  /** 两轴（会话身份轴与工作区根轴）→ 唯一作用域；返回空串表示不过滤。 */
  selector(input: MemoryScopeSelectorInput): MemoryScopeId
  /** 这条记忆在当前两轴下可不可见——全仓唯一判据，宿主自己过滤召回结果时也该用它。 */
  isVisible(target: MemoryScopeTarget, input: MemoryScopeVisibilityInput): boolean
}

/** 作用域规则的对外实例实现。 */
export class MemoryScopes implements MemoryScopesApi {
  public projectScope(root: LooseOptional<string>): MemoryScopeId {
    return buildProjectMemoryScope(root)
  }

  public siteScope(origin: LooseOptional<string>): MemoryScopeId {
    return buildSiteMemoryScope(origin)
  }

  public scopeTypeOf(scopeId: LooseOptional<string>): MemoryScopeType {
    return scopeTypeForScopeId(scopeId)
  }

  public selector(input: MemoryScopeSelectorInput): MemoryScopeId {
    return resolveMemoryScopeSelector(input)
  }

  public isVisible(target: MemoryScopeTarget, input: MemoryScopeVisibilityInput): boolean {
    return isMemoryVisibleInScope(target, input)
  }
}

/** 整个进程共用的作用域规则实例。 */
export const memoryScopes: MemoryScopesApi = new MemoryScopes()
