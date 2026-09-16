import type {
  BrowserActionPolicyConfig,
  BrowserActionPolicyDecision,
  BrowserActionPolicyRequest,
} from '../../types/browser.js'
import { checkBrowserActionPolicy } from '../../utils/action-policy.js'

/**
 * 浏览器动作策略的门面：按宿主给的允许 / 拒绝表裁决一次动作。
 *
 * 动作词表是浏览器自己的语义，住在 `contract/constants.ts` 的 `BrowserActionPolicyActions`；
 * 宿主只负责把用户的开关映射成一张 `BrowserActionPolicyConfig`，判定规则只有这一份。
 */
export interface BrowserActionPolicyApi {
  /** 裁决一次动作：放行还是拒绝，并说明命中了词表里的哪一条。 */
  check(
    policy: LooseOptional<BrowserActionPolicyConfig>,
    request: BrowserActionPolicyRequest
  ): BrowserActionPolicyDecision
}

/** 见 {@link BrowserActionPolicyApi}。 */
class BrowserActionPolicy implements BrowserActionPolicyApi {
  public check(
    policy: LooseOptional<BrowserActionPolicyConfig>,
    request: BrowserActionPolicyRequest
  ): BrowserActionPolicyDecision {
    return checkBrowserActionPolicy(policy, request)
  }
}

/** 整个进程共用的动作策略实例。 */
export const browserActionPolicy: BrowserActionPolicyApi = new BrowserActionPolicy()
