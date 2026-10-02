import { isEmpty, isNull, isUndefined } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type { ModuleCard, ModuleDescription } from '@velaros-ai/kernel'
import type { ScriptModuleIndex } from '@velaros-ai/script'
import { scriptPackageCompiler } from '@velaros-ai/script'
import { scriptOutputs } from '@velaros-ai/script'

import { SystemCatalogLimits, SystemPackageSpecifier } from '../contract/constants.js'
import type { ModulesHost } from '../contract/requires.js'
import type {
  SystemModuleCard,
  SystemModuleDescribeInput,
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
  describe(sessionId: string, input: SystemModuleDescribeInput): SystemModuleDescription
}

export class SystemCatalog implements SystemCatalogApi {
  private readonly indexes = new WeakMap<ModuleDescription, ScriptModuleIndex>()

  public constructor(private readonly host: ModulesHost) {}

  public list(sessionId: string, query: SystemModuleQuery): SystemModulePage {
    const available = this.available(sessionId)
    const members = systemMembers((id) => available.some((item) => item.binding.moduleId === id))
    const system: SystemModuleCard = {
      specifier: SystemPackageSpecifier,
      space: 'system',
      summary: '发现能力，维护记忆、共享状态与材料引用',
      exports: members.map(([name]) => name),
      contentRevision: this.systemRevision(members),
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
        ...this.moduleIndex(this.host.kernel().describe(item.binding.moduleId)),
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

  public describe(sessionId: string, input: SystemModuleDescribeInput): SystemModuleDescription {
    const { module, exports: selectedNames } = input
    if (
      selectedNames &&
      (selectedNames.length < 1 ||
        selectedNames.length > SystemCatalogLimits.maxExports ||
        selectedNames.some((name) => !name.trim()))
    )
      throw new AppError(
        'VALIDATION',
        `exports 必须包含 1 到 ${SystemCatalogLimits.maxExports} 个非空导出名`
      )
    const includeTemplate = input.template ?? isUndefined(selectedNames)
    const available = this.available(sessionId)
    const members = systemMembers((id) => available.some((item) => item.binding.moduleId === id))
    if (module !== SystemPackageSpecifier) {
      if (isSystemMember(module) || !this.host.allows(sessionId, module))
        throw new AppError('CAPABILITY_DENIED', '当前会话没有此能力')
      const description = this.host.kernel().describe(module)
      // 外部接入的模块（MCP）没有用法示例，交回空字符串，模型不必为它另写分支
      const template = description.template ?? ''
      const index = this.moduleIndex(description)
      const described: SystemModuleDescription = {
        ...description,
        template: includeTemplate ? template : '',
        contentRevision: index.contentRevision,
        specifier: module,
        space: 'capability',
      }
      if (isUndefined(selectedNames)) return described
      // 给了导出名：只交回它与它用到的类型，操作说明也只留它自己的
      const slice = scriptPackageCompiler.sliceExports(
        description.declarations,
        module,
        selectedNames
      )
      if (isNull(slice.declarations))
        throw new AppError(
          'MODULE_EXPORT',
          `${module} 没有 ${slice.missing.join('、')}；它导出的有：${slice.exports.join('、')}`
        )
      return {
        ...described,
        declarations: slice.declarations,
        operations: Object.fromEntries(
          [...new Set(selectedNames)].flatMap((name) =>
            isUndefined(description.operations[name]) ? [] : [[name, description.operations[name]]]
          )
        ),
      }
    }
    const selected = members.filter(
      ([name]) => isUndefined(selectedNames) || selectedNames.includes(name)
    )
    if (selectedNames?.some((name) => !selected.some(([memberName]) => memberName === name)))
      throw new AppError('CAPABILITY_DENIED', '系统成员不存在或未授权')
    if (isEmpty(selected)) throw new AppError('CAPABILITY_DENIED', '系统成员不存在或未授权')
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
      contentRevision: this.systemRevision(members),
      space: 'system',
      exports:
        isUndefined(selectedNames) && includeTemplate
          ? descriptions
          : Object.fromEntries(
              Object.entries(descriptions).map(([name, description]) => [
                name,
                {
                  binding: description.binding,
                  summary: description.summary,
                  operations: description.operations,
                },
              ])
            ),
      declarations: compiled.granted.map((item) => item.declarations).join('\n'),
      template: !includeTemplate
        ? ''
        : selectedNames && selected.length === 1
          ? (descriptions[selected[0]![0]]!.template ?? '')
          : `// 当前成员：${selected.map(([name]) => name).join(', ')}\nimport {output} from 'velaros';\nimport * as system from 'velaros:system';\nasync function usage(){output(Object.keys(system));}`,
    }
  }

  /** 系统包内容身份由当前授权成员的真实声明与示例组成，不继承未授权成员。 */
  private systemRevision(members: ReadonlyArray<[string, string]>): string {
    return scriptOutputs.hash(
      members.map(([name, id]) => {
        const description = this.host.kernel().describe(id)
        return [name, this.moduleIndex(description).contentRevision]
      })
    )
  }

  /** 目录缓存只依赖 Kernel 的不可变描述对象；替换描述自然得到新原文版本。 */
  private moduleIndex(description: ModuleDescription): ScriptModuleIndex {
    const existing = this.indexes.get(description)
    if (existing) return existing
    const index = scriptPackageCompiler.index(
      description.declarations,
      description.binding.moduleId,
      description.template
    )
    this.indexes.set(description, index)
    return index
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
