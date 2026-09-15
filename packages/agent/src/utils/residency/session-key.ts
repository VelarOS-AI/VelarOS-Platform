/**
 * 治理账本键的唯一算法（零依赖，故意单独成文件）。
 *
 * 「注册键 = 查询键」原先靠十几处调用点各自手写 `sessionId?.trim() || 'unknown-session'` 自觉
 * 维持，缺页降级那两处恰恰忘了写，于是 `govern-epoch` 级对无身份会话恒查不到账本 —— 零报错的
 * 静默失效。收进一个函数后这条不变量才是机械成立的：字面量只许出现在本文件，
 * `scripts/agent/check-arch-boundaries.mjs` 的「治理会话键单源」哨兵机械拦截其余出现。
 *
 * 不放进 `ContextGovernanceSession.ts` 的理由很实际：`kernel/prefix-shape.ts` 与
 * `kernel/tool-output-store.ts` 也要认同一个兜底键，而它们不该为了一个字符串常量把整条治理
 * 依赖图（账本 / epoch / 蒸馏）拖进来。
 */

/** 会话身份缺席时的治理账本键（编译面与降级面必须回落到同一个，否则强开 epoch 查不到账本）。 */
export const UnknownGovernanceSessionId = 'unknown-session'

/** sessionId → 治理账本键。空白、缺席一律回落 {@link UnknownGovernanceSessionId}。 */
export function resolveGovernanceSessionKey(sessionId: LooseOptional<string>): string {
  return sessionId?.trim() || UnknownGovernanceSessionId
}
