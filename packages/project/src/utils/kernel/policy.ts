/**
 * 内核策略的组装：合同常量表里的缺省策略（ProjectPolicyDefaults）加上宿主给的 corePolicy，得到内核实际执行的 CorePolicy。
 */
import { ProjectPolicyDefaults } from '../../contract/constants.js'
import type { CorePolicy } from '../../types/policy.js'

/** 用宿主给的 corePolicy 覆盖缺省策略：顶层字段整个替换，approval 按子字段合并；缺省的路径名单每次复制一份新数组。 */
export function createCorePolicy(overrides?: Partial<CorePolicy>): CorePolicy {
  return {
    ...ProjectPolicyDefaults,
    readDeny: [...ProjectPolicyDefaults.readDeny],
    writeDeny: [...ProjectPolicyDefaults.writeDeny],
    protectedFiles: [...ProjectPolicyDefaults.protectedFiles],
    generatedFiles: [...ProjectPolicyDefaults.generatedFiles],
    ...(overrides ?? {}),
    approval: { ...ProjectPolicyDefaults.approval, ...(overrides?.approval ?? {}) },
  }
}
