import { SystemMembers } from '../contract/constants.js'

/** 这个模块身份属于 velaros:system 的某个成员（不作为业务能力单独列出）。 */
export function isSystemMember(moduleId: string): boolean {
  return Object.values(SystemMembers).some((ids) => ids.includes(moduleId))
}

/** 每个系统成员实际挂着的模块：取成员表里第一个可用的；一个都不可用的成员不出现。 */
export function systemMembers(available: (moduleId: string) => boolean): Array<[string, string]> {
  return Object.entries(SystemMembers).flatMap(([name, ids]): Array<[string, string]> => {
    const id = ids.find(available)
    return id ? [[name, id]] : []
  })
}
