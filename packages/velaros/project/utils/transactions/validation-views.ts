/**
 * 校验器看到的只读视图：`TransactionValidation` 拼 `ProjectValidationContext` 时，策略、宿主能力和事务都先经这里冻结或包成只读代理，
 * validator 只能看，改不动内核持有的原件。
 */

import { isFunction } from '@velaros-ai/core'

import type { CommandProvider, ProjectProviders } from '../../contract/requires.js'
import type { CorePolicy } from '../../types/policy.js'
import type { StoredTransaction } from '../../types/transaction.js'
import type {
  ProjectValidationPolicy,
  ProjectValidationProviders,
  ProjectValidationTransaction,
} from '../../types/validation.js'

/** 复制并冻结一份策略给校验器，改不到内核的策略。 */
export function validationPolicyView(policy: CorePolicy): ProjectValidationPolicy {
  return Object.freeze({ ...policy })
}

/** 把一个宿主能力包成只读代理：读属性照常（方法绑回原对象），写、删、定义属性一律失败；没给能力返回 undefined。 */
function readonlyProvider<Provider extends object>(
  provider?: Provider
): Readonly<Provider> | undefined {
  if (!provider) return undefined
  const target = Object.freeze({})
  return new Proxy(target, {
    defineProperty: () => false,
    deleteProperty: () => false,
    get: (_target, property) => {
      const value = Reflect.get(provider, property, provider)
      return isFunction(value) ? value.bind(provider) : value
    },
    has: (_target, property) => Reflect.has(provider, property),
    set: () => false,
  }) as Readonly<Provider>
}

/** 宿主能力的只读视图：每一项都包成只读代理，整体冻结；命令能力一定在。 */
export function validationProvidersView(
  providers: ProjectProviders & { command: CommandProvider }
): ProjectValidationProviders {
  return Object.freeze({
    codeIntelligence: readonlyProvider(providers.codeIntelligence),
    command: readonlyProvider(providers.command)!,
    context: readonlyProvider(providers.context),
    fileFilter: readonlyProvider(providers.fileFilter),
    logger: readonlyProvider(providers.logger),
    telemetry: readonlyProvider(providers.telemetry),
  })
}

/** 事务的最小只读投影：只给事务号、改动文件和改动行数，不暴露补丁、metadata 与生命周期；没有事务返回 undefined。 */
export function validationTransactionView(
  transaction?: StoredTransaction
): ProjectValidationTransaction | undefined {
  if (!transaction) return undefined
  return Object.freeze({
    transactionId: transaction.transactionId,
    changedFiles: Object.freeze([...transaction.changedFiles]),
    changedLines: transaction.changedLines,
  })
}
