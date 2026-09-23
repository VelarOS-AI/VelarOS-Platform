import { isEmpty, isNull, isUndefined } from '@velaros-ai/core'
import type { ModuleCard } from '@velaros-ai/kernel'
import { scriptPackageCompiler } from '@velaros-ai/script'

import { SystemCatalogLimits, SystemPackageSpecifier } from '../contract/constants.js'
import type { ModulesHost } from '../contract/requires.js'
import type {
  SystemModuleCard,
  SystemModuleDescription,
  SystemModulePage,
  SystemModuleQuery,
} from '../types/modules.js'
import { isSystemMember, systemMembers } from '../utils/members.js'

/** 当前会话的规范包目录。 */
export interface SystemCatalogApi {
  /** 授权与空间筛选后分页。 */
  list(sessionId: string, query: SystemModuleQuery): SystemModulePage
  /** 读取包或指定成员的真实合同。 */
  describe(sessionId: string, module: string, member?: string): SystemModuleDescription
}

export class SystemCatalog implements SystemCatalogApi {
  public constructor(private readonly host: ModulesHost) {}

  public list(sessionId: string, query: SystemModuleQuery): SystemModulePage {
    const available = this.available(sessionId)
    const members = systemMembers((id) => available.some((item) => item.binding.moduleId === id))
    const system: SystemModuleCard = {
      specifier: SystemPackageSpecifier,
      space: 'system',
      summary: '发现能力，维护记忆、共享状态与材料引用',
      exports: members.map(([name]) => name),
      operations: members.flatMap(([name, id]) =>
        available
          .find((item) => item.binding.moduleId === id)!
          .operations.map((operation) => `${name}.${operation}`)
      ),
    }
    const capabilities = available
      .filter((item) => !isSystemMember(item.binding.moduleId))
      .map((item): SystemModuleCard => ({
        ...item,
        specifier: item.binding.moduleId,
        space: 'capability',
      }))
    const keyword = query.query?.trim().toLowerCase()
    const cards = [...(isEmpty(members) ? [] : [system]), ...capabilities]
      .filter(
        (card) =>
          (!query.space || query.space === 'all' || card.space === query.space) &&
          (!keyword ||
            `${card.specifier} ${card.summary} ${card.operations.join(' ')}`
              .toLowerCase()
              .includes(keyword))
      )
      .sort((a, b) => a.specifier.localeCompare(b.specifier))
    // 分页越界按边界钳制，不拒绝：负偏移从头开始，页大小落在 1 到上限之间
    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const limit = Math.min(
      Math.max(1, Math.trunc(query.limit ?? SystemCatalogLimits.page)),
      SystemCatalogLimits.maxPage
    )
    return {
      items: cards.slice(offset, offset + limit),
      nextOffset: offset + limit < cards.length ? offset + limit : null,
    }
  }

  public describe(sessionId: string, module: string, member?: string): SystemModuleDescription {
    const available = this.available(sessionId)
    const members = systemMembers((id) => available.some((item) => item.binding.moduleId === id))
    if (module !== SystemPackageSpecifier) {
      if (!isUndefined(member))
        throw Object.assign(new Error('成员查询只适用于聚合包'), { code: 'MODULE_EXPORT' })
      if (!this.host.allows(sessionId, module))
        throw Object.assign(new Error('当前会话没有此能力'), { code: 'CAPABILITY_DENIED' })
      const description = this.host.kernel().describe(module)
      const entry = members.find(([, id]) => id === module)
      // 外部接入的模块（MCP）没有用法示例，交回空字符串，模型不必为它另写分支
      const template = description.template ?? ''
      return entry
        ? {
            ...description,
            template,
            specifier: SystemPackageSpecifier,
            space: 'system',
            export: entry[0],
          }
        : { ...description, template, specifier: module, space: 'capability' }
    }
    const selected = members.filter(([name]) => isUndefined(member) || member === name)
    if (isEmpty(selected))
      throw Object.assign(new Error('系统成员不存在或未授权'), { code: 'CAPABILITY_DENIED' })
    const descriptions = Object.fromEntries(
      selected.map(([name, id]) => [name, this.host.kernel().describe(id)])
    )
    const compiled = scriptPackageCompiler.compile(
      [{ specifier: SystemPackageSpecifier, exports: Object.fromEntries(selected) }],
      Object.values(descriptions).map((item) => ({
        namespace: item.binding.moduleId,
        declarations: item.declarations,
      }))
    )
    return {
      specifier: module,
      space: 'system',
      exports: descriptions,
      declarations: compiled.granted.map((item) => item.declarations).join('\n'),
      template: member
        ? (descriptions[member]!.template ?? '')
        : `// 当前成员：${selected.map(([name]) => name).join(', ')}\nimport {output} from 'velaros';\nimport * as system from 'velaros:system';\nasync function usage(){output(Object.keys(system));}`,
    }
  }

  private available(sessionId: string): ModuleCard[] {
    const items: ModuleCard[] = []
    let offset: Nullable<number> = 0
    while (!isNull(offset)) {
      const page = this.host.kernel().list({ offset })
      items.push(...page.items.filter((item) => this.host.allows(sessionId, item.binding.moduleId)))
      offset = page.nextOffset
    }
    return items
  }
}
