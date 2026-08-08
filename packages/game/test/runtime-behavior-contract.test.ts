import { describe, expect, test } from 'bun:test'

import { describeBehaviorContractMisuse } from '../src/runtime/phaser-projection'

/**
 * AGENT-11 的静默失败：玩法脚本猜错契约后**每帧原地返回**，画面照常、报错为空、
 * game:input 回执一切正常，而实体一动不动。这一组把「猜错要出声」钉死。
 */
describe('gameplay behavior contract misuse is reported, not silently ignored', () => {
  test('update(dt, entity) is flagged — the entity参数 does not exist', () => {
    const misuse = describeBehaviorContractMisuse('player', {
      update: (_delta: number, _entity?: unknown) => undefined,
    })

    expect(misuse).not.toBeNull()
    expect(misuse).toContain('player')
    // 必须把正确契约讲全，模型下一轮才改得对。
    expect(misuse).toContain('context.getPosition')
    expect(misuse).toContain('context.setPosition')
    expect(misuse).toContain('context.isActionDown')
    // 必须点破「防御式 early return 会让它彻底静默」这条最难自己想到的因果。
    expect(misuse).toContain('静默')
  })

  test('the correct single-parameter contract is not flagged', () => {
    expect(
      describeBehaviorContractMisuse('player', { update: (_delta: number) => undefined }),
    ).toBeNull()
  })

  test('a behavior without update is not flagged', () => {
    expect(describeBehaviorContractMisuse('player', {})).toBeNull()
    expect(
      describeBehaviorContractMisuse('player', { create: () => undefined }),
    ).toBeNull()
  })

  test('a zero-parameter update is not flagged', () => {
    expect(describeBehaviorContractMisuse('player', { update: () => undefined })).toBeNull()
  })

  test('more than two parameters is flagged with the real arity', () => {
    const misuse = describeBehaviorContractMisuse('enemy-slime-01', {
      update: (_a: number, _b?: unknown, _c?: unknown) => undefined,
    })

    expect(misuse).toContain('enemy-slime-01')
    expect(misuse).toContain('3 个形参')
  })
})
